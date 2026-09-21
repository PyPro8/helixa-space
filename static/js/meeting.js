// ==========================================================================
// HELIXA SPACE — meeting.js
// v0.2  Two-person WebRTC call
// v0.3  Multi-participant mesh
// v0.4  Controls, chat, participants panel
// v0.5  Screen share, fullscreen, spotlight
// v0.6  Media pipeline fixes, diagnostics, control dock, roles, Space IDL
// ==========================================================================

(function () {
  const shell = document.getElementById('meetingShell');
  const spaceId = shell.dataset.spaceId;

  // v0.6: surface WebRTC/signaling failures instead of letting them die
  // silently as unhandled promise rejections (this is exactly how the
  // "connected but no media" bug went unnoticed — a null peerConnection
  // threw inside an async handler with nothing watching for it).
  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled error in meeting:', e.reason);
    if (window.HX) window.HX.toast('A connection error occurred — check the console for details');
    Diag.log('error', String((e.reason && e.reason.message) || e.reason));
  });

  const pendingSpace = JSON.parse(sessionStorage.getItem('hx-pending-space') || 'null');
  const pendingJoin = JSON.parse(sessionStorage.getItem('hx-pending-join') || 'null');
  let myName =
    (pendingSpace && pendingSpace.spaceId === spaceId && pendingSpace.name) ||
    (pendingJoin && pendingJoin.name) ||
    'Guest';
  let myAvatar = null; // data URL once set via Settings; null = show initials
  const myPassword =
    (pendingSpace && pendingSpace.spaceId === spaceId && pendingSpace.password) ||
    (pendingJoin && pendingJoin.password) ||
    '';
  const myCoHostKey =
    (pendingSpace && pendingSpace.spaceId === spaceId && pendingSpace.coHostKey) ||
    (pendingJoin && pendingJoin.coHostKey) ||
    '';
  // The host token is what lets the server recognize a *returning* host
  // after a refresh/reconnect — it must survive that, so it lives in
  // localStorage (namespaced per Space), never just in this page's
  // in-memory state or session storage.
  const myHostToken = localStorage.getItem(`hx-host-token-${spaceId}`) || '';
  // Likewise, a stable participant identity is what makes the block-list
  // actually work across reconnects — generate one once per Space and
  // keep reusing it, rather than a fresh (unblockable) identity every time.
  let myParticipantToken = localStorage.getItem(`hx-participant-token-${spaceId}`);
  if (!myParticipantToken) {
    myParticipantToken = 'pt_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(`hx-participant-token-${spaceId}`, myParticipantToken);
  }

  const ICE_SERVERS = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  };

  // ------------------------------------------------------------------ state
  const state = {
    myId: null,
    role: 'participant', // 'host' | 'co-host' | 'participant'
    micOn: true,
    camOn: true,
    handRaised: false,
    sharing: false,
    spotlightId: null, // null = grid view (host-controlled, synced)
    focusId: null, // null = grid view (personal, click-driven, never synced)
    localStream: null,
    screenStream: null,
    peers: {}, // id -> { pc, name, mic, cam, hand_raised, role, videoEl }
    chatUnread: 0,
    chatOpen: false,
    admissionMode: false,
    spaceName: '',
  };

  function isHost() { return state.role === 'host'; }
  function canModerate() { return state.role === 'host' || state.role === 'co-host'; }

  const socket = io();

  // -------------------------------------------------------- v0.6 diagnostics
  // Temporary debug panel per the v0.6 spec. Toggle with the keyboard
  // shortcut Ctrl+Shift+D, or ?debug=1 in the URL. Hidden by default so it
  // doesn't clutter the production UI, but easy to reach while testing.
  const Diag = (function () {
    const data = {
      camera: 'pending',
      microphone: 'pending',
      localStream: 'pending',
      videoTracks: 0,
      audioTracks: 0,
      peerStates: {}, // remoteId -> connectionState
      remoteStream: {}, // remoteId -> 'OK' | 'FAILED'
      log: [],
    };
    let panel = null;

    function ensurePanel() {
      if (panel) return panel;
      panel = document.createElement('div');
      panel.id = 'diagPanel';
      panel.className = 'diag-panel';
      document.body.appendChild(panel);
      return panel;
    }

    function render() {
      if (!panel) return;
      const peerRows = Object.entries(data.peerStates)
        .map(([id, st]) => `<div>Peer ${id.slice(0, 6)}: <b>${st}</b> · Remote stream: <b>${data.remoteStream[id] || 'pending'}</b></div>`)
        .join('') || '<div>No peers yet</div>';
      panel.innerHTML = `
        <div class="diag-head">WebRTC Diagnostics <button id="diagClose">✕</button></div>
        <div>Camera: <b>${data.camera}</b></div>
        <div>Microphone: <b>${data.microphone}</b></div>
        <div>Local Stream: <b>${data.localStream}</b></div>
        <div>Video Tracks: <b>${data.videoTracks}</b></div>
        <div>Audio Tracks: <b>${data.audioTracks}</b></div>
        <hr>
        ${peerRows}
        <hr>
        <div class="diag-log">${data.log.slice(-8).map((l) => `<div>${l}</div>`).join('')}</div>
      `;
      const closeBtn = panel.querySelector('#diagClose');
      if (closeBtn) closeBtn.addEventListener('click', hide);
    }

    function show() {
      ensurePanel().classList.add('open');
      render();
    }
    function hide() {
      if (panel) panel.classList.remove('open');
    }
    function toggle() {
      if (panel && panel.classList.contains('open')) hide();
      else show();
    }

    function set(key, value) {
      data[key] = value;
      render();
    }
    function setPeer(id, state) {
      data.peerStates[id] = state;
      render();
    }
    function setRemoteStream(id, status) {
      data.remoteStream[id] = status;
      render();
    }
    function log(level, msg) {
      const time = new Date().toLocaleTimeString([], { hour12: false });
      data.log.push(`[${time}] ${level}: ${msg}`);
      render();
    }

    return { show, hide, toggle, set, setPeer, setRemoteStream, log };
  })();

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === 'D') Diag.toggle();
  });
  if (new URLSearchParams(window.location.search).get('debug') === '1') Diag.show();

  // ------------------------------------------------------------------- DOM
  const videoGrid = document.getElementById('videoGrid');
  const chatPanel = document.getElementById('chatPanel');
  const participantsPanel = document.getElementById('participantsPanel');
  const chatMessages = document.getElementById('chatMessages');
  const participantsList = document.getElementById('participantsList');
  const participantCount = document.getElementById('participantCount');
  const participantsBadge = document.getElementById('participantsBadge');
  const chatBadge = document.getElementById('chatBadge');

  const micBtn = document.getElementById('micBtn');
  const camBtn = document.getElementById('camBtn');
  const shareBtn = document.getElementById('shareBtn');
  const handBtn = document.getElementById('handBtn');
  const chatBtn = document.getElementById('chatBtn');
  const participantsBtn = document.getElementById('participantsBtn');
  const moreBtn = document.getElementById('moreBtn');
  const moreMenu = document.getElementById('moreMenu');
  const reactMenuBtn = document.getElementById('reactMenuBtn');
  const shareMenuBtn = document.getElementById('shareMenuBtn');
  const handMenuBtn = document.getElementById('handMenuBtn');
  const fullscreenMenuBtn = document.getElementById('fullscreenMenuBtn');
  const qrMenuBtn = document.getElementById('qrMenuBtn');
  const leaveBtn = document.getElementById('leaveBtn');
  const reactionsTray = document.getElementById('reactionsTray');
  const sharingBanner = document.getElementById('sharingBanner');
  const stopShareBtn = document.getElementById('stopShareBtn');

  // -------------------------------------------------------------- icons

  function renderIcons() {
    document.querySelectorAll('[data-icon]').forEach((el) => {
      const name = el.dataset.icon;
      el.insertAdjacentHTML('afterbegin', HXIcon.svg(name, { size: el.classList.contains('theme-toggle') ? 17 : 20 }));
    });
  }
  renderIcons();

  function setBtnIcon(btn, name) {
    const existingSvg = btn.querySelector('svg');
    if (existingSvg) existingSvg.remove();
    btn.insertAdjacentHTML('afterbegin', HXIcon.svg(name, { size: 20 }));
  }

  // -------------------------------------------------------------- helpers

  function initials(name) {
    return (name || '?').trim().charAt(0).toUpperCase();
  }

  function tileId(id) {
    return `tile-${id}`;
  }

  function createTile(id, name, isLocal) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.id = tileId(id);
    tile.innerHTML = `
      <video ${isLocal ? 'class="mirrored"' : ''} autoplay playsinline></video>
      <div class="tile-avatar" style="display:none;">${initials(name)}</div>
      <span class="tile-sharing-badge" style="display:none;" title="Sharing screen">${HXIcon.svg('monitor', { size: 12 })}</span>
      <div class="tile-label">
        <span class="tile-name">${escapeHtml(name)}${isLocal ? ' (You)' : ''}</span>
        <span class="tile-mic-off" style="display:none;">${HXIcon.svg('mic-off', { size: 12 })}</span>
      </div>
    `;
    videoGrid.appendChild(tile);
    return tile;
  }

  function updateTileSharingBadge(id, sharing) {
    const tile = document.getElementById(tileId(id));
    if (!tile) return;
    const badge = tile.querySelector('.tile-sharing-badge');
    if (badge) badge.style.display = sharing ? 'flex' : 'none';
    // Screen content must show its full frame (letterboxed if needed),
    // never cropped like a camera tile — spec section 37.
    tile.classList.toggle('tile-is-sharing', !!sharing);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function setTileStream(id, stream, isLocal) {
    const tile = document.getElementById(tileId(id));
    if (!tile) return;
    const video = tile.querySelector('video');
    const avatar = tile.querySelector('.tile-avatar');
    const hasVideo = !!(stream && stream.getVideoTracks().some((t) => t.enabled));
    // Always attach the stream so audio keeps flowing even when the
    // camera is off — only the visual element toggles, never the source.
    if (video.srcObject !== stream) video.srcObject = stream || null;
    video.muted = !!isLocal; // never mute remote audio, always mute our own echo
    if (stream) {
      video.play().catch(() => {
        // Autoplay was blocked — most likely unmuted remote audio before
        // any user gesture on mobile. Surface a visible, explicit action
        // rather than failing silently or hoping for a stray click.
        if (!isLocal) showAudioUnlockBanner();
      });
    }
    video.style.display = hasVideo ? 'block' : 'none';
    avatar.style.display = hasVideo ? 'none' : 'flex';
  }

  function updateTileAvatar(id, name, avatarUrl) {
    const tile = document.getElementById(tileId(id));
    if (!tile) return;
    const avatarEl = tile.querySelector('.tile-avatar');
    avatarEl.innerHTML = avatarUrl
      ? `<img src="${avatarUrl}" alt="">`
      : escapeHtml(initials(name));
  }

  // v0.6: explicit "Tap to enable audio" banner for blocked autoplay,
  // per the mobile-autoplay requirement — never fail silently.
  const audioUnlockBanner = document.getElementById('audioUnlockBanner');

  function showAudioUnlockBanner() {
    audioUnlockBanner.classList.add('show');
  }

  audioUnlockBanner.addEventListener('click', () => {
    document.querySelectorAll('.tile video').forEach((v) => {
      if (v.srcObject) v.play().catch(() => {});
    });
    audioUnlockBanner.classList.remove('show');
    Diag.log('info', 'Audio unlocked via user tap');
  });

  function updateTileMicIcon(id, micOn) {
    const tile = document.getElementById(tileId(id));
    if (!tile) return;
    tile.querySelector('.tile-mic-off').style.display = micOn ? 'none' : 'flex';
  }

  // Focus (personal, click-driven, not synced) takes visual priority over
  // Spotlight (host-controlled, synced) on the viewer's own screen — the
  // two are independent per spec: clicking a tile never affects anyone
  // else's view, and it never overrides the host's spotlight for others.
  function renderLayout() {
    const mainId = state.focusId || state.spotlightId;
    videoGrid.classList.toggle('spotlighted', !!mainId);
    gridBackBtn.style.display = mainId ? 'flex' : 'none';

    // Explicit solo-tile class as a fallback for browsers without
    // :has() support — the CSS rule handles it natively where available,
    // this keeps the same sizing fix working everywhere else.
    const tileCount = Object.keys(state.peers).length + 1;
    videoGrid.classList.toggle('solo-tile', tileCount === 1 && !mainId);

    const applyClass = (id, tile) => {
      tile.classList.remove('spot-main', 'spot-rail-tile', 'spotlight-target', 'focus-target');
      if (!mainId) return;
      if (id === mainId) {
        tile.classList.add('spot-main', state.focusId ? 'focus-target' : 'spotlight-target');
      } else {
        tile.classList.add('spot-rail-tile');
      }
    };
    Object.keys(state.peers).forEach((id) => {
      const tile = document.getElementById(tileId(id));
      if (tile) applyClass(id, tile);
    });
    const localTile = document.getElementById(tileId('local'));
    if (localTile) applyClass('local', localTile);
    renderViewHostButton();
  }

  function setFocus(id) {
    // Clicking the currently-focused tile again returns to grid.
    state.focusId = state.focusId === id ? null : id;
    renderLayout();
  }

  // "View Host" — a small contextual control (not a permanent banner) that
  // lets a participant bring the host into their own main view, without
  // affecting anyone else's layout.
  function findHostId() {
    for (const [id, info] of Object.entries(state.peers)) {
      if (info.role === 'host') return id;
    }
    return null;
  }

  function renderViewHostButton() {
    const existing = document.getElementById('viewHostBtn');
    if (existing) existing.remove();

    if (isHost()) return; // hosts don't need a button to view themselves
    const hostId = findHostId();
    if (!hostId || state.focusId === hostId || state.spotlightId === hostId) return;

    const btn = document.createElement('button');
    btn.id = 'viewHostBtn';
    btn.className = 'view-host-btn';
    btn.innerHTML = `${HXIcon.svg('user-check', { size: 13 })} <span>View Host</span>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setFocus(hostId);
    });
    document.getElementById('stage').appendChild(btn);
  }

  videoGrid.addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    // Ignore clicks on interactive controls inside a tile, if any are added later.
    if (e.target.closest('button')) return;
    setFocus(tile.id.replace('tile-', ''));
  });

  const gridBackBtn = document.getElementById('gridBackBtn');
  gridBackBtn.addEventListener('click', () => {
    state.focusId = null;
    renderLayout();
  });

  HX.toastMeeting = window.HX ? window.HX.toast : () => {};

  // -------------------------------------------------------------- media

  async function getLocalMedia() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      state.localStream = stream;

      const videoTracks = stream.getVideoTracks();
      const audioTracks = stream.getAudioTracks();

      Diag.set('localStream', 'OK');
      Diag.set('camera', videoTracks.length && videoTracks[0].readyState === 'live' ? 'OK' : 'FAILED');
      Diag.set('microphone', audioTracks.length && audioTracks[0].readyState === 'live' ? 'OK' : 'FAILED');
      Diag.set('videoTracks', videoTracks.length);
      Diag.set('audioTracks', audioTracks.length);

      if (!videoTracks.length) {
        window.HX.toast('No video track available — camera may not be sending video.');
        Diag.log('warn', 'getUserMedia succeeded but returned 0 video tracks');
      }
      if (!audioTracks.length) {
        window.HX.toast('No audio track available — microphone may not be sending audio.');
        Diag.log('warn', 'getUserMedia succeeded but returned 0 audio tracks');
      }
      Diag.log('info', `Local media ready: ${videoTracks.length} video, ${audioTracks.length} audio track(s)`);

      return stream;
    } catch (err) {
      let msg = 'Unable to access camera or microphone.';
      if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        msg = 'Camera or microphone access requires HTTPS. Open this page over HTTPS (or localhost) on this device.';
      } else if (err.name === 'NotAllowedError') {
        msg = 'Camera or microphone permission was denied.';
      } else if (err.name === 'NotFoundError') {
        msg = 'No camera or microphone was detected on this device.';
      } else if (err.name === 'NotReadableError') {
        msg = 'Camera or microphone is already in use by another application.';
      }
      window.HX.toast(msg);
      console.error('getUserMedia failed:', err);
      Diag.set('localStream', 'FAILED');
      Diag.set('camera', 'FAILED');
      Diag.set('microphone', 'FAILED');
      Diag.log('error', `getUserMedia failed: ${err.name || err.message}`);
      state.camOn = false;
      state.micOn = false;
      return new MediaStream(); // empty stream — still lets signaling work
    }
  }

  function renderLocalTile() {
    createTile('local', myName, true);
    setTileStream('local', state.localStream, true);
    updateControlButtonStates();
  }

  // --------------------------------------------------------- WebRTC mesh

  function createPeerConnection(remoteId) {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    if (state.localStream && state.localStream.getTracks().length) {
      const audioTracks = state.localStream.getAudioTracks();
      // If we're mid screen-share when a new peer connects, send the
      // screen track as the outgoing video, not the (paused) camera —
      // otherwise a late joiner would see our camera while everyone
      // else sees our screen, a silent desync the v0.7 audit flagged.
      const videoTrack = state.sharing && state.screenStream
        ? state.screenStream.getVideoTracks()[0]
        : state.localStream.getVideoTracks()[0];

      if (videoTrack) pc.addTrack(videoTrack, state.localStream);
      audioTracks.forEach((track) => pc.addTrack(track, state.localStream));
      Diag.log('info', `Added local tracks to peer ${remoteId.slice(0, 6)} (video: ${state.sharing ? 'screen' : 'camera'})`);
    } else {
      Diag.log('warn', `No local tracks available when connecting to ${remoteId.slice(0, 6)} — this would create a data-only connection`);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('webrtc-ice-candidate', { to: remoteId, candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      const stream = e.streams[0];
      const hasAudio = stream.getAudioTracks().length > 0;
      const hasVideo = stream.getVideoTracks().length > 0;
      Diag.setRemoteStream(remoteId, hasAudio || hasVideo ? 'OK' : 'FAILED');
      Diag.log('info', `ontrack from ${remoteId.slice(0, 6)}: video=${hasVideo} audio=${hasAudio}`);
      setTileStream(remoteId, stream);
    };

    pc.onconnectionstatechange = () => {
      Diag.setPeer(remoteId, pc.connectionState);
      const tile = document.getElementById(tileId(remoteId));
      if (!tile) return;
      if (pc.connectionState === 'connected') tile.style.opacity = '1';
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        tile.style.opacity = '0.4';
        if (pc.connectionState === 'failed') {
          window.HX.toast(`Connection to ${state.peers[remoteId] ? state.peers[remoteId].name : 'a participant'} failed`);
        }
      }
    };

    return pc;
  }

  async function callPeer(remoteId, name) {
    if (remoteId === state.myId) return; // never create a peer connection to ourselves
    const pc = createPeerConnection(remoteId);
    state.peers[remoteId] = { pc, name, mic: true, cam: true, hand_raised: false, role: 'participant' };
    createTile(remoteId, name, false);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { to: remoteId, sdp: offer });
  }

  async function handleOffer({ from, sdp }) {
    if (from === state.myId) return; // guard: never treat our own socket id as a remote peer
    let entry = state.peers[from];
    if (!entry || !entry.pc) {
      const pc = createPeerConnection(from);
      entry = { ...(entry || {}), pc, name: (entry && entry.name) || 'Participant', mic: (entry && entry.mic) ?? true, cam: (entry && entry.cam) ?? true, hand_raised: (entry && entry.hand_raised) || false, role: (entry && entry.role) || 'participant' };
      state.peers[from] = entry;
      if (!document.getElementById(tileId(from))) createTile(from, entry.name, false);
    }
    await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { to: from, sdp: answer });
  }

  async function handleAnswer({ from, sdp }) {
    const entry = state.peers[from];
    if (!entry || !entry.pc) return;
    await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }

  async function handleIce({ from, candidate }) {
    const entry = state.peers[from];
    if (!entry || !entry.pc || !candidate) return;
    try {
      await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      /* benign race between ICE arrival and remote description */
    }
  }

  function removePeer(id) {
    const entry = state.peers[id];
    if (entry) {
      entry.pc.close();
      delete state.peers[id];
    }
    const tile = document.getElementById(tileId(id));
    if (tile) tile.remove();
    if (state.spotlightId === id) state.spotlightId = null;
    renderLayout();
    updateParticipantsPanel();
  }

  // ------------------------------------------------------------ signaling

  function attemptJoin(extra) {
    socket.emit('join-space', {
      spaceId,
      name: myName,
      password: myPassword,
      coHostKey: myCoHostKey,
      hostToken: myHostToken,
      participantToken: myParticipantToken,
      ...extra,
    });
  }

  socket.on('connect', () => attemptJoin());

  socket.on('join-rejected', ({ reason, spaceName }) => {
    if (reason === 'wrong-password') {
      const entered = window.prompt('This Space is password-protected. Enter the password:');
      if (entered !== null) {
        attemptJoin({ password: entered });
      } else {
        window.HX.toast('You need the Space password to join');
        setTimeout(() => (window.location.href = '/'), 1500);
      }
      return;
    }

    if (reason === 'not-found') {
      showBlockingScreen('Space not found', 'Check the Space ID and try again.');
      return;
    }
    if (reason === 'ended') {
      showBlockingScreen('This Space has ended', 'The host has ended this meeting. It cannot be rejoined.');
      return;
    }
    if (reason === 'blocked') {
      showBlockingScreen('You cannot rejoin this Space', 'You have been removed from this Space and cannot rejoin.');
      return;
    }
    if (reason === 'not-started') {
      showWaitingScreen(spaceName, 'not-started');
      return;
    }
  });

  socket.on('waiting-for-admission', ({ spaceName }) => {
    showWaitingScreen(spaceName, 'admission');
  });

  socket.on('admission-approved', () => {
    hideBlockingOverlay();
    window.HX.toast("You've been admitted");
  });

  socket.on('admission-dismissed', () => {
    showBlockingScreen('Request declined', 'The host did not admit you to this Space.');
  });

  socket.on('meeting-ended', () => {
    // Clean shutdown per spec: stop tracks, close peers, then show the
    // end screen rather than leaving dead video UI on screen.
    Object.values(state.peers).forEach(({ pc }) => pc && pc.close());
    if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
    if (state.screenStream) state.screenStream.getTracks().forEach((t) => t.stop());
    showBlockingScreen('Meeting ended', 'The host has ended this Space.');
  });

  socket.on('removed-from-space', ({ blocked }) => {
    Object.values(state.peers).forEach(({ pc }) => pc && pc.close());
    if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
    showBlockingScreen(
      'Removed from Space',
      blocked ? 'You were removed and blocked from rejoining this Space.' : 'You were removed from this Space by the host.'
    );
  });

  // Host/co-host side: someone is waiting in the admission queue.
  socket.on('admission-requested', ({ sid, name }) => {
    const stack = ensureAdmissionStack();
    const el = document.createElement('div');
    el.className = 'admission-toast';
    el.innerHTML = `
      <div class="admission-toast-title">Join Request</div>
      <div class="admission-toast-name">${escapeHtml(name)} wants to join this Space.</div>
      <div class="admission-toast-actions">
        <button class="dismiss-btn">Dismiss</button>
        <button class="admit-btn">Admit</button>
      </div>
    `;
    el.querySelector('.dismiss-btn').addEventListener('click', () => {
      socket.emit('dismiss-admission', { sid });
      el.remove();
    });
    el.querySelector('.admit-btn').addEventListener('click', () => {
      socket.emit('admit-participant', { sid });
      el.remove();
    });
    stack.appendChild(el);
  });

  function ensureAdmissionStack() {
    let el = document.getElementById('admissionStack');
    if (!el) {
      el = document.createElement('div');
      el.id = 'admissionStack';
      el.className = 'admission-toast-stack';
      document.body.appendChild(el);
    }
    return el;
  }

  socket.on('admission-mode-changed', ({ enabled }) => {
    state.admissionMode = enabled;
    const toggleEl = document.getElementById('admissionModeToggle');
    if (toggleEl) toggleEl.textContent = enabled ? 'ON' : 'OFF';
  });

  // -------------------------------------------------------- blocking / waiting screens

  function ensureOverlay() {
    let el = document.getElementById('meetingOverlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'meetingOverlay';
      el.className = 'meeting-overlay';
      document.body.appendChild(el);
    }
    return el;
  }

  function hideBlockingOverlay() {
    const el = document.getElementById('meetingOverlay');
    if (el) el.remove();
  }

  function showBlockingScreen(title, message) {
    const el = ensureOverlay();
    el.innerHTML = `
      <div class="meeting-overlay-card">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        <a href="/" class="btn btn-primary">Back to Helixa Space</a>
      </div>
    `;
  }

  function showWaitingScreen(spaceName, kind) {
    const el = ensureOverlay();
    const heading = kind === 'not-started' ? 'The host has not started this meeting yet' : 'Waiting for admission…';
    const sub = kind === 'not-started'
      ? 'Please wait for the host to start the Space.'
      : 'The host or co-host will let you in shortly.';
    el.innerHTML = `
      <div class="meeting-overlay-card">
        <h2>${escapeHtml(spaceName || 'Helixa Space')}</h2>
        <p class="waiting-heading">${escapeHtml(heading)}</p>
        <p>${escapeHtml(sub)}</p>
        <div class="waiting-spinner"></div>
      </div>
    `;
  }

  socket.on('space-state', async (data) => {
    hideBlockingOverlay();
    state.myId = data.yourId;
    state.role = data.role;
    state.admissionMode = !!data.admissionMode;
    if (data.spaceName) {
      state.spaceName = data.spaceName;
      const nameEl = document.getElementById('meetingSpaceName');
      if (nameEl) nameEl.textContent = data.spaceName;
      document.title = `${data.spaceName} — Helixa Space`;
    }
    // Persist the host token if the server just confirmed us as host —
    // covers both "we created this Space" (token already stored from the
    // create flow) and "we were promoted/transferred host mid-meeting".
    if (data.role === 'host' && data.hostToken) {
      localStorage.setItem(`hx-host-token-${spaceId}`, data.hostToken);
    }
    if (data.locked) {
      const lockedChip = document.getElementById('lockedChip');
      lockedChip.style.display = 'inline-flex';
      lockedChip.insertAdjacentHTML('beforeend', HXIcon.svg('lock', { size: 12 }));
    }
    if (data.idl) state.spaceIdl = data.idl;
    await getLocalMedia();
    renderLocalTile();

    // Call everyone already in the room (skip ourselves defensively —
    // the server already excludes us, but never assume that blindly)
    for (const [id, info] of Object.entries(data.participants)) {
      if (id === state.myId) continue;
      await callPeer(id, info.name);
      state.peers[id].mic = info.mic;
      state.peers[id].cam = info.cam;
      state.peers[id].hand_raised = info.hand_raised;
      state.peers[id].role = info.role;
    }
    updateParticipantsPanel();
  });

  socket.on('participant-joined', (info) => {
    if (info.id === state.myId) return; // guard: the server should never echo our own join to us, but never trust that blindly
    state.peers[info.id] = {
      pc: null,
      name: info.name,
      mic: info.mic,
      cam: info.cam,
      hand_raised: info.hand_raised,
      role: info.role,
    };
    // The new participant initiates the offer to us (see space-state on their side)
    if (!document.getElementById(tileId(info.id))) createTile(info.id, info.name, false);
    window.HX.toast(`${info.name} joined the Space`);
    updateParticipantsPanel();
  });

  socket.on('webrtc-offer', handleOffer);
  socket.on('webrtc-answer', handleAnswer);
  socket.on('webrtc-ice-candidate', handleIce);

  socket.on('participant-updated', (info) => {
    const entry = state.peers[info.id];
    if (entry) {
      entry.name = info.name;
      entry.mic = info.mic;
      entry.cam = info.cam;
      entry.hand_raised = info.hand_raised;
      entry.role = info.role;
      entry.screen_sharing = info.screen_sharing;
      entry.avatar = info.avatar;
    }
    updateTileMicIcon(info.id, info.mic);
    updateTileSharingBadge(info.id, info.screen_sharing);
    updateTileAvatar(info.id, info.name, info.avatar);
    const nameEl = document.querySelector(`#${tileId(info.id)} .tile-name`);
    if (nameEl) nameEl.textContent = info.name;
    updateParticipantsPanel();
  });

  socket.on('participant-left', ({ id }) => {
    const name = state.peers[id] ? state.peers[id].name : 'A participant';
    removePeer(id);
    window.HX.toast(`${name} left the Space`);
  });

  socket.on('you-are-host', () => {
    state.role = 'host';
    window.HX.toast("You're now the host");
    updateParticipantsPanel();
  });

  socket.on('role-changed', ({ role }) => {
    state.role = role;
    window.HX.toast(role === 'co-host' ? "You're now a co-host" : 'Your role has changed');
    updateParticipantsPanel();
  });

  socket.on('forced-mute', () => {
    setMic(false);
    window.HX.toast('The host muted your microphone');
  });

  socket.on('removed-from-space', () => {
    window.HX.toast('You were removed from the Space');
    setTimeout(() => (window.location.href = '/'), 1500);
  });

  socket.on('spotlight-changed', ({ targetId }) => {
    // The server always sends a real socket id, but locally our own
    // tile is keyed 'local' (see createTile/renderLocalTile) — without
    // this translation, a client spotlighting themself never matches
    // their own tile in renderLayout(), and the spotlighted person can't
    // see themself in the spotlight even though everyone else can.
    state.spotlightId = targetId === state.myId ? 'local' : targetId;
    renderLayout();
  });

  socket.on('reaction', ({ name, emoji }) => {
    spawnReaction(emoji);
  });

  socket.on('chat-message', (msg) => {
    appendChatMessage(msg, msg.from === state.myId);
    if (!state.chatOpen && msg.from !== state.myId) {
      state.chatUnread++;
      chatBadge.textContent = state.chatUnread;
      chatBadge.style.display = 'flex';
      const label = state.chatUnread === 1 ? '1 new message' : `${state.chatUnread} new messages`;
      window.HX.toast(label);
    }
  });

  // ------------------------------------------------------------- controls

  function updateControlButtonStates() {
    micBtn.classList.toggle('off', !state.micOn);
    setBtnIcon(micBtn, state.micOn ? 'mic' : 'mic-off');
    camBtn.classList.toggle('off', !state.camOn);
    setBtnIcon(camBtn, state.camOn ? 'video' : 'video-off');
    handBtn.classList.toggle('active', state.handRaised);
    shareBtn.classList.toggle('active', state.sharing);
  }

  function setMic(on) {
    state.micOn = on;
    if (state.localStream) {
      state.localStream.getAudioTracks().forEach((t) => (t.enabled = on));
    }
    socket.emit('update-media-state', { mic: on });
    updateControlButtonStates();
  }

  function setCam(on) {
    state.camOn = on;
    if (state.localStream) {
      state.localStream.getVideoTracks().forEach((t) => (t.enabled = on));
    }
    setTileStream('local', on ? state.localStream : null, true);
    socket.emit('update-media-state', { cam: on });
    updateControlButtonStates();
  }

  micBtn.addEventListener('click', () => setMic(!state.micOn));
  camBtn.addEventListener('click', () => setCam(!state.camOn));

  function toggleHand() {
    state.handRaised = !state.handRaised;
    socket.emit('raise-hand', { raised: state.handRaised });
    updateControlButtonStates();
    window.HX.toast(state.handRaised ? 'Hand raised' : 'Hand lowered');
  }
  handBtn.addEventListener('click', toggleHand);

  // -------------------------------------------------------------- more menu

  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    moreMenu.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (moreMenu.classList.contains('open') && !moreMenu.contains(e.target) && e.target !== moreBtn) {
      moreMenu.classList.remove('open');
    }
  });

  reactMenuBtn.addEventListener('click', () => {
    moreMenu.classList.remove('open');
    reactionsTray.classList.toggle('open');
  });
  shareMenuBtn.addEventListener('click', () => {
    moreMenu.classList.remove('open');
    toggleScreenShare();
  });
  handMenuBtn.addEventListener('click', () => {
    moreMenu.classList.remove('open');
    toggleHand();
  });
  fullscreenMenuBtn.addEventListener('click', () => {
    moreMenu.classList.remove('open');
    toggleFullscreen();
  });
  qrMenuBtn.addEventListener('click', () => {
    moreMenu.classList.remove('open');
    openQrModal();
  });

  reactionsTray.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-icon]');
    if (!btn) return;
    const iconName = btn.dataset.icon;
    socket.emit('send-reaction', { emoji: iconName });
    spawnReaction(iconName);
    reactionsTray.classList.remove('open');
  });

  function spawnReaction(iconName) {
    const el = document.createElement('div');
    el.className = 'reaction-float';
    el.innerHTML = HXIcon.svg(iconName, { size: 28 });
    el.style.left = 40 + Math.random() * 20 + '%';
    document.getElementById('stage').appendChild(el);
    setTimeout(() => el.remove(), 1800);
  }

  // ----------------------------------------------------------- panels

  function openPanel(panel) {
    [chatPanel, participantsPanel].forEach((p) => (p.style.display = 'none'));
    panel.style.display = 'flex';
    if (panel === chatPanel) {
      state.chatOpen = true;
      state.chatUnread = 0;
      chatBadge.style.display = 'none';
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }

  function closePanel(panel) {
    panel.style.display = 'none';
    if (panel === chatPanel) state.chatOpen = false;
  }

  chatBtn.addEventListener('click', () => {
    if (chatPanel.style.display === 'flex') closePanel(chatPanel);
    else openPanel(chatPanel);
  });

  participantsBtn.addEventListener('click', () => {
    if (participantsPanel.style.display === 'flex') closePanel(participantsPanel);
    else openPanel(participantsPanel);
  });

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closePanel(document.getElementById(btn.dataset.close)));
  });

  // ----------------------------------------------------------------- chat

  function appendChatMessage(msg, isMine) {
    const el = document.createElement('div');
    el.className = 'chat-message';
    const time = new Date(msg.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `
      <div class="chat-message-head">
        <span class="chat-sender">${escapeHtml(msg.name)}${isMine ? ' (You)' : ''}</span>
        <span class="chat-time">${time}</span>
      </div>
      <div class="chat-text"></div>
    `;
    el.querySelector('.chat-text').textContent = msg.text;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  const chatInput = document.getElementById('chatInput');
  const chatSendBtn = document.getElementById('chatSendBtn');

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit('send-chat', { text });
    chatInput.value = '';
  }
  chatSendBtn.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  // ------------------------------------------------------------ participants

  function updateParticipantsPanel() {
    const total = Object.keys(state.peers).length + 1;
    participantCount.textContent = total;
    participantsBadge.textContent = total;

    participantsList.innerHTML = '';

    // Local participant row
    participantsList.appendChild(buildParticipantRow('local', myName, state.micOn, state.camOn, state.handRaised, state.role, true, myAvatar));

    Object.entries(state.peers).forEach(([id, info]) => {
      participantsList.appendChild(buildParticipantRow(id, info.name, info.mic, info.cam, info.hand_raised, info.role || 'participant', false, info.avatar));
    });

    renderLayout(); // re-check solo-tile sizing whenever the roster changes; also refreshes the View Host button
    updateModeratorMenuItems();
  }

  function roleBadge(role) {
    if (role === 'host') return '<span class="role-badge host">HOST</span>';
    if (role === 'co-host') return '<span class="role-badge co-host">CO-HOST</span>';
    return '';
  }

  function buildParticipantRow(id, name, mic, cam, handRaised, role, isLocal, avatar) {
    const row = document.createElement('div');
    row.className = 'participant-row';
    // A host/co-host can always spotlight themself (that's a legitimate,
    // common action — "put me on the main stage while presenting").
    // Every other moderation action never applies to your own row.
    const showMenu = canModerate();
    row.innerHTML = `
      <div class="participant-info">
        <div class="participant-avatar-sm">${avatar ? `<img src="${avatar}" alt="">` : escapeHtml(initials(name))}</div>
        <span class="participant-name">${escapeHtml(name)}${isLocal ? ' (You)' : ''}</span>
        ${roleBadge(role)}
      </div>
      <div class="participant-status">
        <span class="row-icon">${HXIcon.svg(mic ? 'mic' : 'mic-off', { size: 15 })}</span>
        <span class="row-icon">${HXIcon.svg(cam ? 'video' : 'video-off', { size: 15 })}</span>
        ${handRaised ? `<span class="row-icon" style="color:var(--warn);">${HXIcon.svg('hand', { size: 15 })}</span>` : ''}
        ${showMenu ? `<button class="participant-menu-btn" data-menu="${id}">${HXIcon.svg('more-vertical', { size: 15 })}</button>` : ''}
      </div>
    `;
    if (showMenu) {
      row.querySelector('[data-menu]').addEventListener('click', (e) => {
        e.stopPropagation();
        openParticipantActionMenu(e.currentTarget, id, name, role, isLocal);
      });
    }
    return row;
  }

  // Real clickable action menu (per v0.6 spec) — replaces the old
  // prompt()-based moderation flow. Only shows actions the current
  // user's role is actually allowed to perform.
  let openActionMenuEl = null;

  function closeActionMenu() {
    if (openActionMenuEl) {
      openActionMenuEl.remove();
      openActionMenuEl = null;
    }
  }

  function openParticipantActionMenu(anchorEl, targetId, targetName, targetRole, isLocal) {
    closeActionMenu();

    const actions = [];
    // Spotlight is the one action that legitimately targets yourself.
    actions.push({
      key: 'spotlight',
      label: state.spotlightId === targetId ? 'Remove spotlight' : 'Spotlight',
      icon: 'star',
    });
    if (!isLocal) {
      actions.push({ key: 'mute', label: 'Mute', icon: 'mic-off' });
      if (isHost() && targetRole === 'participant') {
        actions.push({ key: 'make-co-host', label: 'Make co-host', icon: 'users' });
      }
      if (isHost() && targetRole === 'co-host') {
        actions.push({ key: 'revoke-co-host', label: 'Remove co-host', icon: 'users' });
      }
      if (isHost()) {
        actions.push({ key: 'remove', label: 'Remove participant', icon: 'x', danger: true });
      }
    }

    const menu = document.createElement('div');
    menu.className = 'action-menu';
    menu.innerHTML = actions
      .map((a) => `<button data-action="${a.key}" class="${a.danger ? 'danger' : ''}">${HXIcon.svg(a.icon, { size: 14 })} ${a.label}</button>`)
      .join('');

    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth - 140)}px`;
    openActionMenuEl = menu;

    // The server only knows real socket ids — never the 'local' key we
    // use internally for our own tile — so translate before every emit.
    const serverTargetId = isLocal ? state.myId : targetId;

    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'spotlight') {
        const clearing = state.spotlightId === targetId;
        socket.emit('spotlight-participant', { targetId: clearing ? null : serverTargetId });
      } else if (action === 'mute') {
        socket.emit('host-mute-participant', { targetId });
      } else if (action === 'make-co-host') {
        socket.emit('make-co-host', { targetId });
      } else if (action === 'revoke-co-host') {
        socket.emit('revoke-co-host', { targetId });
      } else if (action === 'remove') {
        if (window.confirm(`Remove ${targetName} from the Space?`)) {
          socket.emit('host-remove-participant', { targetId });
        }
      }
      closeActionMenu();
    });
  }

  document.addEventListener('click', (e) => {
    if (openActionMenuEl && !openActionMenuEl.contains(e.target) && !e.target.closest('[data-menu]')) {
      closeActionMenu();
    }
  });

  // ------------------------------------------------------------- screen share

  async function startScreenShare() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      window.HX.toast('Screen sharing is not supported in this browser.');
      Diag.log('warn', 'getDisplayMedia unavailable — unsupported browser/device');
      return;
    }
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      state.screenStream = screenStream;
      const screenTrack = screenStream.getVideoTracks()[0];

      Object.values(state.peers).forEach(({ pc }) => {
        if (!pc) return;
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(screenTrack);
      });

      setTileStream('local', screenStream, true);
      state.sharing = true;
      sharingBanner.style.display = 'flex';
      updateTileSharingBadge('local', true);
      socket.emit('screen-share-state', { sharing: true });
      updateControlButtonStates();

      screenTrack.onended = () => stopScreenShare();
    } catch (err) {
      // NotAllowedError covers both "user clicked cancel" and "OS/browser
      // denied permission" — the spec wants cancellation silent but real
      // failures visible, and the DOMException gives no way to tell them
      // apart, so we log to diagnostics either way and only toast for
      // errors that are clearly not a simple cancel.
      Diag.log('info', `Screen share not started: ${err.name || err.message}`);
      if (err.name !== 'NotAllowedError') {
        window.HX.toast('Could not start screen sharing.');
      }
    }
  }

  function stopScreenShare() {
    if (state.screenStream) {
      state.screenStream.getTracks().forEach((t) => t.stop());
      state.screenStream = null;
    }
    const camTrack = state.localStream && state.localStream.getVideoTracks()[0];
    Object.values(state.peers).forEach(({ pc }) => {
      if (!pc || !camTrack) return;
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(camTrack);
    });
    setTileStream('local', state.camOn ? state.localStream : null, true);
    state.sharing = false;
    sharingBanner.style.display = 'none';
    updateTileSharingBadge('local', false);
    socket.emit('screen-share-state', { sharing: false });
    updateControlButtonStates();
  }

  function toggleScreenShare() {
    if (state.sharing) stopScreenShare();
    else startScreenShare();
  }
  shareBtn.addEventListener('click', toggleScreenShare);
  stopShareBtn.addEventListener('click', stopScreenShare);

  // -------------------------------------------------------------- fullscreen

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      shell.requestFullscreen().catch(() => window.HX.toast('Fullscreen not available'));
    } else {
      document.exitFullscreen();
    }
  }

  // ------------------------------------------------------------------ clock

  function tickClock() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    document.getElementById('hxClock').textContent = `${h}:${m}`;
  }
  tickClock();
  setInterval(tickClock, 15000);

  // -------------------------------------------------------------------- ads

  // Architecture note: this list is a stand-in for a backend-managed
  // playlist (see build prompt §28). Swap AD_PLAYLIST for a fetch to
  // /api/ads once that endpoint exists — the sequential-play logic
  // below doesn't need to change.
  const AD_PLAYLIST = []; // no ad creative available yet — box hides itself
  let adIndex = 0;
  const adVideo = document.getElementById('adVideo');
  const adBox = document.getElementById('adBox');

  function playNextAd() {
    if (!AD_PLAYLIST.length) {
      adBox.style.display = 'none';
      return;
    }
    adVideo.src = AD_PLAYLIST[adIndex % AD_PLAYLIST.length];
    adIndex++;
    adVideo.play().catch(() => {});
  }
  adVideo.addEventListener('ended', playNextAd);
  if (AD_PLAYLIST.length) playNextAd();
  else adBox.style.display = 'none';

  // --------------------------------------------------------------------- QR

  const qrBtn = document.getElementById('qrBtn');
  const qrBackdrop = document.getElementById('qrModalBackdrop');
  const qrCloseBtn = document.getElementById('qrCloseBtn');
  const qrCanvasWrap = document.getElementById('qrCanvasWrap');
  const qrJoinUrl = document.getElementById('qrJoinUrl');

  function openQrModal() {
    const joinUrl = `${window.location.origin}/meeting/${spaceId}`;
    qrJoinUrl.textContent = joinUrl;
    qrCanvasWrap.innerHTML = '';

    // Server-generated PNG — no external CDN script to fail/load-race.
    // Cache-bust with a timestamp so a stale image never sticks around
    // if the Space's details change (e.g. after End Meeting → recreate).
    const img = document.createElement('img');
    img.alt = 'QR code to join this Space';
    img.style.width = '220px';
    img.style.height = '220px';
    img.style.display = 'block';
    img.onerror = () => {
      qrCanvasWrap.textContent = 'Could not generate QR code — share the link above instead.';
    };
    img.src = `/api/spaces/${encodeURIComponent(spaceId)}/qr?t=${Date.now()}`;
    qrCanvasWrap.appendChild(img);

    qrBackdrop.classList.add('open');
  }

  qrBtn.addEventListener('click', openQrModal);
  qrCloseBtn.addEventListener('click', () => qrBackdrop.classList.remove('open'));
  qrBackdrop.addEventListener('click', (e) => {
    if (e.target === qrBackdrop) qrBackdrop.classList.remove('open');
  });

  // -------------------------------------------------- admin admission / end meeting

  const admissionModeBtn = document.getElementById('admissionModeBtn');
  const endMeetingMenuBtn = document.getElementById('endMeetingMenuBtn');
  const endMeetingBackdrop = document.getElementById('endMeetingModalBackdrop');
  const endMeetingCancelBtn = document.getElementById('endMeetingCancelBtn');
  const endMeetingConfirmBtn = document.getElementById('endMeetingConfirmBtn');
  const muteEveryoneBtn = document.getElementById('muteEveryoneBtn');
  const requestCoHostBtn = document.getElementById('requestCoHostBtn');
  const blockedListBtn = document.getElementById('blockedListBtn');

  function updateModeratorMenuItems() {
    admissionModeBtn.style.display = canModerate() ? 'flex' : 'none';
    endMeetingMenuBtn.style.display = isHost() ? 'flex' : 'none';
    muteEveryoneBtn.style.display = canModerate() ? 'flex' : 'none';
    blockedListBtn.style.display = canModerate() ? 'flex' : 'none';
    requestCoHostBtn.style.display = state.role === 'participant' ? 'flex' : 'none';
  }

  admissionModeBtn.addEventListener('click', () => {
    moreMenu.classList.remove('open');
    socket.emit('set-admission-mode', { enabled: !state.admissionMode });
  });

  muteEveryoneBtn.addEventListener('click', () => {
    moreMenu.classList.remove('open');
    if (window.confirm('Mute everyone in this Space?')) {
      socket.emit('mute-everyone', {});
    }
  });

  requestCoHostBtn.addEventListener('click', () => {
    moreMenu.classList.remove('open');
    socket.emit('request-co-host', {});
    window.HX.toast('Co-host request sent');
  });

  socket.on('co-host-requested', ({ sid, name }) => {
    const stack = ensureAdmissionStack();
    const el = document.createElement('div');
    el.className = 'admission-toast';
    el.innerHTML = `
      <div class="admission-toast-title">Co-host Request</div>
      <div class="admission-toast-name">${escapeHtml(name)} wants to become a co-host.</div>
      <div class="admission-toast-actions">
        <button class="dismiss-btn">Reject</button>
        <button class="admit-btn">Accept</button>
      </div>
    `;
    el.querySelector('.dismiss-btn').addEventListener('click', () => {
      socket.emit('respond-co-host-request', { targetId: sid, approve: false });
      el.remove();
    });
    el.querySelector('.admit-btn').addEventListener('click', () => {
      socket.emit('respond-co-host-request', { targetId: sid, approve: true });
      el.remove();
    });
    stack.appendChild(el);
  });

  socket.on('co-host-request-declined', () => {
    window.HX.toast('Your co-host request was declined');
  });

  socket.on('unmute-requested', ({ byName }) => {
    const wantsTo = window.confirm(`${byName} asked you to unmute. Unmute now?`);
    if (wantsTo) setMic(true);
  });

  socket.on('blocked-retry-notice', ({ name }) => {
    window.HX.toast(`A removed participant (${name}) is attempting to rejoin`);
  });

  // Blocked-list management modal
  const blockedBackdrop = document.getElementById('blockedModalBackdrop');
  const blockedCloseBtn = document.getElementById('blockedCloseBtn');
  const blockedListBody = document.getElementById('blockedListBody');

  blockedListBtn.addEventListener('click', () => {
    moreMenu.classList.remove('open');
    socket.emit('get-blocked-list', {});
    blockedBackdrop.classList.add('open');
  });
  blockedCloseBtn.addEventListener('click', () => blockedBackdrop.classList.remove('open'));
  blockedBackdrop.addEventListener('click', (e) => {
    if (e.target === blockedBackdrop) blockedBackdrop.classList.remove('open');
  });

  socket.on('blocked-list-updated', ({ blocked }) => {
    if (!blocked.length) {
      blockedListBody.innerHTML = '<p style="font-size:13px; color:var(--text-2);">No one is currently blocked.</p>';
      return;
    }
    blockedListBody.innerHTML = blocked
      .map((b) => `
        <div class="blocked-row">
          <span>${escapeHtml(b.name)}</span>
          <button class="btn btn-ghost btn-sm" data-allow-token="${b.participantToken}">Allow rejoin</button>
        </div>
      `)
      .join('');
    blockedListBody.querySelectorAll('[data-allow-token]').forEach((btn) => {
      btn.addEventListener('click', () => {
        socket.emit('allow-rejoin', { participantToken: btn.dataset.allowToken });
      });
    });
  });

  endMeetingMenuBtn.addEventListener('click', () => {
    moreMenu.classList.remove('open');
    endMeetingBackdrop.classList.add('open');
  });
  endMeetingCancelBtn.addEventListener('click', () => endMeetingBackdrop.classList.remove('open'));
  endMeetingBackdrop.addEventListener('click', (e) => {
    if (e.target === endMeetingBackdrop) endMeetingBackdrop.classList.remove('open');
  });
  endMeetingConfirmBtn.addEventListener('click', () => {
    socket.emit('end-meeting', {});
    endMeetingBackdrop.classList.remove('open');
  });

  // -------------------------------------------------------------- settings

  const settingsBackdrop = document.getElementById('settingsModalBackdrop');
  const settingsCloseBtn = document.getElementById('settingsCloseBtn');
  const settingsMenuBtn = document.getElementById('settingsMenuBtn');

  document.querySelectorAll('.settings-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.settings-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.querySelector(`.settings-panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
    });
  });

  async function openSettings() {
    document.getElementById('settingsDisplayName').value = myName;
    const preview = document.getElementById('avatarPreview');
    preview.innerHTML = myAvatar ? `<img src="${myAvatar}" alt="">` : escapeHtml(initials(myName));
    settingsBackdrop.classList.add('open');
    await populateDeviceLists();
    startSettingsCamPreview();
  }
  function closeSettings() {
    settingsBackdrop.classList.remove('open');
    stopSettingsCamPreview();
    stopAudioLevelMeter();
  }

  settingsMenuBtn.addEventListener('click', () => {
    moreMenu.classList.remove('open');
    openSettings();
  });
  settingsCloseBtn.addEventListener('click', closeSettings);
  settingsBackdrop.addEventListener('click', (e) => {
    if (e.target === settingsBackdrop) closeSettings();
  });

  // Identity — rename + avatar
  const avatarFileInput = document.getElementById('avatarFileInput');
  const avatarClearBtn = document.getElementById('avatarClearBtn');
  let pendingAvatarDataUrl = undefined; // undefined = no change queued this session

  avatarFileInput.addEventListener('change', () => {
    const file = avatarFileInput.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      window.HX.toast('Please choose an image file.');
      return;
    }
    if (file.size > 300_000) {
      window.HX.toast('Image is too large — please choose one under 300KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      pendingAvatarDataUrl = reader.result;
      document.getElementById('avatarPreview').innerHTML = `<img src="${reader.result}" alt="">`;
    };
    reader.readAsDataURL(file);
  });

  avatarClearBtn.addEventListener('click', () => {
    pendingAvatarDataUrl = null;
    document.getElementById('avatarPreview').innerHTML = escapeHtml(initials(myName));
  });

  document.getElementById('settingsSaveIdentityBtn').addEventListener('click', () => {
    const newName = document.getElementById('settingsDisplayName').value.trim();
    if (newName && newName !== myName) {
      myName = newName;
      socket.emit('rename-self', { name: newName });
      const localNameEl = document.querySelector(`#${tileId('local')} .tile-name`);
      if (localNameEl) localNameEl.textContent = `${newName} (You)`;
      updateParticipantsPanel();
    }
    if (pendingAvatarDataUrl !== undefined) {
      myAvatar = pendingAvatarDataUrl;
      socket.emit('update-avatar', { avatar: myAvatar });
      updateTileAvatar('local', myName, myAvatar);
      pendingAvatarDataUrl = undefined;
      updateParticipantsPanel();
    }
    window.HX.toast('Settings saved');
    closeSettings();
  });

  socket.on('avatar-rejected', ({ reason }) => {
    window.HX.toast(reason === 'too-large' ? 'Avatar image was too large.' : 'That avatar image could not be used.');
  });

  // Audio/video device selection
  async function populateDeviceLists() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const micSelect = document.getElementById('micSelect');
      const speakerSelect = document.getElementById('speakerSelect');
      const camSelect = document.getElementById('camSelect');
      micSelect.innerHTML = '';
      speakerSelect.innerHTML = '';
      camSelect.innerHTML = '';

      devices.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `${d.kind} (${d.deviceId.slice(0, 6)})`;
        if (d.kind === 'audioinput') micSelect.appendChild(opt);
        if (d.kind === 'audiooutput') speakerSelect.appendChild(opt.cloneNode(true));
        if (d.kind === 'videoinput') camSelect.appendChild(opt.cloneNode(true));
      });

      if (!speakerSelect.options.length) {
        const opt = document.createElement('option');
        opt.textContent = 'Output selection not supported in this browser';
        speakerSelect.appendChild(opt);
        speakerSelect.disabled = true;
      }
    } catch (err) {
      Diag.log('warn', `enumerateDevices failed: ${err.message}`);
    }
  }

  document.getElementById('micSelect').addEventListener('change', async (e) => {
    await switchAudioDevice(e.target.value);
  });
  document.getElementById('camSelect').addEventListener('change', async (e) => {
    await switchVideoDevice(e.target.value);
  });

  async function switchAudioDevice(deviceId) {
    if (!state.localStream) return;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
      const newTrack = newStream.getAudioTracks()[0];
      const oldTrack = state.localStream.getAudioTracks()[0];
      if (oldTrack) {
        state.localStream.removeTrack(oldTrack);
        oldTrack.stop();
      }
      state.localStream.addTrack(newTrack);
      newTrack.enabled = state.micOn;
      Object.values(state.peers).forEach(({ pc }) => {
        if (!pc) return;
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
        if (sender) sender.replaceTrack(newTrack);
      });
      startAudioLevelMeter();
      window.HX.toast('Microphone switched');
    } catch (err) {
      window.HX.toast('Could not switch microphone.');
      Diag.log('error', `switchAudioDevice failed: ${err.message}`);
    }
  }

  async function switchVideoDevice(deviceId) {
    if (!state.localStream) return;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      const newTrack = newStream.getVideoTracks()[0];
      const oldTrack = state.localStream.getVideoTracks()[0];
      if (oldTrack) {
        state.localStream.removeTrack(oldTrack);
        oldTrack.stop();
      }
      state.localStream.addTrack(newTrack);
      newTrack.enabled = state.camOn;
      Object.values(state.peers).forEach(({ pc }) => {
        if (!pc) return;
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(newTrack);
      });
      setTileStream('local', state.localStream, true);
      startSettingsCamPreview();
      window.HX.toast('Camera switched');
    } catch (err) {
      window.HX.toast('Could not switch camera.');
      Diag.log('error', `switchVideoDevice failed: ${err.message}`);
    }
  }

  function startSettingsCamPreview() {
    const previewEl = document.getElementById('settingsCamPreview');
    if (state.localStream && state.camOn) previewEl.srcObject = state.localStream;
  }
  function stopSettingsCamPreview() {
    document.getElementById('settingsCamPreview').srcObject = null;
  }

  // Microphone sensitivity + input level meter + audio test.
  // True hardware gain control isn't exposed by getUserMedia — what we
  // can do reliably is a software-level threshold/gain applied via the
  // Web Audio API, plus a real input-level readout so the sensitivity
  // slider has an honest, visible effect instead of pretending to change
  // hardware that JS can't actually touch.
  let audioCtx = null;
  let analyser = null;
  let levelMeterRAF = null;
  let sensitivityGain = 0.6;

  document.getElementById('micSensitivity').addEventListener('input', (e) => {
    sensitivityGain = Number(e.target.value) / 100;
  });

  function startAudioLevelMeter() {
    stopAudioLevelMeter();
    if (!state.localStream || !state.localStream.getAudioTracks().length) return;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(state.localStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const fill = document.getElementById('levelMeterFill');

      function tick() {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        const level = Math.min(100, (avg / 255) * 100 * (0.5 + sensitivityGain));
        if (fill) fill.style.width = `${level}%`;
        levelMeterRAF = requestAnimationFrame(tick);
      }
      tick();
    } catch (err) {
      Diag.log('warn', `Audio level meter unavailable: ${err.message}`);
    }
  }

  function stopAudioLevelMeter() {
    if (levelMeterRAF) cancelAnimationFrame(levelMeterRAF);
    levelMeterRAF = null;
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
  }

  document.getElementById('audioTestBtn').addEventListener('click', () => {
    if (!state.localStream || !state.localStream.getAudioTracks().length) {
      window.HX.toast('No microphone is active to test.');
      return;
    }
    window.HX.toast('Speak now — watch the input level bar move.');
    startAudioLevelMeter();
  });

  // Appearance — theme (reuses the existing global toggle, kept in sync)
  document.getElementById('settingsThemeDark').addEventListener('click', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('hx-theme', 'dark');
    const toggleBtn = document.getElementById('themeToggle');
    if (window.HXIcon && toggleBtn) toggleBtn.innerHTML = HXIcon.svg('moon', { size: 17 });
  });
  document.getElementById('settingsThemeLight').addEventListener('click', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('hx-theme', 'light');
    const toggleBtn = document.getElementById('themeToggle');
    if (window.HXIcon && toggleBtn) toggleBtn.innerHTML = HXIcon.svg('sun', { size: 17 });
  });

  // ------------------------------------------------------------------ leave

  leaveBtn.addEventListener('click', () => {
    Object.values(state.peers).forEach(({ pc }) => pc && pc.close());
    if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
    if (state.screenStream) state.screenStream.getTracks().forEach((t) => t.stop());
    socket.disconnect();
    window.location.href = '/';
  });

  window.addEventListener('beforeunload', () => {
    if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
  });
})();

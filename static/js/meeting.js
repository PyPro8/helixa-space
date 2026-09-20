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
  const myName =
    (pendingSpace && pendingSpace.spaceId === spaceId && pendingSpace.name) ||
    (pendingJoin && pendingJoin.name) ||
    'Guest';
  const myPassword =
    (pendingSpace && pendingSpace.spaceId === spaceId && pendingSpace.password) ||
    (pendingJoin && pendingJoin.password) ||
    '';

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

  socket.on('connect', () => {
    socket.emit('join-space', { spaceId, name: myName, password: myPassword });
  });

  socket.on('join-rejected', ({ reason }) => {
    if (reason === 'wrong-password') {
      const entered = window.prompt('This Space is password-protected. Enter the password:');
      if (entered !== null) {
        socket.emit('join-space', { spaceId, name: myName, password: entered });
      } else {
        window.HX.toast('You need the Space password to join');
        setTimeout(() => (window.location.href = '/'), 1500);
      }
    }
  });

  socket.on('space-state', async (data) => {
    state.myId = data.yourId;
    state.role = data.role;
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
      entry.mic = info.mic;
      entry.cam = info.cam;
      entry.hand_raised = info.hand_raised;
      entry.role = info.role;
      entry.screen_sharing = info.screen_sharing;
    }
    updateTileMicIcon(info.id, info.mic);
    updateTileSharingBadge(info.id, info.screen_sharing);
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
    state.spotlightId = targetId;
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
    participantsList.appendChild(buildParticipantRow('local', myName, state.micOn, state.camOn, state.handRaised, state.role, true));

    Object.entries(state.peers).forEach(([id, info]) => {
      participantsList.appendChild(buildParticipantRow(id, info.name, info.mic, info.cam, info.hand_raised, info.role || 'participant', false));
    });

    renderViewHostButton();
  }

  function roleBadge(role) {
    if (role === 'host') return '<span class="role-badge host">HOST</span>';
    if (role === 'co-host') return '<span class="role-badge co-host">CO-HOST</span>';
    return '';
  }

  function buildParticipantRow(id, name, mic, cam, handRaised, role, isLocal) {
    const row = document.createElement('div');
    row.className = 'participant-row';
    const showMenu = canModerate() && !isLocal;
    row.innerHTML = `
      <div class="participant-info">
        <div class="participant-avatar-sm">${initials(name)}</div>
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
        openParticipantActionMenu(e.currentTarget, id, name, role);
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

  function openParticipantActionMenu(anchorEl, targetId, targetName, targetRole) {
    closeActionMenu();

    const actions = [];
    actions.push({
      key: 'spotlight',
      label: state.spotlightId === targetId ? 'Remove spotlight' : 'Spotlight',
      icon: 'star',
    });
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

    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'spotlight') {
        const newTarget = state.spotlightId === targetId ? null : targetId;
        socket.emit('spotlight-participant', { targetId: newTarget });
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
    if (window.QRCode) {
      QRCode.toCanvas(joinUrl, { width: 220, margin: 1 }, (err, canvas) => {
        if (!err) qrCanvasWrap.appendChild(canvas);
        else qrCanvasWrap.textContent = 'Could not generate QR code.';
      });
    } else {
      qrCanvasWrap.textContent = 'QR library failed to load — share the link above instead.';
    }
    qrBackdrop.classList.add('open');
  }

  qrBtn.addEventListener('click', openQrModal);
  qrCloseBtn.addEventListener('click', () => qrBackdrop.classList.remove('open'));
  qrBackdrop.addEventListener('click', (e) => {
    if (e.target === qrBackdrop) qrBackdrop.classList.remove('open');
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

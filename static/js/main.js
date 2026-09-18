// ==========================================================================
// HELIXA SPACE — main.js
// Shared logic for landing, create, and join pages.
// ==========================================================================

const HX = {};

/* ----------------------------- Theme toggle ----------------------------- */

HX.initTheme = function () {
  const root = document.documentElement;
  const toggle = document.getElementById('themeToggle');
  const saved = localStorage.getItem('hx-theme') || 'dark';
  root.setAttribute('data-theme', saved);

  function paintToggle(theme) {
    if (!toggle) return;
    if (window.HXIcon) {
      toggle.innerHTML = HXIcon.svg(theme === 'dark' ? 'moon' : 'sun', { size: 17 });
    } else {
      toggle.textContent = theme === 'dark' ? '🌙' : '☀️';
    }
  }
  paintToggle(saved);

  if (toggle) {
    toggle.addEventListener('click', () => {
      const current = root.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      localStorage.setItem('hx-theme', next);
      paintToggle(next);
    });
  }
};

/* ------------------------------- Toasts ---------------------------------- */

HX.toast = function (message, duration = 2600) {
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), duration);
};

/* --------------------------- Hero typing effect --------------------------- */

HX.initTypingHero = function () {
  const target = document.getElementById('typedWord');
  if (!target) return;

  const words = ['Anywhere', 'Online', 'Offline', 'In Class'];
  let wordIndex = 0;
  let charIndex = words[0].length;
  let deleting = false;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  function tick() {
    const word = words[wordIndex];
    if (!deleting) {
      charIndex++;
      if (charIndex > word.length) {
        deleting = true;
        setTimeout(tick, 1400);
        return;
      }
    } else {
      charIndex--;
      if (charIndex < 1) {
        deleting = false;
        wordIndex = (wordIndex + 1) % words.length;
      }
    }
    target.textContent = words[wordIndex].slice(0, charIndex);
    setTimeout(tick, deleting ? 45 : 85);
  }

  setTimeout(tick, 1800);
};

/* -------------------------- Camera/mic preview --------------------------- */

HX.initDevicePreview = function () {
  const video = document.getElementById('previewVideo');
  const placeholder = document.getElementById('previewPlaceholder');
  const initial = document.getElementById('previewInitial');
  const micBtn = document.getElementById('micToggle');
  const camBtn = document.getElementById('camToggle');
  const nameInput = document.getElementById('displayName') || document.getElementById('displayNameJoin');

  if (!video) return;

  let stream = null;
  let micOn = true;
  let camOn = false;

  function paintPreviewIcon(btn, name) {
    if (!window.HXIcon) return;
    const existing = btn.querySelector('svg');
    if (existing) existing.remove();
    btn.insertAdjacentHTML('afterbegin', HXIcon.svg(name, { size: 18 }));
  }

  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      video.srcObject = stream;
      video.style.display = 'block';
      placeholder.style.display = 'none';
      camOn = true;
      camBtn.classList.remove('off');
      paintPreviewIcon(camBtn, 'video');
      applyMicState();
    } catch (err) {
      let msg = 'Camera access was denied or unavailable.';
      if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        msg = 'Camera/mic blocked: open this page over HTTPS (or localhost) on this device.';
      } else if (err.name === 'NotFoundError') {
        msg = 'No camera or microphone was found on this device.';
      }
      HX.toast(msg);
      camOn = false;
      camBtn.classList.add('off');
      paintPreviewIcon(camBtn, 'video-off');
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.style.display = 'none';
    placeholder.style.display = 'flex';
    camOn = false;
    camBtn.classList.add('off');
    paintPreviewIcon(camBtn, 'video-off');
  }

  function applyMicState() {
    if (stream) {
      stream.getAudioTracks().forEach((t) => (t.enabled = micOn));
    }
  }

  camBtn.addEventListener('click', () => {
    if (camOn) stopCamera();
    else startCamera();
  });

  micBtn.addEventListener('click', () => {
    micOn = !micOn;
    micBtn.classList.toggle('off', !micOn);
    paintPreviewIcon(micBtn, micOn ? 'mic' : 'mic-off');
    applyMicState();
  });

  if (nameInput) {
    nameInput.addEventListener('input', () => {
      const val = nameInput.value.trim();
      initial.textContent = val ? val[0].toUpperCase() : '?';
    });
  }

  // expose current state for form submit handlers
  HX.getDeviceState = () => ({ micOn, camOn });
};

/* ------------------------------ Create form ------------------------------ */

HX.initCreateForm = function () {
  const form = document.getElementById('createForm');
  if (!form) return;

  const modeOnline = document.getElementById('modeOnline');
  const modeLan = document.getElementById('modeLan');
  const spaceIdField = document.getElementById('spaceIdField');
  const spaceIdValue = document.getElementById('spaceIdValue');
  const copyBtn = document.getElementById('copyIdBtn');
  const submitBtn = form.querySelector('button[type="submit"]');
  const idlInput = document.getElementById('spaceIdl');
  const suggestIdlBtn = document.getElementById('suggestIdlBtn');

  let mode = 'online';

  function selectMode(target) {
    mode = target;
    modeOnline.classList.toggle('active', target === 'online');
    modeLan.classList.toggle('active', target === 'lan');
  }

  modeOnline.addEventListener('click', () => selectMode('online'));
  modeLan.addEventListener('click', () => selectMode('lan'));

  copyBtn.addEventListener('click', () => {
    if (spaceIdValue.textContent === '—') return;
    navigator.clipboard.writeText(spaceIdValue.textContent).then(() => HX.toast('Space ID copied'));
  });

  suggestIdlBtn.addEventListener('click', async () => {
    suggestIdlBtn.disabled = true;
    const originalText = suggestIdlBtn.textContent;
    suggestIdlBtn.textContent = '…';
    try {
      const res = await fetch('/api/spaces/suggest-idl');
      if (!res.ok) throw new Error('Server error');
      const data = await res.json();
      idlInput.value = data.idl;
    } catch (err) {
      HX.toast('Could not reach the server — is app.py running?');
    } finally {
      suggestIdlBtn.disabled = false;
      suggestIdlBtn.textContent = originalText;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('displayName').value.trim();
    if (!name) return;

    const spaceName = document.getElementById('spaceName').value.trim();
    const password = document.getElementById('spacePassword').value;
    const idl = idlInput.value.trim().toUpperCase();

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating…';

    let spaceId, resolvedIdl;
    try {
      const res = await fetch('/api/spaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spaceName, password, idl }),
      });
      if (!res.ok) throw new Error('Server error');
      const data = await res.json();
      spaceId = data.spaceId;
      resolvedIdl = data.idl;
      if (idl && !resolvedIdl) {
        HX.toast(`"${idl}" was already taken — Space created without a Space IDL`);
      }
    } catch (err) {
      HX.toast('Could not reach the server — is app.py running?');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Start Space';
      return;
    }

    spaceIdValue.textContent = spaceId;
    spaceIdField.style.display = 'flex';

    if (mode === 'lan') {
      HX.toast('LAN Space mode arrives in v0.8 — starting as an online Space for now');
    }

    sessionStorage.setItem('hx-pending-space', JSON.stringify({
      spaceId,
      name,
      mode,
      spaceName,
      password,
    }));

    window.location.href = `/meeting/${spaceId}`;
  });
};

/* ------------------------------- Join form -------------------------------- */

HX.initJoinForm = function () {
  const form = document.getElementById('joinForm');
  if (!form) return;

  const methodId = document.getElementById('methodId');
  const methodIdl = document.getElementById('methodIdl');
  const joinWithId = document.getElementById('joinWithId');
  const joinWithIdl = document.getElementById('joinWithIdl');
  const submitBtn = form.querySelector('button[type="submit"]');

  let method = 'id';

  function selectMethod(target) {
    method = target;
    methodId.classList.toggle('active', target === 'id');
    methodIdl.classList.toggle('active', target === 'idl');
    joinWithId.style.display = target === 'id' ? 'block' : 'none';
    joinWithIdl.style.display = target === 'idl' ? 'block' : 'none';
  }
  methodId.addEventListener('click', () => selectMethod('id'));
  methodIdl.addEventListener('click', () => selectMethod('idl'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('displayNameJoin').value.trim();
    if (!name) return;

    if (method === 'id') {
      const idOrLink = document.getElementById('spaceIdInput').value.trim();
      const password = document.getElementById('joinPassword').value;
      if (!idOrLink) return;

      // Accept either a bare Space ID or a full join link.
      let spaceId = idOrLink;
      try {
        if (idOrLink.startsWith('http')) {
          const url = new URL(idOrLink);
          spaceId = url.pathname.split('/').pop();
        }
      } catch (err) {
        /* not a URL — treat as a raw Space ID */
      }

      sessionStorage.setItem('hx-pending-join', JSON.stringify({ idOrLink, name, password }));
      window.location.href = `/meeting/${spaceId}`;
      return;
    }

    // Space IDL — quick, passwordless join. Resolve the IDL to a real
    // Space ID via the backend before navigating anywhere.
    const idl = document.getElementById('spaceIdlInput').value.trim().toUpperCase();
    if (!idl) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Joining…';
    try {
      const res = await fetch(`/api/spaces/resolve-idl/${encodeURIComponent(idl)}`);
      if (!res.ok) throw new Error('not-found');
      const data = await res.json();
      sessionStorage.setItem('hx-pending-join', JSON.stringify({ idOrLink: data.spaceId, name, password: '' }));
      window.location.href = `/meeting/${data.spaceId}`;
    } catch (err) {
      HX.toast('That Space IDL was not found or is no longer active.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Join Space';
    }
  });
};

/* ------------------------------- Icon paint ------------------------------- */

HX.paintIcons = function () {
  if (!window.HXIcon) return;
  document.querySelectorAll('[data-icon]:not(.theme-toggle)').forEach((el) => {
    if (el.querySelector('svg')) return; // already painted
    el.insertAdjacentHTML('afterbegin', HXIcon.svg(el.dataset.icon, { size: el.classList.contains('feature-icon') ? 20 : 18 }));
  });
};

/* --------------------------------- Boot ----------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  HX.initTheme();
  HX.paintIcons();
  HX.initTypingHero();
  HX.initDevicePreview();
  HX.initCreateForm();
  HX.initJoinForm();
});

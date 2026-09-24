// ==========================================================================
// HELIXA SPACE — space-details.js
// Populates the Space Details screen after creation. Pure display/utility
// page: no Socket.IO connection happens here, nothing about the Space's
// live state changes until the host actually proceeds into the meeting.
// ==========================================================================

(function () {
  const card = document.getElementById('detailsCard');
  const spaceId = card.dataset.spaceId;

  const pending = JSON.parse(sessionStorage.getItem('hx-pending-space') || 'null');

  // If someone lands here directly (refresh, bookmarked link) without the
  // in-memory create-flow data, we can still show the Space ID and QR —
  // just not the password/co-host key, which only ever existed in this
  // browser's session storage for security (the server never re-serves
  // a plaintext password once it's set).
  const spaceName = (pending && pending.spaceName) || '';
  const password = pending ? pending.password : null;
  const idl = pending ? pending.idl : null;
  const coHostKey = pending ? pending.coHostKey : null;

  document.getElementById('detailsSpaceName').textContent = spaceName || 'Helixa Space';
  document.title = `${spaceName || 'Helixa Space'} — Space Details`;

  if (password) {
    document.getElementById('detailPasswordRow').style.display = 'block';
    document.getElementById('detailPasswordValue').dataset.raw = password;
  }
  if (idl) {
    document.getElementById('detailIdlRow').style.display = 'block';
    document.getElementById('detailIdlValue').textContent = idl;
  }
  if (coHostKey) {
    document.getElementById('detailCoHostRow').style.display = 'block';
    document.getElementById('detailCoHostValue').dataset.raw = coHostKey;
  }

  document.getElementById('detailsQrImg').src = `/api/spaces/${encodeURIComponent(spaceId)}/qr?t=${Date.now()}`;

  // Automatic meeting link generation — built from the current origin so
  // it's always correct wherever this instance is actually running
  // (localhost while developing, the real deployed domain once live),
  // never a hardcoded address.
  const meetingLink = `${window.location.origin}/meeting/${encodeURIComponent(spaceId)}`;
  const linkValueEl = document.getElementById('detailLinkValue');
  linkValueEl.textContent = meetingLink;
  linkValueEl.dataset.raw = meetingLink;

  // Show/hide toggles for password and co-host key
  function wireReveal(btnId, valueId, placeholder) {
    const btn = document.getElementById(btnId);
    const valueEl = document.getElementById(valueId);
    if (!btn || !valueEl) return;
    btn.addEventListener('click', () => {
      const revealed = valueEl.dataset.revealed === 'true';
      if (revealed) {
        valueEl.textContent = placeholder;
        valueEl.dataset.revealed = 'false';
        btn.textContent = 'Show';
      } else {
        valueEl.textContent = valueEl.dataset.raw || placeholder;
        valueEl.dataset.revealed = 'true';
        btn.textContent = 'Hide';
      }
    });
  }
  wireReveal('togglePasswordBtn', 'detailPasswordValue', '••••••••');
  wireReveal('toggleCoHostBtn', 'detailCoHostValue', '••••••••••••');

  // Copy buttons — copy the raw value even while masked, never the dots.
  document.querySelectorAll('[data-copy-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetEl = document.getElementById(btn.dataset.copyTarget);
      const text = btn.dataset.copyRaw === 'true' ? (targetEl.dataset.raw || '') : targetEl.textContent;
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => HX.toast('Copied'));
    });
  });

  document.getElementById('proceedBtn').addEventListener('click', () => {
    window.location.href = `/meeting/${spaceId}`;
  });

  document.getElementById('shareDetailsBtn').addEventListener('click', async () => {
    // Never include the password or co-host key in a share payload —
    // those are meant to be given deliberately, not blasted through
    // whatever share target the OS picker offers.
    const shareText = [
      spaceName ? `Join "${spaceName}" on Helixa Space` : 'Join this Space on Helixa Space',
      `Space ID: ${spaceId}`,
      meetingLink,
    ].join('\n');

    if (navigator.share) {
      try {
        await navigator.share({ title: spaceName || 'Helixa Space', text: shareText, url: meetingLink });
      } catch (err) {
        // AbortError just means the user closed the share sheet — not a failure worth surfacing.
        if (err.name !== 'AbortError') HX.toast('Could not open the share sheet.');
      }
    } else {
      navigator.clipboard.writeText(shareText).then(() => HX.toast('Space details copied — paste to share'));
    }
  });
})();

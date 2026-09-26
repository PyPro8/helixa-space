// ==========================================================================
// HELIXA SPACE — whiteboard.js
// Operation-based collaborative whiteboard. Every committed stroke/shape/
// text box is one object, synced individually via Socket.IO — never a
// full-canvas screenshot. Exposes window.HXWhiteboard.init(socket) which
// meeting.js calls once the socket + role are known.
// ==========================================================================

const HXWhiteboard = (function () {
  let socket = null;
  let canvas, ctx, laserCanvas, laserCtx;
  let container, toolbar, toolbarToggle;
  let objects = [];       // committed objects, mirrors server state
  let currentTool = 'pen';
  let currentColor = '#F5F8FF';
  const LINE_WIDTH = 3;

  let drawing = false;
  let currentStroke = null;   // { id, type:'stroke', color, points:[{x,y}] }
  let shapeStart = null;      // {x,y} for rect/circle drag-start
  let canDrawNow = false;
  let isModerator = false;

  let pendingTextPos = null;
  let toolbarHideTimer = null;
  let laserActive = false;

  // ---------------------------------------------------------------- setup

  function init(sock, opts) {
    socket = sock;
    isModerator = !!opts.isModerator;
    canDrawNow = isModerator; // refined once whiteboard-state/access arrives

    container = document.getElementById('whiteboardContainer');
    canvas = document.getElementById('whiteboardCanvas');
    laserCanvas = document.getElementById('whiteboardLaserCanvas');
    ctx = canvas.getContext('2d');
    laserCtx = laserCanvas.getContext('2d');
    toolbar = document.getElementById('wbToolbar');
    toolbarToggle = document.getElementById('wbToolbarToggle');

    resizeCanvases();
    window.addEventListener('resize', resizeCanvases);

    wireToolbar();
    wirePointerEvents();
    wireSocket();
    wireAutoHide();
  }

  function resizeCanvases() {
    [canvas, laserCanvas].forEach((c) => {
      const rect = container.getBoundingClientRect();
      c.width = rect.width;
      c.height = rect.height;
    });
    redrawAll();
  }

  function open() {
    container.style.display = 'block';
    resizeCanvases();
    socket.emit('whiteboard-join', {});
    showToolbarTemporarily();
  }

  function close() {
    container.style.display = 'none';
  }

  function isOpen() {
    return container && container.style.display !== 'none';
  }

  // -------------------------------------------------------------- toolbar

  function wireToolbar() {
    document.querySelectorAll('.wb-tool[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.wb-tool[data-tool]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        currentTool = btn.dataset.tool;
        laserActive = false;
        clearLaserCanvas();
      });
    });

    document.querySelectorAll('.wb-swatch').forEach((sw) => {
      sw.addEventListener('click', () => {
        document.querySelectorAll('.wb-swatch').forEach((s) => s.classList.remove('active'));
        sw.classList.add('active');
        currentColor = sw.dataset.color;
      });
    });

    document.getElementById('wbUndoBtn').addEventListener('click', () => {
      socket.emit('whiteboard-undo', {});
    });
    document.getElementById('wbRedoBtn').addEventListener('click', () => {
      socket.emit('whiteboard-redo', {});
    });
    document.getElementById('wbClearBtn').addEventListener('click', () => {
      if (window.confirm('Clear the whiteboard for everyone?')) {
        socket.emit('whiteboard-clear', {});
      }
    });
    document.getElementById('wbCloseBtn').addEventListener('click', close);

    toolbarToggle.addEventListener('click', showToolbarTemporarily);

    // Text tool popup
    const textPopup = document.getElementById('wbTextPopup');
    const textInput = document.getElementById('wbTextInput');
    document.getElementById('wbTextCancelBtn').addEventListener('click', () => {
      textPopup.classList.remove('open');
      pendingTextPos = null;
    });
    document.getElementById('wbTextConfirmBtn').addEventListener('click', () => {
      const value = textInput.value.trim();
      if (value && pendingTextPos) {
        commitObject({
          id: genId(),
          type: 'text',
          x: pendingTextPos.x,
          y: pendingTextPos.y,
          text: value,
          color: currentColor,
        });
      }
      textInput.value = '';
      textPopup.classList.remove('open');
      pendingTextPos = null;
    });
  }

  function wireAutoHide() {
    function nudge() {
      showToolbarTemporarily();
    }
    container.addEventListener('pointerdown', nudge);
  }

  function showToolbarTemporarily() {
    toolbar.classList.remove('hidden');
    toolbarToggle.style.display = 'none';
    clearTimeout(toolbarHideTimer);
    toolbarHideTimer = setTimeout(() => {
      toolbar.classList.add('hidden');
      toolbarToggle.style.display = 'flex';
    }, 4000);
  }

  // --------------------------------------------------------- pointer input

  function relPos(e) {
    const rect = canvas.getBoundingClientRect();
    const point = e.touches ? e.touches[0] : e;
    return {
      x: (point.clientX - rect.left) / rect.width,
      y: (point.clientY - rect.top) / rect.height,
    };
  }

  function wirePointerEvents() {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', () => {
      if (currentTool === 'laser') sendLaser(null, null, false);
    });
  }

  function onPointerDown(e) {
    if (!canDrawNow) return;
    showToolbarTemporarily();
    const pos = relPos(e);

    if (currentTool === 'pen') {
      drawing = true;
      currentStroke = { id: genId(), type: 'stroke', color: currentColor, width: LINE_WIDTH, points: [pos] };
    } else if (currentTool === 'eraser') {
      drawing = true;
      eraseNear(pos);
    } else if (currentTool === 'text') {
      pendingTextPos = pos;
      openTextPopup(e);
    } else if (currentTool === 'rect' || currentTool === 'circle') {
      drawing = true;
      shapeStart = pos;
    } else if (currentTool === 'laser') {
      laserActive = true;
      sendLaser(pos.x, pos.y, true);
    }
  }

  function onPointerMove(e) {
    if (!canDrawNow) return;
    const pos = relPos(e);

    if (drawing && currentTool === 'pen' && currentStroke) {
      currentStroke.points.push(pos);
      redrawAll();
      drawStrokePreview(currentStroke);
    } else if (drawing && currentTool === 'eraser') {
      eraseNear(pos);
    } else if (drawing && (currentTool === 'rect' || currentTool === 'circle') && shapeStart) {
      redrawAll();
      drawShapePreview(currentTool, shapeStart, pos);
    } else if (currentTool === 'laser' && laserActive) {
      sendLaser(pos.x, pos.y, true);
    }
  }

  function onPointerUp(e) {
    if (!canDrawNow) return;

    if (drawing && currentTool === 'pen' && currentStroke && currentStroke.points.length > 1) {
      commitObject(currentStroke);
    }
    if (drawing && (currentTool === 'rect' || currentTool === 'circle') && shapeStart) {
      const pos = relPos(e);
      commitObject({
        id: genId(),
        type: currentTool,
        color: currentColor,
        width: LINE_WIDTH,
        x1: shapeStart.x, y1: shapeStart.y,
        x2: pos.x, y2: pos.y,
      });
    }
    if (currentTool === 'laser' && laserActive) {
      laserActive = false;
      sendLaser(null, null, false);
    }

    drawing = false;
    currentStroke = null;
    shapeStart = null;
  }

  function openTextPopup(e) {
    const popup = document.getElementById('wbTextPopup');
    const point = e.touches ? e.touches[0] : e;
    popup.style.left = `${Math.min(point.clientX, window.innerWidth - 240)}px`;
    popup.style.top = `${Math.min(point.clientY, window.innerHeight - 120)}px`;
    popup.classList.add('open');
    document.getElementById('wbTextInput').focus();
  }

  // ------------------------------------------------------------- eraser

  function eraseNear(pos) {
    // Object-based erase per the spec: remove whichever committed stroke
    // passes near the pointer, rather than painting over pixels.
    const threshold = 0.02;
    const hit = objects.find((o) => {
      if (o.type === 'stroke') {
        return o.points.some((p) => Math.hypot(p.x - pos.x, p.y - pos.y) < threshold);
      }
      if (o.type === 'text') {
        return Math.hypot(o.x - pos.x, o.y - pos.y) < threshold * 2;
      }
      if (o.type === 'rect' || o.type === 'circle') {
        const midX = (o.x1 + o.x2) / 2;
        const midY = (o.y1 + o.y2) / 2;
        return Math.hypot(midX - pos.x, midY - pos.y) < threshold * 3;
      }
      return false;
    });
    if (hit) {
      objects = objects.filter((o) => o.id !== hit.id);
      redrawAll();
      socket.emit('whiteboard-erase-object', { id: hit.id });
    }
  }

  // -------------------------------------------------------------- render

  function toPx(pos) {
    return { x: pos.x * canvas.width, y: pos.y * canvas.height };
  }

  function drawObject(o) {
    ctx.strokeStyle = o.color;
    ctx.fillStyle = o.color;
    ctx.lineWidth = o.width || LINE_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (o.type === 'stroke') {
      if (o.points.length < 2) return;
      ctx.beginPath();
      const start = toPx(o.points[0]);
      ctx.moveTo(start.x, start.y);
      o.points.slice(1).forEach((p) => {
        const px = toPx(p);
        ctx.lineTo(px.x, px.y);
      });
      ctx.stroke();
    } else if (o.type === 'text') {
      const px = toPx({ x: o.x, y: o.y });
      ctx.font = '16px Inter, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(o.text, px.x, px.y);
    } else if (o.type === 'rect') {
      const p1 = toPx({ x: o.x1, y: o.y1 });
      const p2 = toPx({ x: o.x2, y: o.y2 });
      ctx.strokeRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
    } else if (o.type === 'circle') {
      const p1 = toPx({ x: o.x1, y: o.y1 });
      const p2 = toPx({ x: o.x2, y: o.y2 });
      const rx = Math.abs(p2.x - p1.x) / 2;
      const ry = Math.abs(p2.y - p1.y) / 2;
      const cx = (p1.x + p2.x) / 2;
      const cy = (p1.y + p2.y) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function redrawAll() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    objects.forEach(drawObject);
  }

  function drawStrokePreview(stroke) {
    drawObject(stroke);
  }
  function drawShapePreview(tool, start, current) {
    drawObject({ type: tool, color: currentColor, width: LINE_WIDTH, x1: start.x, y1: start.y, x2: current.x, y2: current.y });
  }

  function clearLaserCanvas() {
    laserCtx.clearRect(0, 0, laserCanvas.width, laserCanvas.height);
  }

  function renderRemoteLaser(x, y) {
    clearLaserCanvas();
    if (x == null) return;
    const px = toPx({ x, y });
    laserCtx.beginPath();
    laserCtx.arc(px.x, px.y, 8, 0, Math.PI * 2);
    laserCtx.fillStyle = 'rgba(255, 77, 94, 0.85)';
    laserCtx.fill();
    laserCtx.beginPath();
    laserCtx.arc(px.x, px.y, 14, 0, Math.PI * 2);
    laserCtx.strokeStyle = 'rgba(255, 77, 94, 0.4)';
    laserCtx.lineWidth = 2;
    laserCtx.stroke();
  }

  // -------------------------------------------------------------- sync

  function genId() {
    return 'wb_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function commitObject(obj) {
    objects.push(obj);
    redrawAll();
    socket.emit('whiteboard-op', { object: obj });
  }

  function sendLaser(x, y, active) {
    socket.emit('whiteboard-laser', { x, y, active });
  }

  function wireSocket() {
    socket.on('whiteboard-state', (data) => {
      objects = data.objects || [];
      applyAccess(data.drawAccess);
      redrawAll();
    });
    socket.on('whiteboard-op', (data) => {
      objects.push(data.object);
      redrawAll();
    });
    socket.on('whiteboard-undo', ({ id }) => {
      objects = objects.filter((o) => o.id !== id);
      redrawAll();
    });
    socket.on('whiteboard-clear', () => {
      objects = [];
      redrawAll();
    });
    socket.on('whiteboard-erase-object', ({ id }) => {
      objects = objects.filter((o) => o.id !== id);
      redrawAll();
    });
    socket.on('whiteboard-laser', ({ x, y, active }) => {
      renderRemoteLaser(active ? x : null, y);
    });
    socket.on('whiteboard-access-changed', ({ access }) => {
      applyAccess(access);
    });
  }

  function applyAccess(access) {
    canDrawNow = isModerator || access === 'everyone';
  }

  function setModerator(value) {
    isModerator = value;
    canDrawNow = isModerator;
  }

  return { init, open, close, isOpen, setModerator };
})();

window.HXWhiteboard = HXWhiteboard;

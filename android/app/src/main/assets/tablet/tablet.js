/**
 * TabSync Studio - Professional Android Tablet Client Controller
 * Cryptographic pairing, authenticated session management, S-Pen pressure dynamics,
 * palm rejection, precision trackpad, and real-time Mac screen synchronization.
 */
(function() {
  'use strict';

  // Canvas & Layers
  const canvas = document.getElementById('active-canvas');
  const ctx = canvas.getContext('2d');
  const trackpadLayer = document.getElementById('trackpad-layer');
  const statusPill = document.getElementById('status-pill');
  const statusLabel = document.getElementById('status-label');
  const pingLabel = document.getElementById('ping-label');
  const stylusBadge = document.getElementById('stylus-badge');
  const toastEl = document.getElementById('toast');

  // Toolbar Buttons
  const tabDraw = document.getElementById('tab-draw');
  const tabHighlighter = document.getElementById('tab-highlighter');
  const tabLaser = document.getElementById('tab-laser');
  const tabCursor = document.getElementById('tab-cursor');
  const tabEraser = document.getElementById('tab-eraser');
  const tabUndo = document.getElementById('tab-undo');
  const tabRedo = document.getElementById('tab-redo');
  const tabClear = document.getElementById('tab-clear');
  const tabEmergencyStop = document.getElementById('tab-emergency-stop');

  // Trackpad Buttons
  const tpBtnLeft = document.getElementById('tp-btn-left');
  const tpBtnRight = document.getElementById('tp-btn-right');
  const tpBtnDrag = document.getElementById('tp-btn-drag');
  const tpDragText = document.getElementById('tp-drag-text');

  // State
  let currentMode = 'pen'; // 'pen', 'highlighter', 'laser', 'cursor', 'eraser'
  let currentColor = '#0ea5e9';
  let currentSize = 6;

  let strokes = [];
  let redoStack = [];
  let currentStroke = null;
  let isDrawing = false;
  let isStylusActive = false;
  let isDragLocked = false;
  let ws = null;
  let dpr = window.devicePixelRatio || 1;
  let pingInterval = null;
  let isSessionAuthenticated = false;

  // -------------------------------------------------------------
  // DEVICE IDENTITY & AUTH STORAGE
  // -------------------------------------------------------------
  function getDeviceId() {
    let id = localStorage.getItem('tabsync_device_id');
    if (!id) {
      id = 'tablet-' + Math.random().toString(36).substring(2, 9) + '-' + Date.now().toString(36);
      localStorage.setItem('tabsync_device_id', id);
    }
    return id;
  }

  function getStoredAuthToken() {
    return localStorage.getItem('tabsync_auth_token');
  }

  function storeAuthToken(token) {
    if (token) localStorage.setItem('tabsync_auth_token', token);
    else localStorage.removeItem('tabsync_auth_token');
  }

  function getStoredHostInfo() {
    try {
      const data = localStorage.getItem('tabsync_host_info');
      return data ? JSON.parse(data) : null;
    } catch (e) {
      return null;
    }
  }

  function storeHostInfo(hostObj) {
    try {
      if (hostObj) {
        const id = hostObj.id || hostObj.hostId;
        const name = hostObj.name || hostObj.hostName || 'Mac';
        const fingerprint = hostObj.fingerprint || hostObj.fp || '';
        localStorage.setItem('tabsync_host_info', JSON.stringify({ id, name, fingerprint, savedAt: Date.now() }));
      } else {
        localStorage.removeItem('tabsync_host_info');
      }
    } catch (e) {}
  }

  // Parse pairing credentials STRICTLY from URL hash fragment (#token=...&pin=...)
  // Credentials in URL query parameters are disallowed to prevent leakage in server access logs and HTTP referrers
  const hashRaw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  const hashParams = new URLSearchParams(hashRaw);
  let paramToken = hashParams.get('token');
  let paramPin = hashParams.get('pin');
  const paramFp = hashParams.get('fp');
  const paramHostId = hashParams.get('hostId');
  const paramHostName = hashParams.get('hostName');

  // Immediately strip pairing parameters from browser URL bar and history without reloading
  if (paramToken || paramPin || paramFp || paramHostId) {
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }

  function showToast(msg, duration = 2200) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => {
      toastEl.classList.remove('show');
    }, duration);
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    redrawAll();
  }

  window.addEventListener('resize', resize);
  setTimeout(resize, 80);

  function toCanvas(nx, ny) {
    return {
      x: nx * canvas.width,
      y: ny * canvas.height
    };
  }

  function renderStroke(stroke, targetCtx = ctx) {
    if (!stroke || !stroke.points || stroke.points.length === 0) return;
    const pts = stroke.points;
    const c = targetCtx;

    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';

    const baseSize = (stroke.size || 6) * dpr;
    const color = stroke.color || '#0ea5e9';

    if (stroke.tool === 'eraser') {
      c.globalCompositeOperation = 'destination-out';
      c.strokeStyle = 'rgba(0,0,0,1)';
      c.lineWidth = baseSize * 3.5;
    } else if (stroke.tool === 'highlighter') {
      c.globalAlpha = 0.35;
      c.strokeStyle = color;
      c.lineWidth = baseSize * 3;
    } else {
      c.strokeStyle = color;
      c.globalAlpha = 1.0;
      c.lineWidth = baseSize;
    }

    if (pts.length === 1) {
      const p = toCanvas(pts[0].x, pts[0].y);
      const pr = pts[0].p !== undefined ? pts[0].p : 0.5;
      c.fillStyle = stroke.tool === 'eraser' ? 'rgba(0,0,0,1)' : color;
      c.beginPath();
      c.arc(p.x, p.y, Math.max(2, (c.lineWidth * (0.6 + 0.8 * pr)) / 2), 0, Math.PI * 2);
      c.fill();
      c.restore();
      return;
    }

    const p0 = toCanvas(pts[0].x, pts[0].y);
    c.beginPath();
    c.moveTo(p0.x, p0.y);

    if (pts.length === 2) {
      const p1 = toCanvas(pts[1].x, pts[1].y);
      c.lineTo(p1.x, p1.y);
    } else {
      for (let i = 1; i < pts.length - 1; i++) {
        const pc = toCanvas(pts[i].x, pts[i].y);
        const pn = toCanvas(pts[i + 1].x, pts[i + 1].y);
        const midX = (pc.x + pn.x) / 2;
        const midY = (pc.y + pn.y) / 2;
        c.quadraticCurveTo(pc.x, pc.y, midX, midY);
      }
      const last = toCanvas(pts[pts.length - 1].x, pts[pts.length - 1].y);
      c.lineTo(last.x, last.y);
    }

    c.stroke();
    c.restore();
  }

  function renderSegment(pts, stroke) {
    if (!pts || pts.length < 2) return;
    const c = ctx;
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';

    const baseSize = (stroke.size || 6) * dpr;
    const color = stroke.color || '#0ea5e9';

    if (stroke.tool === 'eraser') {
      c.globalCompositeOperation = 'destination-out';
      c.strokeStyle = 'rgba(0,0,0,1)';
      c.lineWidth = baseSize * 3.5;
    } else if (stroke.tool === 'highlighter') {
      c.globalAlpha = 0.35;
      c.strokeStyle = color;
      c.lineWidth = baseSize * 3;
    } else {
      c.strokeStyle = color;
      c.globalAlpha = 1.0;
      c.lineWidth = baseSize;
    }

    const p0 = toCanvas(pts[pts.length - 2].x, pts[pts.length - 2].y);
    const p1 = toCanvas(pts[pts.length - 1].x, pts[pts.length - 1].y);

    c.beginPath();
    c.moveTo(p0.x, p0.y);
    c.lineTo(p1.x, p1.y);
    c.stroke();
    c.restore();
  }

  function redrawAll() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Studio dot grid background for paper feel
    ctx.fillStyle = '#080b12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
    const gridSize = 36 * dpr;
    for (let x = gridSize / 2; x < canvas.width; x += gridSize) {
      for (let y = gridSize / 2; y < canvas.height; y += gridSize) {
        ctx.beginPath();
        ctx.arc(x, y, 1.2 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (const stroke of strokes) {
      renderStroke(stroke);
    }
    if (currentStroke) {
      renderStroke(currentStroke);
    }
  }

  // -------------------------------------------------------------
  // SECURE WEBSOCKET & AUTHENTICATED PAIRING
  // -------------------------------------------------------------
  function connectWS() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      try { ws.close(); } catch (e) {}
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
      // 1. If URL has pairing token or PIN, attempt pairing handshake
      if (paramToken || paramPin) {
        statusLabel.textContent = 'Pairing...';
        ws.send(JSON.stringify({
          type: 'pair_request',
          token: paramToken,
          pin: paramPin,
          device: {
            id: getDeviceId(),
            name: 'Android Tablet',
            model: navigator.userAgent.includes('Android') ? 'Android' : 'Tablet'
          }
        }));
        // Cleanse transient pairing credentials from memory
        paramToken = null;
        paramPin = null;
        return;
      }

      // 2. Otherwise authenticate with stored auth token
      const savedToken = getStoredAuthToken();
      if (savedToken) {
        statusLabel.textContent = 'Authenticating...';
        ws.send(JSON.stringify({
          type: 'auth',
          deviceId: getDeviceId(),
          authToken: savedToken
        }));
      } else {
        // Unpaired device: prompt user to enter PIN
        statusLabel.textContent = 'Unpaired';
        promptManualPair();
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {}
    };

    ws.onclose = () => {
      isSessionAuthenticated = false;
      statusPill.classList.remove('connected');
      pingLabel.textContent = '--ms';
      stopPing();
      scheduleReconnect();
    };
  }

  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let shouldReconnect = true;

  function scheduleReconnect() {
    if (!shouldReconnect) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const baseDelay = Math.min(8000, 1000 * Math.pow(1.4, reconnectAttempts));
    const jitter = Math.random() * 400;
    const delay = Math.round(baseDelay + jitter);
    reconnectAttempts++;
    statusLabel.textContent = `Reconnecting (${Math.round(delay / 1000)}s)...`;
    reconnectTimer = setTimeout(connectWS, delay);
  }

  // Network and app lifecycle reconnection handlers
  window.addEventListener('online', () => {
    shouldReconnect = true;
    reconnectAttempts = 0;
    if (!isSessionAuthenticated) {
      connectWS();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!ws || ws.readyState !== WebSocket.OPEN || !isSessionAuthenticated) {
        shouldReconnect = true;
        reconnectAttempts = 0;
        connectWS();
      }
    }
  });

  function sendWS(data) {
    if (ws && ws.readyState === WebSocket.OPEN && isSessionAuthenticated) {
      ws.send(JSON.stringify(data));
    }
  }

  function startPing() {
    stopPing();
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN && isSessionAuthenticated) {
        ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      }
    }, 2500);
  }

  function stopPing() {
    if (pingInterval) clearInterval(pingInterval);
  }

  function promptManualPair() {
    shouldReconnect = true;
    const pin = prompt('Enter the 6-digit Security PIN displayed on your Mac widget:');
    if (pin && pin.trim().length === 6) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        statusLabel.textContent = 'Verifying PIN...';
        ws.send(JSON.stringify({
          type: 'pair_request',
          pin: pin.trim(),
          device: {
            id: getDeviceId(),
            name: 'Android Tablet',
            model: navigator.userAgent.includes('Android') ? 'Android' : 'Tablet'
          }
        }));
      }
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'pair_success': {
        isSessionAuthenticated = true;
        reconnectAttempts = 0;
        shouldReconnect = true;
        storeAuthToken(msg.authToken);
        const hostInfo = msg.host || { id: msg.hostId, name: msg.hostName, fingerprint: msg.fingerprint };
        storeHostInfo(hostInfo);
        statusPill.classList.add('connected');
        statusLabel.textContent = 'Paired & Secure';
        showToast(`🔒 Paired with ${hostInfo.name || 'Mac'}!`);
        startPing();
        // Clean pairing parameters from browser URL bar without reloading
        if (window.history && window.history.replaceState) {
          window.history.replaceState({}, document.title, window.location.pathname);
        }
        break;
      }

      case 'pair_error':
        statusPill.classList.remove('connected');
        statusLabel.textContent = 'Pairing Failed';
        alert('Pairing error: ' + (msg.error || 'Invalid code'));
        promptManualPair();
        break;

      case 'auth_success': {
        const incomingHost = msg.host || { id: msg.hostId, name: msg.hostName, fingerprint: msg.fingerprint };
        const pairedHost = getStoredHostInfo();

        if (pairedHost && pairedHost.id && incomingHost && incomingHost.id) {
          const idMatch = pairedHost.id === incomingHost.id;
          const fpMatch = !pairedHost.fingerprint || !incomingHost.fingerprint ||
            pairedHost.fingerprint.replace(/:/g, '').toLowerCase() === incomingHost.fingerprint.replace(/:/g, '').toLowerCase();

          if (!idMatch || !fpMatch) {
            console.error('[Security] Host Identity Mismatch detected!', { paired: pairedHost, incoming: incomingHost });
            isSessionAuthenticated = false;
            shouldReconnect = false;
            statusPill.classList.remove('connected');
            statusLabel.textContent = 'Untrusted Host';
            if (ws) {
              try { ws.close(4005, 'Host Identity Mismatch'); } catch (e) {}
            }
            alert(`⚠️ Security Alert: Host Identity Mismatch!\n\nThe Mac at this address (${incomingHost.name || 'Unknown'}) does not match the cryptographic identity of your paired Mac (${pairedHost.name || pairedHost.id}).\n\nPossible host change or network impersonation. To connect to this Mac, you must deliberately re-pair by scanning its QR code or entering its PIN.`);
            return;
          }
        }

        isSessionAuthenticated = true;
        reconnectAttempts = 0;
        shouldReconnect = true;
        if (incomingHost) {
          storeHostInfo(incomingHost);
        }
        statusPill.classList.add('connected');
        statusLabel.textContent = incomingHost.name || 'Mac Connected';
        showToast(`⚡ Connected to ${incomingHost.name || 'Mac'}`);
        startPing();
        break;
      }

      case 'auth_error':
      case 'revoked':
        isSessionAuthenticated = false;
        shouldReconnect = false;
        storeAuthToken(null); // clear revoked token
        storeHostInfo(null);
        statusPill.classList.remove('connected');
        statusLabel.textContent = 'Unpaired';
        alert(msg.reason || msg.error || 'Connection not authorized. Please pair again.');
        promptManualPair();
        break;

      case 'init':
        if (Array.isArray(msg.history)) {
          strokes = msg.history;
          redrawAll();
        }
        break;

      case 'pong':
        if (msg.timestamp) {
          const latency = Math.max(1, Math.round((Date.now() - msg.timestamp) / 2));
          pingLabel.textContent = `${latency}ms`;
        }
        break;

      case 'sync_tool':
        if (msg.mode) setMode(msg.mode, false);
        if (msg.color) setColor(msg.color, false);
        if (msg.size) setSize(msg.size, false);
        break;

      case 'clear':
        strokes = [];
        redoStack = [];
        currentStroke = null;
        redrawAll();
        break;

      case 'sync_history':
        strokes = msg.history || [];
        redrawAll();
        break;

      case 'undo':
        if (strokes.length > 0) {
          redoStack.push(strokes.pop());
          redrawAll();
        }
        break;

      case 'redo':
        if (redoStack.length > 0) {
          strokes.push(redoStack.pop());
          redrawAll();
        }
        break;
    }
  }

  // -------------------------------------------------------------
  // TOOL CONTROLS & SYNCHRONIZATION
  // -------------------------------------------------------------
  function setMode(mode, broadcast = true) {
    currentMode = mode;
    [tabDraw, tabHighlighter, tabLaser, tabCursor, tabEraser].forEach(b => {
      if (b) b.classList.remove('active');
    });

    if (mode === 'pen' || mode === 'draw') {
      tabDraw.classList.add('active');
      trackpadLayer.classList.add('hidden');
    } else if (mode === 'highlighter') {
      tabHighlighter.classList.add('active');
      trackpadLayer.classList.add('hidden');
    } else if (mode === 'laser') {
      tabLaser.classList.add('active');
      trackpadLayer.classList.add('hidden');
    } else if (mode === 'cursor') {
      tabCursor.classList.add('active');
      trackpadLayer.classList.remove('hidden');
    } else if (mode === 'eraser') {
      tabEraser.classList.add('active');
      trackpadLayer.classList.add('hidden');
    }

    if (broadcast) {
      sendWS({ type: 'tool_change', mode, color: currentColor, size: currentSize });
    }
  }

  function setColor(color, broadcast = true) {
    currentColor = color;
    document.querySelectorAll('.swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.color.toLowerCase() === color.toLowerCase());
    });

    if (currentMode === 'eraser' || currentMode === 'cursor') {
      setMode('pen', broadcast);
    } else if (broadcast) {
      sendWS({ type: 'tool_change', mode: currentMode, color: currentColor, size: currentSize });
    }
  }

  function setSize(sz, broadcast = true) {
    currentSize = parseInt(sz, 10);
    document.querySelectorAll('.size-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.size, 10) === currentSize);
    });

    if (broadcast) {
      sendWS({ type: 'tool_change', mode: currentMode, color: currentColor, size: currentSize });
    }
  }

  tabDraw.addEventListener('click', () => setMode('pen'));
  tabHighlighter.addEventListener('click', () => setMode('highlighter'));
  tabLaser.addEventListener('click', () => setMode('laser'));
  tabCursor.addEventListener('click', () => setMode('cursor'));
  tabEraser.addEventListener('click', () => setMode('eraser'));

  document.querySelectorAll('.swatch').forEach(s => {
    s.addEventListener('click', () => setColor(s.dataset.color));
  });

  document.querySelectorAll('.size-btn').forEach(b => {
    b.addEventListener('click', () => setSize(b.dataset.size));
  });

  function performUndo() {
    if (strokes.length > 0) {
      redoStack.push(strokes.pop());
      if (redoStack.length > 200) redoStack.shift();
      redrawAll();
      sendWS({ type: 'undo' });
      return true;
    }
    return false;
  }

  function performRedo() {
    if (redoStack.length > 0) {
      strokes.push(redoStack.pop());
      if (strokes.length > 800) strokes.shift();
      redrawAll();
      sendWS({ type: 'redo' });
      return true;
    }
    return false;
  }

  tabUndo.addEventListener('click', () => {
    if (performUndo()) {
      showToast('↩ Undo');
    }
  });

  tabRedo.addEventListener('click', () => {
    if (performRedo()) {
      showToast('↪ Redo');
    }
  });

  tabClear.addEventListener('click', () => {
    if (confirm('Clear all drawings on Mac screen?')) {
      strokes = [];
      redoStack = [];
      currentStroke = null;
      redrawAll();
      sendWS({ type: 'clear' });
    }
  });

  if (tabEmergencyStop) {
    tabEmergencyStop.addEventListener('click', () => {
      sendWS({ type: 'emergency_stop' });
      isDrawing = false;
      currentStroke = null;
      showToast('⚠️ Emergency Stop: Remote input halted');
    });
  }

  statusPill.addEventListener('click', () => {
    if (!isSessionAuthenticated) {
      promptManualPair();
    } else {
      if (confirm('Disconnect & unpair this tablet from Mac?')) {
        storeAuthToken(null);
        isSessionAuthenticated = false;
        if (ws) ws.close();
        promptManualPair();
      }
    }
  });

  // -------------------------------------------------------------
  // S-PEN / TOUCH SURFACE DRAWING LOGIC
  // -------------------------------------------------------------
  function getNormCoords(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || window.innerWidth || 1;
    const h = rect.height || window.innerHeight || 1;
    return {
      x: Math.min(Math.max((clientX - rect.left) / w, 0), 1),
      y: Math.min(Math.max((clientY - rect.top) / h, 0), 1)
    };
  }

  function handleStart(clientX, clientY, pressure = 0.5, pointerType = 'mouse') {
    if (currentMode === 'cursor') return;

    if (currentMode === 'laser') {
      const norm = getNormCoords(clientX, clientY);
      sendWS({ type: 'laser_pointer', x: norm.x, y: norm.y, active: true });
      return;
    }

    isDrawing = true;
    const norm = getNormCoords(clientX, clientY);

    currentStroke = {
      id: 'str-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      tool: currentMode,
      color: currentColor,
      size: currentSize,
      points: [{ x: norm.x, y: norm.y, p: pressure }]
    };

    renderStroke(currentStroke);
    sendWS({ type: 'stroke_start', stroke: currentStroke });
  }

  function handleMove(clientX, clientY, pressure = 0.5) {
    if (currentMode === 'cursor') return;

    if (currentMode === 'laser') {
      const norm = getNormCoords(clientX, clientY);
      sendWS({ type: 'laser_pointer', x: norm.x, y: norm.y, active: true });
      return;
    }

    if (!isDrawing || !currentStroke) return;
    const norm = getNormCoords(clientX, clientY);
    const pt = { x: norm.x, y: norm.y, p: pressure };

    currentStroke.points.push(pt);
    renderSegment(currentStroke.points, currentStroke);

    sendWS({
      type: 'stroke_point',
      strokeId: currentStroke.id,
      point: pt
    });
  }

  function handleEnd() {
    if (currentMode === 'laser') {
      sendWS({ type: 'laser_pointer', active: false });
      return;
    }

    if (!isDrawing || !currentStroke) return;
    isDrawing = false;

    strokes.push(currentStroke);
    if (strokes.length > 800) strokes.shift();
    redoStack = [];
    sendWS({
      type: 'stroke_end',
      strokeId: currentStroke.id,
      stroke: currentStroke
    });

    currentStroke = null;
    redrawAll();
  }

  // Pointer listeners (Supports S-Pen / Stylus with Palm Rejection)
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (e.pointerType === 'pen') {
      isStylusActive = true;
      stylusBadge.classList.remove('hidden');
    } else if (isStylusActive && e.pointerType === 'touch') {
      // Palm rejection: ignore accidental hand rest
      return;
    }

    try { canvas.setPointerCapture(e.pointerId); } catch(err) {}
    const p = e.pressure && e.pressure > 0 ? e.pressure : (e.pointerType === 'pen' ? 0.6 : 0.5);
    handleStart(e.clientX, e.clientY, p, e.pointerType);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (isStylusActive && e.pointerType === 'touch') return;
    e.preventDefault();
    const p = e.pressure && e.pressure > 0 ? e.pressure : 0.5;
    handleMove(e.clientX, e.clientY, p);
  });

  canvas.addEventListener('pointerup', (e) => {
    e.preventDefault();
    try { canvas.releasePointerCapture(e.pointerId); } catch(err) {}
    handleEnd();
  });

  canvas.addEventListener('pointercancel', (e) => {
    e.preventDefault();
    handleEnd();
  });

  // Multi-Touch Gesture Detection (Two-Finger Tap = Undo, Three-Finger Tap = Redo)
  let gestureTapCandidate = null;

  canvas.addEventListener('touchstart', (e) => {
    const count = e.touches.length;
    if (count >= 2) {
      if (isDrawing) {
        isDrawing = false;
        currentStroke = null;
        redrawAll();
      }
      gestureTapCandidate = {
        count: count,
        startTime: Date.now(),
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY
      };
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (gestureTapCandidate && e.touches.length > 0) {
      const dx = Math.abs(e.touches[0].clientX - gestureTapCandidate.startX);
      const dy = Math.abs(e.touches[0].clientY - gestureTapCandidate.startY);
      if (dx > 20 || dy > 20) {
        gestureTapCandidate = null;
      }
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    if (gestureTapCandidate) {
      const duration = Date.now() - gestureTapCandidate.startTime;
      if (duration < 350) {
        if (gestureTapCandidate.count === 2) {
          if (performUndo()) {
            showToast('↩ Undo (2-Finger Tap)');
          }
        } else if (gestureTapCandidate.count === 3) {
          if (performRedo()) {
            showToast('↪ Redo (3-Finger Tap)');
          }
        }
      }
      gestureTapCandidate = null;
    }
  }, { passive: false });

  // Touch fallback listeners (only registered if browser lacks PointerEvent support)
  if (!window.PointerEvent) {
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (isStylusActive) return;
      if (e.touches.length > 0) {
        handleStart(e.touches[0].clientX, e.touches[0].clientY, 0.6, 'touch');
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (isStylusActive) return;
      if (isDrawing && e.touches.length > 0) {
        handleMove(e.touches[0].clientX, e.touches[0].clientY, 0.6);
      }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      handleEnd();
    }, { passive: false });
  }

  // -------------------------------------------------------------
  // PRECISION TRACKPAD LAYER LOGIC
  // -------------------------------------------------------------
  let tpLastX = 0;
  let tpLastY = 0;
  let tpDownTime = 0;
  let tpTouchCount = 0;

  trackpadLayer.addEventListener('touchstart', (e) => {
    e.preventDefault();
    tpTouchCount = e.touches.length;
    if (tpTouchCount > 0) {
      tpLastX = e.touches[0].clientX;
      tpLastY = e.touches[0].clientY;
      tpDownTime = Date.now();
    }
  }, { passive: false });

  trackpadLayer.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touches = e.touches;
    if (touches.length === 1) {
      const dx = (touches[0].clientX - tpLastX) * 1.8;
      const dy = (touches[0].clientY - tpLastY) * 1.8;
      tpLastX = touches[0].clientX;
      tpLastY = touches[0].clientY;
      sendWS({ type: 'input_move_rel', dx, dy });
    } else if (touches.length === 2) {
      const dy = (touches[0].clientY - tpLastY) * 0.8;
      const dx = (touches[0].clientX - tpLastX) * 0.8;
      tpLastX = touches[0].clientX;
      tpLastY = touches[0].clientY;
      sendWS({ type: 'input_scroll', dy: Math.round(dy), dx: Math.round(dx) });
    }
  }, { passive: false });

  trackpadLayer.addEventListener('touchend', (e) => {
    e.preventDefault();
    const duration = Date.now() - tpDownTime;
    if (duration < 220 && tpTouchCount === 1) {
      sendWS({ type: 'input_click', button: 'left' });
    } else if (duration < 250 && tpTouchCount === 2) {
      sendWS({ type: 'input_click', button: 'right' });
    }
    tpTouchCount = e.touches.length;
  }, { passive: false });

  // Virtual buttons
  tpBtnLeft.addEventListener('click', (e) => {
    e.stopPropagation();
    sendWS({ type: 'input_click', button: 'left' });
  });

  tpBtnRight.addEventListener('click', (e) => {
    e.stopPropagation();
    sendWS({ type: 'input_click', button: 'right' });
  });

  tpBtnDrag.addEventListener('click', (e) => {
    e.stopPropagation();
    isDragLocked = !isDragLocked;
    tpBtnDrag.classList.toggle('active', isDragLocked);
    if (isDragLocked) {
      tpDragText.textContent = '🔓 Drag Lock: ON';
      sendWS({ type: 'input_down', button: 'left' });
      showToast('Mouse Drag Locked (Hold)');
    } else {
      tpDragText.textContent = '🔒 Drag Lock: OFF';
      sendWS({ type: 'input_up', button: 'left' });
      showToast('Mouse Drag Released');
    }
  });

  connectWS();
})();

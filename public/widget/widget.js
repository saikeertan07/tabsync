/**
 * TabSync Studio - Professional Mac Floating Toolbar Controller
 * Security, pairing management, device revocation, and native macOS bridging
 */
(function() {
  'use strict';

  let ws = null;
  let currentMode = 'pen'; // 'pen', 'highlighter', 'laser', 'cursor', 'eraser'
  let currentColor = '#0ea5e9';
  let currentSize = 6;
  let isQrOpen = false;

  const btnDraw = document.getElementById('btn-draw');
  const btnHighlighter = document.getElementById('btn-highlighter');
  const btnLaser = document.getElementById('btn-laser');
  const btnCursor = document.getElementById('btn-cursor');
  const btnEraser = document.getElementById('btn-eraser');
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  const btnClear = document.getElementById('btn-clear');
  const btnSnap = document.getElementById('btn-snap');
  const btnQr = document.getElementById('btn-qr');
  const btnClose = document.getElementById('btn-close');
  const btnEmergencyStop = document.getElementById('btn-emergency-stop');
  const btnPermWarn = document.getElementById('btn-perm-warn');

  // Popover elements
  const qrPopover = document.getElementById('qr-popover');
  const qrImg = document.getElementById('qr-img');
  const tabletIpText = document.getElementById('tablet-ip-text');
  const statusDesc = document.getElementById('status-desc');
  const closeQrBtn = document.getElementById('close-qr-btn');
  const pinNumber = document.getElementById('pin-number');
  const btnRefreshPin = document.getElementById('btn-refresh-pin');
  const tabPairView = document.getElementById('tab-pair-view');
  const tabDevicesView = document.getElementById('tab-devices-view');
  const viewPairPanel = document.getElementById('view-pair-panel');
  const viewDevicesPanel = document.getElementById('view-devices-panel');
  const devicesList = document.getElementById('devices-list');
  const pairedCount = document.getElementById('paired-count');
  const toastEl = document.getElementById('toast');

  function showToast(text, duration = 2200) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add('show');
    setTimeout(() => {
      toastEl.classList.remove('show');
    }, duration);
  }

  function sendNative(action, payload = {}) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tabSync) {
        window.webkit.messageHandlers.tabSync.postMessage({ action, ...payload });
      }
    } catch (e) {
      console.log('Native message error:', e);
    }
  }

  function connectWS() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'register', role: 'widget' }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {}
    };

    ws.onclose = () => {
      setTimeout(connectWS, 1500);
    };
  }

  function sendWS(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'sync_tool':
        if (msg.mode) setMode(msg.mode, false);
        if (msg.color) setColor(msg.color, false);
        if (msg.size) setSize(msg.size, false);
        break;

      case 'tablet_status':
        const connected = msg.status === 'connected' || (Array.isArray(msg.tablets) && msg.tablets.length > 0);
        btnQr.classList.toggle('connected', connected);
        if (connected) {
          const count = msg.tablets ? msg.tablets.length : 1;
          const name = msg.tablets && msg.tablets[0] ? msg.tablets[0].name : 'Android Tablet';
          statusDesc.textContent = `✓ ${name} connected (${count})`;
          statusDesc.style.color = '#10b981';
        } else {
          statusDesc.textContent = 'Searching for tablets on local Wi-Fi...';
          statusDesc.style.color = '#94a3b8';
        }
        loadStatus();
        break;

      case 'mac_system_info':
        if (typeof msg.accessibilityTrusted === 'boolean') {
          btnPermWarn.classList.toggle('hidden', msg.accessibilityTrusted);
        }
        break;

      case 'devices_updated':
        renderDevices(msg.devices);
        break;
    }
  }

  function setMode(mode, broadcast = true) {
    currentMode = mode;
    [btnDraw, btnHighlighter, btnLaser, btnCursor, btnEraser].forEach(b => {
      if (b) b.classList.remove('active');
    });

    if (mode === 'pen' || mode === 'draw') {
      btnDraw.classList.add('active');
    } else if (mode === 'highlighter') {
      btnHighlighter.classList.add('active');
    } else if (mode === 'laser') {
      btnLaser.classList.add('active');
    } else if (mode === 'cursor') {
      btnCursor.classList.add('active');
    } else if (mode === 'eraser') {
      btnEraser.classList.add('active');
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

  // Tool Click Events
  btnDraw.addEventListener('click', () => setMode('pen'));
  btnHighlighter.addEventListener('click', () => setMode('highlighter'));
  btnLaser.addEventListener('click', () => setMode('laser'));
  btnCursor.addEventListener('click', () => setMode('cursor'));
  btnEraser.addEventListener('click', () => setMode('eraser'));

  // Color Swatches
  document.querySelectorAll('.swatch').forEach(s => {
    s.addEventListener('click', () => setColor(s.dataset.color));
  });

  // Size Buttons
  document.querySelectorAll('.size-btn').forEach(b => {
    b.addEventListener('click', () => setSize(b.dataset.size));
  });

  // History & Actions
  btnUndo.addEventListener('click', () => {
    sendWS({ type: 'undo' });
  });

  btnRedo.addEventListener('click', () => {
    sendWS({ type: 'redo' });
  });

  btnClear.addEventListener('click', () => {
    sendWS({ type: 'clear' });
    showToast('Screen cleared');
  });

  btnSnap.addEventListener('click', () => {
    sendNative('screenshot');
    showToast('📸 Screen snapshot copied to clipboard!');
  });

  btnPermWarn.addEventListener('click', () => {
    sendNative('openAccessibility');
  });

  // Native IPC Bridge for Secure Host Administration without DOM Secret Exposure
  window.__pendingHostIpc = new Map();
  window.__handleHostIpcResponse = (reqId, success, data, error) => {
    const pending = window.__pendingHostIpc.get(reqId);
    if (!pending) return;
    window.__pendingHostIpc.delete(reqId);
    if (success) pending.resolve(data);
    else pending.reject(new Error(error || 'Host API call failed'));
  };

  async function callHostApi(endpoint, method = 'GET', body = null) {
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tabSync) {
      return new Promise((resolve, reject) => {
        const reqId = 'ipc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        window.__pendingHostIpc.set(reqId, { resolve, reject });
        window.webkit.messageHandlers.tabSync.postMessage({
          action: 'hostApi',
          reqId,
          endpoint,
          method,
          body
        });
      });
    }
    // Fallback for standalone loopback browser testing
    const headers = { 'Content-Type': 'application/json' };
    const res = await fetch(endpoint, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    return res.json();
  }

  if (btnEmergencyStop) {
    btnEmergencyStop.addEventListener('click', async () => {
      sendWS({ type: 'emergency_stop' });
      try {
        await callHostApi('/api/emergency_stop', 'POST');
      } catch (e) {}
      showToast('⚠️ Emergency Stop: All remote input halted!');
    });
  }

  // Pairing & Paired Devices
  async function loadStatus() {
    try {
      const data = await callHostApi('/api/status');
      if (data.qrDataUrl) qrImg.src = data.qrDataUrl;
      tabletIpText.textContent = data.tabletUrl;

      if (data.pairingInfo && data.pairingInfo.pin) {
        pinNumber.textContent = data.pairingInfo.pin;
      }

      if (Array.isArray(data.pairedDevices)) {
        pairedCount.textContent = data.pairedDevices.length;
        renderDevices(data.pairedDevices);
      }
    } catch (e) {}
  }

  function renderDevices(devices) {
    if (!Array.isArray(devices) || devices.length === 0) {
      devicesList.innerHTML = '<div class="empty-state">No paired devices. Scan QR to pair a tablet.</div>';
      pairedCount.textContent = '0';
      return;
    }

    pairedCount.textContent = devices.length;
    devicesList.innerHTML = devices.map(d => `
      <div class="device-item" data-id="${d.deviceId}">
        <div class="dev-info">
          <div class="dev-name">${escapeHtml(d.name)}</div>
          <div class="dev-meta">${escapeHtml(d.model || 'Android Tablet')} • Last active: ${new Date(d.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        <button class="btn-revoke" data-id="${d.deviceId}">Revoke</button>
      </div>
    `).join('');

    devicesList.querySelectorAll('.btn-revoke').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.dataset.id;
        if (confirm('Revoke access for this tablet? It will not be able to reconnect until re-paired.')) {
          await callHostApi(`/api/devices/${id}/revoke`, 'POST');
          showToast('Device revoked');
          loadStatus();
        }
      });
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]);
  }

  btnRefreshPin.addEventListener('click', async () => {
    try {
      const data = await callHostApi('/api/pairing/refresh', 'POST');
      if (data.session && data.session.pin) {
        pinNumber.textContent = data.session.pin;
        showToast('Generated fresh pairing PIN');
        loadStatus();
      }
    } catch (e) {}
  });

  tabPairView.addEventListener('click', () => {
    tabPairView.classList.add('active');
    tabDevicesView.classList.remove('active');
    viewPairPanel.classList.remove('hidden');
    viewDevicesPanel.classList.add('hidden');
  });

  tabDevicesView.addEventListener('click', () => {
    tabDevicesView.classList.add('active');
    tabPairView.classList.remove('active');
    viewDevicesPanel.classList.remove('hidden');
    viewPairPanel.classList.add('hidden');
    loadStatus();
  });

  function toggleQr(open) {
    isQrOpen = typeof open === 'boolean' ? open : !isQrOpen;
    qrPopover.classList.toggle('hidden', !isQrOpen);
    if (isQrOpen) {
      loadStatus();
      sendNative('resizeWidget', { height: 380 });
    } else {
      sendNative('resizeWidget', { height: 68 });
    }
  }

  btnQr.addEventListener('click', () => toggleQr());
  closeQrBtn.addEventListener('click', () => toggleQr(false));

  btnClose.addEventListener('click', () => {
    sendNative('quit');
    fetch('/api/quit', { method: 'POST' }).catch(() => {});
  });

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey) {
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        sendWS({ type: 'undo' });
      } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
        e.preventDefault();
        sendWS({ type: 'redo' });
      } else if (e.key === 'k') {
        e.preventDefault();
        sendWS({ type: 'clear' });
      }
    }
  });

  connectWS();
  loadStatus();
})();

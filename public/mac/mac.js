/**
 * TabSync Studio - Mac Host Dashboard Logic (Upgraded)
 */
(function() {
  'use strict';

  // DOM Elements
  const canvasEl = document.getElementById('mac-canvas');
  const connectionPill = document.getElementById('connection-pill');
  const connectionText = document.getElementById('connection-text');
  const stylusCursor = document.getElementById('stylus-cursor');
  const tabletListEl = document.getElementById('tablet-list');
  const ipAddressListEl = document.getElementById('ip-address-list');
  const qrModal = document.getElementById('qr-modal');
  const qrCodeImg = document.getElementById('qr-code-img');
  const qrTabletUrl = document.getElementById('qr-tablet-url');
  const statStrokes = document.getElementById('stat-strokes');
  const macScreenRes = document.getElementById('mac-screen-res');
  const macAccessStatus = document.getElementById('mac-access-status');
  const bgSelector = document.getElementById('bg-selector');
  const toastEl = document.getElementById('mac-toast');

  // Initialize Canvas Engine
  const engine = new CanvasEngine(canvasEl, {
    backgroundStyle: 'dark-dots',
    isReadOnly: false
  });

  let ws = null;
  let serverStatusData = null;

  function showToast(msg, duration = 2500) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => {
      toastEl.classList.remove('show');
    }, duration);
  }

  // Fetch Server Network Status & QR code
  async function fetchStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      serverStatusData = data;

      if (data.qrDataUrl) {
        qrCodeImg.src = data.qrDataUrl;
      }
      qrTabletUrl.textContent = data.tabletUrl;

      if (data.backgroundStyle && bgSelector) {
        bgSelector.value = data.backgroundStyle;
        engine.setBackground(data.backgroundStyle);
      }

      ipAddressListEl.innerHTML = '';
      if (data.ipAddresses && data.ipAddresses.length > 0) {
        data.ipAddresses.forEach(ip => {
          const pill = document.createElement('div');
          pill.className = 'ip-pill';
          const url = `http://${ip.address}:${data.port}/tablet`;
          pill.innerHTML = `
            <span>${ip.address} <small style="color:var(--text-secondary)">(${ip.name})</small></span>
            <button class="copy-btn" data-url="${url}">Copy</button>
          `;
          ipAddressListEl.appendChild(pill);
        });

        ipAddressListEl.querySelectorAll('.copy-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            navigator.clipboard.writeText(btn.dataset.url);
            showToast('Copied tablet URL to clipboard!');
          });
        });
      }
    } catch (e) {
      console.error('Failed to fetch status:', e);
    }
  }

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'register',
        role: 'mac'
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {
        console.error('Invalid WS message:', e);
      }
    };

    ws.onclose = () => {
      connectionPill.className = 'connection-status waiting';
      connectionText.textContent = 'Server disconnected... Reconnecting';
      setTimeout(connectWebSocket, 2000);
    };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'init':
        if (msg.history && Array.isArray(msg.history)) {
          engine.history = msg.history;
          engine.redrawAll();
          statStrokes.textContent = engine.history.length;
        }
        if (msg.backgroundStyle) {
          engine.setBackground(msg.backgroundStyle);
          if (bgSelector) bgSelector.value = msg.backgroundStyle;
        }
        break;

      case 'tablet_status':
        updateTabletStatus(msg.status, msg.tablets || []);
        break;

      case 'mac_system_info':
        macScreenRes.textContent = `${msg.screenWidth} × ${msg.screenHeight}`;
        if (msg.accessibilityTrusted) {
          macAccessStatus.textContent = 'Granted (Active)';
          macAccessStatus.style.color = '#10b981';
        } else {
          macAccessStatus.textContent = 'Action Required';
          macAccessStatus.style.color = '#f59e0b';
        }
        break;

      case 'background_changed':
        if (msg.style) {
          engine.setBackground(msg.style);
          if (bgSelector) bgSelector.value = msg.style;
        }
        break;

      case 'stroke_start':
        engine.activeStroke = engine.startStroke(msg.stroke);
        engine.composite();
        updateStylusMarker(msg.stroke.points[0], msg.stroke.color);
        break;

      case 'stroke_point':
        if (engine.activeStroke) {
          engine.activeStroke.points.push(msg.point);
          engine.composite();
          updateStylusMarker(msg.point, engine.activeStroke.color);
        }
        break;

      case 'stroke_end':
        if (msg.stroke) {
          engine.activeStroke = msg.stroke;
          engine.commitActiveStroke();
          statStrokes.textContent = engine.history.length;
        } else {
          engine.commitActiveStroke();
        }
        hideStylusMarker();
        break;

      case 'clear':
        engine.clear();
        statStrokes.textContent = '0';
        break;

      case 'sync_history':
        engine.history = msg.history || [];
        engine.redrawAll();
        statStrokes.textContent = engine.history.length;
        break;

      case 'laser_pointer':
        if (msg.active) {
          engine.updateLaser(msg.nx, msg.ny, true);
        } else {
          engine.hideLaser();
        }
        break;
    }
  }

  function updateStylusMarker(pt, color) {
    if (!pt) return;
    const canvasPt = engine.toCanvas(pt.x, pt.y);
    const x = canvasPt.x / engine.dpr;
    const y = canvasPt.y / engine.dpr;

    stylusCursor.style.display = 'block';
    stylusCursor.style.left = `${x}px`;
    stylusCursor.style.top = `${y}px`;
    stylusCursor.style.borderColor = color || '#38bdf8';
    stylusCursor.style.boxShadow = `0 0 16px ${color || '#38bdf8'}`;

    const pressure = pt.p !== undefined ? pt.p : 0.5;
    const size = Math.max(12, Math.round(pressure * 28));
    stylusCursor.style.width = `${size}px`;
    stylusCursor.style.height = `${size}px`;
  }

  function hideStylusMarker() {
    stylusCursor.style.display = 'none';
  }

  function updateTabletStatus(status, tablets) {
    if (status === 'connected' && tablets.length > 0) {
      connectionPill.className = 'connection-status';
      const firstTab = tablets[0];
      const batteryStr = firstTab.battery !== null ? ` • 🔋 ${firstTab.battery}%` : '';
      connectionText.textContent = `Connected: ${firstTab.name}${batteryStr}`;

      tabletListEl.innerHTML = '';
      tablets.forEach(tab => {
        const item = document.createElement('div');
        item.className = 'device-item';
        item.innerHTML = `
          <div>
            <div class="device-name">📱 ${tab.name}</div>
            <div class="device-sub">${tab.ip}${tab.battery !== null ? ` • Battery: ${tab.battery}%` : ''}</div>
          </div>
          <span style="font-size: 11px; color: #10b981; font-weight: 600;">ACTIVE</span>
        `;
        tabletListEl.appendChild(item);
      });
    } else {
      connectionPill.className = 'connection-status waiting';
      connectionText.textContent = 'Waiting for Android Tablet...';
      tabletListEl.innerHTML = `
        <div style="font-size: 13px; color: var(--text-secondary); text-align: center; padding: 12px 0;">
          No tablets connected.<br>Scan QR code to connect!
        </div>
      `;
    }
  }

  // Floating Controls
  bgSelector.addEventListener('change', (e) => {
    const style = e.target.value;
    engine.setBackground(style);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'change_background', style }));
    }
  });

  document.getElementById('undo-btn').addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'undo' }));
    }
  });

  document.getElementById('clear-btn').addEventListener('click', () => {
    if (confirm('Clear the canvas on all connected devices?')) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'clear' }));
      }
    }
  });

  // Copy to Mac Clipboard
  document.getElementById('copy-clipboard-btn').addEventListener('click', async () => {
    try {
      const dataUrl = engine.exportImage('image/png');
      const res = await fetch(dataUrl);
      const blob = await res.blob();

      if (navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ]);
        showToast('📋 Canvas copied to Mac clipboard!');
      } else {
        showToast('Clipboard API not supported in this browser context');
      }
    } catch (err) {
      showToast('Error copying to clipboard: ' + err.message);
    }
  });

  // Save Image
  document.getElementById('save-image-btn').addEventListener('click', () => {
    const dataUrl = engine.exportImage('image/png');
    const link = document.createElement('a');
    link.download = `TabSync-Drawing-${Date.now()}.png`;
    link.href = dataUrl;
    link.click();
    showToast('💾 Saved high-resolution PNG');
  });

  // Sidebar Toggle
  const sideDrawer = document.getElementById('side-drawer');
  document.getElementById('sidebar-toggle-btn').addEventListener('click', () => {
    sideDrawer.classList.toggle('hidden');
    setTimeout(() => engine.resize(), 50);
  });

  // QR Modal
  const qrModalBtn = document.getElementById('qr-modal-btn');
  const closeModalBtn = document.getElementById('close-modal-btn');
  const copyUrlBtn = document.getElementById('copy-url-btn');

  qrModalBtn.addEventListener('click', () => {
    fetchStatus();
    qrModal.classList.add('open');
  });

  closeModalBtn.addEventListener('click', () => {
    qrModal.classList.remove('open');
  });

  qrModal.addEventListener('click', (e) => {
    if (e.target === qrModal) {
      qrModal.classList.remove('open');
    }
  });

  copyUrlBtn.addEventListener('click', () => {
    if (serverStatusData && serverStatusData.tabletUrl) {
      navigator.clipboard.writeText(serverStatusData.tabletUrl);
      showToast('Copied tablet link to clipboard!');
    }
  });

  document.getElementById('mac-fullscreen-btn').addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  fetchStatus();
  connectWebSocket();
})();

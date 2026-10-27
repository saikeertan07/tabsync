/**
 * TabSync Studio - Production Host Server & WebSocket Gateway
 * Manages secure cryptographic pairing, authenticated WebSocket sessions,
 * canvas synchronization, and native macOS input automation.
 */
const https = require('https');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const dgram = require('dgram');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const { PairingManager, validateMessage } = require('./security/pairing');

// Structured logging helper
const log = {
  info: (sub, msg) => console.log(`[${new Date().toISOString()}] [${sub}] ${msg}`),
  warn: (sub, msg) => console.warn(`[${new Date().toISOString()}] [${sub}] WARN: ${msg}`),
  error: (sub, msg) => console.error(`[${new Date().toISOString()}] [${sub}] ERROR: ${msg}`)
};

// Get local network IPv4 addresses (excluding loopback and virtual adapters)
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    // prioritize standard en0/wlan0 interfaces
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({
          name,
          address: iface.address
        });
      }
    }
  }
  return addresses;
}

const app = express();

// Strict HTTP Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self' wss: https:;");
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

let PORT = parseInt(process.env.PORT || '4444', 10);
const initialIps = getLocalIpAddresses().map(i => i.address);
const pairingManager = new PairingManager(null, initialIps);
const HOST_SECRET = crypto.randomBytes(32).toString('hex');

// Authenticated TLS Server for transport security and tamper resistance
const server = https.createServer({
  key: pairingManager.tlsCert.key,
  cert: pairingManager.tlsCert.cert
}, app);

const wss = new WebSocketServer({
  server,
  maxPayload: 65536 // 64 KB max payload to prevent memory exhaustion attacks
});

// Global drawing & state
let drawingHistory = [];
let redoHistory = [];
let currentBackgroundStyle = 'dark-dots';
let activeConnections = new Map(); // ws -> { role, deviceId, name, ip, connectedAt, isAuthenticated }
let macClients = new Set(); // internal widget & overlay clients on localhost
let isEmergencyStopActive = false; // Emergency stop state flag

// Operational Telemetry & Health Metrics
const serverStartTime = Date.now();
const serverMetrics = {
  totalConnections: 0,
  strokesProcessed: 0,
  inputMovesProcessed: 0,
  inputClicksProcessed: 0,
  blockedInputsCount: 0,
  emergencyStopsCount: 0
};

// Native Swift input controller for macOS mouse/digitizer automation
let macInputProcess = null;
const macInputPath = path.join(__dirname, 'mac-input');

function startMacInputProcess() {
  try {
    macInputProcess = spawn(macInputPath, [], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdoutBuffer = '';
    macInputProcess.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop(); // keep trailing partial

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('INFO')) {
          const parts = trimmed.split(' ');
          const screenWidth = parseFloat(parts[1]);
          const screenHeight = parseFloat(parts[2]);
          const isTrusted = parts[3] === '1';
          broadcastToMacs({
            type: 'mac_system_info',
            screenWidth,
            screenHeight,
            accessibilityTrusted: isTrusted
          });
        }
      }
    });

    macInputProcess.stderr.on('data', (data) => {
      log.error('mac-input', data.toString().trim());
    });

    macInputProcess.on('close', (code) => {
      log.info('mac-input', `Process closed with code ${code}`);
      macInputProcess = null;
    });

    sendToMacInput('info');
  } catch (err) {
    log.error('mac-input', `Could not start process: ${err.message}`);
  }
}

const ALLOWED_MAC_INPUT_COMMANDS = /^(move\s+[0-9.]+\s+[0-9.]+(\s+[0-9.]+)?|move_rel\s+-?[0-9.]+\s+-?[0-9.]+|down\s+(left|right|middle)(\s+[0-9.]+)?|up\s+(left|right|middle)|click(\s+(left|right|middle))?|rclick|scroll\s+-?[0-9]+\s+-?[0-9]+|type\s+[^\r\n]{1,256}|key\s+[0-9]+(\s+[a-z,]+)?|release_all|emergency_stop|resume_input|info)$/;

function sendToMacInput(cmd) {
  if (typeof cmd !== 'string' || !ALLOWED_MAC_INPUT_COMMANDS.test(cmd)) {
    log.error('mac-input', `Blocked invalid or disallowed native command: ${String(cmd).slice(0, 30)}`);
    return false;
  }
  if (!macInputProcess || !macInputProcess.stdin || macInputProcess.stdin.destroyed) {
    log.warn('mac-input', 'Native process dead or pipe destroyed; restarting...');
    startMacInputProcess();
    return false;
  }
  try {
    const ok = macInputProcess.stdin.write(cmd + '\n');
    if (!ok) {
      log.warn('mac-input', 'Native stdin buffer full (backpressure detected)');
    }
    return true;
  } catch (e) {
    log.error('mac-input', `Error writing command: ${e.message}`);
    return false;
  }
}

// Start native input engine
startMacInputProcess();

// Security Headers & Request Limit Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '64kb' }));

// Helper to verify loopback socket
function isLoopbackAddress(addr) {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.includes('127.0.0.1');
}

// In-memory rate limiting map
const rateLimitMap = new Map();
function simpleRateLimit(maxPerMinute) {
  return (req, res, next) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let record = rateLimitMap.get(ip);
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + 60000 };
      rateLimitMap.set(ip, record);
      return next();
    }
    record.count++;
    if (record.count > maxPerMinute) {
      log.warn('RateLimit', `Rate limit exceeded for IP ${ip}`);
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}

// Constant-time string comparison for host authorization
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Host Authorization Guard for Administrative Endpoints
function requireHostAuth(req, res, next) {
  // 1. Explicitly disallow query-string authentication (prevents credential leaks in access logs & URLs)
  if (req.query.host_secret || req.query.token) {
    return res.status(400).json({ error: 'Query-string authentication is prohibited. Use X-TabSync-Host-Secret header.' });
  }

  // 2. Cross-origin validation: exact parsing and validation of scheme, hostname, and port
  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsedOrigin = new URL(origin);
      const isLoopbackHost = parsedOrigin.hostname === 'localhost' || parsedOrigin.hostname === '127.0.0.1' || parsedOrigin.hostname === '[::1]';
      const isExpectedPort = !parsedOrigin.port || parseInt(parsedOrigin.port, 10) === PORT;
      const isAllowedScheme = parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:';

      if (!isLoopbackHost || !isExpectedPort || !isAllowedScheme) {
        log.warn('Security', `Blocked cross-origin request from disallowed origin ${origin} to ${req.path}`);
        return res.status(403).json({ error: 'Forbidden: cross-origin access disallowed' });
      }
    } catch (e) {
      log.warn('Security', `Malformed origin rejected: ${origin}`);
      return res.status(403).json({ error: 'Forbidden: malformed origin' });
    }
  }

  // 3. Header authorization check using constant-time safeCompare
  const tokenHeader = req.headers['x-tabsync-host-secret'];
  if (tokenHeader && safeCompare(tokenHeader, HOST_SECRET)) {
    return next();
  }

  log.warn('Security', `Unauthorized administrative request to ${req.path} from ${req.socket.remoteAddress}`);
  return res.status(401).json({ error: 'Unauthorized: Valid X-TabSync-Host-Secret required' });
}

// Disallow query parameter credentials across all routes (prevents HTTP access log & referrer leakage)
app.use((req, res, next) => {
  if (req.query && (req.query.token || req.query.pin || req.query.host_secret || req.query.secret)) {
    log.warn('Security', `Rejected query parameter credentials from ${req.ip}`);
    return res.status(400).json({ error: 'Query parameter credentials are strictly forbidden. Use URL hash fragments (#) or HTTP headers.' });
  }
  next();
});

// Admin Widget endpoint (restricted exclusively to local loopback interface)
app.get(['/widget', '/widget/index.html'], (req, res) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    log.warn('Security', `Blocked non-local access attempt to /widget from ${req.socket.remoteAddress}`);
    return res.status(403).send('Forbidden: Widget is only accessible from local Mac interface.');
  }
  const filePath = path.join(__dirname, 'public', 'widget', 'index.html');
  res.sendFile(filePath);
});

// Serve static assets
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------
// REST API ROUTES
// -------------------------------------------------------------

// Public Discovery Endpoint (rate-limited, zero sensitive tokens/PINs leaked)
app.get('/api/discovery', simpleRateLimit(120), (req, res) => {
  const ips = getLocalIpAddresses();
  const primaryIp = ips.length > 0 ? ips[0].address : 'localhost';
  res.json({
    service: 'tabsync-studio',
    version: '1.0.0',
    protocol: 'https',
    hostName: pairingManager.hostConfig.hostName,
    hostId: pairingManager.hostConfig.hostId,
    fingerprint: pairingManager.tlsCert.fingerprint,
    hostIp: primaryIp,
    port: PORT,
    pairingRequired: true
  });
});

// Public Health & System Diagnostics Endpoint (rate-limited, zero secrets leaked)
app.get('/api/health', simpleRateLimit(120), (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'healthy',
    service: 'tabsync-studio',
    version: '1.0.0',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    memory: {
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
      rssMb: Math.round(mem.rss / 1024 / 1024 * 100) / 100
    },
    activeClients: activeConnections.size,
    emergencyStop: isEmergencyStopActive
  });
});

// Authenticated Real-time Metrics & Operational Counters
app.get('/api/metrics', simpleRateLimit(60), requireHostAuth, (req, res) => {
  res.json({
    service: 'tabsync-studio',
    uptime: process.uptime(),
    serverStartedAt: new Date(serverStartTime).toISOString(),
    metrics: { ...serverMetrics },
    state: {
      activeConnections: activeConnections.size,
      activeTablets: Array.from(activeConnections.values()).filter(c => c.isAuthenticated && c.role === 'tablet').length,
      activeMacs: macClients.size,
      drawingHistoryCount: drawingHistory.length,
      isEmergencyStopActive
    }
  });
});

// Authenticated Host Status Endpoint
app.get('/api/status', simpleRateLimit(120), requireHostAuth, async (req, res) => {
  const ips = getLocalIpAddresses();
  const primaryIp = ips.length > 0 ? ips[0].address : 'localhost';
  const pairingInfo = pairingManager.getPairingInfo(primaryIp, PORT);
  // Use URL hash fragment for credentials (#token=...&pin=...) over secure HTTPS
  const tabletUrl = `https://${primaryIp}:${PORT}/tablet#token=${pairingInfo.token}&pin=${pairingInfo.pin}&fp=${encodeURIComponent(pairingInfo.fingerprint)}&hostId=${encodeURIComponent(pairingInfo.hostId)}&hostName=${encodeURIComponent(pairingInfo.hostName)}`;

  let qrDataUrl = '';
  try {
    // Generate QR with hash-based pairing URI
    qrDataUrl = await QRCode.toDataURL(tabletUrl, {
      margin: 1,
      width: 320,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
  } catch (e) {
    log.error('QR', `Generation error: ${e.message}`);
  }

  const authenticatedTablets = Array.from(activeConnections.values()).filter(c => c.isAuthenticated && c.role === 'tablet');

  res.json({
    port: PORT,
    ipAddresses: ips,
    primaryIp,
    tabletUrl,
    pairingInfo,
    qrDataUrl,
    pairedDevices: pairingManager.getPairedDevicesList(),
    activeTablets: authenticatedTablets.length,
    activeMacs: macClients.size,
    historyLength: drawingHistory.length
  });
});

app.post('/api/pairing/refresh', requireHostAuth, (req, res) => {
  const newSession = pairingManager.generateNewPairingSession();
  res.json({ success: true, session: newSession });
});

app.get('/api/devices', requireHostAuth, (req, res) => {
  res.json({ devices: pairingManager.getPairedDevicesList() });
});

app.post('/api/devices/:id/revoke', requireHostAuth, (req, res) => {
  const { id } = req.params;
  const success = pairingManager.revokeDevice(id);

  // Terminate any active socket for this revoked device and release inputs if it held ownership
  for (const [socket, meta] of activeConnections.entries()) {
    if (meta.deviceId === id) {
      if (currentInputOwner === socket) {
        currentInputOwner = null;
        sendToMacInput('release_all');
      }
      try {
        socket.send(JSON.stringify({ type: 'revoked', reason: 'Device authorization revoked by Mac user' }));
        socket.close(4003, 'Revoked');
      } catch (e) {}
      activeConnections.delete(socket);
    }
  }

  broadcastToMacs({ type: 'devices_updated', devices: pairingManager.getPairedDevicesList() });
  res.json({ success });
});

app.post('/api/devices/:id/rename', requireHostAuth, (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  const sanitizedName = typeof name === 'string' ? name.trim().slice(0, 50) : '';
  const success = pairingManager.renameDevice(id, sanitizedName);
  res.json({ success });
});

app.post('/api/canvas/clear', requireHostAuth, (req, res) => {
  drawingHistory = [];
  redoHistory = [];
  broadcastToAuthenticated({ type: 'clear' });
  res.json({ success: true });
});

app.post('/api/emergency_stop', requireHostAuth, (req, res) => {
  isEmergencyStopActive = true;
  log.warn('Security', 'Emergency Stop endpoint called: halting all remote inputs');
  sendToMacInput('emergency_stop');
  broadcastToAuthenticated({ type: 'emergency_stop_state', active: true });
  res.json({ success: true, isEmergencyStopActive: true });
});

app.post('/api/emergency_resume', requireHostAuth, (req, res) => {
  isEmergencyStopActive = false;
  log.info('Security', 'Emergency Stop deactivated: resuming remote inputs');
  sendToMacInput('resume_input');
  broadcastToAuthenticated({ type: 'emergency_stop_state', active: false });
  res.json({ success: true, isEmergencyStopActive: false });
});

app.get('/api/emergency_status', (req, res) => {
  res.json({ isEmergencyStopActive });
});

app.get(['/overlay', '/overlay/index.html'], (req, res) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    log.warn('Security', `Blocked non-local access attempt to /overlay from ${req.socket.remoteAddress}`);
    return res.status(403).send('Forbidden: Overlay is only accessible from local Mac interface.');
  }
  res.sendFile(path.join(__dirname, 'public', 'overlay', 'index.html'));
});

app.post('/api/quit', requireHostAuth, (req, res) => {
  res.json({ quitting: true });
  setTimeout(() => {
    cleanExit();
  }, 250);
});

app.get('/tablet', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tablet', 'index.html'));
});

app.get('/mac', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mac', 'index.html'));
});

app.get('/', (req, res) => {
  const ua = req.headers['user-agent'] || '';
  if (/Android|iPad|iPhone|Mobile/i.test(ua)) {
    return res.redirect('/tablet');
  }
  res.redirect('/widget');
});

function broadcastToMacs(data, excludeWs = null) {
  const payload = JSON.stringify(data);
  for (const client of macClients) {
    const meta = activeConnections.get(client);
    if (client !== excludeWs && meta?.isAuthenticated && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function broadcastToAuthenticated(data, excludeWs = null) {
  const payload = JSON.stringify(data);
  for (const [client, meta] of activeConnections.entries()) {
    if (client !== excludeWs && meta.isAuthenticated && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// Track input ownership across clients
let currentInputOwner = null;

// -------------------------------------------------------------
// WEBSOCKET SECURITY & EVENT ROUTING
// -------------------------------------------------------------
wss.on('connection', (ws, req) => {
  serverMetrics.totalConnections++;
  const ip = req.socket.remoteAddress || 'unknown';
  const isLocalhost = isLoopbackAddress(ip);

  const clientMeta = {
    role: 'unknown',
    deviceId: null,
    name: 'Unknown Client',
    ip: ip,
    connectedAt: Date.now(),
    isAuthenticated: false
  };

  activeConnections.set(ws, clientMeta);

  // Authentication timeout: unauthenticated connections are safely terminated after 10s
  const authTimeout = setTimeout(() => {
    if (!clientMeta.isAuthenticated) {
      log.warn('Security', `Closing unauthenticated connection from ${ip} (timeout)`);
      try {
        ws.send(JSON.stringify({ type: 'auth_timeout', message: 'Authentication required within 10 seconds' }));
        ws.close(4001, 'Authentication Timeout');
      } catch (e) {}
      activeConnections.delete(ws);
    }
  }, 10000);

  ws.on('message', (messageBuffer) => {
    let msg;
    try {
      msg = JSON.parse(messageBuffer.toString());
    } catch (e) {
      log.warn('Network', `Malformed JSON rejected from ${ip}`);
      return;
    }

    // Message schema validation
    const validation = validateMessage(msg);
    if (!validation.valid) {
      log.warn('Security', `Validation failed from ${ip}: ${validation.reason}`);
      return;
    }

    // Handle Authentication & Pairing Handshake
    switch (msg.type) {
      case 'pair_request': {
        if (clientMeta.isAuthenticated) {
          ws.send(JSON.stringify({ type: 'error', error: 'Already authenticated' }));
          return;
        }
        const pairResult = pairingManager.attemptPair(ip, msg);
        if (pairResult.success) {
          clientMeta.isAuthenticated = true;
          clientMeta.deviceId = msg.device.id;
          clientMeta.name = msg.device.name || 'Android Tablet';
          clientMeta.role = 'tablet';
          clearTimeout(authTimeout);

          log.info('Pairing', `✓ Successfully paired device: ${clientMeta.name} (${msg.device.id})`);
          ws.send(JSON.stringify({
            type: 'pair_success',
            authToken: pairResult.authToken,
            hostId: pairResult.hostId,
            hostName: pairResult.hostName,
            host: pairingManager.getHostIdentity()
          }));

          // Send initial application state only after authentication succeeds
          ws.send(JSON.stringify({
            type: 'init',
            history: drawingHistory,
            backgroundStyle: currentBackgroundStyle
          }));

          broadcastToMacs({
            type: 'tablet_status',
            status: 'connected',
            tablets: Array.from(activeConnections.values()).filter(c => c.isAuthenticated && c.role === 'tablet')
          });
        } else {
          log.warn('Pairing', `Pairing failed for ${ip}: ${pairResult.error}`);
          ws.send(JSON.stringify({
            type: 'pair_error',
            error: pairResult.error
          }));
        }
        return;
      }

      case 'auth': {
        if (clientMeta.isAuthenticated) {
          ws.send(JSON.stringify({ type: 'error', error: 'Already authenticated' }));
          return;
        }
        const device = pairingManager.verifyAuth(msg.deviceId, msg.authToken);
        if (device) {
          // Supersede existing connection for this device
          for (const [otherWs, otherMeta] of activeConnections.entries()) {
            if (otherWs !== ws && otherMeta.deviceId === device.deviceId) {
              log.info('Auth', `Replacing superseded connection for device ${device.deviceId}`);
              try {
                otherWs.send(JSON.stringify({ type: 'superseded', message: 'Reconnected from another session' }));
                otherWs.close(4004, 'Superseded');
              } catch (e) {}
              activeConnections.delete(otherWs);
            }
          }

          clientMeta.isAuthenticated = true;
          clientMeta.deviceId = device.deviceId;
          clientMeta.name = device.name;
          clientMeta.role = 'tablet';
          clearTimeout(authTimeout);

          log.info('Auth', `✓ Authenticated tablet: ${device.name} (${device.deviceId})`);
          ws.send(JSON.stringify({
            type: 'auth_success',
            deviceId: device.deviceId,
            name: device.name,
            hostId: pairingManager.hostConfig.hostId,
            hostName: pairingManager.hostConfig.hostName,
            host: pairingManager.getHostIdentity()
          }));

          // Send initial application state only after authentication succeeds
          ws.send(JSON.stringify({
            type: 'init',
            history: drawingHistory,
            backgroundStyle: currentBackgroundStyle
          }));

          broadcastToMacs({
            type: 'tablet_status',
            status: 'connected',
            tablets: Array.from(activeConnections.values()).filter(c => c.isAuthenticated && c.role === 'tablet')
          });
        } else {
          log.warn('Auth', `Failed auth from ${ip} for device ${msg.deviceId}`);
          ws.send(JSON.stringify({
            type: 'auth_error',
            error: 'Authentication failed. Please re-pair your tablet with the Mac.'
          }));
          ws.close(4002, 'Authentication Failed');
        }
        return;
      }

      case 'register': {
        if (clientMeta.isAuthenticated) {
          ws.send(JSON.stringify({ type: 'error', error: 'Already registered' }));
          return;
        }
        // Localhost internal registration (widget or overlay)
        if (isLocalhost && (msg.role === 'widget' || msg.role === 'overlay' || msg.role === 'mac')) {
          clientMeta.role = msg.role;
          clientMeta.isAuthenticated = true;
          clearTimeout(authTimeout);
          macClients.add(ws);

          ws.send(JSON.stringify({
            type: 'tablet_status',
            status: Array.from(activeConnections.values()).some(c => c.isAuthenticated && c.role === 'tablet') ? 'connected' : 'waiting',
            tablets: Array.from(activeConnections.values()).filter(c => c.isAuthenticated && c.role === 'tablet')
          }));

          // Send initial canvas state & background to internal Mac client
          ws.send(JSON.stringify({
            type: 'init',
            history: drawingHistory,
            backgroundStyle: currentBackgroundStyle
          }));

          sendToMacInput('info');
          return;
        }
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
        return;
      }
    }

    // -------------------------------------------------------------
    // PRIVILEGED COMMAND GATE: Reject all unauthenticated commands
    // -------------------------------------------------------------
    if (!clientMeta.isAuthenticated) {
      log.warn('Security', `Rejected unauthenticated command '${msg.type}' from ${ip}`);
      return;
    }

    // Replay Attack & Timestamp Freshness Check (Drop stale frames >15s or futuristic >5s)
    if (typeof msg.timestamp === 'number') {
      const now = Date.now();
      if (msg.timestamp < now - 15000 || msg.timestamp > now + 5000) {
        log.warn('Security', `Dropped expired/skewed message '${msg.type}' from ${clientMeta.deviceId} (delta: ${now - msg.timestamp}ms)`);
        return;
      }
    }

    // Privileged Command Routing
    switch (msg.type) {
      // Drawing events
      case 'stroke_start':
      case 'stroke_point':
      case 'stroke_end': {
        if (msg.type === 'stroke_end' && msg.stroke) {
          serverMetrics.strokesProcessed++;
          drawingHistory.push(msg.stroke);
          redoHistory = []; // clear redo on new stroke
          if (drawingHistory.length > 800) {
            drawingHistory.shift();
          }
        }
        broadcastToAuthenticated(msg, ws);
        break;
      }

      case 'undo': {
        if (drawingHistory.length > 0) {
          const undone = drawingHistory.pop();
          redoHistory.push(undone);
          if (redoHistory.length > 200) redoHistory.shift();
          broadcastToAuthenticated({ type: 'sync_history', history: drawingHistory });
        }
        break;
      }

      case 'redo': {
        if (redoHistory.length > 0) {
          const redone = redoHistory.pop();
          drawingHistory.push(redone);
          broadcastToAuthenticated({ type: 'sync_history', history: drawingHistory });
        }
        break;
      }

      case 'clear': {
        drawingHistory = [];
        redoHistory = [];
        broadcastToAuthenticated({ type: 'clear' });
        break;
      }

      case 'tool_change': {
        broadcastToAuthenticated({
          type: 'sync_tool',
          mode: msg.mode,
          color: msg.color,
          size: msg.size
        }, ws);
        break;
      }

      case 'laser_pointer': {
        broadcastToMacs(msg, ws);
        break;
      }

      // Virtual Graphics Tablet & Mouse Automation (Guarded by Emergency Stop state and Input Ownership)
      case 'input_move': {
        if (isEmergencyStopActive) {
          serverMetrics.blockedInputsCount++;
          ws.send(JSON.stringify({ type: 'input_blocked', reason: 'Emergency Stop is active' }));
          break;
        }
        serverMetrics.inputMovesProcessed++;
        if (typeof msg.x === 'number' && typeof msg.y === 'number') {
          const p = typeof msg.p === 'number' ? ` ${msg.p}` : '';
          sendToMacInput(`move ${msg.x} ${msg.y}${p}`);
        }
        break;
      }

      case 'input_move_rel': {
        if (isEmergencyStopActive) {
          serverMetrics.blockedInputsCount++;
          ws.send(JSON.stringify({ type: 'input_blocked', reason: 'Emergency Stop is active' }));
          break;
        }
        if (currentInputOwner && currentInputOwner !== ws) {
          serverMetrics.blockedInputsCount++;
          // Reject movement collision while another client owns the active drag
          break;
        }
        serverMetrics.inputMovesProcessed++;
        if (typeof msg.dx === 'number' && typeof msg.dy === 'number') {
          sendToMacInput(`move_rel ${msg.dx} ${msg.dy}`);
        }
        break;
      }

      case 'input_down': {
        if (isEmergencyStopActive) {
          serverMetrics.blockedInputsCount++;
          break;
        }
        if (currentInputOwner && currentInputOwner !== ws) {
          serverMetrics.blockedInputsCount++;
          log.warn('Input', `Client ${clientMeta.deviceId} input_down rejected: another client holds active input`);
          break;
        }
        serverMetrics.inputClicksProcessed++;
        currentInputOwner = ws;
        const p = typeof msg.p === 'number' ? ` ${msg.p}` : '';
        sendToMacInput(`down ${msg.button || 'left'}${p}`);
        break;
      }

      case 'input_up': {
        if (isEmergencyStopActive) break;
        if (currentInputOwner === ws || currentInputOwner === null) {
          currentInputOwner = null;
          sendToMacInput(`up ${msg.button || 'left'}`);
        }
        break;
      }

      case 'input_click': {
        if (isEmergencyStopActive) {
          serverMetrics.blockedInputsCount++;
          break;
        }
        if (currentInputOwner && currentInputOwner !== ws) {
          serverMetrics.blockedInputsCount++;
          // Collision prevention
          break;
        }
        serverMetrics.inputClicksProcessed++;
        if (msg.button === 'right') {
          sendToMacInput('rclick');
        } else if (msg.button === 'middle') {
          sendToMacInput('click middle');
        } else {
          sendToMacInput('click');
        }
        break;
      }

      case 'input_scroll': {
        if (isEmergencyStopActive) break;
        if (typeof msg.dy === 'number') {
          sendToMacInput(`scroll ${msg.dy} ${msg.dx || 0}`);
        }
        break;
      }

      case 'input_type': {
        if (isEmergencyStopActive) break;
        if (typeof msg.text === 'string') {
          const cleanText = msg.text.replace(/[\r\n\t\x00-\x1f]/g, ' ');
          sendToMacInput(`type ${cleanText}`);
        }
        break;
      }

      case 'emergency_stop': {
        serverMetrics.emergencyStopsCount++;
        isEmergencyStopActive = true;
        log.warn('Security', 'Emergency Stop received via WebSocket: halting all remote inputs');
        sendToMacInput('emergency_stop');
        broadcastToAuthenticated({ type: 'emergency_stop_state', active: true });
        break;
      }

      case 'resume_input': {
        if (clientMeta.isAuthenticated) {
          isEmergencyStopActive = false;
          log.info('Security', 'Remote input resumed via WebSocket');
          sendToMacInput('resume_input');
          broadcastToAuthenticated({ type: 'emergency_stop_state', active: false });
        }
        break;
      }

      default:
        broadcastToAuthenticated(msg, ws);
        break;
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    activeConnections.delete(ws);
    macClients.delete(ws);

    // Input ownership: safely release held inputs if disconnecting client owned them
    // or if no authenticated tablet clients remain connected
    const remainingTablets = Array.from(activeConnections.values()).filter(c => c.isAuthenticated && c.role === 'tablet');
    if (currentInputOwner === ws || remainingTablets.length === 0) {
      currentInputOwner = null;
      sendToMacInput('release_all');
    }

    if (clientMeta.role === 'tablet' && clientMeta.isAuthenticated) {
      log.info('Network', `Tablet disconnected: ${clientMeta.name} (${ip})`);
      broadcastToMacs({
        type: 'tablet_status',
        status: remainingTablets.length > 0 ? 'connected' : 'disconnected',
        tablets: remainingTablets
      });
    }
  });

  ws.on('error', (err) => {
    log.error('Network', `Socket error for ${ip}: ${err.message}`);
    const remainingTablets = Array.from(activeConnections.values()).filter(c => c.isAuthenticated && c.role === 'tablet');
    if (currentInputOwner === ws || remainingTablets.length === 0) {
      currentInputOwner = null;
      sendToMacInput('release_all');
    }
  });
});

// -------------------------------------------------------------
// LOCAL NETWORK UDP DISCOVERY BEACON
// -------------------------------------------------------------
let udpSocket = null;
let udpBroadcastInterval = null;
const UDP_PORT = 44445;

function startUdpDiscovery() {
  try {
    udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    udpSocket.on('error', (err) => {
      log.warn('Discovery', `UDP socket: ${err.message}`);
    });

    udpSocket.on('message', (msg, rinfo) => {
      try {
        const text = msg.toString('utf8');
        if (text.includes('TABSYNC_DISCOVER')) {
          const ips = getLocalIpAddresses();
          const primaryIp = ips.length > 0 ? ips[0].address : '127.0.0.1';
          const reply = JSON.stringify({
            type: 'tabsync_host_presence',
            service: 'tabsync-studio',
            version: '1.0.0',
            hostName: pairingManager.hostConfig.hostName,
            hostId: pairingManager.hostConfig.hostId,
            hostIp: primaryIp,
            port: PORT
          });
          udpSocket.send(reply, 0, reply.length, rinfo.port, rinfo.address);
        }
      } catch (e) {}
    });

    udpSocket.bind(UDP_PORT, () => {
      try {
        udpSocket.setBroadcast(true);
        log.info('Discovery', `UDP beacon active on port ${UDP_PORT}`);
      } catch (e) {
        log.warn('Discovery', `setBroadcast: ${e.message}`);
      }
    });

    udpBroadcastInterval = setInterval(broadcastUdpBeacon, 4000);
    broadcastUdpBeacon();
  } catch (err) {
    log.warn('Discovery', `Could not initialize UDP broadcast: ${err.message}`);
  }
}

function broadcastUdpBeacon() {
  if (!udpSocket) return;
  const ips = getLocalIpAddresses();
  const primaryIp = ips.length > 0 ? ips[0].address : '127.0.0.1';
  const beaconPayload = Buffer.from(JSON.stringify({
    type: 'tabsync_beacon',
    service: 'tabsync-studio',
    version: '1.0.0',
    proto: 'https',
    hostName: pairingManager.hostConfig.hostName,
    hostId: pairingManager.hostConfig.hostId,
    fingerprint: pairingManager.tlsCert.fingerprint,
    hostIp: primaryIp,
    port: PORT,
    timestamp: Date.now()
  }));

  try {
    udpSocket.send(beaconPayload, 0, beaconPayload.length, UDP_PORT, '255.255.255.255', (err) => {
      if (err && err.code !== 'EACCES') {
        // Suppress transient broadcast network errors
      }
    });
  } catch (e) {}
}

function stopUdpDiscovery() {
  if (udpBroadcastInterval) {
    clearInterval(udpBroadcastInterval);
    udpBroadcastInterval = null;
  }
  if (udpSocket) {
    try { udpSocket.close(); } catch (e) {}
    udpSocket = null;
  }
}

function saveSessionInfo() {
  try {
    const sessionFile = path.join(pairingManager.configDir, 'host_session.json');
    fs.writeFileSync(sessionFile, JSON.stringify({
      hostSecret: HOST_SECRET,
      port: PORT,
      pid: process.pid,
      fingerprint: pairingManager.tlsCert.fingerprint,
      startedAt: Date.now()
    }, null, 2), { mode: 0o600 });
  } catch (e) {
    log.warn('Server', `Could not write host_session.json: ${e.message}`);
  }
}

function removeSessionInfo() {
  try {
    const sessionFile = path.join(pairingManager.configDir, 'host_session.json');
    if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
  } catch (e) {}
}

// Port retry & listener
function startListening(portToTry) {
  server.listen(portToTry, '0.0.0.0', () => {
    PORT = portToTry;
    saveSessionInfo();
    startUdpDiscovery();
    const ips = getLocalIpAddresses();
    log.info('Server', `⚡ TabSync Studio Host listening on port ${PORT} (HTTPS & WSS)`);
    ips.forEach(ip => {
      log.info('Server', `   ➜ https://${ip.address}:${PORT}/tablet (${ip.name})`);
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.warn('Server', `Port ${portToTry} in use, trying ${portToTry + 1}...`);
      startListening(portToTry + 1);
    } else {
      log.error('Server', `Server error: ${err.message}`);
    }
  });
}

startListening(PORT);

const cleanExit = () => {
  log.info('Server', 'Graceful shutdown initiated...');
  stopUdpDiscovery();
  removeSessionInfo();
  if (macInputProcess) {
    sendToMacInput('release_all');
    sendToMacInput('quit');
    try { macInputProcess.kill('SIGKILL'); } catch (e) {}
  }
  process.exit(0);
};

process.on('SIGINT', cleanExit);
process.on('SIGTERM', cleanExit);
process.on('exit', () => {
  stopUdpDiscovery();
  removeSessionInfo();
  if (macInputProcess) {
    try {
      sendToMacInput('release_all');
      macInputProcess.kill('SIGKILL');
    } catch (e) {}
  }
});

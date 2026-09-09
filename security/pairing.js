/**
 * TabSync Studio - Cryptographic Pairing & Authentication Subsystem
 * Production-grade security for local network remote control & annotation
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { getOrCreateTlsCertificate, normalizeFingerprint, formatFingerprint } = require('./tls');

/**
 * Constant-time string comparison resistant to timing attacks and RangeError
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Atomic file writer using temporary file creation and atomic rename.
 * Creates an automatic .bak backup to survive power cuts, process kills, and disk failures.
 */
function atomicWriteJsonSync(filePath, data, mode = 0o600) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const bakPath = filePath + '.bak';
  const serialized = JSON.stringify(data, null, 2);

  // 1. Write to temporary file with restrictive permissions
  fs.writeFileSync(tempPath, serialized, { mode, encoding: 'utf8' });

  // 2. Backup existing file before replacement
  try {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, bakPath);
    } else {
      fs.writeFileSync(bakPath, serialized, { mode, encoding: 'utf8' });
    }
  } catch (e) {
    // Non-fatal if backup fails
  }

  // 3. Atomic rename replaces destination in one filesystem metadata operation
  fs.renameSync(tempPath, filePath);
}

class PairingManager {
  constructor(configDir, hostIps = []) {
    this.configDir = configDir || path.join(os.homedir(), '.tabsync');
    this.configFile = path.join(this.configDir, 'host_config.json');
    this.devicesFile = path.join(this.configDir, 'paired_devices.json');

    this.hostConfig = null;
    this.pairedDevices = new Map(); // deviceId -> { deviceId, name, model, authSecret, pairedAt, lastSeen }
    
    // Active ephemeral pairing session
    this.activePairingToken = null;
    this.activePairingPin = null;
    this.pairingExpiresAt = 0;
    
    // Rate-limiting for brute force protection
    this.failedAttempts = new Map(); // ip -> { count, lockedUntil }

    this.ensureDirectory();
    this.tlsCert = getOrCreateTlsCertificate(this.configDir, hostIps);
    this.loadOrCreateHostConfig();
    this.loadPairedDevices();
    this.generateNewPairingSession();
  }

  getHostIdentity() {
    return {
      id: this.hostConfig.hostId,
      name: this.hostConfig.hostName,
      fingerprint: this.tlsCert.fingerprint
    };
  }

  ensureDirectory() {
    try {
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
      }
    } catch (e) {
      console.error('[Security] Could not create ~/.tabsync, falling back to local data dir:', e.message);
      this.configDir = path.join(__dirname, '..', 'data');
      fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
      this.configFile = path.join(this.configDir, 'host_config.json');
      this.devicesFile = path.join(this.configDir, 'paired_devices.json');
    }
  }

  loadOrCreateHostConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        const raw = fs.readFileSync(this.configFile, 'utf8');
        this.hostConfig = JSON.parse(raw);
      }
    } catch (e) {
      console.warn('[Security] Failed to read host_config, regenerating:', e.message);
    }

    if (!this.hostConfig || !this.hostConfig.hostId) {
      this.hostConfig = {
        hostId: 'mac-' + crypto.randomUUID(),
        hostName: os.hostname() || 'MacBook Pro',
        createdAt: Date.now(),
        protocolVersion: 1
      };
    }
    this.hostConfig.hostFingerprint = this.tlsCert.fingerprint;
    this.saveHostConfig();
  }

  saveHostConfig() {
    try {
      atomicWriteJsonSync(this.configFile, this.hostConfig, 0o600);
    } catch (e) {
      console.error('[Security] Failed to atomic-save host config:', e.message);
    }
  }

  loadPairedDevices() {
    this.pairedDevices.clear();
    let parsedList = null;

    // 1. Try loading primary paired_devices.json
    if (fs.existsSync(this.devicesFile)) {
      try {
        const raw = fs.readFileSync(this.devicesFile, 'utf8');
        parsedList = JSON.parse(raw);
      } catch (e) {
        console.warn('[Security] Corrupted or unreadable paired_devices.json:', e.message);
      }
    }

    // 2. If primary missing or corrupted, try reading backup file .bak
    if (!parsedList && fs.existsSync(this.devicesFile + '.bak')) {
      try {
        console.warn('[Security] Primary paired devices file invalid, attempting recovery from .bak');
        const rawBak = fs.readFileSync(this.devicesFile + '.bak', 'utf8');
        parsedList = JSON.parse(rawBak);
      } catch (e) {
        console.error('[Security] Failed to read or parse paired devices backup:', e.message);
      }
    }

    if (Array.isArray(parsedList)) {
      for (const dev of parsedList) {
        // Validate required fields and cryptographic format
        if (dev && typeof dev.deviceId === 'string' && dev.deviceId.trim().length > 0 &&
            typeof dev.authSecret === 'string' && dev.authSecret.trim().length === 64) {
          this.pairedDevices.set(dev.deviceId.trim(), {
            deviceId: dev.deviceId.trim(),
            name: typeof dev.name === 'string' ? dev.name.slice(0, 50) : 'Tablet',
            model: typeof dev.model === 'string' ? dev.model.slice(0, 50) : 'Tablet',
            os: typeof dev.os === 'string' ? dev.os.slice(0, 30) : 'Android',
            authSecret: dev.authSecret.trim(),
            pairedAt: typeof dev.pairedAt === 'number' ? dev.pairedAt : Date.now(),
            lastSeen: typeof dev.lastSeen === 'number' ? dev.lastSeen : Date.now(),
            ip: typeof dev.ip === 'string' ? dev.ip : 'unknown'
          });
        }
      }
    }
  }

  savePairedDevices() {
    try {
      const list = Array.from(this.pairedDevices.values());
      atomicWriteJsonSync(this.devicesFile, list, 0o600);
    } catch (e) {
      console.error('[Security] Failed to atomic-save paired devices:', e.message);
    }
  }

  /**
   * Generates a new 5-minute ephemeral pairing token and 6-digit human PIN
   */
  generateNewPairingSession() {
    this.activePairingToken = crypto.randomBytes(16).toString('hex');
    // Generate secure 6-digit numeric PIN (e.g. 482915)
    const pinNum = crypto.randomInt(100000, 999999);
    this.activePairingPin = pinNum.toString();
    this.pairingExpiresAt = Date.now() + (5 * 60 * 1000); // 5 minutes
    return {
      token: this.activePairingToken,
      pin: this.activePairingPin,
      expiresAt: this.pairingExpiresAt
    };
  }

  getPairingInfo(hostIp, port) {
    // Regenerate if expired
    if (Date.now() > this.pairingExpiresAt) {
      this.generateNewPairingSession();
    }

    const hostIdentity = this.getHostIdentity();
    const payload = {
      v: 1,
      action: 'pair',
      protocol: 'https',
      host: hostIp,
      port: port,
      token: this.activePairingToken,
      pin: this.activePairingPin,
      hostName: this.hostConfig.hostName,
      hostId: this.hostConfig.hostId,
      fingerprint: this.tlsCert.fingerprint,
      host: hostIdentity,
      expires: this.pairingExpiresAt
    };

    return {
      ...payload,
      pairingUri: `tabsync://pair?v=1&host=${encodeURIComponent(hostIp)}&port=${port}&proto=https&token=${this.activePairingToken}&pin=${this.activePairingPin}&fp=${encodeURIComponent(this.tlsCert.fingerprint)}&hostId=${encodeURIComponent(this.hostConfig.hostId)}&hostName=${encodeURIComponent(this.hostConfig.hostName)}`
    };
  }

  /**
   * Rate limiting check for remote IP
   */
  checkRateLimit(ip) {
    const entry = this.failedAttempts.get(ip);
    if (!entry) return true;
    if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
      return false; // locked out
    }
    if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
      this.failedAttempts.delete(ip);
    }
    return true;
  }

  recordFailedAttempt(ip) {
    let entry = this.failedAttempts.get(ip) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= 5) {
      entry.lockedUntil = Date.now() + (5 * 60 * 1000); // 5 min lockout
      console.warn(`[Security] IP ${ip} exceeded failed pairing attempts; locked out for 5 minutes.`);
    }
    this.failedAttempts.set(ip, entry);
  }

  resetFailedAttempts(ip) {
    this.failedAttempts.delete(ip);
  }

  /**
   * Validate a pairing request from Android tablet.
   * Defines explicit credential policies for QR flow vs manual PIN flow.
   */
  attemptPair(ip, { flow, token, pin, device }) {
    if (!this.checkRateLimit(ip)) {
      return { success: false, error: 'Too many failed pairing attempts. Please wait 5 minutes.' };
    }

    if (Date.now() > this.pairingExpiresAt) {
      this.recordFailedAttempt(ip);
      return { success: false, error: 'Pairing session expired. Please refresh the QR code on your Mac.' };
    }

    if (!device || typeof device !== 'object' || !device.id || typeof device.id !== 'string' || device.id.trim().length === 0) {
      return { success: false, error: 'Invalid device metadata: device.id is required.' };
    }

    let credentialValid = false;

    // Explicit QR Code Pairing Flow
    if (flow === 'qr') {
      if (typeof token !== 'string' || token.trim().length !== 32) {
        this.recordFailedAttempt(ip);
        return { success: false, error: 'QR pairing requires a 32-character pairing token.' };
      }
      credentialValid = safeCompare(token.trim(), this.activePairingToken);
      if (!credentialValid) {
        this.recordFailedAttempt(ip);
        return { success: false, error: 'Invalid or expired QR pairing token.' };
      }
    } 
    // Explicit Manual PIN Pairing Flow
    else if (flow === 'pin') {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin.trim())) {
        this.recordFailedAttempt(ip);
        return { success: false, error: 'Manual PIN pairing requires a 6-digit numeric PIN.' };
      }
      credentialValid = safeCompare(pin.trim(), this.activePairingPin);
      if (!credentialValid) {
        this.recordFailedAttempt(ip);
        return { success: false, error: 'Invalid security PIN code.' };
      }
    }
    // Unified/Auto-detection flow: strictly checks the supplied credential
    else {
      // If token is provided, it must be valid
      if (token && typeof token === 'string' && token.trim().length > 0) {
        if (!safeCompare(token.trim(), this.activePairingToken)) {
          this.recordFailedAttempt(ip);
          return { success: false, error: 'Invalid pairing token.' };
        }
        credentialValid = true;
      }
      // If pin is provided without token, it must be valid 6-digit PIN
      else if (pin && typeof pin === 'string' && pin.trim().length > 0) {
        if (!/^\d{6}$/.test(pin.trim()) || !safeCompare(pin.trim(), this.activePairingPin)) {
          this.recordFailedAttempt(ip);
          return { success: false, error: 'Invalid security PIN code.' };
        }
        credentialValid = true;
      } else {
        this.recordFailedAttempt(ip);
        return { success: false, error: 'Missing pairing credentials (token or pin required).' };
      }
    }

    if (!credentialValid) {
      this.recordFailedAttempt(ip);
      return { success: false, error: 'Authentication failed.' };
    }

    this.resetFailedAttempts(ip);

    // Generate persistent 256-bit cryptographic auth secret
    const authSecret = crypto.randomBytes(32).toString('hex');
    const deviceRecord = {
      deviceId: device.id.trim(),
      name: (device.name && typeof device.name === 'string') ? device.name.trim().slice(0, 50) : 'Android Tablet',
      model: (device.model && typeof device.model === 'string') ? device.model.trim().slice(0, 50) : 'Tablet',
      os: (device.os && typeof device.os === 'string') ? device.os.trim().slice(0, 30) : 'Android',
      authSecret: authSecret,
      pairedAt: Date.now(),
      lastSeen: Date.now(),
      ip: ip
    };

    this.pairedDevices.set(device.id.trim(), deviceRecord);
    this.savePairedDevices();

    // Expire current pairing session immediately so token/PIN cannot be reused (Single-Use Policy)
    this.generateNewPairingSession();

    return {
      success: true,
      authToken: authSecret,
      hostId: this.hostConfig.hostId,
      hostName: this.hostConfig.hostName,
      host: this.getHostIdentity()
    };
  }

  /**
   * Verify an authenticated session from Android tablet
   */
  verifyAuth(deviceId, authToken) {
    if (!deviceId || !authToken || typeof deviceId !== 'string' || typeof authToken !== 'string') {
      return false;
    }

    const device = this.pairedDevices.get(deviceId);
    if (!device) return false;

    try {
      if (safeCompare(authToken, device.authSecret)) {
        device.lastSeen = Date.now();
        this.savePairedDevices();
        return device;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  getPairedDevicesList() {
    return Array.from(this.pairedDevices.values()).map(dev => ({
      deviceId: dev.deviceId,
      name: dev.name,
      model: dev.model,
      pairedAt: dev.pairedAt,
      lastSeen: dev.lastSeen,
      ip: dev.ip
    }));
  }

  renameDevice(deviceId, newName) {
    const dev = this.pairedDevices.get(deviceId);
    if (dev && newName && typeof newName === 'string') {
      dev.name = newName.trim().slice(0, 40);
      this.savePairedDevices();
      return true;
    }
    return false;
  }

  revokeDevice(deviceId) {
    if (this.pairedDevices.has(deviceId)) {
      this.pairedDevices.delete(deviceId);
      this.savePairedDevices();
      return true;
    }
    return false;
  }
}

// -------------------------------------------------------------
// STRICT MESSAGE VALIDATION & ALLOWLISTING
// -------------------------------------------------------------
const ALLOWED_MESSAGE_TYPES = new Set([
  'auth', 'pair_request', 'register', 'ping', 'pong',
  'stroke_start', 'stroke_point', 'stroke_end', 'clear', 'undo', 'redo',
  'sync_tool', 'tool_change', 'laser_pointer',
  'input_move', 'input_move_rel', 'input_click', 'input_down', 'input_up',
  'input_scroll', 'input_type', 'emergency_stop', 'resume_input'
]);

function validateMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { valid: false, reason: 'Payload must be a non-null JSON object' };
  }
  if (typeof msg.type !== 'string' || msg.type.length === 0 || msg.type.length > 50) {
    return { valid: false, reason: 'Invalid or missing message type' };
  }
  if (!ALLOWED_MESSAGE_TYPES.has(msg.type)) {
    return { valid: false, reason: `Disallowed or unknown message type: ${msg.type}` };
  }

  switch (msg.type) {
    case 'auth':
      if (typeof msg.deviceId !== 'string' || msg.deviceId.length === 0 ||
          typeof msg.authToken !== 'string' || msg.authToken.length !== 64) {
        return { valid: false, reason: 'auth requires non-empty deviceId and 64-char authToken' };
      }
      return { valid: true };

    case 'pair_request':
      if (!msg.token && !msg.pin) return { valid: false, reason: 'pair_request requires token or pin' };
      if (!msg.device || typeof msg.device !== 'object' || typeof msg.device.id !== 'string' || msg.device.id.trim().length === 0) {
        return { valid: false, reason: 'pair_request requires valid device.id' };
      }
      return { valid: true };

    case 'stroke_start':
      if (!msg.stroke || typeof msg.stroke !== 'object') return { valid: false, reason: 'stroke_start requires stroke object' };
      if (!Array.isArray(msg.stroke.points) || msg.stroke.points.length === 0) return { valid: false, reason: 'stroke.points must be non-empty array' };
      if (msg.stroke.points.length > 2000) return { valid: false, reason: 'stroke exceeds max point limit (2000)' };
      for (const pt of msg.stroke.points) {
        if (!pt || typeof pt !== 'object') return { valid: false, reason: 'stroke point must be object' };
        if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y) || pt.x < 0 || pt.x > 1 || pt.y < 0 || pt.y > 1) {
          return { valid: false, reason: 'stroke coordinates must be finite numbers in [0, 1]' };
        }
      }
      return { valid: true };

    case 'stroke_point':
      if (!msg.point || typeof msg.point !== 'object') return { valid: false, reason: 'stroke_point requires point object' };
      if (!Number.isFinite(msg.point.x) || !Number.isFinite(msg.point.y) ||
          msg.point.x < 0 || msg.point.x > 1 || msg.point.y < 0 || msg.point.y > 1) {
        return { valid: false, reason: 'point coordinates must be finite numbers in [0, 1]' };
      }
      return { valid: true };

    case 'stroke_end':
      if (msg.stroke) {
        if (typeof msg.stroke !== 'object' || !Array.isArray(msg.stroke.points)) {
          return { valid: false, reason: 'stroke_end stroke must have points array' };
        }
        if (msg.stroke.points.length > 5000) {
          return { valid: false, reason: 'stroke exceeds max point limit (5000)' };
        }
      }
      return { valid: true };

    case 'input_move_rel':
      if (!Number.isFinite(msg.dx) || !Number.isFinite(msg.dy)) {
        return { valid: false, reason: 'dx and dy must be finite numbers' };
      }
      msg.dx = Math.max(-200, Math.min(200, msg.dx));
      msg.dy = Math.max(-200, Math.min(200, msg.dy));
      return { valid: true };

    case 'input_move':
      if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y) || msg.x < 0 || msg.x > 1 || msg.y < 0 || msg.y > 1) {
        return { valid: false, reason: 'Coordinates x and y must be finite numbers in [0, 1]' };
      }
      return { valid: true };

    case 'input_click':
    case 'input_down':
    case 'input_up':
      if (msg.button && !['left', 'right', 'middle'].includes(msg.button)) {
        return { valid: false, reason: 'Invalid mouse button (only left, right, middle allowed)' };
      }
      return { valid: true };

    case 'input_scroll':
      if (!Number.isFinite(msg.dy)) return { valid: false, reason: 'dy must be a finite number' };
      if (msg.dx !== undefined && !Number.isFinite(msg.dx)) return { valid: false, reason: 'dx must be a finite number' };
      msg.dy = Math.max(-100, Math.min(100, msg.dy));
      msg.dx = Number.isFinite(msg.dx) ? Math.max(-100, Math.min(100, msg.dx)) : 0;
      return { valid: true };

    case 'input_type':
      if (typeof msg.text !== 'string') return { valid: false, reason: 'text must be string' };
      if (msg.text.length > 256) msg.text = msg.text.slice(0, 256);
      return { valid: true };

    case 'laser_pointer':
      if (typeof msg.x === 'number') {
        if (!Number.isFinite(msg.x)) return { valid: false, reason: 'laser x out of range' };
        msg.x = Math.max(0, Math.min(1, msg.x));
      }
      if (typeof msg.y === 'number') {
        if (!Number.isFinite(msg.y)) return { valid: false, reason: 'laser y out of range' };
        msg.y = Math.max(0, Math.min(1, msg.y));
      }
      return { valid: true };

    case 'emergency_stop':
    case 'resume_input':
    case 'ping':
    case 'pong':
    case 'clear':
    case 'undo':
    case 'redo':
    case 'register':
    case 'tool_change':
    case 'sync_tool':
      return { valid: true };

    default:
      return { valid: false, reason: `Disallowed message: ${msg.type}` };
  }
}

module.exports = {
  PairingManager,
  validateMessage,
  normalizeFingerprint,
  formatFingerprint
};

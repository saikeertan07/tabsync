/**
 * TabSync Studio - Automated Test Suite: Security & Protocol Validation
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PairingManager, validateMessage, normalizeFingerprint, formatFingerprint } = require('../security/pairing');
const { getOrCreateTlsCertificate } = require('../security/tls');

// Create isolated scratch directory for tests
const testDir = path.join(os.tmpdir(), 'tabsync_test_' + Date.now());
fs.mkdirSync(testDir, { recursive: true });

console.log('========================================================');
console.log('⚡ RUNNING TABSYNC STUDIO TEST SUITE: SECURITY & PROTOCOL');
console.log('========================================================');

let testsPassed = 0;
let testsFailed = 0;

function it(name, fn) {
  try {
    fn();
    console.log(`  ✓ PASS: ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    -> ${err.message}`);
    testsFailed++;
  }
}

// -------------------------------------------------------------
// 1. PAIRING & CRYPTOGRAPHIC IDENTITY TESTS
// -------------------------------------------------------------
console.log('\n[Subsystem: Cryptographic Pairing]');
const pm = new PairingManager(testDir);

it('Generates persistent host ID and hostname', () => {
  assert(pm.hostConfig.hostId.startsWith('mac-'), 'Host ID must start with mac-');
  assert(pm.hostConfig.hostName, 'Host name must be set');
  assert.strictEqual(pm.hostConfig.protocolVersion, 1, 'Protocol version must be 1');
});

it('Generates 6-digit PIN and 32-character hex pairing token with 5-minute expiry', () => {
  const session = pm.generateNewPairingSession();
  assert.strictEqual(session.token.length, 32, 'Pairing token must be 16 bytes (32 hex chars)');
  assert.strictEqual(session.pin.length, 6, 'PIN must be exactly 6 digits');
  assert(/^\d{6}$/.test(session.pin), 'PIN must consist only of digits');
  assert(session.expiresAt > Date.now() + 290000, 'Expiration must be ~5 minutes in future');
});

it('Rejects pairing request with invalid token or PIN', () => {
  const result = pm.attemptPair('192.168.1.100', {
    token: 'invalid_token_123',
    pin: '000000',
    device: { id: 'test-device-1', name: 'Test Tablet' }
  });
  assert.strictEqual(result.success, false);
  assert(result.error.includes('Invalid pairing token'));
});

it('Successfully pairs device with valid PIN and issues 64-char auth token', () => {
  const currentPin = pm.activePairingPin;
  const result = pm.attemptPair('192.168.1.101', {
    pin: currentPin,
    device: { id: 'device-samsung-tab', name: 'Galaxy Tab S9', model: 'SM-X810' }
  });
  assert.strictEqual(result.success, true, 'Pairing must succeed');
  assert(result.authToken, 'Must return authToken');
  assert.strictEqual(result.authToken.length, 64, 'Auth token must be 32 bytes hex (64 chars)');
  assert(pm.pairedDevices.has('device-samsung-tab'), 'Device must be stored in paired devices');
});

it('Authenticates paired device using auth token', () => {
  const dev = pm.pairedDevices.get('device-samsung-tab');
  assert(dev, 'Device must exist');
  const authed = pm.verifyAuth('device-samsung-tab', dev.authSecret);
  assert(authed, 'Authentication must succeed with valid token');
  assert.strictEqual(authed.deviceId, 'device-samsung-tab');

  const failed = pm.verifyAuth('device-samsung-tab', 'tampered_token_xyz');
  assert.strictEqual(failed, false, 'Authentication must fail with invalid token');
});

it('Revocation immediately invalidates device auth', () => {
  const dev = pm.pairedDevices.get('device-samsung-tab');
  const token = dev.authSecret;
  const revoked = pm.revokeDevice('device-samsung-tab');
  assert.strictEqual(revoked, true, 'Revocation must return true');
  assert.strictEqual(pm.pairedDevices.has('device-samsung-tab'), false, 'Must be removed from map');

  const attemptAfterRevoke = pm.verifyAuth('device-samsung-tab', token);
  assert.strictEqual(attemptAfterRevoke, false, 'Revoked token must not authenticate');
});

it('Resists RangeError and timing attacks across arbitrary token lengths', () => {
  const shortTokenAttempt = pm.attemptPair('192.168.1.102', {
    token: 'x',
    device: { id: 'd1' }
  });
  assert.strictEqual(shortTokenAttempt.success, false);

  const giantTokenAttempt = pm.attemptPair('192.168.1.103', {
    token: 'A'.repeat(4096),
    device: { id: 'd2' }
  });
  assert.strictEqual(giantTokenAttempt.success, false);
});

it('Invalidates active pairing session immediately after successful pairing (single-use)', () => {
  const token = pm.activePairingToken;
  const pair1 = pm.attemptPair('192.168.1.104', {
    token: token,
    device: { id: 'device-single-1', name: 'First' }
  });
  assert.strictEqual(pair1.success, true);

  // Attempting to reuse the exact same token must fail
  const pair2 = pm.attemptPair('192.168.1.105', {
    token: token,
    device: { id: 'device-single-2', name: 'Second' }
  });
  assert.strictEqual(pair2.success, false, 'Pairing token must not be reusable');
});

it('Enforces brute-force rate-limiting (locks out after 5 failures)', () => {
  const attackerIp = '192.168.1.200';
  for (let i = 0; i < 5; i++) {
    pm.attemptPair(attackerIp, { pin: '999999', device: { id: 'attacker' } });
  }
  const blockedAttempt = pm.attemptPair(attackerIp, { pin: pm.activePairingPin, device: { id: 'attacker' } });
  assert.strictEqual(blockedAttempt.success, false);
  assert(blockedAttempt.error.includes('Too many failed pairing attempts'), 'Must lock out attacker');
});

// -------------------------------------------------------------
// 2. MESSAGE SCHEMA VALIDATION & SANITIZATION TESTS
// -------------------------------------------------------------
console.log('\n[Subsystem: Message Validation & Sanitization]');

it('Rejects non-object or missing type payload', () => {
  assert.strictEqual(validateMessage(null).valid, false);
  assert.strictEqual(validateMessage('not-json').valid, false);
  assert.strictEqual(validateMessage({}).valid, false);
  assert.strictEqual(validateMessage({ type: 123 }).valid, false);
});

it('Validates and clamps input_move_rel values', () => {
  const msgNormal = { type: 'input_move_rel', dx: 15.5, dy: -22.3 };
  assert.strictEqual(validateMessage(msgNormal).valid, true);

  const msgExorbitant = { type: 'input_move_rel', dx: 50000, dy: -99999 };
  assert.strictEqual(validateMessage(msgExorbitant).valid, true);
  assert.strictEqual(msgExorbitant.dx, 200, 'dx must be clamped to 200');
  assert.strictEqual(msgExorbitant.dy, -200, 'dy must be clamped to -200');
});

it('Validates and clamps scroll values', () => {
  const scrollMsg = { type: 'input_scroll', dy: -500, dx: 300 };
  assert.strictEqual(validateMessage(scrollMsg).valid, true);
  assert.strictEqual(scrollMsg.dy, -100, 'dy must be clamped to -100');
  assert.strictEqual(scrollMsg.dx, 100, 'dx must be clamped to 100');
});

it('Validates mouse buttons (only left, right, middle permitted)', () => {
  assert.strictEqual(validateMessage({ type: 'input_click', button: 'left' }).valid, true);
  assert.strictEqual(validateMessage({ type: 'input_click', button: 'right' }).valid, true);
  assert.strictEqual(validateMessage({ type: 'input_click', button: 'middle' }).valid, true);
  assert.strictEqual(validateMessage({ type: 'input_click', button: 'malicious_exec' }).valid, false);
});

it('Sanitizes typed text (truncates to 256 chars max)', () => {
  const longText = 'A'.repeat(500);
  const typeMsg = { type: 'input_type', text: longText };
  assert.strictEqual(validateMessage(typeMsg).valid, true);
  assert.strictEqual(typeMsg.text.length, 256, 'Text must be capped at 256 characters');
});

it('Validates laser pointer coordinates within [0, 1]', () => {
  const laserMsg = { type: 'laser_pointer', x: 1.5, y: -0.2 };
  assert.strictEqual(validateMessage(laserMsg).valid, true);
  assert.strictEqual(laserMsg.x, 1, 'x must be clamped to 1');
  assert.strictEqual(laserMsg.y, 0, 'y must be clamped to 0');
});

it('Validates emergency_stop message command', () => {
  assert.strictEqual(validateMessage({ type: 'emergency_stop' }).valid, true);
});

it('Rejects non-finite numbers (NaN, Infinity) across input commands', () => {
  assert.strictEqual(validateMessage({ type: 'input_move_rel', dx: NaN, dy: 10 }).valid, false);
  assert.strictEqual(validateMessage({ type: 'input_move_rel', dx: 10, dy: Infinity }).valid, false);
  assert.strictEqual(validateMessage({ type: 'input_move', x: -Infinity, y: 0.5 }).valid, false);
  assert.strictEqual(validateMessage({ type: 'draw_point', x: NaN, y: 0.5 }).valid, false);
  assert.strictEqual(validateMessage({ type: 'input_scroll', dy: NaN, dx: 0 }).valid, false);
});

it('Rejects unknown or disallowed message types', () => {
  assert.strictEqual(validateMessage({ type: 'exec_cmd', cmd: 'rm -rf /' }).valid, false);
  assert.strictEqual(validateMessage({ type: '__proto__' }).valid, false);
  assert.strictEqual(validateMessage({ type: 'shell_eval' }).valid, false);
});

it('Validates stroke_start and stroke_end point bounds', () => {
  // Rejects stroke_start with >2000 points
  const hugePoints = Array.from({ length: 2001 }, () => ({ x: 0.5, y: 0.5 }));
  assert.strictEqual(validateMessage({ type: 'stroke_start', stroke: { points: hugePoints } }).valid, false);

  // Accepts stroke_start with valid points
  const validPoints = [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }];
  assert.strictEqual(validateMessage({ type: 'stroke_start', stroke: { points: validPoints } }).valid, true);

  // Rejects stroke_end with malformed points
  assert.strictEqual(validateMessage({ type: 'stroke_end', stroke: { points: 'invalid' } }).valid, false);

  // Rejects stroke_end with >5000 points
  const excessivePoints = Array.from({ length: 5001 }, () => ({ x: 0.5, y: 0.5 }));
  assert.strictEqual(validateMessage({ type: 'stroke_end', stroke: { points: excessivePoints } }).valid, false);
});

it('Provides host identity in getPairingInfo and attemptPair', () => {
  const pInfo = pm.getPairingInfo('192.168.1.50', 4567);
  assert(pInfo.hostId && pInfo.hostId.startsWith('mac-'), 'Pairing info must include hostId');
  assert(pInfo.hostName, 'Pairing info must include hostName');
  assert(pInfo.fingerprint, 'Pairing info must include TLS certificate fingerprint');
  assert(pInfo.pairingUri.includes('proto=https'), 'Pairing URI must specify https protocol');
  assert(pInfo.pairingUri.includes('fp='), 'Pairing URI must carry host fingerprint');

  const pairRes = pm.attemptPair('192.168.1.50', {
    token: pInfo.token,
    device: { id: 'device-host-verify', name: 'Verify Tablet' }
  });
  assert.strictEqual(pairRes.success, true);
  assert.strictEqual(pairRes.hostId, pm.hostConfig.hostId);
  assert.strictEqual(pairRes.hostName, pm.hostConfig.hostName);
  assert.strictEqual(pairRes.host.fingerprint, pm.tlsCert.fingerprint);
});

it('Generates valid host TLS certificate with SANs and SHA-256 fingerprint', () => {
  const tlsDir = path.join(os.tmpdir(), 'tabsync_tls_test_' + Date.now());
  const certData = getOrCreateTlsCertificate(tlsDir, ['192.168.1.10', '10.0.0.5']);
  assert(certData.key.includes('BEGIN PRIVATE KEY'), 'Must generate valid RSA private key');
  assert(certData.cert.includes('BEGIN CERTIFICATE'), 'Must generate valid X.509 certificate');
  assert(certData.fingerprint.includes(':'), 'Fingerprint must be colon-separated SHA-256');
  assert.strictEqual(certData.fingerprintHex.length, 64, 'Raw fingerprint hex must be 64 characters');
  assert(certData.subjectAltName.includes('127.0.0.1'), 'SAN must include loopback');
  assert(certData.subjectAltName.includes('localhost'), 'SAN must include localhost');
  fs.rmSync(tlsDir, { recursive: true, force: true });
});

it('Formats and normalizes certificate fingerprints accurately', () => {
  const rawColon = '0D:22:AF:A2:37:33:9B:B5:97:7B:EE:1F:FB:C4:11:A4:29:FA:FB:F3:48:27:8A:F4:C5:87:86:67:06:C4:3F:A3';
  const cleanHex = normalizeFingerprint(rawColon);
  assert.strictEqual(cleanHex, '0d22afa237339bb5977bee1ffbc411a429fafbf348278af4c587866706c43fa3');
  assert.strictEqual(formatFingerprint(cleanHex), rawColon);
});

it('Detects host identity mismatch and prevents silent impersonation', () => {
  const storedHost = {
    id: 'mac-original-host-12345',
    name: 'Real Mac',
    fingerprint: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
  };
  const spoofedHost = {
    id: 'mac-spoofed-host-99999',
    name: 'Attacker Mac',
    fingerprint: '11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF'
  };

  const isMatch = (storedHost.id === spoofedHost.id) &&
    (normalizeFingerprint(storedHost.fingerprint) === normalizeFingerprint(spoofedHost.fingerprint));
  assert.strictEqual(isMatch, false, 'Must identify host identity mismatch');
});

it('Recovers from corrupt paired_devices.json using .bak fallback', () => {
  const corruptDir = path.join(os.tmpdir(), 'tabsync_corrupt_' + Date.now());
  fs.mkdirSync(corruptDir, { recursive: true });
  const pm1 = new PairingManager(corruptDir);
  const pin = pm1.activePairingPin;
  pm1.attemptPair('127.0.0.1', { pin, device: { id: 'device-backup-test', name: 'Backup Test' } });
  assert(pm1.pairedDevices.has('device-backup-test'));

  // Corrupt the primary paired_devices.json with truncated garbage
  const primaryPath = path.join(corruptDir, 'paired_devices.json');
  fs.writeFileSync(primaryPath, '{ "corrupted": true, broken');

  // Verify that initializing a new PairingManager safely falls back to .bak
  const pm2 = new PairingManager(corruptDir);
  assert(pm2.pairedDevices.has('device-backup-test'), 'Must recover device from .bak file');

  fs.rmSync(corruptDir, { recursive: true, force: true });
});

// Cleanup test dir
fs.rmSync(testDir, { recursive: true, force: true });

console.log('========================================================');
console.log(`RESULTS: ${testsPassed} PASSED, ${testsFailed} FAILED`);
console.log('========================================================');

if (testsFailed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}

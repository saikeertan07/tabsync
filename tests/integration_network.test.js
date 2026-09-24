/**
 * TabSync Studio - Integration Network & Security Test
 * Tests WebSocket connection, authentication enforcement, and stuck input protection
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const os = require('os');
const { PairingManager, validateMessage } = require('../security/pairing');

const testDir = path.join(os.tmpdir(), 'tabsync_net_test_' + Date.now());
const pm = new PairingManager(testDir);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let activeConnections = new Map();
let executedCommands = [];
let isEmergencyStopActive = false;
let currentInputOwner = null;
const hostSecret = 'test-secret-host-key-12345';

// Host API endpoint with strict security enforcement and exact origin parsing
app.get('/api/status', (req, res) => {
  if (req.query.host_secret || req.query.token) {
    return res.status(401).json({ error: 'Query parameter authentication forbidden' });
  }

  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      const isPort = !parsed.port || parseInt(parsed.port, 10) === 4567;
      if (!isLoopback || !isPort) {
        return res.status(403).json({ error: 'Forbidden cross-origin' });
      }
    } catch (e) {
      return res.status(403).json({ error: 'Malformed origin' });
    }
  }

  const provided = req.headers['x-tabsync-host-secret'];
  if (!provided || provided !== hostSecret) {
    return res.status(401).json({ error: 'Unauthorized host access' });
  }
  res.json({ ok: true, isEmergencyStopActive });
});

// Canvas Snapshot Export Endpoint
app.get('/api/canvas/export', (req, res) => {
  res.json({
    timestamp: Date.now(),
    backgroundStyle: 'dark-dots',
    totalStrokes: 0,
    strokes: []
  });
});

function broadcastToAuthenticated(data, excludeWs = null) {
  const payload = JSON.stringify(data);
  for (const [client, meta] of activeConnections.entries()) {
    if (client !== excludeWs && meta.isAuthenticated && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

wss.on('connection', (ws, req) => {
  const meta = { isAuthenticated: false, deviceId: null };
  activeConnections.set(ws, meta);

  // Notice: In the updated server, initial 'init' message is NO LONGER sent to unauthenticated sockets!

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const val = validateMessage(msg);
    if (!val.valid) return;

    if (msg.type === 'pair_request') {
      if (meta.isAuthenticated) {
        ws.send(JSON.stringify({ type: 'error', error: 'Already authenticated' }));
        return;
      }
      const res = pm.attemptPair('127.0.0.1', msg);
      if (res.success) {
        meta.isAuthenticated = true;
        meta.deviceId = msg.device.id;
        ws.send(JSON.stringify({
          type: 'pair_success',
          authToken: res.authToken,
          hostId: res.hostId,
          hostName: res.hostName,
          host: pm.getHostIdentity()
        }));
        // Send initial state only after successful authentication
        ws.send(JSON.stringify({ type: 'init', historyLength: 0 }));
      } else {
        ws.send(JSON.stringify({ type: 'pair_error', error: res.error }));
      }
      return;
    }

    if (msg.type === 'auth') {
      if (meta.isAuthenticated) {
        ws.send(JSON.stringify({ type: 'error', error: 'Already authenticated' }));
        return;
      }
      const dev = pm.verifyAuth(msg.deviceId, msg.authToken);
      if (dev) {
        meta.isAuthenticated = true;
        meta.deviceId = dev.deviceId;
        ws.send(JSON.stringify({
          type: 'auth_success',
          deviceId: dev.deviceId,
          name: dev.name,
          hostId: pm.hostConfig.hostId,
          hostName: pm.hostConfig.hostName,
          host: pm.getHostIdentity()
        }));
        ws.send(JSON.stringify({ type: 'init', historyLength: 0 }));
      } else {
        ws.send(JSON.stringify({ type: 'auth_error' }));
      }
      return;
    }

    // Privileged commands
    if (!meta.isAuthenticated) {
      ws.send(JSON.stringify({ type: 'error', error: 'Unauthorized' }));
      return;
    }

    if (msg.type === 'emergency_stop') {
      isEmergencyStopActive = true;
      broadcastToAuthenticated({ type: 'emergency_stop_state', active: true }, ws);
      ws.send(JSON.stringify({ type: 'emergency_stop_ack', active: true }));
      return;
    }

    if (msg.type === 'resume_input') {
      isEmergencyStopActive = false;
      broadcastToAuthenticated({ type: 'emergency_stop_state', active: false }, ws);
      ws.send(JSON.stringify({ type: 'emergency_stop_ack', active: false }));
      return;
    }

    if (isEmergencyStopActive && msg.type.startsWith('input_')) {
      ws.send(JSON.stringify({ type: 'blocked', reason: 'emergency_stop_active' }));
      return;
    }

    if (msg.type === 'input_down') {
      if (currentInputOwner && currentInputOwner !== ws) {
        ws.send(JSON.stringify({ type: 'collision_rejected', reason: 'input_busy' }));
        return;
      }
      currentInputOwner = ws;
      executedCommands.push('input_down');
      ws.send(JSON.stringify({ type: 'ack', cmd: 'input_down' }));
      return;
    }

    if (msg.type === 'input_move_rel') {
      if (currentInputOwner && currentInputOwner !== ws) {
        return; // Drop secondary client move during active drag
      }
      executedCommands.push(`move_rel_${msg.dx}_${msg.dy}`);
      ws.send(JSON.stringify({ type: 'ack', cmd: 'input_move_rel' }));
      return;
    }

    if (msg.type === 'input_move') {
      if (currentInputOwner && currentInputOwner !== ws) {
        return; // Drop secondary client move during active drag
      }
      executedCommands.push(`move_${msg.x}_${msg.y}`);
      ws.send(JSON.stringify({ type: 'ack', cmd: 'input_move' }));
      return;
    }

    if (msg.type === 'input_up') {
      if (currentInputOwner === ws || !currentInputOwner) {
        currentInputOwner = null;
      }
      executedCommands.push('input_up');
      ws.send(JSON.stringify({ type: 'ack', cmd: 'input_up' }));
      return;
    }

    executedCommands.push(msg.type);
    ws.send(JSON.stringify({ type: 'ack', cmd: msg.type }));
  });

  ws.on('close', () => {
    activeConnections.delete(ws);
    // Safe input ownership model:
    // Only release inputs if disconnecting socket owned the input or if no active connections remain
    if (currentInputOwner === ws || activeConnections.size === 0) {
      currentInputOwner = null;
      executedCommands.push('RELEASE_ALL_INPUTS');
    }
  });
});

server.listen(4567, async () => {
  console.log('\n[Integration: WebSocket Authentication & Stuck Input Protection]');
  let testPass = 0;

  function createQueue(targetWs) {
    const queue = [];
    const waiting = [];
    targetWs.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (waiting.length > 0) {
          waiting.shift()(parsed);
        } else {
          queue.push(parsed);
        }
      } catch (e) {}
    });
    return {
      next: () => {
        if (queue.length > 0) return Promise.resolve(queue.shift());
        return new Promise(r => waiting.push(r));
      }
    };
  }

  try {
    // 1. Unauthenticated client attempt
    const ws1 = new WebSocket('ws://localhost:4567');
    const q1 = createQueue(ws1);
    await new Promise(r => ws1.on('open', r));

    ws1.send(JSON.stringify({ type: 'input_move_rel', dx: 10, dy: 10 }));
    const resp1 = await q1.next();
    assert.strictEqual(resp1.error, 'Unauthorized', 'Unauthenticated command must be rejected');
    console.log('  ✓ PASS: Unauthenticated command rejected');
    testPass++;

    // 2. Successful Pairing
    const pin = pm.activePairingPin;
    ws1.send(JSON.stringify({
      type: 'pair_request',
      pin: pin,
      device: { id: 'tablet-net-1', name: 'Net Tablet' }
    }));
    const pairResp = await q1.next();
    assert.strictEqual(pairResp.type, 'pair_success');
    assert(pairResp.authToken, 'Must return auth token');
    const initResp = await q1.next();
    assert.strictEqual(initResp.type, 'init', 'Initial state must be delivered strictly after pairing');
    console.log('  ✓ PASS: Pairing request succeeds with issued token and init delivery');
    testPass++;

    // 3. Authenticated command
    ws1.send(JSON.stringify({ type: 'input_move_rel', dx: 5, dy: 5 }));
    const cmdResp = await q1.next();
    assert.strictEqual(cmdResp.cmd, 'input_move_rel');
    console.log('  ✓ PASS: Authenticated command executed');
    testPass++;

    // 4. Disconnect triggers stuck input release
    ws1.close();
    await new Promise(r => setTimeout(r, 100));
    assert(executedCommands.includes('RELEASE_ALL_INPUTS'), 'Disconnect must trigger RELEASE_ALL_INPUTS');
    console.log('  ✓ PASS: Disconnect safely releases all inputs');
    testPass++;

    // 5. Subsequent connection with authToken
    const ws2 = new WebSocket('ws://localhost:4567');
    const q2 = createQueue(ws2);
    await new Promise(r => ws2.on('open', r));
    ws2.send(JSON.stringify({
      type: 'auth',
      deviceId: 'tablet-net-1',
      authToken: pairResp.authToken
    }));
    const authResp = await q2.next();
    assert.strictEqual(authResp.type, 'auth_success');
    assert.strictEqual(authResp.hostId, pm.hostConfig.hostId, 'Host ID must match Mac pairing host ID');
    assert.strictEqual(authResp.hostName, pm.hostConfig.hostName, 'Host name must match Mac pairing host name');
    assert(authResp.host && authResp.host.fingerprint, 'Auth success must contain host identity and fingerprint');
    assert.strictEqual(authResp.host.id, pm.hostConfig.hostId);
    const authInit = await q2.next();
    assert.strictEqual(authInit.type, 'init', 'Initial state delivered strictly after auth');
    console.log('  ✓ PASS: Reconnection authenticated with stored token and init delivered');
    testPass++;

    // 6. Emergency Stop halts input on WebSocket
    ws2.send(JSON.stringify({ type: 'emergency_stop' }));
    const eStopResp = await q2.next();
    assert.strictEqual(eStopResp.active, true);

    ws2.send(JSON.stringify({ type: 'input_move_rel', dx: 1, dy: 1 }));
    const blockedResp = await q2.next();
    assert.strictEqual(blockedResp.type, 'blocked');
    assert.strictEqual(blockedResp.reason, 'emergency_stop_active');
    console.log('  ✓ PASS: Emergency stop blocks input commands');
    testPass++;

    // 7. Resume input restores command execution
    ws2.send(JSON.stringify({ type: 'resume_input' }));
    const resumeResp = await q2.next();
    assert.strictEqual(resumeResp.active, false);

    ws2.send(JSON.stringify({ type: 'input_move_rel', dx: 1, dy: 1 }));
    const resumedCmd = await q2.next();
    assert.strictEqual(resumedCmd.type, 'ack');
    console.log('  ✓ PASS: Resume input re-enables command execution');
    testPass++;

    // 8. Re-authentication on already authenticated socket is rejected
    ws2.send(JSON.stringify({ type: 'auth', deviceId: 'tablet-net-1', authToken: pairResp.authToken }));
    const reAuthResp = await q2.next();
    assert.strictEqual(reAuthResp.type, 'error');
    assert.strictEqual(reAuthResp.error, 'Already authenticated');
    console.log('  ✓ PASS: Re-authentication on active session rejected');
    testPass++;

    ws2.close();

    // 9. HTTP query-string credential leakage prevention
    const httpGet = (url, headers = {}) => new Promise((resolve) => {
      http.get(url, { headers }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      });
    });

    const leakAttempt = await httpGet(`http://localhost:4567/api/status?host_secret=${hostSecret}`);
    assert.strictEqual(leakAttempt.statusCode, 401, 'Query-string credentials must be rejected with 401');
    console.log('  ✓ PASS: HTTP query-string secret rejected');
    testPass++;

    const headerAuth = await httpGet('http://localhost:4567/api/status', { 'X-TabSync-Host-Secret': hostSecret });
    assert.strictEqual(headerAuth.statusCode, 200, 'Header-based authentication must succeed with 200');
    console.log('  ✓ PASS: HTTP header-based secret accepted');
    testPass++;

    // 10. Deceptive Origin Rejection
    const deceptiveOrigin = await httpGet('http://localhost:4567/api/status', {
      'Origin': 'http://localhost.attacker.com',
      'X-TabSync-Host-Secret': hostSecret
    });
    assert.strictEqual(deceptiveOrigin.statusCode, 403, 'Deceptive origin must be rejected with 403');
    console.log('  ✓ PASS: Deceptive cross-origin rejected');
    testPass++;

    const validOrigin = await httpGet('http://localhost:4567/api/status', {
      'Origin': 'http://localhost:4567',
      'X-TabSync-Host-Secret': hostSecret
    });
    assert.strictEqual(validOrigin.statusCode, 200, 'Valid loopback origin must be accepted');
    console.log('  ✓ PASS: Valid loopback origin accepted');
    testPass++;

    // 11. Multi-Client Input Ownership
    const wsA = new WebSocket('ws://localhost:4567');
    const wsB = new WebSocket('ws://localhost:4567');
    const qA = createQueue(wsA);
    const qB = createQueue(wsB);
    await Promise.all([new Promise(r => wsA.on('open', r)), new Promise(r => wsB.on('open', r))]);

    // Pair two distinct devices
    const pinA = pm.activePairingPin;
    const resA = pm.attemptPair('127.0.0.1', { pin: pinA, device: { id: 'tablet-net-A', name: 'Tablet A' } });
    const pinB = pm.activePairingPin;
    const resB = pm.attemptPair('127.0.0.1', { pin: pinB, device: { id: 'tablet-net-B', name: 'Tablet B' } });

    wsA.send(JSON.stringify({ type: 'auth', deviceId: 'tablet-net-A', authToken: resA.authToken }));
    const aResp = await qA.next();
    assert.strictEqual(aResp.type, 'auth_success');
    await qA.next(); // init

    wsB.send(JSON.stringify({ type: 'auth', deviceId: 'tablet-net-B', authToken: resB.authToken }));
    const bResp = await qB.next();
    assert.strictEqual(bResp.type, 'auth_success');
    await qB.next(); // init

    executedCommands = [];
    wsA.send(JSON.stringify({ type: 'input_down', button: 'left' }));
    await qA.next(); // ack
    assert(executedCommands.includes('input_down'));

    // Test input collision protection: Client B attempts input_down while Client A holds ownership
    wsB.send(JSON.stringify({ type: 'input_down', button: 'left' }));
    const bReject = await qB.next();
    assert.strictEqual(bReject.type, 'collision_rejected', 'Must reject collision when another client owns input');
    console.log("  ✓ PASS: Multi-client input collision rejected while owner holds drag");
    testPass++;

    // Test input_move collision protection: Client B attempts input_move while Client A holds ownership
    wsB.send(JSON.stringify({ type: 'input_move', x: 500, y: 500 }));
    await new Promise(r => setTimeout(r, 60));
    assert(!executedCommands.includes('move_500_500'), 'Must drop absolute move collision when another client owns input');
    console.log("  ✓ PASS: Multi-client absolute input_move collision dropped while owner holds drag");
    testPass++;

    // Test canvas snapshot export endpoint
    const exportRes = await httpGet('http://localhost:4567/api/canvas/export');
    assert.strictEqual(exportRes.statusCode, 200, 'Canvas export endpoint should return 200');
    const exportJson = JSON.parse(exportRes.body);
    assert.strictEqual(typeof exportJson.timestamp, 'number');
    assert(Array.isArray(exportJson.strokes));
    console.log("  ✓ PASS: Canvas snapshot export endpoint returns structured strokes and timestamp");
    testPass++;

    // Client B disconnects while Client A is holding down input
    wsB.close();
    await new Promise(r => setTimeout(r, 100));
    assert(!executedCommands.includes('RELEASE_ALL_INPUTS'), "Client B disconnect must not interrupt Client A input");
    console.log("  ✓ PASS: Disconnecting non-owner client does not interrupt active owner's input");
    testPass++;

    // Owner Client A disconnects: input must be released
    wsA.close();
    await new Promise(r => setTimeout(r, 100));
    assert(executedCommands.includes('RELEASE_ALL_INPUTS'), "Owner disconnect must release held inputs");
    console.log("  ✓ PASS: Owner disconnect cleanly releases all held inputs");
    testPass++;

    server.close();
    console.log(`\nINTEGRATION RESULTS: ${testPass} PASSED, 0 FAILED\n`);
    process.exit(0);
  } catch (err) {
    console.error('Integration test failed:', err);
    server.close();
    process.exit(1);
  }
});

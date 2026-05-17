'use strict';

// Feature: admin-user-device-management
//
// Property tests for mqtt-worker connection tracking + heartbeat:
//
//   - Property 19 (Task 10.5): connect → is_connected=1+last_seen_at fresh;
//                              close/error/offline → is_connected=0 without
//                              touching last_seen_at.
//                              Validates Requirements 8.1, 8.2.
//   - Property 20 (Task 10.6): heartbeat updates last_seen_at only for
//                              currently-connected devices.
//                              Validates Requirement 8.3.
//   - Property 21 (Task 10.7): worker no-throw on DB error.
//                              Validates Requirement 8.5.
//
// These tests do NOT touch a real MQTT broker or a real database. The
// `_helpers.js` stubs swap the cached `mqtt` module and patch `pool.query`
// on `src/config/db.js` so we can drive every code path deterministically.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  installMqttStub,
  installPoolStub,
  useFakeTimers,
  resetModule
} = require('./_helpers');

// ---------------------------------------------------------------------------
// Console.error spy
// ---------------------------------------------------------------------------

let originalConsoleError;
let consoleErrorCalls;

function installConsoleSpy() {
  originalConsoleError = console.error;
  consoleErrorCalls = [];
  console.error = function (...args) { consoleErrorCalls.push(args); };
}

function restoreConsole() {
  if (originalConsoleError) console.error = originalConsoleError;
  originalConsoleError = null;
  consoleErrorCalls = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function microtick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeDevice(deviceId, deviceType) {
  return {
    device_id: deviceId,
    device_type: deviceType || 'esp32-inkubator',
    broker_url: 'broker.example.com',
    broker_port: '1883',
    mq_user: 'u',
    mq_pass: 'p'
  };
}

// ---------------------------------------------------------------------------
// Property 19: connect / close / error / offline transitions
// ---------------------------------------------------------------------------

test('Property 19: connect → is_connected=1 + last_seen_at fresh; close/error/offline → is_connected=0 without changing last_seen_at', async () => {
  const dbStub = installPoolStub();
  const mqttStub = installMqttStub();
  installConsoleSpy();

  try {
    let counter = 0;
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('close', 'error', 'offline'), async (event) => {
        counter += 1;
        const deviceId = counter;
        const deviceIdStr = String(deviceId);

        // Fresh DeviceManager singleton per iteration so connectedDeviceIds
        // and mqttClients don't leak across runs.
        resetModule('../src/services/DeviceManager');
        const deviceManager = require('../src/services/DeviceManager');

        dbStub.reset();

        deviceManager.connectDevice(makeDevice(deviceId));
        const client = mqttStub.latest();
        assert.ok(client, 'mqtt stub should have produced a client');

        // --- connect transition ---
        client.simulateConnect();
        await microtick();

        const connectCall = dbStub.calls.find((c) =>
          /^UPDATE device SET is_connected = 1, last_seen_at = NOW\(\) WHERE device_id = \?$/.test(c.sql)
        );
        assert.ok(connectCall, 'expected connect-state UPDATE to be issued');
        assert.deepStrictEqual(connectCall.params, [deviceId]);
        assert.ok(
          deviceManager.connectedDeviceIds.has(deviceIdStr),
          'connectedDeviceIds should contain the device after connect'
        );

        // --- disconnect transition ---
        // Snapshot of calls BEFORE the disconnect event so we can scope
        // assertions to only what the disconnect handler produced.
        const callsBeforeDisconnect = dbStub.calls.length;

        if (event === 'close') client.simulateClose();
        else if (event === 'error') client.simulateError(new Error('simulated'));
        else client.simulateOffline();

        await microtick();

        const newCalls = dbStub.calls.slice(callsBeforeDisconnect);
        const disconnectCall = newCalls.find((c) =>
          /^UPDATE device SET is_connected = 0 WHERE device_id = \?$/.test(c.sql)
        );
        assert.ok(
          disconnectCall,
          `expected disconnect-state UPDATE for event "${event}", got: ` +
            JSON.stringify(newCalls.map((c) => c.sql))
        );
        // Crucially, the disconnect SQL must NOT touch last_seen_at.
        assert.ok(
          !/last_seen_at/i.test(disconnectCall.sql),
          'disconnect UPDATE must NOT modify last_seen_at'
        );
        assert.deepStrictEqual(disconnectCall.params, [deviceIdStr]);
        assert.ok(
          !deviceManager.connectedDeviceIds.has(deviceIdStr),
          'device should be removed from connectedDeviceIds after disconnect'
        );
      }),
      { numRuns: 9 }
    );
  } finally {
    restoreConsole();
    mqttStub.restore();
    dbStub.restore();
  }
});

// ---------------------------------------------------------------------------
// Property 20: heartbeat updates last_seen_at only for connected devices
// ---------------------------------------------------------------------------

test('Property 20: heartbeat updates last_seen_at only for currently-connected devices', async () => {
  const dbStub = installPoolStub();
  const mqttStub = installMqttStub();
  const timers = useFakeTimers();
  installConsoleSpy();

  // Install fake timers BEFORE requiring DeviceManager so the singleton's
  // `setInterval` reference resolves to the fake one.
  timers.install();

  try {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        resetModule('../src/services/DeviceManager');
        const deviceManager = require('../src/services/DeviceManager');

        dbStub.reset();

        const devA = makeDevice(101);
        const devB = makeDevice(102, 'esp32-smartlamp');

        deviceManager.connectDevice(devA);
        const clientA = mqttStub.latest();
        deviceManager.connectDevice(devB);
        const clientB = mqttStub.latest();
        assert.notStrictEqual(clientA, clientB, 'each device gets its own client');

        // Only A actually connects; B never receives a 'connect' event so it
        // should never be heartbeated.
        clientA.simulateConnect();
        await microtick();

        // Drop the connect-state UPDATE so we only count heartbeat calls.
        dbStub.calls.length = 0;

        // Start the heartbeat. Confirm the interval was registered with the
        // expected 30s period.
        deviceManager.startHeartbeat();
        const intervals = timers.intervals();
        assert.strictEqual(intervals.length, 1, 'expected exactly one heartbeat interval');
        assert.strictEqual(intervals[0].ms, 30000, 'heartbeat interval must be 30s');

        // First tick fires the interval once.
        await timers.tick(30000);

        const heartbeatRegex = /^UPDATE device SET last_seen_at = NOW\(\) WHERE device_id = \?$/;
        let heartbeats = dbStub.calls.filter((c) => heartbeatRegex.test(c.sql));
        assert.strictEqual(
          heartbeats.length,
          1,
          'one heartbeat UPDATE expected after first 30s tick'
        );
        assert.deepStrictEqual(heartbeats[0].params, [String(devA.device_id)]);

        // No heartbeat should target B.
        for (const call of heartbeats) {
          assert.notStrictEqual(
            call.params[0],
            String(devB.device_id),
            'B is not connected and must not be heartbeated'
          );
        }

        // 60 more seconds → two more ticks for A, none for B.
        await timers.tick(60000);
        heartbeats = dbStub.calls.filter((c) => heartbeatRegex.test(c.sql));
        assert.strictEqual(heartbeats.length, 3, 'three heartbeat UPDATEs total after 90s elapsed');
        for (const hb of heartbeats) {
          assert.deepStrictEqual(hb.params, [String(devA.device_id)]);
        }

        // gracefulShutdown clears the heartbeat interval.
        deviceManager.gracefulShutdown();
        assert.strictEqual(
          timers.intervals().length,
          0,
          'gracefulShutdown must clear the heartbeat interval'
        );
      }),
      { numRuns: 1 }
    );
  } finally {
    timers.restore();
    restoreConsole();
    mqttStub.restore();
    dbStub.restore();
  }
});

// ---------------------------------------------------------------------------
// Property 21: worker no-throw on DB error
// ---------------------------------------------------------------------------

test('Property 21: worker swallows DB errors and keeps running', async () => {
  const dbStub = installPoolStub();
  const mqttStub = installMqttStub();
  const timers = useFakeTimers();
  installConsoleSpy();

  // Every pool.query rejects.
  dbStub.setHandler(() => { throw new Error('boom'); });

  // Track unhandled rejections — the worker must NEVER let one escape.
  const unhandled = [];
  function onUnhandled(reason) { unhandled.push(reason); }
  process.on('unhandledRejection', onUnhandled);

  // Heartbeat path needs the fake timer; install up-front so the cached
  // DeviceManager picks it up consistently across iterations.
  timers.install();

  try {
    let counter = 0;
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('connect', 'close', 'heartbeat'), async (action) => {
        counter += 1;
        const deviceId = 200 + counter;

        resetModule('../src/services/DeviceManager');
        const deviceManager = require('../src/services/DeviceManager');

        // Don't reset the throwing handler — keep failing every query.
        dbStub.calls.length = 0;
        consoleErrorCalls.length = 0;

        await assert.doesNotReject(async () => {
          deviceManager.connectDevice(makeDevice(deviceId));
          const client = mqttStub.latest();
          assert.ok(client, 'mqtt stub should have produced a client');

          if (action === 'connect') {
            client.simulateConnect();
            await microtick();
          } else if (action === 'close') {
            client.simulateConnect();
            await microtick();
            client.simulateClose();
            await microtick();
          } else { // 'heartbeat'
            client.simulateConnect();
            await microtick();
            deviceManager.startHeartbeat();
            await timers.tick(30000);
            // Stop the interval so it doesn't keep adding to console.error
            // when we move on to the next iteration.
            deviceManager.gracefulShutdown();
          }
        });

        // Allow any tail microtasks to settle.
        await microtick();

        assert.strictEqual(
          unhandled.length,
          0,
          'no unhandled rejection should escape the worker, got: ' +
            JSON.stringify(unhandled.map(String))
        );
        assert.ok(
          consoleErrorCalls.length > 0,
          `expected console.error to be called for action "${action}"`
        );
      }),
      { numRuns: 9 }
    );
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    timers.restore();
    restoreConsole();
    mqttStub.restore();
    dbStub.restore();
  }
});

// ---------------------------------------------------------------------------
// Cleanly tear down the lazy mysql2 pool so `node --test` exits.
// ---------------------------------------------------------------------------

after(async () => {
  const pool = require('../src/config/db');
  try { await pool.end(); } catch (err) { /* ignore */ }
});

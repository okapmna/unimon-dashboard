'use strict';

// Feature: admin-user-device-management
//
// Property tests for firmware extraction:
//
//   - Property 22 (Task 11.4): firmware update only when string non-empty AND
//                              changed; otherwise no-op.
//                              Validates Requirements 9.1, 9.2, 9.4, 9.5.
//   - Property 23 (Task 11.5): non-JSON MQTT payloads do not change
//                              firmware_version (the parse error is logged
//                              and the dispatch is skipped, so the firmware
//                              helper is never reached).
//                              Validates Requirement 9.3.
//
// All tests run against in-memory stubs from `_helpers.js` — no real DB or
// MQTT broker is involved.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  installMqttStub,
  installPoolStub,
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

function microtick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Property 22: firmware update only when string non-empty and changed
// ---------------------------------------------------------------------------
//
// Tests `maybeUpdateFirmwareVersion(device, data)` directly. The handler
// performs:
//   1. SELECT firmware_version FROM device WHERE device_id = ? LIMIT 1
//   2. if data.firmware_version is a non-empty (after trim) string AND its
//      trimmed form differs from the SELECT result:
//        UPDATE device SET firmware_version = ? WHERE device_id = ?
//        INSERT INTO device_logs (..., 'change_event')
//   3. else: no UPDATE, no INSERT.
//
// We classify each generated payload to compute the expected DB activity and
// then assert exactly that activity against the stub's recorded calls.

function classify(firmwareValue, currentFw) {
  if (typeof firmwareValue !== 'string') return { update: false, trimmed: null };
  const trimmed = firmwareValue.trim();
  if (trimmed === '') return { update: false, trimmed: null };
  if (trimmed === currentFw) return { update: false, trimmed };
  return { update: true, trimmed };
}

function extractCallKinds(calls) {
  const selects = calls.filter((c) => /^SELECT firmware_version FROM device/i.test(c.sql));
  const updates = calls.filter((c) => /^UPDATE device SET firmware_version = \?/i.test(c.sql));
  const inserts = calls.filter((c) => /^INSERT INTO device_logs/i.test(c.sql));
  return { selects, updates, inserts };
}

test('Property 22 (random): firmware UPDATE+INSERT only when string non-empty AND differs from current', async () => {
  const dbStub = installPoolStub();
  installConsoleSpy();

  // The helper is required AFTER the pool stub is in place so its captured
  // `pool` reference points at the stubbed pool.query.
  const { maybeUpdateFirmwareVersion } = require('../src/handlers/firmware');

  try {
    await fc.assert(
      fc.asyncProperty(
        // `data.firmware_version` covers strings (incl. blank/whitespace),
        // numbers, booleans, null, and missing values.
        fc.option(
          fc.oneof(
            fc.string(),
            fc.constant(''),
            fc.constant('  '),
            fc.constant('\t\n  '),
            fc.constant('  1.0.0  '),
            fc.integer(),
            fc.boolean(),
            fc.constant(null)
          ),
          { nil: undefined }
        ),
        // current `device.firmware_version` value in the DB.
        fc.option(fc.stringMatching(/^[0-9]+\.[0-9]+\.[0-9]+$/), { nil: null }),
        async (firmwareValue, currentFw) => {
          dbStub.reset();
          dbStub.setHandler((sql) => {
            if (/^SELECT firmware_version FROM device/i.test(sql)) {
              return [[{ firmware_version: currentFw }], []];
            }
            // UPDATE / INSERT — return a noop OkPacket-shaped tuple.
            return [{ affectedRows: 1 }, []];
          });

          const data = firmwareValue === undefined
            ? undefined
            : { firmware_version: firmwareValue };
          await maybeUpdateFirmwareVersion({ device_id: 1 }, data);

          const { selects, updates, inserts } = extractCallKinds(dbStub.calls);
          const { update, trimmed } = classify(firmwareValue, currentFw);

          if (update) {
            assert.strictEqual(selects.length, 1, 'expected exactly one SELECT');
            assert.strictEqual(updates.length, 1, 'expected exactly one UPDATE');
            assert.deepStrictEqual(updates[0].params, [trimmed, 1]);
            assert.strictEqual(inserts.length, 1, 'expected exactly one INSERT into device_logs');
            const [deviceId, payload, logType] = inserts[0].params;
            assert.strictEqual(deviceId, 1);
            assert.strictEqual(logType, 'change_event');
            const parsed = JSON.parse(payload);
            assert.deepStrictEqual(parsed, {
              type: 'firmware_version',
              old: currentFw,
              new: trimmed
            });
          } else {
            assert.strictEqual(updates.length, 0, 'no UPDATE should fire on no-op');
            assert.strictEqual(inserts.length, 0, 'no INSERT should fire on no-op');
          }
        }
      ),
      { numRuns: 50 }
    );
  } finally {
    restoreConsole();
    dbStub.restore();
  }
});

// ---------------------------------------------------------------------------
// Property 22 — hand-rolled cases for must-cover scenarios
// ---------------------------------------------------------------------------

test('Property 22 (cases): canonical no-op and update scenarios', async (t) => {
  const dbStub = installPoolStub();
  installConsoleSpy();
  const { maybeUpdateFirmwareVersion } = require('../src/handlers/firmware');

  try {
    const cases = [
      { name: 'data is undefined', data: undefined, currentFw: null, shouldUpdate: false },
      { name: 'data has no firmware_version', data: {}, currentFw: null, shouldUpdate: false },
      { name: 'firmware_version is a number', data: { firmware_version: 123 }, currentFw: null, shouldUpdate: false },
      { name: 'firmware_version is a boolean', data: { firmware_version: true }, currentFw: null, shouldUpdate: false },
      { name: 'firmware_version is null', data: { firmware_version: null }, currentFw: null, shouldUpdate: false },
      { name: 'firmware_version is empty string', data: { firmware_version: '' }, currentFw: null, shouldUpdate: false },
      { name: 'firmware_version is whitespace only', data: { firmware_version: '  \t\n  ' }, currentFw: null, shouldUpdate: false },
      { name: 'firmware_version equals current (idempotent)', data: { firmware_version: '1.0.0' }, currentFw: '1.0.0', shouldUpdate: false },
      { name: 'firmware_version differs from current null', data: { firmware_version: '1.0.0' }, currentFw: null, shouldUpdate: true, expectedNew: '1.0.0' },
      { name: 'firmware_version differs from current value', data: { firmware_version: '2.0.0' }, currentFw: '1.0.0', shouldUpdate: true, expectedNew: '2.0.0' },
      { name: 'firmware_version trims to differ from current', data: { firmware_version: '  1.0.0  ' }, currentFw: null, shouldUpdate: true, expectedNew: '1.0.0' },
      { name: 'firmware_version trims to equal current (idempotent)', data: { firmware_version: '  1.0.0  ' }, currentFw: '1.0.0', shouldUpdate: false }
    ];

    for (const tc of cases) {
      await t.test(tc.name, async () => {
        dbStub.reset();
        dbStub.setHandler((sql) => {
          if (/^SELECT firmware_version FROM device/i.test(sql)) {
            return [[{ firmware_version: tc.currentFw }], []];
          }
          return [{ affectedRows: 1 }, []];
        });

        await maybeUpdateFirmwareVersion({ device_id: 42 }, tc.data);

        const { updates, inserts } = extractCallKinds(dbStub.calls);
        if (tc.shouldUpdate) {
          assert.strictEqual(updates.length, 1, `${tc.name}: expected one UPDATE`);
          assert.deepStrictEqual(updates[0].params, [tc.expectedNew, 42]);
          assert.strictEqual(inserts.length, 1, `${tc.name}: expected one INSERT`);
          const parsed = JSON.parse(inserts[0].params[1]);
          assert.strictEqual(parsed.type, 'firmware_version');
          assert.strictEqual(parsed.old, tc.currentFw);
          assert.strictEqual(parsed.new, tc.expectedNew);
        } else {
          assert.strictEqual(updates.length, 0, `${tc.name}: expected NO UPDATE`);
          assert.strictEqual(inserts.length, 0, `${tc.name}: expected NO INSERT`);
        }
      });
    }
  } finally {
    restoreConsole();
    dbStub.restore();
  }
});

// ---------------------------------------------------------------------------
// Property 23: non-JSON payload does not change firmware_version
// ---------------------------------------------------------------------------
//
// The end-to-end path is:
//   client.on('message', ...) → JSON.parse(rawMsg)
//     → if parses, dispatch → maybeUpdateFirmwareVersion
//     → else, console.error and return.
//
// We drive the message event with non-JSON payloads and assert that no
// firmware-related queries (SELECT/UPDATE/INSERT) are issued on the pool.

function looksLikeJson(s) {
  try { JSON.parse(s); return true; } catch { return false; }
}

test('Property 23: non-JSON MQTT payload never reaches firmware update path', async () => {
  const dbStub = installPoolStub();
  const mqttStub = installMqttStub();
  installConsoleSpy();

  try {
    let counter = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant(''),
          fc.constant('not json'),
          fc.constant('{not json}'),
          fc.constant('{"unterminated'),
          fc.constant('<xml/>'),
          fc.constant('hello world'),
          fc.string().filter((s) => !looksLikeJson(s))
        ),
        async (rawPayload) => {
          counter += 1;
          const deviceId = 300 + counter;

          resetModule('../src/services/DeviceManager');
          const deviceManager = require('../src/services/DeviceManager');

          // Default handler: behave like a real (empty-result) DB so the
          // worker can subscribe and operate normally.
          dbStub.reset();
          consoleErrorCalls.length = 0;

          const device = {
            device_id: deviceId,
            device_type: 'esp32-inkubator',
            broker_url: 'broker.example.com',
            broker_port: '1883',
            mq_user: '',
            mq_pass: ''
          };
          deviceManager.connectDevice(device);
          const client = mqttStub.latest();
          assert.ok(client, 'mqtt stub should have produced a client');

          // Drive the connect lifecycle so the topic is subscribed.
          client.simulateConnect();
          await microtick();

          // Discard the connect-state UPDATE so it doesn't pollute our
          // firmware-related assertion.
          dbStub.calls.length = 0;

          // Now feed the non-JSON payload through the message handler.
          client.simulateMessage(`incubator/${deviceId}/data`, rawPayload);
          // Two microticks: one for the JSON.parse path itself, one for the
          // (non-existent) handler dispatch chain. Belt-and-braces.
          await microtick();
          await microtick();

          // Firmware path queries: SELECT firmware_version, UPDATE
          // firmware_version, or INSERT INTO device_logs. None should fire.
          const firmwareTouching = dbStub.calls.filter((c) =>
            /firmware_version/i.test(c.sql) || /^INSERT INTO device_logs/i.test(c.sql)
          );
          assert.strictEqual(
            firmwareTouching.length,
            0,
            'non-JSON payload must not trigger firmware-related queries, got: ' +
              JSON.stringify(firmwareTouching.map((c) => c.sql))
          );

          // The DeviceManager logs the parse failure to console.error.
          assert.ok(
            consoleErrorCalls.length > 0,
            'expected console.error to be called for the JSON parse failure'
          );

          // Tear down this iteration's client so we don't leak listeners.
          deviceManager.gracefulShutdown();
        }
      ),
      { numRuns: 30 }
    );
  } finally {
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

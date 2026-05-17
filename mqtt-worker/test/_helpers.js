'use strict';

// Test helpers for mqtt-worker.
//
// The worker has two external boundaries: the MQTT broker (via the `mqtt`
// package) and MariaDB (via the shared `pool` exported by `src/config/db.js`,
// which is the pool object directly — `module.exports = pool`, NOT
// `module.exports = { pool }`).
//
// Tests do not (and should not) talk to a real broker or a real database, so
// these helpers provide:
//
//   - createFakeMqttClient(): an EventEmitter-shaped fake client mirroring the
//     surface that `DeviceManager.connectDevice` uses (subscribe / publish /
//     end / on / once / removeListener).
//   - installMqttStub(): patches the cached `mqtt` module so `mqtt.connect`
//     returns a fresh fake client and every connect() call is recorded.
//   - installPoolStub(): wraps `pool.query` on `src/config/db.js` so tests can
//     inject specific responses (or errors) without a real DB.
//   - useFakeTimers(): minimal monkey-patch of `setInterval` / `clearInterval`
//     so heartbeat tests can advance time deterministically and synchronously.
//   - resetModule(modPath): drops a module from `require.cache` so DeviceManager
//     can be re-required after stubs are installed (it's a singleton).

const path = require('path');
const { EventEmitter } = require('events');

// ---------------------------------------------------------------------------
// Fake MQTT client
// ---------------------------------------------------------------------------

/**
 * Build a fake MQTT client. Inherits from EventEmitter so DeviceManager's
 * `client.on('connect', ...)` / `'close'` / `'error'` / `'offline'` /
 * `'message'` listeners work unchanged.
 *
 * Recorded state on the returned object:
 *   - clientId   : string identifier (defaults to a unique counter)
 *   - subscribed : array of { topic, opts }
 *   - published  : array of { topic, payload, opts }
 *   - ended      : boolean, true once `end()` has been called
 *
 * Helper methods to drive the listeners that DeviceManager registers:
 *   - simulateConnect()
 *   - simulateClose()
 *   - simulateError(err)
 *   - simulateOffline()
 *   - simulateMessage(topic, payloadString)
 */
let _fakeClientCounter = 0;
function createFakeMqttClient(opts = {}) {
  _fakeClientCounter += 1;
  const client = new EventEmitter();
  // Allow many listeners; some tests may wire several handlers.
  client.setMaxListeners(50);

  client.clientId = (opts && opts.clientId) || ('fake-client-' + _fakeClientCounter);
  client.subscribed = [];
  client.published = [];
  client.ended = false;
  client.options = Object.assign({}, opts);

  client.subscribe = function subscribe(topic, subOpts, cb) {
    if (typeof subOpts === 'function') { cb = subOpts; subOpts = undefined; }
    client.subscribed.push({ topic, opts: subOpts });
    if (typeof cb === 'function') cb(null);
    return client;
  };

  client.publish = function publish(topic, payload, pubOpts, cb) {
    if (typeof pubOpts === 'function') { cb = pubOpts; pubOpts = undefined; }
    client.published.push({ topic, payload, opts: pubOpts });
    if (typeof cb === 'function') cb(null);
    return client;
  };

  client.end = function end(force, endOpts, cb) {
    if (typeof force === 'function') { cb = force; force = false; endOpts = undefined; }
    if (typeof endOpts === 'function') { cb = endOpts; endOpts = undefined; }
    client.ended = true;
    if (typeof cb === 'function') cb();
    return client;
  };

  client.simulateConnect = function simulateConnect() {
    client.emit('connect', { sessionPresent: false });
  };
  client.simulateClose = function simulateClose() {
    client.emit('close');
  };
  client.simulateError = function simulateError(err) {
    client.emit('error', err || new Error('fake error'));
  };
  client.simulateOffline = function simulateOffline() {
    client.emit('offline');
  };
  client.simulateMessage = function simulateMessage(topic, payloadString) {
    const buf = Buffer.isBuffer(payloadString)
      ? payloadString
      : Buffer.from(String(payloadString));
    client.emit('message', topic, buf);
  };

  return client;
}

// ---------------------------------------------------------------------------
// MQTT module stub
// ---------------------------------------------------------------------------

/**
 * Replace the cached `mqtt` module so that any subsequent `require('mqtt')`
 * (including the one already cached inside DeviceManager) sees a `connect`
 * function that hands back a fresh fake client.
 *
 * Usage:
 *   const stub = installMqttStub();
 *   // ... require / re-require DeviceManager, drive events, etc.
 *   stub.restore();
 *
 * Returned controller:
 *   - calls   : array of { url, options, client } captured per connect()
 *   - latest(): last fake client created, or undefined
 *   - byClientId(id): first fake client whose options.clientId equals `id`
 *   - restore(): restore the original mqtt module export
 */
function installMqttStub() {
  const mqttPath = require.resolve('mqtt');
  // Force the real module to be loaded at least once so we have its cache entry.
  const realMqtt = require('mqtt');
  const cacheEntry = require.cache[mqttPath];
  const originalExports = cacheEntry ? cacheEntry.exports : realMqtt;

  const calls = [];

  const fakeConnect = function connect(url, options) {
    const client = createFakeMqttClient(options || {});
    calls.push({ url, options: options || {}, client });
    return client;
  };

  // Build a fresh exports object so every property the worker might touch
  // routes through our stub. `mqtt.connect` is the only one DeviceManager
  // actually calls today.
  const stubExports = Object.assign({}, originalExports, { connect: fakeConnect });

  if (cacheEntry) {
    cacheEntry.exports = stubExports;
  } else {
    require.cache[mqttPath] = {
      id: mqttPath,
      filename: mqttPath,
      loaded: true,
      exports: stubExports,
      children: [],
      paths: []
    };
  }

  return {
    calls,
    latest() {
      return calls.length === 0 ? undefined : calls[calls.length - 1].client;
    },
    byClientId(id) {
      const hit = calls.find((c) => c.options && c.options.clientId === id);
      return hit ? hit.client : undefined;
    },
    restore() {
      const entry = require.cache[mqttPath];
      if (entry) entry.exports = originalExports;
    }
  };
}

// ---------------------------------------------------------------------------
// Pool query stub
// ---------------------------------------------------------------------------

/**
 * Wrap `pool.query` on `mqtt-worker/src/config/db.js` with a stubbable
 * function. Tests can register a handler that decides what each `query` call
 * resolves to; by default an empty `[[], []]` shape is returned so that
 * `DeviceManager.syncDevices()` against an empty device list works without a
 * real DB.
 *
 * Usage:
 *   const dbStub = installPoolStub();
 *   dbStub.setHandler((sql, params) => {
 *     if (/^SELECT \* FROM device/i.test(sql)) return [[{ device_id: 1, ... }], []];
 *     return [[], []];
 *   });
 *   // ... run code ...
 *   dbStub.restore();
 *
 * Returned controller:
 *   - calls       : array of { sql, params } in the order observed
 *   - setHandler(fn): fn(sql, params) => Promise<[rows, fields]> | [rows, fields]
 *                    or a function that throws / returns a rejected promise
 *                    to simulate DB errors.
 *   - reset()     : clear `calls` and remove the registered handler (revert
 *                   to the default empty-result behavior).
 *   - restore()   : restore the original `pool.query`.
 */
function installPoolStub() {
  const poolPath = require.resolve(path.join(__dirname, '..', 'src', 'config', 'db.js'));
  const pool = require(poolPath);
  const originalQuery = pool.query.bind(pool);

  const state = {
    calls: [],
    handler: null
  };

  pool.query = async function stubbedQuery(sql, params) {
    state.calls.push({ sql, params });
    if (state.handler) {
      // Allow the handler to throw synchronously, return a value, or return
      // a promise. Always normalise to a promise.
      return await state.handler(sql, params);
    }
    return [[], []];
  };

  return {
    calls: state.calls,
    setHandler(fn) { state.handler = fn; },
    reset() {
      state.calls.length = 0;
      state.handler = null;
    },
    restore() {
      pool.query = originalQuery;
    }
  };
}

// ---------------------------------------------------------------------------
// Fake timers (setInterval / clearInterval only)
// ---------------------------------------------------------------------------

/**
 * Minimal fake timer helper for the heartbeat path. Only `setInterval` and
 * `clearInterval` are intercepted because that's all `DeviceManager` uses for
 * the 30-second heartbeat. The wider Node timer API (setTimeout, setImmediate,
 * Date.now, etc.) is left untouched.
 *
 * Usage:
 *   const timers = useFakeTimers();
 *   timers.install();
 *   // ... start heartbeat ...
 *   await timers.tick(60_000); // fires the 30s interval twice
 *   timers.restore();
 *
 * Returned controller:
 *   - install()        : monkey-patch global setInterval / clearInterval
 *   - restore()        : put the originals back
 *   - tick(ms)         : advance virtual time by `ms`. For each registered
 *                        interval, fire its callback `floor(elapsed / ms)`
 *                        times in installation order. Returns a promise that
 *                        resolves once all (possibly async) callbacks settle.
 *   - intervals()      : snapshot of [{ id, ms, fn }] for inspection
 *   - now()            : current virtual time (ms since install())
 */
function useFakeTimers() {
  let originalSetInterval = null;
  let originalClearInterval = null;
  let installed = false;
  let nextId = 1;
  let virtualNow = 0;
  // id -> { id, ms, fn, lastFiredAt }
  const intervals = new Map();

  function fakeSetInterval(fn, ms) {
    const id = nextId++;
    intervals.set(id, { id, ms: Number(ms) || 0, fn, lastFiredAt: virtualNow });
    // Mimic the Node timer object enough that `clearInterval(setInterval(...))`
    // works and code that stores the return value as a numeric id also works.
    const handle = { _id: id, ref() { return handle; }, unref() { return handle; } };
    // Allow `clearInterval(id)` (numeric) too.
    handle.valueOf = function () { return id; };
    return handle;
  }

  function fakeClearInterval(handle) {
    if (handle == null) return;
    const id = typeof handle === 'object' && handle !== null && '_id' in handle
      ? handle._id
      : Number(handle);
    intervals.delete(id);
  }

  return {
    install() {
      if (installed) return;
      originalSetInterval = global.setInterval;
      originalClearInterval = global.clearInterval;
      global.setInterval = fakeSetInterval;
      global.clearInterval = fakeClearInterval;
      installed = true;
    },
    restore() {
      if (!installed) return;
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      originalSetInterval = null;
      originalClearInterval = null;
      installed = false;
      intervals.clear();
      virtualNow = 0;
      nextId = 1;
    },
    async tick(ms) {
      const advance = Number(ms) || 0;
      const target = virtualNow + advance;
      // Snapshot intervals at tick start so newly-added ones during fires
      // don't immediately fire in this tick.
      const snapshot = Array.from(intervals.values());
      const pending = [];
      for (const interval of snapshot) {
        if (interval.ms <= 0) continue;
        // Number of times this interval should fire in [virtualNow, target].
        const elapsedSinceLast = target - interval.lastFiredAt;
        const fires = Math.floor(elapsedSinceLast / interval.ms);
        if (fires <= 0) continue;
        for (let i = 0; i < fires; i++) {
          interval.lastFiredAt += interval.ms;
          try {
            const result = interval.fn();
            if (result && typeof result.then === 'function') {
              pending.push(result);
            }
          } catch (err) {
            pending.push(Promise.reject(err));
          }
        }
      }
      virtualNow = target;
      // Wait for any async callbacks to settle so assertions made after
      // `await timers.tick(...)` see the side effects.
      if (pending.length) {
        await Promise.allSettled(pending);
      }
    },
    intervals() {
      return Array.from(intervals.values()).map((i) => ({
        id: i.id,
        ms: i.ms,
        fn: i.fn
      }));
    },
    now() {
      return virtualNow;
    }
  };
}

// ---------------------------------------------------------------------------
// Module reset
// ---------------------------------------------------------------------------

/**
 * Drop a module from `require.cache` so the next `require()` runs the module
 * factory fresh. Useful for `DeviceManager`, which is a `module.exports = new
 * DeviceManager()` singleton — tests that need a clean instance after
 * installing stubs should:
 *
 *   resetModule('../src/services/DeviceManager');
 *   const deviceManager = require('../src/services/DeviceManager');
 *
 * Accepts either a path resolvable from the caller (e.g. relative paths only
 * work for already-cached modules whose absolute filename we can resolve).
 * The simplest form is to pass a path relative to this helper file.
 */
function resetModule(modPath) {
  let resolved;
  try {
    resolved = require.resolve(modPath);
  } catch (e) {
    // Fall back to resolving relative to this helper's directory.
    resolved = require.resolve(path.resolve(__dirname, modPath));
  }
  delete require.cache[resolved];
  return resolved;
}

module.exports = {
  createFakeMqttClient,
  installMqttStub,
  installPoolStub,
  useFakeTimers,
  resetModule
};

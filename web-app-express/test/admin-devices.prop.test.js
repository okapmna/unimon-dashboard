'use strict';

// Feature: admin-user-device-management
//
// Property tests for the admin device-management routes:
//
//   - Property 1  (Task 7.6) : add_device produces device + serial regex + token row
//                              Validates Requirement 1.1
//   - Property 2  (Task 7.7) : edit_device round-trip
//                              Validates Requirement 1.2
//   - Property 3  (Task 7.8) : delete_device cascade
//                              Validates Requirement 1.3
//   - Property 7  (Task 7.9) : change_owner state
//                              Validates Requirements 2.1, 2.2
//   - Property 12 (Task 7.12): /admin/devices firmware/last_seen rendering
//                              Validates Requirements 5.1, 5.4
//   - Property 13 (Task 7.13): /admin/devices reads fresh DB
//                              Validates Requirement 5.5
//
// Same env-var / cleanup / setImmediate(process.exit) skeleton as the other
// admin property tests so the test process exits cleanly even though
// express-mysql-session keeps a periodic timer alive.

process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'user_app';
process.env.DB_PASS = process.env.DB_PASS || 'password_app';
process.env.DB_NAME = process.env.DB_NAME || 'unimq';
process.env.DB_PORT = process.env.DB_PORT || '3306';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const app = require('../src/app');
const { pool } = require('../src/config/db');
const { ensureAdminDeviceTables } = require('../src/services/devices');
const {
  request,
  signSession,
  seedUser,
  seedDevice,
  seedAccess
} = require('./_helpers');

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const seededUserIds = [];

function trackUser(user) {
  if (user && user.user_id != null) seededUserIds.push(user.user_id);
  return user;
}

async function cleanupUser(userId) {
  await pool.query('DELETE FROM admin_audit_log WHERE admin_id = ?', [userId]);
  await pool.query('DELETE FROM device_access_tokens WHERE created_by = ?', [userId]);
  await pool.query('DELETE FROM user_device_access WHERE user_id = ?', [userId]);
  await pool.query(
    'DELETE FROM user_device_access WHERE device_id IN (SELECT device_id FROM device WHERE user_id = ?)',
    [userId]
  );
  await pool.query('DELETE FROM device WHERE user_id = ?', [userId]);
  await pool.query('DELETE FROM user_tokens WHERE user_id = ?', [userId]);
  await pool.query('DELETE FROM `user` WHERE user_id = ?', [userId]);
}

before(async () => {
  await ensureAdminDeviceTables();
});

after(async () => {
  for (const id of seededUserIds.splice(0)) {
    try { await cleanupUser(id); } catch (err) { /* ignore */ }
  }
  await pool.end();
  setImmediate(() => process.exit());
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Extract the substring of the rendered admin/devices HTML that corresponds to
// the table row containing `serial`. The admin/devices table renders one
// `<tr>` per device and includes the device's `serial_number` inside it; we
// slice from the most recent `<tr` before the serial up to the next `</tr>`.
function findRowFor(html, serial) {
  const idx = html.indexOf(serial);
  if (idx < 0) return null;
  const start = html.lastIndexOf('<tr', idx);
  const end = html.indexOf('</tr>', idx);
  if (start < 0 || end < 0) return null;
  return html.slice(start, end + '</tr>'.length);
}

const DEVICE_TYPES = ['esp32-inkubator', 'esp32-smartlamp'];

// ---------------------------------------------------------------------------
// Property 1 (Task 7.6): add_device produces device + serial regex + token row
// Validates: Requirement 1.1
// ---------------------------------------------------------------------------
test('Property 1: admin add_device creates device + 8-hex serial + paired token', async () => {
  const admin = trackUser(await seedUser(null, { role: 'admin' }));
  const adminSess = await signSession(app, admin);

  await fc.assert(
    fc.asyncProperty(
      fc.record({
        deviceName: fc.stringMatching(/^[a-zA-Z0-9 _-]{3,30}$/),
        deviceType: fc.constantFrom(...DEVICE_TYPES),
        brokerUrl: fc.stringMatching(/^[a-z0-9.-]{3,30}$/),
        brokerPort: fc.integer({ min: 1, max: 65535 }).map(String),
        mqUser: fc.stringMatching(/^[a-zA-Z0-9_]{0,15}$/),
        mqPass: fc.stringMatching(/^[a-zA-Z0-9_]{0,15}$/)
      }),
      async (input) => {
        // Per-iteration owner so cleanup-by-user_id picks up every created
        // device exactly once.
        const owner = trackUser(await seedUser(null, { role: 'user' }));

        const res = await request(app, {
          method: 'POST',
          path: '/admin/devices',
          headers: { Cookie: adminSess.cookieHeader },
          body: {
            add_device: '1',
            device_name: input.deviceName,
            device_type: input.deviceType,
            broker_url: input.brokerUrl,
            broker_port: input.brokerPort,
            owner_id: owner.user_id,
            mq_user: input.mqUser,
            mq_pass: input.mqPass
          }
        });

        assert.equal(res.status, 302, 'add_device must redirect (302)');
        assert.equal(
          res.headers.location,
          '/admin/devices',
          'add_device must redirect to /admin/devices'
        );

        // A new device row exists for this owner with the input fields.
        const [deviceRows] = await pool.query(
          `SELECT device_id, device_name, device_type, broker_url, broker_port,
                  mq_user, mq_pass, user_id, serial_number
             FROM device WHERE user_id = ?
            ORDER BY device_id DESC LIMIT 1`,
          [owner.user_id]
        );
        assert.equal(
          deviceRows.length,
          1,
          'exactly one device row must exist for this owner (Req 1.1)'
        );
        const dev = deviceRows[0];
        assert.equal(dev.device_name, input.deviceName);
        assert.equal(dev.device_type, input.deviceType);
        assert.equal(dev.broker_url, input.brokerUrl);
        assert.equal(String(dev.broker_port), input.brokerPort);
        assert.equal(dev.mq_user, input.mqUser);
        assert.equal(dev.mq_pass, input.mqPass);
        assert.equal(dev.user_id, owner.user_id);

        // Serial number is 8-char uppercase hex (Req 1.1).
        assert.match(
          String(dev.serial_number),
          /^[0-9A-F]{8}$/,
          'serial_number must match ^[0-9A-F]{8}$ (Req 1.1)'
        );

        // Paired device_access_tokens row with max_uses = 1 (Req 1.1).
        const [tokenRows] = await pool.query(
          `SELECT token_id, device_id, token_code, serial_number, max_uses, created_by
             FROM device_access_tokens WHERE device_id = ?`,
          [dev.device_id]
        );
        assert.equal(
          tokenRows.length,
          1,
          'exactly one device_access_tokens row must exist for the new device (Req 1.1)'
        );
        const tok = tokenRows[0];
        assert.equal(tok.max_uses, 1, 'token max_uses must be 1 (Req 1.1)');
        assert.equal(
          tok.serial_number,
          dev.serial_number,
          'token.serial_number must match device.serial_number'
        );
        assert.equal(
          tok.token_code,
          dev.serial_number,
          'token.token_code must match device.serial_number'
        );
        assert.equal(
          tok.created_by,
          admin.user_id,
          'token.created_by must equal admin user_id'
        );
      }
    ),
    { numRuns: 25 }
  );
});

// ---------------------------------------------------------------------------
// Property 2 (Task 7.7): edit_device round-trip
// Validates: Requirement 1.2
// ---------------------------------------------------------------------------
test('Property 2: admin edit_device is a write-then-read identity', async () => {
  const admin = trackUser(await seedUser(null, { role: 'admin' }));
  const adminSess = await signSession(app, admin);

  await fc.assert(
    fc.asyncProperty(
      fc.record({
        deviceName: fc.stringMatching(/^[a-zA-Z0-9 _-]{3,30}$/),
        deviceType: fc.constantFrom(...DEVICE_TYPES),
        brokerUrl: fc.stringMatching(/^[a-z0-9.-]{3,30}$/),
        brokerPort: fc.integer({ min: 1, max: 65535 }).map(String),
        mqUser: fc.stringMatching(/^[a-zA-Z0-9_]{0,15}$/),
        mqPass: fc.stringMatching(/^[a-zA-Z0-9_]{0,15}$/)
      }),
      async (input) => {
        const oldOwner = trackUser(await seedUser(null, { role: 'user' }));
        const newOwner = trackUser(await seedUser(null, { role: 'user' }));
        const device = await seedDevice(null, { user_id: oldOwner.user_id });

        const res = await request(app, {
          method: 'POST',
          path: '/admin/devices',
          headers: { Cookie: adminSess.cookieHeader },
          body: {
            edit_device: '1',
            edit_device_id: device.device_id,
            edit_device_name: input.deviceName,
            edit_device_type: input.deviceType,
            edit_owner_id: newOwner.user_id,
            edit_broker_url: input.brokerUrl,
            edit_broker_port: input.brokerPort,
            edit_mq_user: input.mqUser,
            edit_mq_pass: input.mqPass
          }
        });
        assert.equal(res.status, 302, 'edit_device must redirect (302)');
        assert.equal(res.headers.location, '/admin/devices');

        const [rows] = await pool.query(
          `SELECT device_name, device_type, broker_url, broker_port,
                  mq_user, mq_pass, user_id
             FROM device WHERE device_id = ?`,
          [device.device_id]
        );
        assert.equal(rows.length, 1, 'device row must still exist after edit');
        const r = rows[0];
        assert.equal(r.device_name, input.deviceName, 'device_name must match input (Req 1.2)');
        assert.equal(r.device_type, input.deviceType, 'device_type must match input (Req 1.2)');
        assert.equal(r.broker_url, input.brokerUrl, 'broker_url must match input (Req 1.2)');
        assert.equal(String(r.broker_port), input.brokerPort, 'broker_port must match input (Req 1.2)');
        assert.equal(r.mq_user, input.mqUser, 'mq_user must match input (Req 1.2)');
        assert.equal(r.mq_pass, input.mqPass, 'mq_pass must match input (Req 1.2)');
        assert.equal(r.user_id, newOwner.user_id, 'user_id must equal new owner (Req 1.2)');
      }
    ),
    { numRuns: 25 }
  );
});

// ---------------------------------------------------------------------------
// Property 3 (Task 7.8): delete_device cascade
// Validates: Requirement 1.3
// ---------------------------------------------------------------------------
test('Property 3: admin delete_device cascades to all related rows', async () => {
  const admin = trackUser(await seedUser(null, { role: 'admin' }));
  const adminSess = await signSession(app, admin);

  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 3 }),
      async (numViewers) => {
        const owner = trackUser(await seedUser(null, { role: 'user' }));
        const device = await seedDevice(null, { user_id: owner.user_id });
        const deviceId = device.device_id;

        // Seed N viewer access rows.
        const viewers = [];
        for (let i = 0; i < numViewers; i++) {
          const v = trackUser(await seedUser(null, { role: 'user' }));
          await seedAccess(null, {
            user_id: v.user_id,
            device_id: deviceId,
            access_type: 'viewer'
          });
          viewers.push(v);
        }

        // Seed at least one device_access_tokens row.
        await pool.query(
          `INSERT INTO device_access_tokens
             (device_id, token_code, serial_number, created_by, max_uses)
           VALUES (?, ?, ?, ?, 1)`,
          [
            deviceId,
            'TOK-' + deviceId + '-' + Math.random().toString(16).slice(2, 8),
            'SN' + deviceId + '-' + Math.random().toString(16).slice(2, 8),
            admin.user_id
          ]
        );

        // Seed at least one device_logs row (so we can verify cascade there).
        await pool.query(
          `INSERT INTO device_logs (device_id, data, log_type)
           VALUES (?, ?, 'aggregation')`,
          [deviceId, JSON.stringify({ value: 1 })]
        );

        // Sanity: pre-conditions are non-zero / one for relevant tables.
        const [pre] = await pool.query(
          `SELECT
             (SELECT COUNT(*) FROM device WHERE device_id = ?) AS d,
             (SELECT COUNT(*) FROM user_device_access WHERE device_id = ?) AS uda,
             (SELECT COUNT(*) FROM device_access_tokens WHERE device_id = ?) AS tok,
             (SELECT COUNT(*) FROM device_logs WHERE device_id = ?) AS logs`,
          [deviceId, deviceId, deviceId, deviceId]
        );
        assert.equal(pre[0].d, 1, 'precondition: device row must exist');
        assert.equal(pre[0].uda, numViewers, 'precondition: viewer rows must exist');
        assert.ok(pre[0].tok >= 1, 'precondition: at least one token row');
        assert.ok(pre[0].logs >= 1, 'precondition: at least one log row');

        const res = await request(app, {
          method: 'POST',
          path: '/admin/devices',
          headers: { Cookie: adminSess.cookieHeader },
          body: { delete_device: '1', device_id: deviceId }
        });
        assert.equal(res.status, 302, 'delete_device must redirect (302)');
        assert.equal(res.headers.location, '/admin/devices');

        // Req 1.3: zero rows in every dependent table for that device_id.
        const [post] = await pool.query(
          `SELECT
             (SELECT COUNT(*) FROM device WHERE device_id = ?) AS d,
             (SELECT COUNT(*) FROM user_device_access WHERE device_id = ?) AS uda,
             (SELECT COUNT(*) FROM device_access_tokens WHERE device_id = ?) AS tok,
             (SELECT COUNT(*) FROM device_logs WHERE device_id = ?) AS logs`,
          [deviceId, deviceId, deviceId, deviceId]
        );
        assert.equal(post[0].d, 0, 'device row must be gone (Req 1.3)');
        assert.equal(post[0].uda, 0, 'user_device_access must cascade-delete (Req 1.3)');
        assert.equal(post[0].tok, 0, 'device_access_tokens must cascade-delete (Req 1.3)');
        assert.equal(post[0].logs, 0, 'device_logs must cascade-delete (Req 1.3)');
      }
    ),
    { numRuns: 25 }
  );
});

// ---------------------------------------------------------------------------
// Property 7 (Task 7.9): change_owner state
// Validates: Requirements 2.1, 2.2
// ---------------------------------------------------------------------------
test('Property 7: admin change_owner moves owner and removes duplicate viewer row', async () => {
  const admin = trackUser(await seedUser(null, { role: 'admin' }));
  const adminSess = await signSession(app, admin);

  await fc.assert(
    fc.asyncProperty(fc.constant(0), async () => {
      const oldOwner = trackUser(await seedUser(null, { role: 'user' }));
      const newOwner = trackUser(await seedUser(null, { role: 'user' }));
      const device = await seedDevice(null, { user_id: oldOwner.user_id });

      // Pre-seed the new owner as a viewer of this device so we can verify
      // change_owner removes the duplicate access row (Req 2.2).
      await seedAccess(null, {
        user_id: newOwner.user_id,
        device_id: device.device_id,
        access_type: 'viewer'
      });

      const res = await request(app, {
        method: 'POST',
        path: '/admin/devices',
        headers: { Cookie: adminSess.cookieHeader },
        body: {
          change_owner: '1',
          device_id: device.device_id,
          new_owner_id: newOwner.user_id
        }
      });
      assert.equal(res.status, 302, 'change_owner must redirect (302)');
      assert.equal(res.headers.location, '/admin/devices');

      // Req 2.1: device.user_id = new_owner_id.
      const [devRows] = await pool.query(
        'SELECT user_id FROM device WHERE device_id = ?',
        [device.device_id]
      );
      assert.equal(devRows.length, 1, 'device row still exists');
      assert.equal(
        devRows[0].user_id,
        newOwner.user_id,
        'device.user_id must equal new owner (Req 2.1)'
      );

      // Req 2.2: no row in user_device_access for (new_owner, device).
      const [accessRows] = await pool.query(
        'SELECT id FROM user_device_access WHERE user_id = ? AND device_id = ?',
        [newOwner.user_id, device.device_id]
      );
      assert.equal(
        accessRows.length,
        0,
        'duplicate viewer row for new owner must be removed (Req 2.2)'
      );
    }),
    { numRuns: 25 }
  );
});

// ---------------------------------------------------------------------------
// Property 12 (Task 7.12): /admin/devices firmware/last_seen text
// Validates: Requirements 5.1, 5.4
// ---------------------------------------------------------------------------
test('Property 12: /admin/devices renders firmware and last_seen as readable text', async () => {
  const admin = trackUser(await seedUser(null, { role: 'admin' }));
  const adminSess = await signSession(app, admin);

  await fc.assert(
    fc.asyncProperty(fc.constant(0), async () => {
      const owner = trackUser(await seedUser(null, { role: 'user' }));

      // Four devices, one per state combination we care about.
      const devNullFw = await seedDevice(null, { user_id: owner.user_id });
      const devSetFw = await seedDevice(null, { user_id: owner.user_id });
      const devNullLastSeen = await seedDevice(null, { user_id: owner.user_id });
      const devFreshLastSeen = await seedDevice(null, { user_id: owner.user_id });

      // Force the state explicitly via direct UPDATEs (the route doesn't expose
      // these fields).
      await pool.query(
        'UPDATE device SET firmware_version = NULL, last_seen_at = NULL WHERE device_id = ?',
        [devNullFw.device_id]
      );
      await pool.query(
        'UPDATE device SET firmware_version = ?, last_seen_at = NULL WHERE device_id = ?',
        ['1.2.3', devSetFw.device_id]
      );
      await pool.query(
        'UPDATE device SET firmware_version = NULL, last_seen_at = NULL WHERE device_id = ?',
        [devNullLastSeen.device_id]
      );
      await pool.query(
        'UPDATE device SET firmware_version = ?, last_seen_at = NOW(), is_connected = 1 WHERE device_id = ?',
        ['9.9.9', devFreshLastSeen.device_id]
      );

      const res = await request(app, {
        method: 'GET',
        path: '/admin/devices',
        headers: { Cookie: adminSess.cookieHeader }
      });
      assert.equal(res.status, 200, 'admin GET /admin/devices must render');
      const html = res.body;

      // Per-device row rendering (Req 5.1, 5.4).
      const rowNullFw = findRowFor(html, devNullFw.serial_number);
      assert.ok(rowNullFw, 'NULL-firmware device row must be in HTML');
      assert.ok(
        rowNullFw.includes('unknown'),
        'NULL firmware_version row must render "unknown" (Req 5.1)'
      );

      const rowSetFw = findRowFor(html, devSetFw.serial_number);
      assert.ok(rowSetFw, 'set-firmware device row must be in HTML');
      assert.ok(
        rowSetFw.includes('1.2.3'),
        'populated firmware_version row must render "1.2.3" (Req 5.1)'
      );

      const rowNullLs = findRowFor(html, devNullLastSeen.serial_number);
      assert.ok(rowNullLs, 'NULL-last-seen device row must be in HTML');
      assert.ok(
        rowNullLs.includes('Belum pernah terhubung'),
        'NULL last_seen_at row must render "Belum pernah terhubung" (Req 5.4)'
      );

      const rowFresh = findRowFor(html, devFreshLastSeen.serial_number);
      assert.ok(rowFresh, 'fresh-last-seen device row must be in HTML');
      assert.match(
        rowFresh,
        /\d+[smhd] ago/,
        'fresh last_seen_at row must render an "Xs/m/h/d ago" string (Req 5.4)'
      );
    }),
    { numRuns: 10 }
  );
});

// ---------------------------------------------------------------------------
// Property 13 (Task 7.13): /admin/devices reads fresh DB
// Validates: Requirement 5.5
// ---------------------------------------------------------------------------
test('Property 13: /admin/devices reflects DB updates between two GETs', async () => {
  const admin = trackUser(await seedUser(null, { role: 'admin' }));
  const adminSess = await signSession(app, admin);

  await fc.assert(
    fc.asyncProperty(fc.constant(0), async () => {
      const owner = trackUser(await seedUser(null, { role: 'user' }));
      const device = await seedDevice(null, { user_id: owner.user_id });
      const deviceId = device.device_id;
      const serial = device.serial_number;

      // v1: disconnected, firmware = 1.0.0.
      await pool.query(
        `UPDATE device SET is_connected = 0, last_seen_at = NULL, firmware_version = ?
           WHERE device_id = ?`,
        ['1.0.0', deviceId]
      );

      const res1 = await request(app, {
        method: 'GET',
        path: '/admin/devices',
        headers: { Cookie: adminSess.cookieHeader }
      });
      assert.equal(res1.status, 200, 'first GET must render');
      const row1 = findRowFor(res1.body, serial);
      assert.ok(row1, 'first GET must include the device row');
      assert.ok(
        row1.includes('1.0.0'),
        'first GET row must show firmware "1.0.0" (Req 5.5)'
      );
      assert.ok(
        row1.includes('Disconnected'),
        'first GET row must show "Disconnected" (Req 5.5)'
      );

      // v2: connected fresh, firmware = 2.0.0.
      await pool.query(
        `UPDATE device SET is_connected = 1, last_seen_at = NOW(), firmware_version = ?
           WHERE device_id = ?`,
        ['2.0.0', deviceId]
      );

      const res2 = await request(app, {
        method: 'GET',
        path: '/admin/devices',
        headers: { Cookie: adminSess.cookieHeader }
      });
      assert.equal(res2.status, 200, 'second GET must render');
      const row2 = findRowFor(res2.body, serial);
      assert.ok(row2, 'second GET must include the device row');
      assert.ok(
        row2.includes('2.0.0'),
        'second GET row must reflect updated firmware "2.0.0" (Req 5.5)'
      );
      // 'Connected' is a substring of 'Disconnected', so check both presence
      // of 'Connected' AND absence of 'Disconnected'.
      assert.ok(
        row2.includes('Connected'),
        'second GET row must reflect updated "Connected" status (Req 5.5)'
      );
      assert.ok(
        !row2.includes('Disconnected'),
        'second GET row must NOT still render "Disconnected" (Req 5.5)'
      );
    }),
    { numRuns: 5 }
  );
});

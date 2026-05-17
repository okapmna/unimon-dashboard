'use strict';

// Feature: admin-user-device-management
//
// Property tests for the owner-driven sharing/revoke action routes:
//
//   - Property 15 (Task 6.4): Share device menambah baris viewer; revoke share menghapusnya
//                             Validates Requirements 6.3, 6.8
//   - Property 16 (Task 6.5): Aksi sharing/transfer dari non-owner ditolak 403 dan tidak
//                             mengubah DB
//                             Validates Requirements 6.6, 7.2

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
  seedDevice
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

async function countAccessFor(userId, deviceId) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS c FROM user_device_access WHERE user_id = ? AND device_id = ?',
    [userId, deviceId]
  );
  return rows[0].c;
}

async function snapshotDeviceState(deviceId) {
  // Scope the "DB unchanged" assertion to rows that the action under test
  // could legitimately touch. Using global COUNT(*) makes the assertion
  // racy when other test files run in parallel and seed unrelated rows.
  const [accessCount] = await pool.query(
    'SELECT COUNT(*) AS c FROM user_device_access WHERE device_id = ?',
    [deviceId]
  );
  const [auditCount] = await pool.query(
    "SELECT COUNT(*) AS c FROM admin_audit_log WHERE target_type = 'device' AND target_id = ?",
    [deviceId]
  );
  const [deviceRow] = await pool.query(
    'SELECT user_id FROM device WHERE device_id = ?',
    [deviceId]
  );
  return {
    user_device_access: accessCount[0].c,
    admin_audit_log: auditCount[0].c,
    owner_user_id: deviceRow[0] ? deviceRow[0].user_id : null
  };
}

async function readDeviceOwner(deviceId) {
  const [rows] = await pool.query(
    'SELECT user_id FROM device WHERE device_id = ?',
    [deviceId]
  );
  return rows[0] ? rows[0].user_id : null;
}

// ---------------------------------------------------------------------------
// Property 15 (Task 6.4): share + revoke roundtrip
// Validates: Requirements 6.3, 6.8
// ---------------------------------------------------------------------------
test('Property 15: share_device adds viewer row; revoke_share removes it', async () => {
  await fc.assert(
    fc.asyncProperty(fc.constant(0), async () => {
      const owner = trackUser(await seedUser(null, { role: 'user' }));
      const target = trackUser(await seedUser(null, { role: 'user' }));
      const device = await seedDevice(null, { user_id: owner.user_id });

      const sess = await signSession(app, owner);

      // Share.
      const shareRes = await request(app, {
        method: 'POST',
        path: '/actions/share_device',
        headers: { Cookie: sess.cookieHeader },
        body: {
          device_id: device.device_id,
          target_username: target.user_name
        }
      });
      assert.equal(shareRes.status, 302, 'successful share must redirect (302)');
      assert.equal(
        shareRes.headers.location,
        '/dashboard',
        'successful share must redirect to /dashboard'
      );

      // Req 6.3: row (target_user_id, device_id, 'viewer') exists.
      const [afterShare] = await pool.query(
        `SELECT access_type FROM user_device_access
          WHERE user_id = ? AND device_id = ?`,
        [target.user_id, device.device_id]
      );
      assert.equal(afterShare.length, 1, 'share must insert exactly one row');
      assert.equal(
        afterShare[0].access_type,
        'viewer',
        'shared row must have access_type = viewer (Req 6.3)'
      );

      // Revoke.
      const revokeRes = await request(app, {
        method: 'POST',
        path: '/actions/revoke_share',
        headers: { Cookie: sess.cookieHeader },
        body: {
          device_id: device.device_id,
          viewer_user_id: target.user_id
        }
      });
      assert.equal(revokeRes.status, 302, 'successful revoke must redirect (302)');

      // Req 6.8: that row no longer exists.
      assert.equal(
        await countAccessFor(target.user_id, device.device_id),
        0,
        'revoke_share must delete the (target, device) viewer row (Req 6.8)'
      );
    }),
    { numRuns: 25 }
  );
});

// ---------------------------------------------------------------------------
// Property 16 (Task 6.5): non-owner sharing/transfer rejected with 403
// Validates: Requirements 6.6, 7.2
// ---------------------------------------------------------------------------
test('Property 16: non-owner sharing/transfer rejected 403, DB unchanged', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('share_device', 'revoke_share', 'transfer_ownership'),
      async (action) => {
        // Owner O, attacker A (non-owner), target T.
        const owner = trackUser(await seedUser(null, { role: 'user' }));
        const attacker = trackUser(await seedUser(null, { role: 'user' }));
        const target = trackUser(await seedUser(null, { role: 'user' }));
        const device = await seedDevice(null, { user_id: owner.user_id });

        const attackerSess = await signSession(app, attacker);

        const before = await snapshotDeviceState(device.device_id);
        const ownerBefore = before.owner_user_id;

        // Build a request body shaped per action.
        let body;
        if (action === 'share_device') {
          body = { device_id: device.device_id, target_username: target.user_name };
        } else if (action === 'revoke_share') {
          body = { device_id: device.device_id, viewer_user_id: target.user_id };
        } else { // transfer_ownership
          body = {
            device_id: device.device_id,
            target_username: target.user_name,
            keep_as_viewer: 'on'
          };
        }

        const res = await request(app, {
          method: 'POST',
          path: '/actions/' + action,
          headers: { Cookie: attackerSess.cookieHeader },
          body
        });

        // Req 6.6 / 7.2: status 403.
        assert.equal(
          res.status,
          403,
          `non-owner POST /actions/${action} must return 403 (got ${res.status})`
        );

        // DB unchanged for this device.
        const after = await snapshotDeviceState(device.device_id);
        assert.deepEqual(
          after,
          before,
          `non-owner POST /actions/${action} must not change device / user_device_access / admin_audit_log for device ${device.device_id}`
        );

        const ownerAfter = await readDeviceOwner(device.device_id);
        assert.equal(
          ownerAfter,
          ownerBefore,
          `non-owner POST /actions/${action} must not change device.user_id`
        );
      }
    ),
    { numRuns: 25 }
  );
});

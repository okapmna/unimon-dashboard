'use strict';

// Feature: admin-user-device-management
//
// Property tests for the owner-driven transfer route and audit-log invariant:
//
//   - Property 17 (Task 6.6): Transfer ownership memindah owner dan opsional menyisakan viewer
//                             Validates Requirements 7.1, 7.5, 7.7
//   - Property 18 (Task 6.7): Aksi user (sharing/transfer) tidak menulis admin_audit_log
//                             Validates Requirements 7.6, 11.4

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

async function readDeviceOwner(deviceId) {
  const [rows] = await pool.query(
    'SELECT user_id FROM device WHERE device_id = ?',
    [deviceId]
  );
  return rows[0] ? rows[0].user_id : null;
}

async function countAccessFor(userId, deviceId) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS c FROM user_device_access WHERE user_id = ? AND device_id = ?',
    [userId, deviceId]
  );
  return rows[0].c;
}

async function countAuditLog() {
  const [rows] = await pool.query('SELECT COUNT(*) AS c FROM admin_audit_log');
  return rows[0].c;
}

// ---------------------------------------------------------------------------
// Property 17 (Task 6.6): transfer ownership state
// Validates: Requirements 7.1, 7.5, 7.7
// ---------------------------------------------------------------------------
test('Property 17: transfer_ownership moves owner and optionally keeps viewer', async () => {
  await fc.assert(
    fc.asyncProperty(fc.boolean(), async (keepAsViewer) => {
      const owner = trackUser(await seedUser(null, { role: 'user' }));
      const target = trackUser(await seedUser(null, { role: 'user' }));
      const device = await seedDevice(null, { user_id: owner.user_id });

      const ownerSess = await signSession(app, owner);

      const body = {
        device_id: device.device_id,
        target_username: target.user_name
      };
      if (keepAsViewer) body.keep_as_viewer = 'on';

      const res = await request(app, {
        method: 'POST',
        path: '/actions/transfer_ownership',
        headers: { Cookie: ownerSess.cookieHeader },
        body
      });

      // Req 7.7: success → 302 to /dashboard.
      assert.equal(res.status, 302, 'successful transfer must redirect (302)');
      assert.equal(
        res.headers.location,
        '/dashboard',
        'successful transfer must redirect to /dashboard (Req 7.7)'
      );

      // Req 7.1: device.user_id = target_user_id.
      assert.equal(
        await readDeviceOwner(device.device_id),
        target.user_id,
        'device.user_id must equal target user_id after transfer (Req 7.1)'
      );

      // Req 7.1: target should NOT be a viewer of their own device.
      assert.equal(
        await countAccessFor(target.user_id, device.device_id),
        0,
        'new owner must not have a user_device_access row (Req 7.1)'
      );

      // Req 7.1 / 7.5: old owner viewer row exists IFF keepAsViewer.
      const oldOwnerAccess = await countAccessFor(owner.user_id, device.device_id);
      if (keepAsViewer) {
        assert.equal(
          oldOwnerAccess,
          1,
          'old owner must have a viewer row when keep_as_viewer=on (Req 7.1)'
        );
      } else {
        assert.equal(
          oldOwnerAccess,
          0,
          'old owner must not retain access when keep_as_viewer is absent (Req 7.5)'
        );
      }
    }),
    { numRuns: 25 }
  );
});

// ---------------------------------------------------------------------------
// Property 18 (Task 6.7): user actions never write admin_audit_log
// Validates: Requirements 7.6, 11.4
// ---------------------------------------------------------------------------
test('Property 18: owner sharing/transfer never writes admin_audit_log', async () => {
  await fc.assert(
    fc.asyncProperty(fc.constant(0), async () => {
      const before = await countAuditLog();

      const owner = trackUser(await seedUser(null, { role: 'user' }));
      const target = trackUser(await seedUser(null, { role: 'user' }));
      const device = await seedDevice(null, { user_id: owner.user_id });

      const ownerSess = await signSession(app, owner);

      // share_device → revoke_share → re-share → transfer_ownership
      const shareBody = {
        device_id: device.device_id,
        target_username: target.user_name
      };

      const r1 = await request(app, {
        method: 'POST',
        path: '/actions/share_device',
        headers: { Cookie: ownerSess.cookieHeader },
        body: shareBody
      });
      assert.equal(r1.status, 302, 'share_device must succeed');

      const r2 = await request(app, {
        method: 'POST',
        path: '/actions/revoke_share',
        headers: { Cookie: ownerSess.cookieHeader },
        body: { device_id: device.device_id, viewer_user_id: target.user_id }
      });
      assert.equal(r2.status, 302, 'revoke_share must succeed');

      const r3 = await request(app, {
        method: 'POST',
        path: '/actions/share_device',
        headers: { Cookie: ownerSess.cookieHeader },
        body: shareBody
      });
      assert.equal(r3.status, 302, 're-share must succeed');

      const r4 = await request(app, {
        method: 'POST',
        path: '/actions/transfer_ownership',
        headers: { Cookie: ownerSess.cookieHeader },
        body: {
          device_id: device.device_id,
          target_username: target.user_name
        }
      });
      assert.equal(r4.status, 302, 'transfer_ownership must succeed');

      const after = await countAuditLog();
      assert.equal(
        after,
        before,
        'admin_audit_log row count must not change after owner-driven actions (Req 7.6, 11.4)'
      );
    }),
    { numRuns: 10 }
  );
});

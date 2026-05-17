'use strict';

// Feature: admin-user-device-management
//
// Property test for the admin device-access subpage:
//
//   - Property 8 (Task 7.11): /admin/devices/:id/access shows owner ∪ all
//                             user_device_access rows
//                             Validates Requirements 3.1, 3.2, 3.3
//
// Per iteration we seed a device owned by O and N viewer rows (varied
// 0 ≤ N ≤ 3), then GET /admin/devices/:id/access as an admin and assert the
// rendered HTML contains:
//   - owner.user_name + an "owner" label
//   - every viewer's user_name + a "viewer" label
//   - the empty-state message "Tidak ada user lain yang memiliki akses"
//     when N = 0

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
// Property 8 (Task 7.11): /admin/devices/:id/access shows owner ∪ all access
// Validates: Requirements 3.1, 3.2, 3.3
// ---------------------------------------------------------------------------
test('Property 8: /admin/devices/:id/access lists owner + all viewer rows', async () => {
  const admin = trackUser(await seedUser(null, { role: 'admin' }));
  const adminSess = await signSession(app, admin);

  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 3 }), async (numViewers) => {
      const owner = trackUser(await seedUser(null, { role: 'user' }));
      const device = await seedDevice(null, { user_id: owner.user_id });

      const viewers = [];
      for (let i = 0; i < numViewers; i++) {
        const v = trackUser(await seedUser(null, { role: 'user' }));
        await seedAccess(null, {
          user_id: v.user_id,
          device_id: device.device_id,
          access_type: 'viewer'
        });
        viewers.push(v);
      }

      const res = await request(app, {
        method: 'GET',
        path: '/admin/devices/' + device.device_id + '/access',
        headers: { Cookie: adminSess.cookieHeader }
      });
      assert.equal(
        res.status,
        200,
        'admin GET /admin/devices/:id/access must render (Req 3.1)'
      );
      const html = res.body;

      // Req 3.1, 3.2: owner row with 'owner' label.
      assert.ok(
        html.includes(owner.user_name),
        'rendered HTML must include owner user_name (Req 3.1)'
      );
      assert.ok(
        html.includes('owner'),
        'rendered HTML must include the "owner" access_type label (Req 3.2)'
      );

      // Req 3.1, 3.2: every viewer row.
      for (const v of viewers) {
        assert.ok(
          html.includes(v.user_name),
          `rendered HTML must include viewer user_name "${v.user_name}" (Req 3.1)`
        );
      }
      if (viewers.length > 0) {
        assert.ok(
          html.includes('viewer'),
          'rendered HTML must include the "viewer" access_type label (Req 3.2)'
        );
      }

      // Req 3.3: empty-state message when N = 0.
      if (numViewers === 0) {
        assert.ok(
          html.includes('Tidak ada user lain yang memiliki akses'),
          'with no viewers the empty-state message must render (Req 3.3)'
        );
      }
    }),
    { numRuns: 10 }
  );
});

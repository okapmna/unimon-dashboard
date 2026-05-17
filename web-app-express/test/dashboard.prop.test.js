'use strict';

// Feature: admin-user-device-management
//
// Property test for the dashboard owner kebab menu UI:
//
//   - Property 14 (Task 5.3): Kebab menu owner dirender pada setiap kartu owner
//                             Validates Requirements 6.1, 6.2, 6.7
//
// Per iteration we seed N owned devices and M shared (viewer) devices for one
// "owner" user, log them in, GET /dashboard, then assert the rendered HTML:
//   - has `onclick="toggleKebab(<deviceId>)"` for every owned device
//   - has `onclick="openShareModal(<deviceId>)"` for every owned device
//   - has `onclick="openTransferModal(<deviceId>)"` for every owned device
//   - shows a viewer name + a /actions/revoke_share form for any seeded viewer
//     of an owned device
//   - does NOT render a kebab toggle for shared (viewer) cards
//
// The same env-var / cleanup / setImmediate(process.exit) skeleton as
// auth.prop.test.js is reused so the test process exits cleanly even though
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
// Property 14 (Task 5.3): owner kebab menu present on every owner card
// Validates: Requirements 6.1, 6.2, 6.7
// ---------------------------------------------------------------------------
test('Property 14: dashboard renders kebab menu on every owner card', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 3 }),
      fc.integer({ min: 0, max: 3 }),
      async (numOwned, numShared) => {
        // Per-iteration owner that we'll log in as.
        const owner = trackUser(await seedUser(null, { role: 'user' }));
        // Sharer: another user who owns devices and grants `owner` viewer access.
        const sharer = trackUser(await seedUser(null, { role: 'user' }));
        // A third user, used as a viewer on some owned devices to populate
        // the "Active Viewers" sub-list.
        const viewer = trackUser(await seedUser(null, { role: 'user' }));

        // N owned devices.
        const ownedDevices = [];
        for (let i = 0; i < numOwned; i++) {
          ownedDevices.push(await seedDevice(null, { user_id: owner.user_id }));
        }

        // M shared (viewer-access) devices: owned by sharer, owner has viewer access.
        const sharedDevices = [];
        for (let i = 0; i < numShared; i++) {
          const dev = await seedDevice(null, { user_id: sharer.user_id });
          await seedAccess(null, {
            user_id: owner.user_id,
            device_id: dev.device_id,
            access_type: 'viewer'
          });
          sharedDevices.push(dev);
        }

        // Half the owned devices get a viewer (the third user) so we can
        // assert the active-viewer sub-list appears.
        const ownedWithViewer = [];
        for (let i = 0; i < ownedDevices.length; i++) {
          if (i % 2 === 0) {
            await seedAccess(null, {
              user_id: viewer.user_id,
              device_id: ownedDevices[i].device_id,
              access_type: 'viewer'
            });
            ownedWithViewer.push(ownedDevices[i]);
          }
        }

        // Log owner in and load the dashboard.
        const sess = await signSession(app, owner);
        const res = await request(app, {
          method: 'GET',
          path: '/dashboard',
          headers: { Cookie: sess.cookieHeader }
        });
        assert.equal(res.status, 200, 'GET /dashboard must render (200)');
        const html = res.body;

        // Owner cards: kebab toggle + Share + Transfer entries (Req 6.1, 6.2)
        for (const dev of ownedDevices) {
          const id = dev.device_id;
          assert.ok(
            html.includes(`onclick="toggleKebab(${id})"`),
            `owned device ${id} must have a kebab toggle (Req 6.1)`
          );
          assert.ok(
            html.includes(`openShareModal(${id})`),
            `owned device ${id} must have a Share menu entry (Req 6.2)`
          );
          assert.ok(
            html.includes(`openTransferModal(${id})`),
            `owned device ${id} must have a Transfer Ownership menu entry (Req 6.2)`
          );
        }

        // Active viewers sub-list (Req 6.7): viewer name + revoke form
        for (const dev of ownedWithViewer) {
          assert.ok(
            html.includes(viewer.user_name),
            `viewer name ${viewer.user_name} must appear for owned device ${dev.device_id} (Req 6.7)`
          );
          assert.ok(
            html.includes('/actions/revoke_share'),
            'a /actions/revoke_share form must be rendered for active viewers (Req 6.7)'
          );
          // The viewer_user_id hidden input must be present in the rendered
          // active-viewers section.
          assert.ok(
            html.includes(`name="viewer_user_id" value="${viewer.user_id}"`),
            `revoke form for owned device ${dev.device_id} must carry hidden viewer_user_id=${viewer.user_id}`
          );
        }

        // Shared (viewer) cards: must NOT have a kebab toggle for that device.
        for (const dev of sharedDevices) {
          assert.ok(
            !html.includes(`toggleKebab(${dev.device_id})`),
            `shared device ${dev.device_id} must NOT render a kebab toggle (Req 6.1)`
          );
          // The shared-card alternative is the remove_shared form.
          assert.ok(
            html.includes('/actions/remove_shared'),
            'shared (viewer) cards must render the /actions/remove_shared form'
          );
        }
      }
    ),
    { numRuns: 10 }
  );
});

'use strict';

// Feature: admin-user-device-management
//
// Property test for invalid input across admin and owner mutation routes:
//
//   - Property 4 (Task 7.10): invalid input → no DB change, redirect (302)
//                             Validates Requirements 1.4, 2.4, 2.5, 6.4, 6.5, 7.3, 7.4
//
// Each iteration picks one of eight invalid scenarios (admin add_device with
// unknown device_type, admin add_device with missing owner_id, admin
// change_owner with non-existent new_owner_id, admin change_owner with
// new_owner_id == current owner, owner share_device with non-existent
// target_username, owner share_device with a target that already has access,
// owner transfer_ownership with non-existent target_username, and owner
// transfer_ownership with target == owner). For each scenario we snapshot the
// relevant DB state before the request, fire the request, snapshot again, and
// assert (a) the response is a 302 redirect (toast set in session means the
// route reached the redirect branch) and (b) every snapshotted table is
// unchanged.

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
// Snapshot helper: captures DB state scoped to the IDs the test cares about
// so other tests running in the same MariaDB cannot make the snapshot drift.
// ---------------------------------------------------------------------------
async function snapshotState({ ownerIds = [], deviceIds = [], adminId = null }) {
  const snap = {};

  // Per-device row + per-device access rows.
  for (const did of deviceIds) {
    const [d] = await pool.query(
      `SELECT device_id, device_name, device_type, broker_url, broker_port,
              mq_user, mq_pass, user_id, serial_number
         FROM device WHERE device_id = ?`,
      [did]
    );
    snap['device:' + did] = d[0] || null;

    const [uda] = await pool.query(
      `SELECT user_id, device_id, access_type
         FROM user_device_access
        WHERE device_id = ?
        ORDER BY user_id ASC`,
      [did]
    );
    snap['uda:' + did] = uda;

    const [tok] = await pool.query(
      'SELECT COUNT(*) AS c FROM device_access_tokens WHERE device_id = ?',
      [did]
    );
    snap['tokens:' + did] = tok[0].c;
  }

  // For add_device scenarios we also need to know whether the owner gained a
  // new device or token row.
  for (const oid of ownerIds) {
    const [d] = await pool.query(
      'SELECT COUNT(*) AS c FROM device WHERE user_id = ?',
      [oid]
    );
    snap['ownerDeviceCount:' + oid] = d[0].c;

    const [uda] = await pool.query(
      'SELECT COUNT(*) AS c FROM user_device_access WHERE user_id = ?',
      [oid]
    );
    snap['ownerAccessCount:' + oid] = uda[0].c;
  }

  if (adminId != null) {
    const [audit] = await pool.query(
      'SELECT COUNT(*) AS c FROM admin_audit_log WHERE admin_id = ?',
      [adminId]
    );
    snap['auditByAdmin:' + adminId] = audit[0].c;

    const [tok] = await pool.query(
      'SELECT COUNT(*) AS c FROM device_access_tokens WHERE created_by = ?',
      [adminId]
    );
    snap['tokensByAdmin:' + adminId] = tok[0].c;
  }

  return snap;
}

// ---------------------------------------------------------------------------
// Property 4 (Task 7.10): invalid input → DB unchanged + 302 redirect
// Validates: Requirements 1.4, 2.4, 2.5, 6.4, 6.5, 7.3, 7.4
// ---------------------------------------------------------------------------
test('Property 4: invalid input does not mutate DB and redirects (302)', async () => {
  const admin = trackUser(await seedUser(null, { role: 'admin' }));
  const adminSess = await signSession(app, admin);

  const SCENARIOS = [
    'admin_add_device_unknown_type',
    'admin_add_device_missing_owner',
    'admin_change_owner_nonexistent_target',
    'admin_change_owner_target_eq_current',
    'owner_share_device_nonexistent_target',
    'owner_share_device_target_already_has_access',
    'owner_transfer_ownership_nonexistent_target',
    'owner_transfer_ownership_target_eq_owner'
  ];

  await fc.assert(
    fc.asyncProperty(fc.constantFrom(...SCENARIOS), async (scenario) => {
      // Per-iteration owner / target / device so cleanup-by-user_id works.
      const owner = trackUser(await seedUser(null, { role: 'user' }));
      const target = trackUser(await seedUser(null, { role: 'user' }));
      const ownerSess = await signSession(app, owner);

      let path;
      let cookieHeader;
      let body;
      let snapshotIds;

      switch (scenario) {
        case 'admin_add_device_unknown_type': {
          // No device yet; we track owner counts and admin audit/token counts.
          path = '/admin/devices';
          cookieHeader = adminSess.cookieHeader;
          body = {
            add_device: '1',
            device_name: 'X',
            device_type: 'unknown-device-type', // INVALID
            broker_url: 'broker.example.com',
            broker_port: '1883',
            owner_id: owner.user_id,
            mq_user: '',
            mq_pass: ''
          };
          snapshotIds = { ownerIds: [owner.user_id], adminId: admin.user_id };
          break;
        }
        case 'admin_add_device_missing_owner': {
          path = '/admin/devices';
          cookieHeader = adminSess.cookieHeader;
          body = {
            add_device: '1',
            device_name: 'X',
            device_type: 'esp32-inkubator',
            broker_url: 'broker.example.com',
            broker_port: '1883',
            // owner_id intentionally omitted (INVALID)
            mq_user: '',
            mq_pass: ''
          };
          snapshotIds = { ownerIds: [owner.user_id], adminId: admin.user_id };
          break;
        }
        case 'admin_change_owner_nonexistent_target': {
          // Seed device for owner. Target user is real but we'll pass a
          // user_id that does not exist (max + 1000).
          const device = await seedDevice(null, { user_id: owner.user_id });
          const [maxRow] = await pool.query('SELECT MAX(user_id) AS m FROM `user`');
          const ghostUserId = (maxRow[0].m || 0) + 1000;
          path = '/admin/devices';
          cookieHeader = adminSess.cookieHeader;
          body = {
            change_owner: '1',
            device_id: device.device_id,
            new_owner_id: ghostUserId
          };
          snapshotIds = {
            ownerIds: [owner.user_id],
            deviceIds: [device.device_id],
            adminId: admin.user_id
          };
          break;
        }
        case 'admin_change_owner_target_eq_current': {
          const device = await seedDevice(null, { user_id: owner.user_id });
          path = '/admin/devices';
          cookieHeader = adminSess.cookieHeader;
          body = {
            change_owner: '1',
            device_id: device.device_id,
            new_owner_id: owner.user_id // same as current owner (INVALID, Req 2.5)
          };
          snapshotIds = {
            ownerIds: [owner.user_id],
            deviceIds: [device.device_id],
            adminId: admin.user_id
          };
          break;
        }
        case 'owner_share_device_nonexistent_target': {
          const device = await seedDevice(null, { user_id: owner.user_id });
          path = '/actions/share_device';
          cookieHeader = ownerSess.cookieHeader;
          body = {
            device_id: device.device_id,
            target_username: 'no_such_user_' + Math.random().toString(16).slice(2, 8)
          };
          snapshotIds = {
            ownerIds: [owner.user_id],
            deviceIds: [device.device_id],
            adminId: admin.user_id
          };
          break;
        }
        case 'owner_share_device_target_already_has_access': {
          const device = await seedDevice(null, { user_id: owner.user_id });
          // Pre-seed: target already has viewer access.
          await seedAccess(null, {
            user_id: target.user_id,
            device_id: device.device_id,
            access_type: 'viewer'
          });
          path = '/actions/share_device';
          cookieHeader = ownerSess.cookieHeader;
          body = {
            device_id: device.device_id,
            target_username: target.user_name
          };
          snapshotIds = {
            ownerIds: [owner.user_id, target.user_id],
            deviceIds: [device.device_id],
            adminId: admin.user_id
          };
          break;
        }
        case 'owner_transfer_ownership_nonexistent_target': {
          const device = await seedDevice(null, { user_id: owner.user_id });
          path = '/actions/transfer_ownership';
          cookieHeader = ownerSess.cookieHeader;
          body = {
            device_id: device.device_id,
            target_username: 'no_such_user_' + Math.random().toString(16).slice(2, 8)
          };
          snapshotIds = {
            ownerIds: [owner.user_id],
            deviceIds: [device.device_id],
            adminId: admin.user_id
          };
          break;
        }
        case 'owner_transfer_ownership_target_eq_owner': {
          const device = await seedDevice(null, { user_id: owner.user_id });
          path = '/actions/transfer_ownership';
          cookieHeader = ownerSess.cookieHeader;
          body = {
            device_id: device.device_id,
            target_username: owner.user_name // same as current owner (INVALID, Req 7.4)
          };
          snapshotIds = {
            ownerIds: [owner.user_id],
            deviceIds: [device.device_id],
            adminId: admin.user_id
          };
          break;
        }
        default:
          throw new Error('unknown scenario ' + scenario);
      }

      const snapBefore = await snapshotState(snapshotIds);

      const res = await request(app, {
        method: 'POST',
        path,
        headers: { Cookie: cookieHeader },
        body
      });

      // Req 1.4 / 2.4 / 2.5 / 6.4 / 6.5 / 7.3 / 7.4: redirect to a sane page;
      // never 200 (admin pages would mean the action succeeded) or 500.
      assert.equal(
        res.status,
        302,
        `[${scenario}] expected 302 redirect, got ${res.status}`
      );

      const snapAfter = await snapshotState(snapshotIds);
      assert.deepEqual(
        snapAfter,
        snapBefore,
        `[${scenario}] DB state must be unchanged after invalid input`
      );
    }),
    { numRuns: 16 }
  );
});

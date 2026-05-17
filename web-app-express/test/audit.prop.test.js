'use strict';

// Feature: admin-user-device-management
//
// Property tests for the admin audit-log behavior:
//
//   - Property 5  (Task 7.14): every successful admin mutation writes exactly
//                              one audit row (Validates Requirements 1.5,
//                              2.3, 3.5, 11.1, 11.2)
//   - Property 27 (Task 7.15): insertAdminAuditLog never throws on DB error
//                              (Validates Requirement 11.3)

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
const { insertAdminAuditLog } = require('../src/services/audit');
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
  await pool.query('DELETE FROM admin_audit_log WHERE target_type = ? AND target_id = ?', ['user', userId]);
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

async function countAuditFor(adminId) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS c FROM admin_audit_log WHERE admin_id = ?',
    [adminId]
  );
  return rows[0].c;
}

async function latestAuditFor(adminId) {
  const [rows] = await pool.query(
    `SELECT log_id, admin_id, action, target_type, target_id, details
       FROM admin_audit_log
      WHERE admin_id = ?
      ORDER BY log_id DESC LIMIT 1`,
    [adminId]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Property 5 (Task 7.14): every successful admin mutation writes exactly one
// audit row. Validates: Requirements 1.5, 2.3, 3.5, 11.1, 11.2
// ---------------------------------------------------------------------------
test('Property 5: each successful admin mutation writes exactly one audit row', async () => {
  const ACTIONS = [
    'add_device',
    'edit_device',
    'delete_device',
    'change_owner',
    'revoke_access',
    'change_role',
    'delete_user'
  ];

  await fc.assert(
    fc.asyncProperty(fc.constantFrom(...ACTIONS), async (action) => {
      // Per-iteration admin so the audit-row delta we measure is isolated
      // from anything other tests do in parallel.
      const admin = trackUser(await seedUser(null, { role: 'admin' }));
      const adminSess = await signSession(app, admin);

      const before = await countAuditFor(admin.user_id);

      let expectedAction = action;
      let expectedTargetType;
      let expectedTargetId;

      switch (action) {
        case 'add_device': {
          const owner = trackUser(await seedUser(null, { role: 'user' }));
          const res = await request(app, {
            method: 'POST',
            path: '/admin/devices',
            headers: { Cookie: adminSess.cookieHeader },
            body: {
              add_device: '1',
              device_name: 'AuditDev',
              device_type: 'esp32-inkubator',
              broker_url: 'broker.example.com',
              broker_port: '1883',
              owner_id: owner.user_id,
              mq_user: '',
              mq_pass: ''
            }
          });
          assert.equal(res.status, 302, 'add_device must redirect on success');

          const [devRows] = await pool.query(
            'SELECT device_id FROM device WHERE user_id = ? ORDER BY device_id DESC LIMIT 1',
            [owner.user_id]
          );
          assert.equal(devRows.length, 1, 'add_device must create a device row');
          expectedTargetType = 'device';
          expectedTargetId = devRows[0].device_id;
          break;
        }
        case 'edit_device': {
          const owner = trackUser(await seedUser(null, { role: 'user' }));
          const newOwner = trackUser(await seedUser(null, { role: 'user' }));
          const dev = await seedDevice(null, { user_id: owner.user_id });
          const res = await request(app, {
            method: 'POST',
            path: '/admin/devices',
            headers: { Cookie: adminSess.cookieHeader },
            body: {
              edit_device: '1',
              edit_device_id: dev.device_id,
              edit_device_name: 'EditedDev',
              edit_device_type: 'esp32-smartlamp',
              edit_owner_id: newOwner.user_id,
              edit_broker_url: 'edit.example.com',
              edit_broker_port: '8883',
              edit_mq_user: 'eu',
              edit_mq_pass: 'ep'
            }
          });
          assert.equal(res.status, 302, 'edit_device must redirect on success');
          expectedTargetType = 'device';
          expectedTargetId = dev.device_id;
          break;
        }
        case 'delete_device': {
          const owner = trackUser(await seedUser(null, { role: 'user' }));
          const dev = await seedDevice(null, { user_id: owner.user_id });
          const res = await request(app, {
            method: 'POST',
            path: '/admin/devices',
            headers: { Cookie: adminSess.cookieHeader },
            body: { delete_device: '1', device_id: dev.device_id }
          });
          assert.equal(res.status, 302, 'delete_device must redirect on success');
          expectedTargetType = 'device';
          expectedTargetId = dev.device_id;
          break;
        }
        case 'change_owner': {
          const oldOwner = trackUser(await seedUser(null, { role: 'user' }));
          const newOwner = trackUser(await seedUser(null, { role: 'user' }));
          const dev = await seedDevice(null, { user_id: oldOwner.user_id });
          const res = await request(app, {
            method: 'POST',
            path: '/admin/devices',
            headers: { Cookie: adminSess.cookieHeader },
            body: {
              change_owner: '1',
              device_id: dev.device_id,
              new_owner_id: newOwner.user_id
            }
          });
          assert.equal(res.status, 302, 'change_owner must redirect on success');
          expectedTargetType = 'device';
          expectedTargetId = dev.device_id;
          break;
        }
        case 'revoke_access': {
          const owner = trackUser(await seedUser(null, { role: 'user' }));
          const viewer = trackUser(await seedUser(null, { role: 'user' }));
          const dev = await seedDevice(null, { user_id: owner.user_id });
          await seedAccess(null, {
            user_id: viewer.user_id,
            device_id: dev.device_id,
            access_type: 'viewer'
          });
          const res = await request(app, {
            method: 'POST',
            path: '/admin/devices/' + dev.device_id + '/access/revoke',
            headers: { Cookie: adminSess.cookieHeader },
            body: { viewer_user_id: viewer.user_id }
          });
          assert.equal(res.status, 302, 'revoke must redirect on success');
          expectedTargetType = 'device';
          expectedTargetId = dev.device_id;
          break;
        }
        case 'change_role': {
          const target = trackUser(await seedUser(null, { role: 'user' }));
          const res = await request(app, {
            method: 'POST',
            path: '/admin/users',
            headers: { Cookie: adminSess.cookieHeader },
            body: {
              change_role: '1',
              user_id: target.user_id,
              role: 'admin'
            }
          });
          assert.equal(res.status, 302, 'change_role must redirect on success');
          expectedTargetType = 'user';
          expectedTargetId = target.user_id;
          break;
        }
        case 'delete_user': {
          const target = trackUser(await seedUser(null, { role: 'user' }));
          const res = await request(app, {
            method: 'POST',
            path: '/admin/users',
            headers: { Cookie: adminSess.cookieHeader },
            body: { delete_user: '1', user_id: target.user_id }
          });
          assert.equal(res.status, 302, 'delete_user must redirect on success');
          expectedTargetType = 'user';
          expectedTargetId = target.user_id;
          break;
        }
        default:
          throw new Error('unknown action ' + action);
      }

      // Req 11.1 / 11.2: count grew by exactly 1.
      const after = await countAuditFor(admin.user_id);
      assert.equal(
        after,
        before + 1,
        `[${action}] admin_audit_log row count must grow by exactly 1 ` +
        `(was ${before}, now ${after})`
      );

      // The new row matches the expected shape.
      const row = await latestAuditFor(admin.user_id);
      assert.ok(row, 'must be able to read back the new audit row');
      assert.equal(row.admin_id, admin.user_id, 'audit row admin_id must match');
      assert.equal(row.action, expectedAction, `audit row action must be "${expectedAction}"`);
      assert.equal(
        row.target_type,
        expectedTargetType,
        `audit row target_type must be "${expectedTargetType}"`
      );
      assert.equal(
        Number(row.target_id),
        Number(expectedTargetId),
        'audit row target_id must match the affected entity'
      );

      // details: not required for delete_user; required object for everything
      // else (Req 11.1 says "details berbentuk objek JSON yang merangkum
      // perubahan").
      if (action !== 'delete_user') {
        assert.notEqual(row.details, null, `[${action}] details must not be null`);
        const parsed = typeof row.details === 'string'
          ? JSON.parse(row.details)
          : row.details;
        assert.equal(
          typeof parsed,
          'object',
          `[${action}] details must be a JSON object`
        );
        assert.ok(
          parsed && Object.keys(parsed).length > 0,
          `[${action}] details object must have at least one field-change entry`
        );
      }
    }),
    { numRuns: 14 }
  );
});

// ---------------------------------------------------------------------------
// Property 27 (Task 7.15): insertAdminAuditLog must not throw on DB error.
// Validates: Requirement 11.3
// ---------------------------------------------------------------------------
test('Property 27: insertAdminAuditLog swallows DB errors and logs to console.error', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        adminId: fc.integer({ min: 1, max: 1000000 }),
        action: fc.constantFrom('add_device', 'edit_device', 'delete_device',
          'change_owner', 'revoke_access', 'change_role', 'delete_user'),
        targetType: fc.constantFrom('device', 'user'),
        targetId: fc.integer({ min: 1, max: 1000000 }),
        details: fc.option(
          fc.dictionary(
            fc.stringMatching(/^[a-z_]{1,12}$/),
            fc.oneof(fc.string(), fc.integer(), fc.boolean())
          ),
          { nil: null }
        )
      }),
      async (input) => {
        const originalQuery = pool.query;
        const originalConsoleError = console.error;
        const errorCalls = [];
        console.error = (...args) => { errorCalls.push(args); };

        // Every pool.query call should throw, simulating a hard DB error.
        pool.query = async function stubFailingQuery() {
          throw new Error('Simulated DB failure');
        };

        try {
          await assert.doesNotReject(
            () => insertAdminAuditLog(
              input.adminId,
              input.action,
              input.targetType,
              input.targetId,
              input.details
            ),
            'insertAdminAuditLog must not throw when pool.query throws (Req 11.3)'
          );

          assert.ok(
            errorCalls.length >= 1,
            'console.error must be called at least once on DB failure (Req 11.3)'
          );
        } finally {
          pool.query = originalQuery;
          console.error = originalConsoleError;
        }
      }
    ),
    { numRuns: 10 }
  );
});

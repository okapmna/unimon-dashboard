'use strict';

// Feature: admin-user-device-management
//
// Property tests for the admin auth / dashboard flow:
//
//   - Property 9  (Task 3.5): admin login lands on /dashboard with Admin Panel link
//                              Validates Requirements 4.1, 4.2, 4.3, 4.5
//   - Property 6  (Task 3.6): /admin/* denied for non-admin
//                              Validates Requirements 1.6, 3.4, 4.6
//   - Property 10 (Task 3.7): /admin/* renders for admin
//                              Validates Requirement 4.4
//
// The tests spin up the real Express app against the dev MariaDB container
// referenced by the standard DB_* env vars. Sessions go through
// express-mysql-session (table `web_sessions`), so seeded users that need to
// log in MUST live outside any per-test transaction. We track every seeded
// user_id and clean them up (along with their session rows / dependent rows)
// in `after()`.

// MUST be set BEFORE requiring `../src/app` / `../src/config/db`.
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
const { request, signSession, seedUser } = require('./_helpers');

// ---------------------------------------------------------------------------
// Lifecycle: ensure schema before any test, clean up seeded rows after all
// tests, and end the pool so the test process can exit.
// ---------------------------------------------------------------------------

const seededUserIds = [];

function trackUser(user) {
  if (user && user.user_id != null) seededUserIds.push(user.user_id);
  return user;
}

async function cleanupUser(userId) {
  // Order matters: child rows / FKs first, then session rows by username are
  // not feasible (express-mysql-session stores opaque blobs), but they expire
  // naturally and don't reference user.user_id. Just delete every row that
  // points back to this user.
  await pool.query('DELETE FROM admin_audit_log WHERE admin_id = ?', [userId]);
  await pool.query('DELETE FROM device_access_tokens WHERE created_by = ?', [userId]);
  await pool.query('DELETE FROM user_device_access WHERE user_id = ?', [userId]);
  await pool.query('DELETE FROM device WHERE user_id = ?', [userId]);
  await pool.query('DELETE FROM user_tokens WHERE user_id = ?', [userId]);
  await pool.query('DELETE FROM `user` WHERE user_id = ?', [userId]);
}

before(async () => {
  await ensureAdminDeviceTables();
});

after(async () => {
  // Best-effort cleanup of every seeded user.
  for (const id of seededUserIds.splice(0)) {
    try { await cleanupUser(id); } catch (err) { /* ignore */ }
  }
  await pool.end();
  // express-mysql-session creates its own pool with a periodic cleanup timer
  // that keeps the event loop alive. There's no clean way to close it from
  // here without exporting the session store from app.js. By the time this
  // hook runs every test has finished and node:test has already set
  // `process.exitCode` to reflect the result, so we trigger a clean exit
  // (preserving that exit code) instead of letting the runner hang.
  setImmediate(() => process.exit());
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function snapshotCounts() {
  const [u] = await pool.query('SELECT COUNT(*) AS c FROM `user`');
  const [d] = await pool.query('SELECT COUNT(*) AS c FROM `device`');
  const [a] = await pool.query('SELECT COUNT(*) AS c FROM `user_device_access`');
  const [l] = await pool.query('SELECT COUNT(*) AS c FROM `admin_audit_log`');
  return {
    user: u[0].c,
    device: d[0].c,
    user_device_access: a[0].c,
    admin_audit_log: l[0].c
  };
}

function randomHex(n) {
  const chars = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ---------------------------------------------------------------------------
// Property 9 (Task 3.5): admin login lands on /dashboard with Admin Panel link
// Validates: Requirements 4.1, 4.2, 4.3, 4.5
// ---------------------------------------------------------------------------
test('Property 9: admin login lands on /dashboard with Admin Panel link', async () => {
  await fc.assert(
    fc.asyncProperty(fc.constant(0), async () => {
      const admin = trackUser(await seedUser(null, { role: 'admin' }));

      // 4.1: POST / with admin credentials → 302 to /dashboard
      const loginRes = await request(app, {
        method: 'POST',
        path: '/',
        body: { username: admin.user_name, password: admin.password_plain }
      });
      assert.equal(loginRes.status, 302, 'admin login must redirect (302)');
      assert.equal(
        loginRes.headers.location,
        '/dashboard',
        'admin login must redirect to /dashboard (Req 4.1)'
      );

      const sid = loginRes.cookies['unimq.sid'];
      assert.ok(sid, 'login must produce a unimq.sid cookie');
      const cookieHeader = `unimq.sid=${sid}`;

      // 4.2: an already-authed admin GETing / is redirected to /dashboard
      const rootRes = await request(app, {
        method: 'GET',
        path: '/',
        headers: { Cookie: cookieHeader }
      });
      assert.equal(rootRes.status, 302, 'authed admin GET / must redirect');
      assert.equal(
        rootRes.headers.location,
        '/dashboard',
        'authed admin GET / must redirect to /dashboard (Req 4.2)'
      );

      // 4.3 + 4.5: GET /dashboard renders dashboard with an Admin Panel link
      const dashRes = await request(app, {
        method: 'GET',
        path: '/dashboard',
        headers: { Cookie: cookieHeader }
      });
      assert.equal(dashRes.status, 200, 'admin GET /dashboard must render (Req 4.3)');
      assert.ok(
        dashRes.body.includes('/admin/users'),
        'dashboard for admin must link to /admin/users (Req 4.5)'
      );
      assert.ok(
        dashRes.body.includes('Admin Panel'),
        'dashboard for admin must include the "Admin Panel" label (Req 4.5)'
      );
    }),
    { numRuns: 1 }
  );
});

// ---------------------------------------------------------------------------
// Property 6 (Task 3.6): /admin/* denial for non-admin
// Validates: Requirements 1.6, 3.4, 4.6
// ---------------------------------------------------------------------------
test('Property 6: /admin/* is denied for non-admin sessions', async () => {
  // One shared non-admin session for every iteration that picks sessionType='user'.
  const userAccount = trackUser(await seedUser(null, { role: 'user' }));
  const userSession = await signSession(app, userAccount);
  const userCookieHeader = userSession.cookieHeader;

  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('/admin/users', '/admin/devices', '__random__'),
      fc.constantFrom('GET', 'POST'),
      fc.constantFrom('none', 'user'),
      async (pathChoice, method, sessionType) => {
        const path = pathChoice === '__random__'
          ? '/admin/' + randomHex(8)
          : pathChoice;

        const before = await snapshotCounts();

        const headers = {};
        if (sessionType === 'user') headers.Cookie = userCookieHeader;

        const res = await request(app, { method, path, headers });

        // Req 1.6 / 3.4 / 4.6: must redirect (302) and never render an admin page.
        assert.equal(
          res.status,
          302,
          `expected 302 for sessionType=${sessionType} ${method} ${path}, ` +
          `got ${res.status}`
        );

        if (sessionType === 'none') {
          assert.equal(
            res.headers.location,
            '/',
            `unauthenticated ${method} ${path} must redirect to / ` +
            '(requireAdmin: no session)'
          );
        } else {
          assert.equal(
            res.headers.location,
            '/dashboard',
            `non-admin user ${method} ${path} must redirect to /dashboard ` +
            '(Req 4.6)'
          );
        }

        // Database invariant: a denied admin request must not change any
        // admin-touched table.
        const after = await snapshotCounts();
        assert.deepEqual(
          after,
          before,
          `denied ${method} ${path} (sessionType=${sessionType}) must not ` +
          'change user / device / user_device_access / admin_audit_log counts'
        );
      }
    ),
    { numRuns: 25 }
  );
});

// ---------------------------------------------------------------------------
// Property 10 (Task 3.7): /admin/* renders for admin
// Validates: Requirement 4.4
// ---------------------------------------------------------------------------
test('Property 10: /admin/* renders for admin sessions', async () => {
  const admin = trackUser(await seedUser(null, { role: 'admin' }));
  const adminSession = await signSession(app, admin);
  const cookieHeader = adminSession.cookieHeader;

  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(
        { path: '/admin/users', expectText: 'User Management' },
        { path: '/admin/devices', expectText: 'Device Management' }
      ),
      async ({ path, expectText }) => {
        const res = await request(app, {
          method: 'GET',
          path,
          headers: { Cookie: cookieHeader }
        });

        assert.equal(
          res.status,
          200,
          `admin GET ${path} must return 200 (Req 4.4), got ${res.status} ` +
          `(location=${res.headers.location || '<none>'})`
        );
        assert.ok(
          !/access\s*denied/i.test(res.body),
          `admin GET ${path} must not render an "Access Denied" message`
        );
        assert.ok(
          res.body.includes(expectText),
          `admin GET ${path} must include "${expectText}" in rendered HTML`
        );
        assert.notEqual(
          res.headers.location,
          '/dashboard',
          `admin GET ${path} must not redirect to /dashboard`
        );
      }
    ),
    { numRuns: 1 }
  );
});

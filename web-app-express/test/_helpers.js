'use strict';

// Test helpers for web-app-express.
//
// Exports:
//   - withTx(fn)              : Run `fn(conn)` inside a BEGIN ... ROLLBACK so any
//                               writes made through `conn` are reverted at the end.
//   - request(app, opts)      : Make a single HTTP request against `app` using
//                               Node's built-in `http` on an ephemeral port.
//                               Returns { status, headers, body, cookies }.
//   - signSession(app, user)  : Helper that logs `user` in via `POST /` and
//                               returns the resulting session cookie header
//                               (`unimq.sid=...; ...`). This is the recommended
//                               way to obtain an authenticated session because
//                               sessions are stored in MariaDB by
//                               express-mysql-session.
//   - seedUser, seedDevice,
//     seedAccess              : Insert minimal rows into `user`, `device`,
//                               `user_device_access`. Each accepts an optional
//                               `conn` (so they can be used inside a transaction)
//                               and an `overrides` object.

const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { pool } = require('../src/config/db');
const { generateUniqueDeviceSerialNumber } = require('../src/services/devices');

// ---------------------------------------------------------------------------
// Transaction wrapper
// ---------------------------------------------------------------------------

/**
 * Get a connection from the shared pool, BEGIN, run `fn(conn)`, then always
 * ROLLBACK and release the connection. Any error from `fn` is rethrown after
 * the rollback so tests can assert on it.
 *
 * The returned value is whatever `fn` returns.
 */
async function withTx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      const result = await fn(conn);
      return result;
    } finally {
      try { await conn.rollback(); } catch (err) { /* ignore */ }
    }
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// HTTP request helper
// ---------------------------------------------------------------------------

function parseSetCookies(setCookieHeader) {
  // Convert raw Set-Cookie header(s) into a simple { name: value } map.
  // Only the first attribute pair (name=value) is captured; cookie attributes
  // like Path, HttpOnly, etc. are dropped.
  const cookies = {};
  if (!setCookieHeader) return cookies;
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const raw of list) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const firstPair = raw.split(';', 1)[0];
    const eq = firstPair.indexOf('=');
    if (eq <= 0) continue;
    const name = firstPair.slice(0, eq).trim();
    const value = firstPair.slice(eq + 1).trim();
    cookies[name] = value;
  }
  return cookies;
}

function serializeCookieHeader(cookies) {
  if (!cookies) return '';
  if (typeof cookies === 'string') return cookies;
  return Object.keys(cookies)
    .map((k) => `${k}=${cookies[k]}`)
    .join('; ');
}

/**
 * Start `app` on an ephemeral port (port 0), make a single HTTP request,
 * collect the response, then close the server.
 *
 * opts:
 *   method  : HTTP method (default 'GET')
 *   path    : URL path (default '/')
 *   headers : extra request headers (object)
 *   body    : request body. If an object (and no Content-Type set), it is
 *             URL-encoded as application/x-www-form-urlencoded; if a string
 *             or Buffer it is sent as-is.
 *   cookies : either a Cookie header string or an object { name: value, ... }.
 *
 * Returns: { status, headers, body, cookies }
 *   - body    : decoded utf8 string
 *   - cookies : parsed Set-Cookie headers as a { name: value } map
 */
function request(app, opts = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const method = (opts.method || 'GET').toUpperCase();
      const path = opts.path || '/';
      const headers = Object.assign({}, opts.headers || {});

      let body = opts.body;
      if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
        body = new URLSearchParams(body).toString();
      }
      if (typeof body === 'string') {
        if (!headers['Content-Length'] && !headers['content-length']) {
          headers['Content-Length'] = Buffer.byteLength(body);
        }
      }

      const cookieHeader = serializeCookieHeader(opts.cookies);
      if (cookieHeader && !headers['Cookie'] && !headers['cookie']) {
        headers['Cookie'] = cookieHeader;
      }

      const req = http.request(
        { hostname: '127.0.0.1', port, path, method, headers },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const result = {
              status: res.statusCode,
              headers: res.headers,
              body: buf.toString('utf8'),
              cookies: parseSetCookies(res.headers['set-cookie'])
            };
            server.close(() => resolve(result));
          });
        }
      );

      req.on('error', (err) => {
        server.close(() => reject(err));
      });

      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        req.write(body);
      }
      req.end();
    });
    server.on('error', reject);
  });
}

/**
 * Recommended helper for authenticated tests: log `user` in via `POST /` so
 * express-session creates the row in `web_sessions`, and return the session
 * cookie value (the value of the `unimq.sid` cookie) plus the full Cookie
 * header to send on subsequent requests.
 *
 * `user` must be the object returned from `seedUser` (i.e. it must contain
 * `user_name` and `password_plain`).
 *
 * NOTE: because session rows live in `web_sessions` (a real DB table), the
 *       seeded user MUST be visible outside any per-test transaction. Use
 *       `seedUser(null, ...)` (or `seedUser()` with no conn) so the row is
 *       inserted via the shared pool and persists for the login request.
 */
async function signSession(app, user) {
  const res = await request(app, {
    method: 'POST',
    path: '/',
    body: { username: user.user_name, password: user.password_plain }
  });

  const sid = res.cookies['unimq.sid'];
  if (!sid) {
    const snippet = (res.body || '').slice(0, 200);
    throw new Error(
      `signSession: login did not produce a unimq.sid cookie ` +
      `(status=${res.status}, body="${snippet}")`
    );
  }

  return {
    sid,
    cookieHeader: `unimq.sid=${sid}`,
    cookies: { 'unimq.sid': sid }
  };
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function runner(conn) {
  // If `conn` is a real connection it has `.query`; otherwise fall back to the
  // shared pool. This lets seed helpers run inside or outside a transaction.
  return conn && typeof conn.query === 'function' ? conn : pool;
}

/**
 * Insert a row into `user` and return the seed metadata.
 *
 * overrides may include: user_name, password_plain, role.
 * Defaults: random user_name (8 hex chars), random password, role = 'user'.
 *
 * Returns: { user_id, user_name, password_plain, role }
 */
async function seedUser(conn, overrides = {}) {
  const db = runner(conn);
  const user_name = overrides.user_name || crypto.randomBytes(4).toString('hex');
  const password_plain = overrides.password_plain || crypto.randomBytes(8).toString('hex');
  const role = overrides.role || 'user';
  const hashed = await bcrypt.hash(password_plain, 4);

  const [result] = await db.query(
    'INSERT INTO `user` (`user_name`, `password`, `role`) VALUES (?, ?, ?)',
    [user_name, hashed, role]
  );
  return {
    user_id: result.insertId,
    user_name,
    password_plain,
    role
  };
}

/**
 * Insert a row into `device` owned by `overrides.user_id` (required) and
 * return the inserted `device_id`.
 *
 * overrides may include: device_name, device_type, broker_url, broker_port,
 *                        mq_user, mq_pass, serial_number.
 *
 * Defaults:
 *   device_name   : 'test-device-' + random hex
 *   device_type   : 'esp32-inkubator'
 *   broker_url    : 'mqtt://localhost'
 *   broker_port   : '1883'
 *   mq_user / mq_pass : ''
 *   serial_number : generated via generateUniqueDeviceSerialNumber()
 *
 * Returns: { device_id, user_id, device_name, device_type, broker_url,
 *            broker_port, mq_user, mq_pass, serial_number }
 */
async function seedDevice(conn, overrides = {}) {
  if (!overrides.user_id) {
    throw new Error('seedDevice: overrides.user_id is required');
  }
  const db = runner(conn);
  const row = {
    user_id: overrides.user_id,
    device_name: overrides.device_name || ('test-device-' + crypto.randomBytes(3).toString('hex')),
    device_type: overrides.device_type || 'esp32-inkubator',
    broker_url: overrides.broker_url || 'mqtt://localhost',
    broker_port: overrides.broker_port || '1883',
    mq_user: overrides.mq_user != null ? overrides.mq_user : '',
    mq_pass: overrides.mq_pass != null ? overrides.mq_pass : '',
    serial_number: overrides.serial_number || (await generateUniqueDeviceSerialNumber())
  };

  const [result] = await db.query(
    `INSERT INTO \`device\`
       (\`device_name\`, \`device_type\`, \`broker_url\`, \`broker_port\`,
        \`mq_user\`, \`mq_pass\`, \`user_id\`, \`serial_number\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.device_name,
      row.device_type,
      row.broker_url,
      row.broker_port,
      row.mq_user,
      row.mq_pass,
      row.user_id,
      row.serial_number
    ]
  );
  return Object.assign({ device_id: result.insertId }, row);
}

/**
 * Insert a row into `user_device_access`.
 *
 * overrides must include: user_id, device_id.
 * overrides.access_type defaults to 'viewer'.
 *
 * Returns: { id, user_id, device_id, access_type }
 */
async function seedAccess(conn, overrides = {}) {
  if (!overrides.user_id) throw new Error('seedAccess: overrides.user_id is required');
  if (!overrides.device_id) throw new Error('seedAccess: overrides.device_id is required');
  const db = runner(conn);
  const access_type = overrides.access_type || 'viewer';

  const [result] = await db.query(
    'INSERT INTO `user_device_access` (`user_id`, `device_id`, `access_type`) VALUES (?, ?, ?)',
    [overrides.user_id, overrides.device_id, access_type]
  );
  return {
    id: result.insertId,
    user_id: overrides.user_id,
    device_id: overrides.device_id,
    access_type
  };
}

module.exports = {
  withTx,
  request,
  signSession,
  seedUser,
  seedDevice,
  seedAccess,
  // exported for advanced cases
  parseSetCookies,
  serializeCookieHeader
};

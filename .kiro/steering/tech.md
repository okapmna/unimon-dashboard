# Tech Stack

## Runtime & Language
- Node.js (CommonJS, `require`/`module.exports`) for both `web-app-express` and `mqtt-worker`.
- No TypeScript, no build step, no bundler.

## Web App (`web-app-express`)
- Framework: Express 4.
- View engine: EJS (server-rendered templates in `src/views`).
- Sessions: `express-session` backed by MariaDB via `express-mysql-session` (table `web_sessions`).
- Auth: `bcryptjs` for password hashing; cookie-based "remember me" using a `selector:validator` pair stored in `user_tokens`.
- Cookies: `cookie-parser`.
- Config: `dotenv` (`.env` in `web-app-express/`, see `.env.example`).
- Database driver: `mysql2/promise` with a connection pool (`src/config/db.js`).
- Static assets: served from `web-app-express/public` (Tailwind via CDN config in `public/assets/js/tailwind.config.js`).

## Background Worker (`mqtt-worker`)
- Library: `mqtt` (WebSocket transport `ws`/`wss` based on broker port; 8883/8884 → wss).
- DB: same `mysql2/promise` pool, separate config (`mqtt-worker/src/config/db.js`).
- Pattern: a singleton `DeviceManager` syncs the device list from MariaDB every 20s, opens an MQTT client per device, and dispatches to handlers (`handlers/incubator.js`, `handlers/smartlamp.js`).

## Database
- MariaDB (latest). Schema in `database/unimq.sql`; migrations applied manually after the base schema (`database/migrations/*.sql`).
- Charset/collation: `utf8mb4` / `utf8mb4_general_ci`.
- Some tables (`device_access_tokens`, `user_device_access`, `admin_audit_log`, columns/indexes on `device`) are auto-ensured at runtime via `ensureAdminDeviceTables()` in `services/devices.js`.

## MQTT Topic Conventions
- Incubator: subscribe `incubator/{deviceId}/data`, publish `incubator/{deviceId}/con`.
- Smartlamp: subscribe `smartlamp/{deviceId}/status`, publish `smartlamp/{deviceId}/control`.
- Device log types in `device_logs.log_type`: `aggregation`, `change_event`.

## Coding Conventions
- Use the shared `pool` from `config/db.js`; pass parameters via `?` placeholders, never string-concat user input.
- Always `await pool.query(...)` and destructure `[rows]`.
- Wrap route handlers with `try/catch (err) { next(err); }`; the global error handler in `app.js` returns 500.
- Auth gating uses `requireLogin` / `requireAdmin` / `redirectIfAuthed` from `middleware/auth.js`.
- Flash-style messages: set `req.session.toast = { type, message }`, then redirect; `app.js` exposes it as `res.locals.toast` and clears it.
- Admin mutations should call `insertAdminAuditLog(adminId, action, targetType, targetId, details)`.
- Use 2-space indentation, single quotes, semicolons (matches existing code).

## Environment Variables (see `.env.example`)
- `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`, `DB_PORT`
- `PORT` (default 8080), `HOST` (default 0.0.0.0), `NODE_ENV`
- `SESSION_SECRET` (must be set in production)

## Common Commands

Run everything via Docker (recommended):

```bash
# Build and start web, db, phpMyAdmin, and mqtt-worker
docker compose up -d --build

# Tail the background worker logs
docker logs -f mqtt_background_worker

# Stop everything
docker compose down
```

Local development without Docker:

```bash
# Web app
cd web-app-express
npm install
npm run dev      # node --watch server.js
npm start        # node server.js

# MQTT worker
cd mqtt-worker
npm install
npm start
```

Useful URLs (default ports):
- Web app: `http://localhost:8080`
- phpMyAdmin: `http://localhost:8082` (root / rootpassword)
- MariaDB: `localhost:3306`

There is no test runner, linter, or build script configured. Do not invent commands.

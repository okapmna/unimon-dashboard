# Project Structure

The repo is a Docker Compose monorepo with two Node.js services and a SQL database.

```
.
├── docker-compose.yml          # web, db (MariaDB), phpmyadmin, mqtt-worker
├── database/
│   ├── unimq.sql               # base schema (import first)
│   └── migrations/
│       └── 001_admin_sharing_spike.sql   # admin/sharing/audit tables
├── web-app-express/            # Express web dashboard (port 8080)
└── mqtt-worker/                # Background MQTT → MariaDB logger
```

## `web-app-express/`

```
web-app-express/
├── server.js                   # Loads .env, starts app on PORT/HOST
├── package.json                # scripts: start, dev (node --watch)
├── Dockerfile
├── .env / .env.example         # DB + session config
├── public/                     # Static assets served at /
│   ├── assets/{css,images,js}
│   ├── manifest.json
│   └── service-worker.js
├── scripts/check-views.js      # Ad-hoc maintenance script
└── src/
    ├── app.js                  # Express setup: views, sessions, routes
    ├── config/db.js            # mysql2 pool + dbConfig
    ├── middleware/auth.js      # requireLogin / requireAdmin / remember-me
    ├── routes/                 # One file per top-level path
    │   ├── auth.js             # /, /register, /logout
    │   ├── dashboard.js        # /dashboard
    │   ├── profile.js          # /profile
    │   ├── actions.js          # /actions/* (e.g. redeem serial)
    │   ├── iot.js              # /iot/incubator/:id, /iot/smartlamp/:id
    │   └── admin.js            # /admin/* (admin-only)
    ├── services/               # DB-facing helpers shared by routes
    │   ├── devices.js          # schema-ensure + device access helpers
    │   └── audit.js            # insertAdminAuditLog
    └── views/                  # EJS templates
        ├── login.ejs, register.ejs, dashboard.ejs, profile.ejs
        ├── partials/{header,footer}.ejs
        ├── iot/{incubator,smartlamp}.ejs
        └── admin/{users,devices}.ejs
```

### Where to put new code
- New URL/page → add a route file in `src/routes/`, mount it in `src/app.js`.
- Reusable DB logic → `src/services/`, not inside route handlers.
- New page UI → EJS template in `src/views/` (use `partials/header.ejs` and `partials/footer.ejs`).
- Shared auth checks → extend `src/middleware/auth.js`.
- New schema requirements that must be auto-applied → extend `ensureAdminDeviceTables` in `services/devices.js` and/or add a SQL file under `database/migrations/`.

## `mqtt-worker/`

```
mqtt-worker/
├── index.js                    # boot: initial sync + 20s interval, signal handlers
├── package.json
├── Dockerfile
└── src/
    ├── config/db.js            # mysql2 pool (separate from web app)
    ├── services/
    │   └── DeviceManager.js    # singleton; syncs devices, manages MQTT clients
    └── handlers/
        ├── incubator.js        # processes incubator/{id}/data
        └── smartlamp.js        # processes smartlamp/{id}/status
```

### Where to put new code
- New device type → add a handler in `mqtt-worker/src/handlers/` and dispatch to it from `DeviceManager.connectDevice` / `client.on('message')`.
- New aggregation or log type → write to `device_logs` with an appropriate `log_type` (current values: `aggregation`, `change_event`).

## Conventions Across the Repo

- Two separate `package.json` and `node_modules` per service. Don't share dependencies across services.
- Both services connect to the same MariaDB but have their own pool; never import across `web-app-express/` and `mqtt-worker/`.
- Device IDs are integers; the user-facing identifier is `device.serial_number` (8-char hex, uppercase).
- `device.user_id` = owner; additional access lives in `user_device_access` with `access_type` of `owner` or `viewer`.
- Treat `viewer` access as read-only in routes/views (`isViewer = device.access_type === 'viewer'`).

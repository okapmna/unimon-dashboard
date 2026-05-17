# Implementation Plan: admin-user-device-management

## Overview

Convert the feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.

Implementation order:

1. Database schema additions (migration + auto-ensure + connection-status helper).
2. Test scaffolding (`node --test` + `fast-check`) for both `web-app-express` and `mqtt-worker`.
3. Web app auth flow change (admin lands on `/dashboard`).
4. Dashboard owner kebab menu UI.
5. Owner-driven sharing and transfer routes.
6. Admin device routes (firmware/status columns, change_owner, access subpage and revoke).
7. Admin views update.
8. MQTT worker connection tracking + heartbeat.
9. MQTT worker firmware extraction.

Tasks marked with `*` are optional and can be skipped for a faster MVP. They mostly cover property-based tests and a few unit tests that follow the property-to-file mapping defined in `design.md` § Testing Strategy.

## Tasks

- [x] 1. Database schema additions and shared connection-status helper
  - [x] 1.1 Create migration file `database/migrations/002_device_status_firmware.sql`
    - Add `device.firmware_version VARCHAR(50) DEFAULT NULL`, `device.is_connected TINYINT(1) NOT NULL DEFAULT 0`, `device.last_seen_at DATETIME DEFAULT NULL` using `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
    - Add `CREATE INDEX IF NOT EXISTS device_is_connected ON device (is_connected)`
    - Keep statements idempotent so the file can be re-run safely
    - _Requirements: 10.1, 10.2, 10.3, 10.5, 10.6_

  - [x] 1.2 Extend `ensureAdminDeviceTables()` in `web-app-express/src/services/devices.js`
    - Use existing `columnExists` / `indexExists` guards before each `ALTER TABLE`
    - Wrap each `ALTER TABLE` in `try/catch` that routes failures to `console.error` so startup never crashes
    - Add the same three columns and the `device_is_connected` index
    - Export a pure helper `computeConnectionStatus(isConnected, lastSeenAt, now)` returning `'Connected'` only when `isConnected = 1` AND `lastSeenAt` is non-null AND `(now - lastSeenAt) <= 90s`, otherwise `'Disconnected'`
    - _Requirements: 10.4, 10.7, 5.2, 5.3_

  - [x] 1.3 Property test for schema columns and index
    - **Property 24: Schema device punya kolom dan index yang dispesifikasi**
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.6**
    - File: `web-app-express/test/schema.prop.test.js`
    - Run `ensureAdminDeviceTables()` against a clean DB, then `SHOW COLUMNS FROM device` and `SHOW INDEX FROM device`

  - [x] 1.4 Property test for ensure idempotence
    - **Property 25: ensure/migration idempoten**
    - **Validates: Requirements 10.4, 10.5**
    - File: `web-app-express/test/schema.prop.test.js`
    - Run `ensureAdminDeviceTables()` twice; snapshot `SHOW COLUMNS` / `SHOW INDEX` before-second-run and after-second-run must be equal

  - [x] 1.5 Property test for ensure no-crash on ALTER failure
    - **Property 26: ensure tidak men-crash startup pada error ALTER**
    - **Validates: Requirements 10.7**
    - File: `web-app-express/test/schema.prop.test.js`
    - Stub `pool.query` to reject for one of the ALTER statements; assert function resolves and `console.error` was called

  - [x] 1.6 Property test for `computeConnectionStatus`
    - **Property 11: Status koneksi efektif = is_connected=1 AND last_seen_at dalam 90 detik**
    - **Validates: Requirements 5.2, 5.3**
    - File: `web-app-express/test/connection-status.test.js`
    - Pure function test, no DB; generators cover null `last_seen_at`, both values of `is_connected`, and ages around the 90-second boundary

- [x] 2. Test scaffolding for both services
  - [x] 2.1 Add test runner config and helpers for `web-app-express`
    - Add `"test": "node --test"` to `web-app-express/package.json` scripts
    - Add `fast-check` as a devDependency in `web-app-express/package.json` (do not invent new build/lint commands)
    - Create `web-app-express/test/_helpers.js` exposing: a per-test `BEGIN`/`ROLLBACK` connection wrapper around the shared pool, a small Express `request(app, ...)` helper using Node's `http`, and seed helpers for `user`/`device`/`user_device_access`
    - _Requirements: supports all property tests in this plan_

  - [x] 2.2 Add test runner config and helpers for `mqtt-worker`
    - Add `"test": "node --test"` to `mqtt-worker/package.json` scripts
    - Add `fast-check` as a devDependency in `mqtt-worker/package.json`
    - Create `mqtt-worker/test/_helpers.js` exposing: a stub for `mqtt.connect` that returns a fake EventEmitter client (with `subscribe`, `publish`, `end`, `on`), a fake-timer wrapper around `setInterval` for heartbeat tests, and a stubbable `pool.query` for DB-error simulation
    - _Requirements: supports properties 19, 20, 21, 22, 23_

- [x] 3. Auth flow: admin lands on `/dashboard`
  - [x] 3.1 Update `redirectIfAuthed` in `web-app-express/src/middleware/auth.js`
    - Always `res.redirect('/dashboard')` for any authed session, regardless of role
    - Keep `requireLogin` and `requireAdmin` behavior unchanged (admin-only routes still set toast and redirect to `/dashboard`)
    - _Requirements: 4.2_

  - [x] 3.2 Update `POST /` in `web-app-express/src/routes/auth.js`
    - On successful authentication and remember-me flow, single `res.redirect('/dashboard')`
    - Remove any branch that redirects admins to `/admin/users`
    - _Requirements: 4.1_

  - [x] 3.3 Update `GET /dashboard` in `web-app-express/src/routes/dashboard.js`
    - Remove the early `if (req.session.user.role === 'admin') return res.redirect('/admin/users')` branch
    - Run the same device list query for any role using `req.session.user.user_id`
    - For each row, compute `is_connected_effective = is_connected = 1 AND last_seen_at >= NOW() - INTERVAL 90 SECOND` (in SQL or via the helper from 1.2) and pass it to the template
    - _Requirements: 4.3, 5.2, 5.3_

  - [x] 3.4 Show the Admin Panel link to admins on the dashboard
    - In `web-app-express/src/views/dashboard.ejs` (or `partials/header.ejs`), conditionally render an `<a href="/admin/users">Admin Panel</a>` when `user.role === 'admin'`
    - _Requirements: 4.5_

  - [x] 3.5 Property test: admin login lands on `/dashboard` with Admin Panel link
    - **Property 9: Login admin mendarat di dashboard, dengan link Admin Panel**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.5**
    - File: `web-app-express/test/auth.prop.test.js`

  - [x] 3.6 Property test: `/admin/*` denial for non-admin
    - **Property 6: Akses ke /admin/* ditolak untuk user non-admin**
    - **Validates: Requirements 1.6, 3.4, 4.6**
    - File: `web-app-express/test/auth.prop.test.js`
    - Generator emits arbitrary subpaths under `/admin/*` and arbitrary HTTP methods from `{GET, POST}` for sessions with `role = 'user'` or no session

  - [x] 3.7 Property test: `/admin/*` renders for admin
    - **Property 10: Halaman /admin/* valid bekerja untuk admin**
    - **Validates: Requirements 4.4**
    - File: `web-app-express/test/auth.prop.test.js`

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Dashboard owner kebab menu UI
  - [x] 5.1 Render the kebab menu and modals in `web-app-express/src/views/dashboard.ejs`
    - For each device with `access_type === 'owner'`, render a kebab (titik-tiga) toggle on the card with menu entries: Share, Transfer Ownership, and a sub-list of active viewers (each with a "Cabut Akses" form posting to `/actions/revoke_share`)
    - Add `#shareModal` (input `target_username`, hidden `device_id`, hardcoded `access_type=viewer`) and `#transferModal` (input `target_username`, checkbox `keep_as_viewer`, hidden `device_id`)
    - Reuse the existing `openNewDeviceModal()` pattern for open/close JS so no new front-end dependencies are added
    - _Requirements: 6.1, 6.2, 6.7_

  - [x] 5.2 Render the connection-status badge on each device card
    - Show `Connected` (green) when `is_connected_effective` is true and `Disconnected` (gray) otherwise, using the field passed in by 3.3
    - _Requirements: 5.2, 5.3_

  - [x] 5.3 Property test: owner kebab menu present on owner cards
    - **Property 14: Kebab menu owner dirender pada setiap kartu owner di dashboard**
    - **Validates: Requirements 6.1, 6.2, 6.7**
    - File: `web-app-express/test/dashboard.prop.test.js`

- [x] 6. Owner-driven sharing and transfer routes
  - [x] 6.1 Add `POST /actions/share_device` in `web-app-express/src/routes/actions.js`
    - Use `requireLogin`; validate `device.user_id === req.session.user.user_id`; look up `target_username` in `user`; reject if missing, equal to owner, or already in `user_device_access` for that device
    - Insert `(target_user_id, device_id, 'viewer')` into `user_device_access` via parameterized `?` placeholders
    - On auth failure: `res.status(403)` then redirect `/dashboard` with `req.session.toast = { type: 'error', ... }`
    - Do NOT call `insertAdminAuditLog`
    - _Requirements: 6.3, 6.4, 6.5, 6.6, 11.4_

  - [x] 6.2 Add `POST /actions/revoke_share` in `web-app-express/src/routes/actions.js`
    - Validate ownership; `DELETE FROM user_device_access WHERE user_id = ? AND device_id = ? AND access_type = 'viewer'`
    - Toast + redirect; no audit log
    - _Requirements: 6.6, 6.8, 11.4_

  - [x] 6.3 Add `POST /actions/transfer_ownership` in `web-app-express/src/routes/actions.js`
    - Validate ownership, target username existence, target ≠ current owner
    - Single transaction via `pool.getConnection()` + `beginTransaction`/`commit`/`rollback` + release in `finally`:
      1. `UPDATE device SET user_id = ? WHERE device_id = ?`
      2. `DELETE FROM user_device_access WHERE user_id = ? AND device_id = ?` (target)
      3. `DELETE FROM user_device_access WHERE user_id = ? AND device_id = ?` (old owner)
      4. If `keep_as_viewer === 'on'`: `INSERT INTO user_device_access (user_id, device_id, access_type) VALUES (?, ?, 'viewer')` for old owner
    - Success: `req.session.toast = { type: 'success', ... }` and redirect `/dashboard`
    - Do NOT call `insertAdminAuditLog`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 11.4_

  - [x] 6.4 Property test: share + revoke roundtrip
    - **Property 15: Share device menambah baris viewer; revoke share menghapusnya**
    - **Validates: Requirements 6.3, 6.8**
    - File: `web-app-express/test/sharing.prop.test.js`

  - [x] 6.5 Property test: non-owner sharing/transfer rejected with 403
    - **Property 16: Aksi sharing/transfer dari non-owner ditolak 403 dan tidak mengubah DB**
    - **Validates: Requirements 6.6, 7.2**
    - File: `web-app-express/test/sharing.prop.test.js`

  - [x] 6.6 Property test: transfer ownership state
    - **Property 17: Transfer ownership memindah owner dan opsional menyisakan viewer**
    - **Validates: Requirements 7.1, 7.5, 7.7**
    - File: `web-app-express/test/transfer.prop.test.js`

  - [x] 6.7 Property test: user actions never write `admin_audit_log`
    - **Property 18: Aksi user (sharing/transfer) tidak menulis admin_audit_log**
    - **Validates: Requirements 7.6, 11.4**
    - File: `web-app-express/test/transfer.prop.test.js`

- [x] 7. Admin device management routes
  - [x] 7.1 Update `GET /admin/devices` in `web-app-express/src/routes/admin.js`
    - Extend SELECT to include `firmware_version`, `is_connected`, `last_seen_at`
    - Compute `connected_effective` per row (`is_connected = 1 AND TIMESTAMPDIFF(SECOND, last_seen_at, NOW()) <= 90`) and pass it to the template
    - Always read fresh from DB; no caching
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 7.2 Add `change_owner` branch to `POST /admin/devices` in `web-app-express/src/routes/admin.js`
    - Body: `change_owner=1`, `device_id`, `new_owner_id`
    - Validate device existence, target user existence, `new_owner_id !== device.user_id`
    - Single transaction: `UPDATE device SET user_id = ?` + `DELETE FROM user_device_access WHERE user_id = ? AND device_id = ?` for the new owner
    - On success: `insertAdminAuditLog(adminId, 'change_owner', 'device', device_id, { old_owner_id, new_owner_id })`
    - On invalid input: rollback, set `req.session.toast = { type: 'error', ... }`, redirect
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 11.1_

  - [x] 7.3 Reinforce `add_device`, `edit_device`, `delete_device` handlers in `POST /admin/devices`
    - Ensure validation paths (unknown `device_type`, missing `owner_id`, etc.) abort all DB writes and set an error toast (Requirement 1.4)
    - Ensure `add_device` produces a unique 8-char uppercase-hex `serial_number` and a paired `device_access_tokens` row with `max_uses = 1` (Requirement 1.1)
    - Ensure each success path calls `insertAdminAuditLog(adminId, action, 'device', device_id, details)` with `action ∈ {'add_device', 'edit_device', 'delete_device'}` and `details` listing changed fields (Requirements 1.5, 11.1)
    - Confirm `requireAdmin` is mounted on the route and that non-admins are redirected to `/dashboard` with an error toast (Requirement 1.6)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 11.1_

  - [x] 7.4 Add `GET /admin/devices/:deviceId/access` in `web-app-express/src/routes/admin.js`
    - Use `requireAdmin`; query owner row from `device JOIN user` and all rows from `user_device_access JOIN user` for the device
    - Render `views/admin/device_access.ejs` with `{ device, owner, accessRows }`
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 7.5 Add `POST /admin/devices/:deviceId/access/revoke` in `web-app-express/src/routes/admin.js`
    - Use `requireAdmin`; body: `viewer_user_id`
    - `DELETE FROM user_device_access WHERE user_id = ? AND device_id = ? AND access_type = 'viewer'`
    - On success: `insertAdminAuditLog(adminId, 'revoke_access', 'device', device_id, { revoked_user_id })`
    - _Requirements: 3.5, 11.1_

  - [x] 7.6 Property test: `add_device` produces device + serial regex + token row
    - **Property 1: Add device menghasilkan device + serial unik + token akses**
    - **Validates: Requirements 1.1**
    - File: `web-app-express/test/admin-devices.prop.test.js`

  - [x] 7.7 Property test: `edit_device` round-trip
    - **Property 2: Edit device adalah write-then-read identitas**
    - **Validates: Requirements 1.2**
    - File: `web-app-express/test/admin-devices.prop.test.js`

  - [x] 7.8 Property test: `delete_device` cascade
    - **Property 3: Delete device cascade-bersih**
    - **Validates: Requirements 1.3**
    - File: `web-app-express/test/admin-devices.prop.test.js`

  - [x] 7.9 Property test: `change_owner` state
    - **Property 7: Change owner mengubah device.user_id dan menghapus duplikasi viewer**
    - **Validates: Requirements 2.1, 2.2**
    - File: `web-app-express/test/admin-devices.prop.test.js`

  - [x] 7.10 Property test: invalid input → no DB change + error toast
    - **Property 4: Input invalid menyebabkan DB tidak berubah dan toast error**
    - **Validates: Requirements 1.4, 2.4, 2.5, 6.4, 6.5, 7.3, 7.4**
    - File: `web-app-express/test/validation.prop.test.js`

  - [x] 7.11 Property test: `/admin/devices/:id/access` shows owner ∪ user_device_access
    - **Property 8: Halaman akses perangkat menampilkan owner ∪ semua user_device_access**
    - **Validates: Requirements 3.1, 3.2, 3.3**
    - File: `web-app-express/test/admin-access.prop.test.js`

  - [x] 7.12 Property test: `/admin/devices` firmware/last_seen text
    - **Property 12: Tabel /admin/devices selalu menampilkan firmware dan last_seen yang dapat dibaca**
    - **Validates: Requirements 5.1, 5.4**
    - File: `web-app-express/test/admin-devices.prop.test.js`

  - [x] 7.13 Property test: `/admin/devices` reads fresh DB
    - **Property 13: Halaman admin/devices selalu membaca DB segar**
    - **Validates: Requirements 5.5**
    - File: `web-app-express/test/admin-devices.prop.test.js`

  - [x] 7.14 Property test: every successful admin mutation writes exactly one audit row
    - **Property 5: Setiap mutasi admin sukses menulis tepat satu baris audit**
    - **Validates: Requirements 1.5, 2.3, 3.5, 11.1, 11.2**
    - File: `web-app-express/test/audit.prop.test.js`

  - [x] 7.15 Property test: `insertAdminAuditLog` no-throw on DB error
    - **Property 27: Audit logger tidak melempar pada error DB**
    - **Validates: Requirements 11.3**
    - File: `web-app-express/test/audit.prop.test.js`

- [x] 8. Admin views: devices table and device access page
  - [x] 8.1 Update `web-app-express/src/views/admin/devices.ejs`
    - Add `Firmware` column rendering `device.firmware_version || 'unknown'`
    - Add `Connection` badge driven by `connected_effective` (`Connected` green vs `Disconnected` gray)
    - Add `Last Seen` column rendering a small inline EJS helper for human-readable elapsed time, falling back to `Belum pernah terhubung` when `last_seen_at` is null
    - Add a per-row "Change Owner" button that opens `#changeOwnerModal` posting to `POST /admin/devices` with `change_owner=1`, `device_id`, `new_owner_id`
    - Add a per-row "Access" link to `/admin/devices/:deviceId/access`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 2.1_

  - [x] 8.2 Create `web-app-express/src/views/admin/device_access.ejs`
    - Heading with device name and `serial_number`
    - Table listing the owner row + every `user_device_access` row, columns: `user_id`, `user_name`, `access_type`, `granted_at`
    - For each `viewer` row, render a "Cabut Akses" form posting to `/admin/devices/:deviceId/access/revoke` with `viewer_user_id`
    - Empty state: render "Tidak ada user lain yang memiliki akses" when there are no `user_device_access` rows
    - _Requirements: 3.1, 3.2, 3.3_

- [x] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. MQTT_Worker connection tracking + heartbeat
  - [x] 10.1 Track connection state in `mqtt-worker/src/services/DeviceManager.js`
    - Add `this.connectedDeviceIds = new Set()`
    - In `connectDevice(device)`, on the `connect` event: `UPDATE device SET is_connected = 1, last_seen_at = NOW() WHERE device_id = ?` and `connectedDeviceIds.add(String(device.device_id))`
    - On `close`, `error`, and `offline`: call an internal `markDisconnected(deviceId)` that runs `UPDATE device SET is_connected = 0 WHERE device_id = ?` (without touching `last_seen_at`) and removes the id from the set
    - Wrap each `pool.query` in `try/catch` that logs to `console.error` and never rethrows
    - _Requirements: 8.1, 8.2, 8.5_

  - [x] 10.2 Add the heartbeat in `DeviceManager`
    - Add `startHeartbeat()` that sets `this.heartbeatTimer = setInterval(..., 30_000)` and, on each tick, runs `UPDATE device SET last_seen_at = NOW() WHERE device_id = ?` for every id in `connectedDeviceIds`
    - Each query wrapped in `try/catch` → `console.error`
    - In `gracefulShutdown()`, `clearInterval(this.heartbeatTimer)` before ending clients/pool
    - _Requirements: 8.3_

  - [x] 10.3 Update `syncDevices()` removal path in `DeviceManager`
    - When a `device_id` disappears from the SELECT result, call `client.end()` and remove the id from `mqttClients`, `deviceBuffers`, and `connectedDeviceIds` without writing to `device.is_connected`
    - _Requirements: 8.4_

  - [x] 10.4 Wire `startHeartbeat()` from `mqtt-worker/index.js`
    - After the initial `syncDevices()` call (and before the 20s recurring sync interval), invoke `deviceManager.startHeartbeat()` once
    - Ensure existing signal handlers still trigger `gracefulShutdown()`
    - _Requirements: 8.3_

  - [x] 10.5 Property test: `connect` / `close` / `error` / `offline` transitions
    - **Property 19: Worker melaporkan koneksi: connect → is_connected=1+last_seen_at fresh; close/error/offline → is_connected=0 tanpa mengubah last_seen_at**
    - **Validates: Requirements 8.1, 8.2**
    - File: `mqtt-worker/test/device-manager.prop.test.js`

  - [x] 10.6 Property test: heartbeat updates `last_seen_at` only for connected devices
    - **Property 20: Heartbeat memperbarui last_seen_at pada device yang terhubung**
    - **Validates: Requirements 8.3**
    - File: `mqtt-worker/test/device-manager.prop.test.js`

  - [x] 10.7 Property test: worker no-throw on DB error
    - **Property 21: Worker tidak crash pada error DB**
    - **Validates: Requirements 8.5**
    - File: `mqtt-worker/test/device-manager.prop.test.js`

- [x] 11. MQTT_Worker firmware extraction
  - [x] 11.1 Add shared firmware helper
    - Create `mqtt-worker/src/handlers/firmware.js` exporting `maybeUpdateFirmwareVersion(device, data)`
    - No-op when `data.firmware_version` is missing, not a string, or trims to empty
    - On a real change: `UPDATE device SET firmware_version = ? WHERE device_id = ?` and `INSERT INTO device_logs (device_id, data, log_type) VALUES (?, ?, 'change_event')` with `data = JSON.stringify({ type: 'firmware_version', old, new })`
    - All queries through the shared `pool` with `?` placeholders, wrapped in `try/catch` → `console.error`
    - _Requirements: 9.1, 9.2, 9.4, 9.5_

  - [x] 11.2 Call the helper from both device handlers
    - In `mqtt-worker/src/handlers/incubator.js` and `mqtt-worker/src/handlers/smartlamp.js`, `await maybeUpdateFirmwareVersion(device, data)` immediately after the parsed JSON is available, before the existing handler body
    - _Requirements: 9.1, 9.2_

  - [x] 11.3 Confirm DeviceManager message dispatch tolerates non-JSON payloads
    - Verify the existing `client.on('message', ...)` `JSON.parse` is wrapped in `try/catch` that logs to `console.error` and skips the dispatch; if it isn't, add the wrapper
    - Ensures non-JSON payloads never reach `maybeUpdateFirmwareVersion`
    - _Requirements: 9.3_

  - [x] 11.4 Property test: firmware update only when string non-empty and changed
    - **Property 22: Firmware update hanya saat string non-kosong dan berbeda; selain itu no-op**
    - **Validates: Requirements 9.1, 9.2, 9.4, 9.5**
    - File: `mqtt-worker/test/firmware.prop.test.js`

  - [x] 11.5 Property test: non-JSON payload does not change `firmware_version`
    - **Property 23: Payload non-JSON tidak mengubah firmware_version**
    - **Validates: Requirements 9.3**
    - File: `mqtt-worker/test/firmware.prop.test.js`

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. Core implementation tasks are never marked optional.
- Each property-based test target is a single property from the design's "Correctness Properties" section, sized to ≥100 iterations via `fc.assert(prop, { numRuns: 100 })` per the testing strategy.
- Each property test references its parent requirement clauses inline so traceability stays close to the implementation.
- Checkpoints (tasks 4, 9, 12) are inserted at natural breakpoints: after auth flow, after admin views, and at the end.
- All DB statements use the shared `pool` from `config/db.js` with `?` placeholders, per the repo's coding conventions.
- This workflow is for creating design and planning artifacts only. To begin executing, open this `tasks.md` and click "Start task" next to a task item.

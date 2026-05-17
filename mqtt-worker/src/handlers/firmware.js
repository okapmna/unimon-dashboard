'use strict';

const pool = require('../config/db');

/**
 * Update `device.firmware_version` if `data.firmware_version` is a non-empty
 * string AND differs from the current value. On a real change, also write a
 * `change_event` row to `device_logs`.
 *
 * No-ops (per Requirements 9.4 and 9.5) when:
 *   - `data` is missing
 *   - `data.firmware_version` is missing
 *   - `data.firmware_version` is not a string
 *   - `data.firmware_version` is an empty / whitespace-only string
 *
 * Errors during DB writes are logged to `console.error` and never thrown
 * (Requirement 8.5 / 9 in general — keep the worker alive).
 */
async function maybeUpdateFirmwareVersion(device, data) {
  try {
    if (!device || device.device_id == null) return;
    if (!data || typeof data !== 'object') return;
    if (typeof data.firmware_version !== 'string') return;
    const fw = data.firmware_version.trim();
    if (!fw) return;

    const [rows] = await pool.query(
      'SELECT firmware_version FROM device WHERE device_id = ? LIMIT 1',
      [device.device_id]
    );
    const current = rows[0] ? rows[0].firmware_version : null;
    if (current === fw) return;

    await pool.query(
      'UPDATE device SET firmware_version = ? WHERE device_id = ?',
      [fw, device.device_id]
    );
    await pool.query(
      'INSERT INTO device_logs (device_id, data, log_type) VALUES (?, ?, ?)',
      [
        device.device_id,
        JSON.stringify({ type: 'firmware_version', old: current, new: fw }),
        'change_event'
      ]
    );
  } catch (err) {
    console.error('[Firmware] update failed for device ' + (device && device.device_id) + ':', err.message);
  }
}

module.exports = { maybeUpdateFirmwareVersion };

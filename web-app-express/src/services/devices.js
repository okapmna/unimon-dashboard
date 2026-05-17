const crypto = require('crypto');
const { pool } = require('../config/db');

async function tableExists(table) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [table]);
  return rows.length > 0;
}

async function columnExists(table, column) {
  const [rows] = await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
  return rows.length > 0;
}

async function indexExists(table, indexName) {
  const [rows] = await pool.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [indexName]);
  return rows.length > 0;
}

function randomSerial() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function generateUniqueDeviceSerialNumber() {
  // Loop until we find a serial not used in `device` (and `device_access_tokens` if exists)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const serial = randomSerial();
    const [d] = await pool.query('SELECT device_id FROM device WHERE serial_number = ? LIMIT 1', [serial]);
    let usedInTokens = false;
    if (await tableExists('device_access_tokens')) {
      const [t] = await pool.query(
        'SELECT token_id FROM device_access_tokens WHERE token_code = ? OR serial_number = ? LIMIT 1',
        [serial, serial]
      );
      usedInTokens = t.length > 0;
    }
    if (d.length === 0 && !usedInTokens) return serial;
  }
}

async function ensureAdminDeviceTables() {
  const schemaQueries = [
    `CREATE TABLE IF NOT EXISTS \`device_access_tokens\` (
      \`token_id\` int(11) NOT NULL AUTO_INCREMENT,
      \`device_id\` int(10) NOT NULL,
      \`token_code\` varchar(50) NOT NULL,
      \`serial_number\` varchar(50) DEFAULT NULL,
      \`created_by\` int(10) NOT NULL,
      \`max_uses\` int(11) DEFAULT NULL,
      \`current_uses\` int(11) DEFAULT 0,
      \`expires_at\` datetime DEFAULT NULL,
      \`is_active\` tinyint(1) DEFAULT 1,
      \`created_at\` timestamp NOT NULL DEFAULT current_timestamp(),
      PRIMARY KEY (\`token_id\`),
      UNIQUE KEY \`token_code\` (\`token_code\`),
      KEY \`device_id\` (\`device_id\`),
      KEY \`created_by\` (\`created_by\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    `CREATE TABLE IF NOT EXISTS \`user_device_access\` (
      \`id\` int(11) NOT NULL AUTO_INCREMENT,
      \`user_id\` int(10) NOT NULL,
      \`device_id\` int(10) NOT NULL,
      \`access_type\` ENUM('owner','viewer') NOT NULL,
      \`redeemed_via_token_id\` int(11) DEFAULT NULL,
      \`granted_at\` timestamp NOT NULL DEFAULT current_timestamp(),
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`user_device\` (\`user_id\`, \`device_id\`),
      KEY \`user_id\` (\`user_id\`),
      KEY \`device_id\` (\`device_id\`),
      KEY \`redeemed_via_token_id\` (\`redeemed_via_token_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    `CREATE TABLE IF NOT EXISTS \`admin_audit_log\` (
      \`log_id\` int(11) NOT NULL AUTO_INCREMENT,
      \`admin_id\` int(10) NOT NULL,
      \`action\` varchar(255) NOT NULL,
      \`target_type\` varchar(50) NOT NULL,
      \`target_id\` int(11) DEFAULT NULL,
      \`details\` json DEFAULT NULL,
      \`created_at\` timestamp NOT NULL DEFAULT current_timestamp(),
      PRIMARY KEY (\`log_id\`),
      KEY \`admin_id\` (\`admin_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`
  ];
  for (const q of schemaQueries) {
    try { await pool.query(q); } catch (err) { console.error('Schema check failed:', err.message); }
  }

  if (!(await columnExists('device', 'serial_number'))) {
    await pool.query("ALTER TABLE `device` ADD COLUMN `serial_number` varchar(50) DEFAULT NULL AFTER `device_name`");
  }
  if (!(await columnExists('device_access_tokens', 'serial_number'))) {
    await pool.query("ALTER TABLE `device_access_tokens` ADD COLUMN `serial_number` varchar(50) DEFAULT NULL AFTER `token_code`");
  }
  await pool.query("UPDATE `device_access_tokens` SET `serial_number` = `token_code` WHERE `serial_number` IS NULL OR `serial_number` = ''");
  if (!(await indexExists('device_access_tokens', 'serial_number'))) {
    try {
      await pool.query("ALTER TABLE `device_access_tokens` ADD UNIQUE KEY `serial_number` (`serial_number`)");
    } catch (err) { /* ignore if duplicates */ }
  }

  // Backfill missing serial numbers on devices
  const [missing] = await pool.query("SELECT device_id FROM device WHERE serial_number IS NULL OR serial_number = ''");
  for (const row of missing) {
    const serial = await generateUniqueDeviceSerialNumber();
    await pool.query('UPDATE device SET serial_number = ? WHERE device_id = ?', [serial, row.device_id]);
  }

  if (!(await indexExists('device', 'device_serial_number'))) {
    try {
      await pool.query("ALTER TABLE `device` ADD UNIQUE KEY `device_serial_number` (`serial_number`)");
    } catch (err) { /* ignore */ }
  }

  if (!(await columnExists('device', 'firmware_version'))) {
    try {
      await pool.query("ALTER TABLE `device` ADD COLUMN `firmware_version` varchar(50) DEFAULT NULL");
    } catch (err) { console.error('Add device.firmware_version failed:', err.message); }
  }
  if (!(await columnExists('device', 'is_connected'))) {
    try {
      await pool.query("ALTER TABLE `device` ADD COLUMN `is_connected` tinyint(1) NOT NULL DEFAULT 0");
    } catch (err) { console.error('Add device.is_connected failed:', err.message); }
  }
  if (!(await columnExists('device', 'last_seen_at'))) {
    try {
      await pool.query("ALTER TABLE `device` ADD COLUMN `last_seen_at` datetime DEFAULT NULL");
    } catch (err) { console.error('Add device.last_seen_at failed:', err.message); }
  }
  if (!(await indexExists('device', 'device_is_connected'))) {
    try {
      await pool.query("ALTER TABLE `device` ADD KEY `device_is_connected` (`is_connected`)");
    } catch (err) { console.error('Add device.device_is_connected index failed:', err.message); }
  }
}

function computeConnectionStatus(isConnected, lastSeenAt, now) {
  if (isConnected != 1) return 'Disconnected';
  if (lastSeenAt === null || lastSeenAt === undefined) return 'Disconnected';
  const lastSeenMs = lastSeenAt instanceof Date
    ? lastSeenAt.getTime()
    : new Date(lastSeenAt).getTime();
  if (Number.isNaN(lastSeenMs)) return 'Disconnected';
  let nowMs;
  if (now instanceof Date) {
    nowMs = now.getTime();
  } else if (typeof now === 'number') {
    nowMs = now;
  } else {
    nowMs = new Date(now).getTime();
  }
  if (Number.isNaN(nowMs)) return 'Disconnected';
  return (nowMs - lastSeenMs) <= 90000 ? 'Connected' : 'Disconnected';
}

async function fetchDeviceWithAccess(deviceId, user) {
  if (user.role === 'admin') {
    const [rows] = await pool.query(
      "SELECT d.*, 'owner' as access_type FROM device d WHERE d.device_id = ?",
      [deviceId]
    );
    return rows[0] || null;
  }
  const [rows] = await pool.query(
    `SELECT d.*, 'owner' as access_type FROM device d WHERE d.device_id = ? AND d.user_id = ?
     UNION
     SELECT d.*, uda.access_type FROM device d
     JOIN user_device_access uda ON d.device_id = uda.device_id
     WHERE d.device_id = ? AND uda.user_id = ?`,
    [deviceId, user.user_id, deviceId, user.user_id]
  );
  return rows[0] || null;
}

module.exports = {
  tableExists,
  columnExists,
  indexExists,
  generateUniqueDeviceSerialNumber,
  ensureAdminDeviceTables,
  fetchDeviceWithAccess,
  computeConnectionStatus
};

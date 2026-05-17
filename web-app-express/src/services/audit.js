const { pool } = require('../config/db');

async function insertAdminAuditLog(adminId, action, targetType, targetId, details = null) {
  if (!adminId) return;
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
       VALUES (?, ?, ?, ?, ?)`,
      [adminId, action, targetType, targetId, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    console.error('Audit log insert failed:', err);
  }
}

module.exports = { insertAdminAuditLog };

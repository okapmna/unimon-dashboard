const express = require('express');
const { pool } = require('../config/db');
const { requireAdmin } = require('../middleware/auth');
const { insertAdminAuditLog } = require('../services/audit');
const {
  ensureAdminDeviceTables,
  generateUniqueDeviceSerialNumber,
  tableExists
} = require('../services/devices');

const router = express.Router();

router.use(requireAdmin);

router.get('/', (req, res) => res.redirect('/admin/users'));

// ---------------- USERS ----------------

const USERS_ALLOWED_SORT = ['user_id', 'user_name', 'role', 'owned_count', 'shared_count'];
const PAGE_LIMIT = 25;

router.get('/users', async (req, res, next) => {
  try {
    const search = (req.query.search || '').toString();
    let sortCol = (req.query.sort || 'user_id').toString();
    if (!USERS_ALLOWED_SORT.includes(sortCol)) sortCol = 'user_id';
    const sortDir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * PAGE_LIMIT;

    const whereClause = search ? 'WHERE user_name LIKE ? OR role LIKE ?' : '';
    const whereParams = search ? [`%${search}%`, `%${search}%`] : [];

    const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM user u ${whereClause}`, whereParams);
    const totalRows = countRows[0].total;
    const totalPages = Math.ceil(totalRows / PAGE_LIMIT) || 1;

    const sql = `SELECT u.user_id, u.user_name, u.role,
                  (SELECT COUNT(*) FROM device d WHERE d.user_id = u.user_id) as owned_count,
                  (SELECT COUNT(*) FROM user_device_access uda WHERE uda.user_id = u.user_id) as shared_count
                 FROM user u
                 ${whereClause}
                 ORDER BY ${sortCol} ${sortDir}
                 LIMIT ? OFFSET ?`;
    const [users] = await pool.query(sql, [...whereParams, PAGE_LIMIT, offset]);

    res.render('admin/users', {
      currentAdminId: req.session.user.user_id,
      users,
      search,
      sortCol,
      sortDir,
      page,
      totalPages,
      totalRows,
      shownCount: users.length
    });
  } catch (err) { next(err); }
});

router.post('/users', async (req, res, next) => {
  const adminId = req.session.user.user_id;
  try {
    if (req.body.change_role !== undefined) {
      const targetUserId = parseInt(req.body.user_id, 10);
      const newRole = req.body.role;
      if (!['admin', 'user'].includes(newRole)) {
        req.session.toast = { type: 'error', message: 'Invalid role selected.' };
        return res.redirect('/admin/users');
      }
      const [curRows] = await pool.query('SELECT role FROM user WHERE user_id = ? LIMIT 1', [targetUserId]);
      if (curRows.length === 0) {
        req.session.toast = { type: 'error', message: 'User not found.' };
        return res.redirect('/admin/users');
      }
      const currentRole = curRows[0].role;
      if (newRole === 'user') {
        const [adminCountRows] = await pool.query("SELECT COUNT(*) as count FROM user WHERE role = 'admin'");
        if (adminCountRows[0].count <= 1 && currentRole === 'admin') {
          req.session.toast = { type: 'error', message: 'Cannot demote the last admin!' };
          return res.redirect('/admin/users');
        }
      }
      await pool.query('UPDATE user SET role = ? WHERE user_id = ?', [newRole, targetUserId]);
      await insertAdminAuditLog(adminId, 'change_role', 'user', targetUserId, { old_role: currentRole, new_role: newRole });
      req.session.toast = { type: 'success', message: 'Role updated successfully!' };
      return res.redirect('/admin/users');
    }

    if (req.body.delete_user !== undefined) {
      const targetUserId = parseInt(req.body.user_id, 10);
      if (targetUserId === parseInt(adminId, 10)) {
        req.session.toast = { type: 'error', message: 'You cannot delete yourself!' };
        return res.redirect('/admin/users');
      }
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM admin_audit_log WHERE admin_id = ?', [targetUserId]);
        await conn.query('DELETE FROM device_access_tokens WHERE created_by = ?', [targetUserId]);
        await conn.query('DELETE FROM user_device_access WHERE user_id = ?', [targetUserId]);
        await conn.query('DELETE FROM device WHERE user_id = ?', [targetUserId]);
        await conn.query('DELETE FROM user_tokens WHERE user_id = ?', [targetUserId]);
        await conn.query('DELETE FROM user WHERE user_id = ?', [targetUserId]);
        await conn.commit();
        await insertAdminAuditLog(adminId, 'delete_user', 'user', targetUserId);
        req.session.toast = { type: 'success', message: 'User deleted successfully!' };
      } catch (e) {
        await conn.rollback();
        req.session.toast = { type: 'error', message: 'Failed to delete user: ' + e.message };
      } finally {
        conn.release();
      }
      return res.redirect('/admin/users');
    }

    return res.redirect('/admin/users');
  } catch (err) { next(err); }
});

// ---------------- DEVICES ----------------

const DEVICES_ALLOWED_SORT = ['device_id', 'device_name', 'serial_number', 'device_type', 'owner_name', 'shared_users'];

router.get('/devices', async (req, res, next) => {
  try {
    await ensureAdminDeviceTables();

    const search = (req.query.search || '').toString();
    let sortCol = (req.query.sort || 'device_id').toString();
    if (!DEVICES_ALLOWED_SORT.includes(sortCol)) sortCol = 'device_id';
    const sortDir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * PAGE_LIMIT;

    const whereClause = search
      ? 'WHERE d.device_name LIKE ? OR d.serial_number LIKE ? OR u.user_name LIKE ? OR d.device_type LIKE ?'
      : '';
    const whereParams = search ? [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`] : [];

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM device d JOIN user u ON d.user_id = u.user_id ${whereClause}`,
      whereParams
    );
    const totalRows = countRows[0].total;
    const totalPages = Math.ceil(totalRows / PAGE_LIMIT) || 1;

    const hasUDA = await tableExists('user_device_access');
    const sharedSelect = hasUDA
      ? "(SELECT COUNT(*) FROM user_device_access uda WHERE uda.device_id = d.device_id AND uda.access_type = 'viewer')"
      : '0';

    const sql = `SELECT d.*, u.user_name as owner_name, ${sharedSelect} as shared_users,
                   (d.is_connected = 1 AND d.last_seen_at IS NOT NULL AND TIMESTAMPDIFF(SECOND, d.last_seen_at, NOW()) <= 90) AS connected_effective
                 FROM device d
                 JOIN user u ON d.user_id = u.user_id
                 ${whereClause}
                 ORDER BY ${sortCol} ${sortDir}
                 LIMIT ? OFFSET ?`;
    const [devices] = await pool.query(sql, [...whereParams, PAGE_LIMIT, offset]);
    const [usersList] = await pool.query('SELECT user_id, user_name FROM user ORDER BY user_name ASC');

    res.render('admin/devices', {
      currentAdminId: req.session.user.user_id,
      devices,
      usersList,
      search,
      sortCol,
      sortDir,
      page,
      totalPages,
      totalRows,
      shownCount: devices.length
    });
  } catch (err) { next(err); }
});

router.post('/devices', async (req, res, next) => {
  const adminId = req.session.user.user_id;
  try {
    if (req.body.add_device !== undefined) {
      const ownerId = parseInt(req.body.owner_id, 10);
      const deviceName = req.body.device_name;
      const deviceType = req.body.device_type;
      const brokerUrl = req.body.broker_url;
      const brokerPort = req.body.broker_port;
      const mqUser = req.body.mq_user || '';
      const mqPass = req.body.mq_pass || '';

      if (!ownerId || !['esp32-inkubator', 'esp32-smartlamp'].includes(deviceType)) {
        req.session.toast = { type: 'error', message: 'Invalid device data.' };
        return res.redirect('/admin/devices');
      }

      const serial = await generateUniqueDeviceSerialNumber();
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [ins] = await conn.query(
          `INSERT INTO device (user_id, device_name, serial_number, broker_url, mq_user, mq_pass, device_type, broker_port)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [ownerId, deviceName, serial, brokerUrl, mqUser, mqPass, deviceType, brokerPort]
        );
        const newId = ins.insertId;
        await conn.query(
          `INSERT INTO device_access_tokens (device_id, token_code, serial_number, created_by, max_uses)
           VALUES (?, ?, ?, ?, 1)`,
          [newId, serial, serial, adminId]
        );
        await conn.commit();
        await insertAdminAuditLog(adminId, 'add_device', 'device', newId, { name: deviceName, serial_number: serial });
        req.session.toast = { type: 'success', message: `Device added. Serial number: ${serial}` };
      } catch (e) {
        await conn.rollback();
        req.session.toast = { type: 'error', message: 'Failed to add device: ' + e.message };
      } finally {
        conn.release();
      }
      return res.redirect('/admin/devices');
    }

    if (req.body.edit_device !== undefined) {
      const deviceId = parseInt(req.body.edit_device_id, 10);
      const ownerId = parseInt(req.body.edit_owner_id, 10);
      const deviceName = req.body.edit_device_name;
      const deviceType = req.body.edit_device_type;
      const brokerUrl = req.body.edit_broker_url;
      const brokerPort = req.body.edit_broker_port;
      const mqUser = req.body.edit_mq_user || '';
      const mqPass = req.body.edit_mq_pass || '';

      if (!deviceId || !ownerId || !['esp32-inkubator', 'esp32-smartlamp'].includes(deviceType)) {
        req.session.toast = { type: 'error', message: 'Invalid device data.' };
        return res.redirect('/admin/devices');
      }

      try {
        await pool.query(
          `UPDATE device SET user_id = ?, device_name = ?, device_type = ?, broker_url = ?, broker_port = ?, mq_user = ?, mq_pass = ?
           WHERE device_id = ?`,
          [ownerId, deviceName, deviceType, brokerUrl, brokerPort, mqUser, mqPass, deviceId]
        );
        if (await tableExists('user_device_access')) {
          await pool.query('DELETE FROM user_device_access WHERE user_id = ? AND device_id = ?', [ownerId, deviceId]);
        }
        await insertAdminAuditLog(adminId, 'edit_device', 'device', deviceId, { name: deviceName });
        req.session.toast = { type: 'success', message: 'Device successfully updated!' };
      } catch (e) {
        req.session.toast = { type: 'error', message: 'Failed to update: ' + e.message };
      }
      return res.redirect('/admin/devices');
    }

    if (req.body.delete_device !== undefined) {
      const deviceId = parseInt(req.body.device_id, 10);
      try {
        const [info] = await pool.query('SELECT device_name FROM device WHERE device_id = ?', [deviceId]);
        const name = info[0] ? info[0].device_name : 'Unknown';
        await pool.query('DELETE FROM device WHERE device_id = ?', [deviceId]);
        await insertAdminAuditLog(adminId, 'delete_device', 'device', deviceId, { name });
        req.session.toast = { type: 'success', message: 'Device deleted successfully.' };
      } catch (e) {
        req.session.toast = { type: 'error', message: 'Failed to delete device.' };
      }
      return res.redirect('/admin/devices');
    }

    if (req.body.change_owner !== undefined) {
      const deviceId = parseInt(req.body.device_id, 10);
      const newOwnerId = parseInt(req.body.new_owner_id, 10);
      if (!deviceId || !newOwnerId) {
        req.session.toast = { type: 'error', message: 'Invalid device or owner.' };
        return res.redirect('/admin/devices');
      }
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [deviceRows] = await conn.query(
          'SELECT user_id FROM device WHERE device_id = ? LIMIT 1',
          [deviceId]
        );
        if (deviceRows.length === 0) {
          await conn.rollback();
          req.session.toast = { type: 'error', message: 'Device not found.' };
          return res.redirect('/admin/devices');
        }
        const oldOwnerId = parseInt(deviceRows[0].user_id, 10);
        if (oldOwnerId === newOwnerId) {
          await conn.rollback();
          req.session.toast = { type: 'error', message: 'Owner unchanged.' };
          return res.redirect('/admin/devices');
        }
        const [userRows] = await conn.query(
          'SELECT user_id FROM `user` WHERE user_id = ? LIMIT 1',
          [newOwnerId]
        );
        if (userRows.length === 0) {
          await conn.rollback();
          req.session.toast = { type: 'error', message: 'New owner not found.' };
          return res.redirect('/admin/devices');
        }
        await conn.query('UPDATE device SET user_id = ? WHERE device_id = ?', [newOwnerId, deviceId]);
        await conn.query(
          'DELETE FROM user_device_access WHERE user_id = ? AND device_id = ?',
          [newOwnerId, deviceId]
        );
        await conn.commit();
        await insertAdminAuditLog(adminId, 'change_owner', 'device', deviceId, {
          old_owner_id: oldOwnerId,
          new_owner_id: newOwnerId
        });
        req.session.toast = { type: 'success', message: 'Owner changed successfully.' };
      } catch (e) {
        try { await conn.rollback(); } catch (rbErr) { /* ignore */ }
        req.session.toast = { type: 'error', message: 'Failed to change owner: ' + e.message };
      } finally {
        conn.release();
      }
      return res.redirect('/admin/devices');
    }

    return res.redirect('/admin/devices');
  } catch (err) { next(err); }
});

// ---------------- DEVICE ACCESS SUBPAGE ----------------

router.get('/devices/:deviceId/access', async (req, res, next) => {
  try {
    const deviceId = parseInt(req.params.deviceId, 10);
    if (!deviceId) {
      req.session.toast = { type: 'error', message: 'Invalid device.' };
      return res.redirect('/admin/devices');
    }
    const [deviceRows] = await pool.query(
      `SELECT d.device_id, d.device_name, d.serial_number, d.user_id, u.user_name AS owner_name
         FROM device d JOIN \`user\` u ON d.user_id = u.user_id
        WHERE d.device_id = ? LIMIT 1`,
      [deviceId]
    );
    if (deviceRows.length === 0) {
      req.session.toast = { type: 'error', message: 'Device not found.' };
      return res.redirect('/admin/devices');
    }
    const device = deviceRows[0];
    const owner = {
      user_id: device.user_id,
      user_name: device.owner_name,
      access_type: 'owner',
      granted_at: null
    };
    const [accessRows] = await pool.query(
      `SELECT uda.user_id, u.user_name, uda.access_type, uda.granted_at
         FROM user_device_access uda
         JOIN \`user\` u ON uda.user_id = u.user_id
        WHERE uda.device_id = ?
        ORDER BY uda.granted_at ASC`,
      [deviceId]
    );
    res.render('admin/device_access', {
      currentAdminId: req.session.user.user_id,
      device,
      owner,
      accessRows
    });
  } catch (err) { next(err); }
});

router.post('/devices/:deviceId/access/revoke', async (req, res, next) => {
  const adminId = req.session.user.user_id;
  try {
    const deviceId = parseInt(req.params.deviceId, 10);
    const viewerUserId = parseInt(req.body.viewer_user_id, 10);
    if (!deviceId || !viewerUserId) {
      req.session.toast = { type: 'error', message: 'Invalid input.' };
      return res.redirect('/admin/devices');
    }
    const [result] = await pool.query(
      "DELETE FROM user_device_access WHERE user_id = ? AND device_id = ? AND access_type = 'viewer'",
      [viewerUserId, deviceId]
    );
    if (result.affectedRows > 0) {
      await insertAdminAuditLog(adminId, 'revoke_access', 'device', deviceId, {
        revoked_user_id: viewerUserId
      });
      req.session.toast = { type: 'success', message: 'Access revoked.' };
    } else {
      req.session.toast = { type: 'error', message: 'No matching viewer access found.' };
    }
    return res.redirect('/admin/devices/' + deviceId + '/access');
  } catch (err) { next(err); }
});

module.exports = router;

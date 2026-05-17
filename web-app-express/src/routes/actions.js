const express = require('express');
const { pool } = require('../config/db');
const { requireLogin } = require('../middleware/auth');
const {
  ensureAdminDeviceTables,
  generateUniqueDeviceSerialNumber,
  columnExists,
  indexExists
} = require('../services/devices');

const router = express.Router();

async function ensureDeviceSerialNumbers() {
  if (!(await columnExists('device', 'serial_number'))) {
    await pool.query("ALTER TABLE `device` ADD COLUMN `serial_number` varchar(50) DEFAULT NULL AFTER `device_name`");
  }
  const [missing] = await pool.query("SELECT device_id FROM device WHERE serial_number IS NULL OR serial_number = ''");
  for (const row of missing) {
    const serial = await generateUniqueDeviceSerialNumber();
    await pool.query('UPDATE device SET serial_number = ? WHERE device_id = ?', [serial, row.device_id]);
  }
  if (!(await indexExists('device', 'device_serial_number'))) {
    try { await pool.query("ALTER TABLE `device` ADD UNIQUE KEY `device_serial_number` (`serial_number`)"); } catch (e) {}
  }
}

router.post('/redeem_serial_number', requireLogin, async (req, res) => {
  const userId = req.session.user.user_id;
  const serialNumber = String(req.body.serial_number || '').trim().toUpperCase();

  if (!serialNumber) {
    req.session.toast = { type: 'error', message: 'Invalid serial number.' };
    return res.redirect('/dashboard');
  }

  let conn;
  try {
    await ensureDeviceSerialNumbers();
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [deviceRows] = await conn.query(
      'SELECT device_id, user_id FROM device WHERE serial_number = ? LIMIT 1 FOR UPDATE',
      [serialNumber]
    );
    if (deviceRows.length === 0) throw new Error('Invalid serial number.');

    const device = deviceRows[0];
    if (parseInt(device.user_id, 10) === parseInt(userId, 10)) {
      throw new Error('You already own this device.');
    }

    const [accessRows] = await conn.query(
      'SELECT id FROM user_device_access WHERE user_id = ? AND device_id = ? LIMIT 1',
      [userId, device.device_id]
    );
    if (accessRows.length > 0) throw new Error('You already have access to this device.');

    await conn.query(
      `INSERT INTO user_device_access (user_id, device_id, access_type, redeemed_via_token_id)
       VALUES (?, ?, 'viewer', NULL)`,
      [userId, device.device_id]
    );

    await conn.commit();
    req.session.toast = { type: 'success', message: 'Device successfully added to your dashboard!' };
  } catch (err) {
    if (conn) await conn.rollback();
    req.session.toast = { type: 'error', message: err.message || 'Failed to add device.' };
  } finally {
    if (conn) conn.release();
  }
  return res.redirect('/dashboard');
});

router.post('/remove_shared', requireLogin, async (req, res) => {
  const userId = req.session.user.user_id;
  const deviceId = parseInt(req.body.device_id, 10);
  if (!deviceId) {
    req.session.toast = { type: 'error', message: 'Invalid device.' };
    return res.redirect('/dashboard');
  }
  try {
    const [ownerRows] = await pool.query('SELECT user_id FROM device WHERE device_id = ? LIMIT 1', [deviceId]);
    if (ownerRows.length && parseInt(ownerRows[0].user_id, 10) === parseInt(userId, 10)) {
      req.session.toast = { type: 'error', message: 'Owned devices can only be managed by an admin.' };
    } else {
      const [result] = await pool.query(
        'DELETE FROM user_device_access WHERE user_id = ? AND device_id = ?',
        [userId, deviceId]
      );
      if (result.affectedRows > 0) {
        req.session.toast = { type: 'success', message: 'Shared device removed from your dashboard.' };
      } else {
        req.session.toast = { type: 'error', message: 'Failed to remove shared device.' };
      }
    }
  } catch (err) {
    console.error('remove_shared error:', err);
    req.session.toast = { type: 'error', message: 'Failed to remove shared device.' };
  }
  return res.redirect('/dashboard');
});

router.post('/share_device', requireLogin, async (req, res) => {
  const userId = req.session.user.user_id;
  const deviceId = parseInt(req.body.device_id, 10);
  const targetUsername = String(req.body.target_username || '').trim();

  if (!deviceId || !targetUsername) {
    req.session.toast = { type: 'error', message: 'Invalid input.' };
    return res.redirect('/dashboard');
  }

  try {
    const [deviceRows] = await pool.query(
      'SELECT user_id FROM device WHERE device_id = ? LIMIT 1',
      [deviceId]
    );
    if (deviceRows.length === 0) {
      req.session.toast = { type: 'error', message: 'Device not found.' };
      return res.redirect('/dashboard');
    }
    if (parseInt(deviceRows[0].user_id, 10) !== parseInt(userId, 10)) {
      req.session.toast = { type: 'error', message: 'Only the device owner can share.' };
      return res.status(403).send('Forbidden');
    }

    const [targetRows] = await pool.query(
      'SELECT user_id FROM `user` WHERE user_name = ? LIMIT 1',
      [targetUsername]
    );
    if (targetRows.length === 0) {
      req.session.toast = { type: 'error', message: 'Target user not found.' };
      return res.redirect('/dashboard');
    }
    const targetUserId = targetRows[0].user_id;
    if (parseInt(targetUserId, 10) === parseInt(userId, 10)) {
      req.session.toast = { type: 'error', message: 'Cannot share with yourself.' };
      return res.redirect('/dashboard');
    }

    const [existing] = await pool.query(
      'SELECT id FROM user_device_access WHERE user_id = ? AND device_id = ? LIMIT 1',
      [targetUserId, deviceId]
    );
    if (existing.length > 0) {
      req.session.toast = { type: 'error', message: 'User already has access.' };
      return res.redirect('/dashboard');
    }

    await pool.query(
      "INSERT INTO user_device_access (user_id, device_id, access_type) VALUES (?, ?, 'viewer')",
      [targetUserId, deviceId]
    );
    req.session.toast = { type: 'success', message: 'Device shared with ' + targetUsername + '.' };
  } catch (err) {
    console.error('share_device error:', err);
    req.session.toast = { type: 'error', message: 'Failed to share device.' };
  }
  return res.redirect('/dashboard');
});

router.post('/revoke_share', requireLogin, async (req, res) => {
  const userId = req.session.user.user_id;
  const deviceId = parseInt(req.body.device_id, 10);
  const viewerUserId = parseInt(req.body.viewer_user_id, 10);

  if (!deviceId || !viewerUserId) {
    req.session.toast = { type: 'error', message: 'Invalid input.' };
    return res.redirect('/dashboard');
  }

  try {
    const [deviceRows] = await pool.query(
      'SELECT user_id FROM device WHERE device_id = ? LIMIT 1',
      [deviceId]
    );
    if (deviceRows.length === 0) {
      req.session.toast = { type: 'error', message: 'Device not found.' };
      return res.redirect('/dashboard');
    }
    if (parseInt(deviceRows[0].user_id, 10) !== parseInt(userId, 10)) {
      req.session.toast = { type: 'error', message: 'Only the device owner can revoke.' };
      return res.status(403).send('Forbidden');
    }

    await pool.query(
      "DELETE FROM user_device_access WHERE user_id = ? AND device_id = ? AND access_type = 'viewer'",
      [viewerUserId, deviceId]
    );
    req.session.toast = { type: 'success', message: 'Access revoked.' };
  } catch (err) {
    console.error('revoke_share error:', err);
    req.session.toast = { type: 'error', message: 'Failed to revoke access.' };
  }
  return res.redirect('/dashboard');
});

router.post('/transfer_ownership', requireLogin, async (req, res) => {
  const userId = req.session.user.user_id;
  const deviceId = parseInt(req.body.device_id, 10);
  const targetUsername = String(req.body.target_username || '').trim();
  const keepAsViewer = req.body.keep_as_viewer === 'on';

  if (!deviceId || !targetUsername) {
    req.session.toast = { type: 'error', message: 'Invalid input.' };
    return res.redirect('/dashboard');
  }

  let conn;
  try {
    const [deviceRows] = await pool.query(
      'SELECT user_id FROM device WHERE device_id = ? LIMIT 1',
      [deviceId]
    );
    if (deviceRows.length === 0) {
      req.session.toast = { type: 'error', message: 'Device not found.' };
      return res.redirect('/dashboard');
    }
    if (parseInt(deviceRows[0].user_id, 10) !== parseInt(userId, 10)) {
      req.session.toast = { type: 'error', message: 'Only the device owner can transfer.' };
      return res.status(403).send('Forbidden');
    }

    const [targetRows] = await pool.query(
      'SELECT user_id FROM `user` WHERE user_name = ? LIMIT 1',
      [targetUsername]
    );
    if (targetRows.length === 0) {
      req.session.toast = { type: 'error', message: 'Target user not found.' };
      return res.redirect('/dashboard');
    }
    const targetUserId = targetRows[0].user_id;
    if (parseInt(targetUserId, 10) === parseInt(userId, 10)) {
      req.session.toast = { type: 'error', message: 'Target is already the owner.' };
      return res.redirect('/dashboard');
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.query('UPDATE device SET user_id = ? WHERE device_id = ?', [targetUserId, deviceId]);
    await conn.query(
      'DELETE FROM user_device_access WHERE user_id = ? AND device_id = ?',
      [targetUserId, deviceId]
    );
    await conn.query(
      'DELETE FROM user_device_access WHERE user_id = ? AND device_id = ?',
      [userId, deviceId]
    );
    if (keepAsViewer) {
      await conn.query(
        "INSERT INTO user_device_access (user_id, device_id, access_type) VALUES (?, ?, 'viewer')",
        [userId, deviceId]
      );
    }
    await conn.commit();
    req.session.toast = { type: 'success', message: 'Ownership transferred to ' + targetUsername + '.' };
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch (e) { /* ignore */ }
    }
    console.error('transfer_ownership error:', err);
    req.session.toast = { type: 'error', message: 'Failed to transfer ownership.' };
  } finally {
    if (conn) conn.release();
  }
  return res.redirect('/dashboard');
});

module.exports = router;

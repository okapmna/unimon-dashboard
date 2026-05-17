const express = require('express');
const { pool } = require('../config/db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireLogin, async (req, res, next) => {
  try {
    const userId = req.session.user.user_id;
    const [devices] = await pool.query(
      `SELECT d.*, 'owner' as access_type,
              (d.is_connected = 1 AND d.last_seen_at IS NOT NULL AND TIMESTAMPDIFF(SECOND, d.last_seen_at, NOW()) <= 90) AS is_connected_effective
         FROM device d WHERE d.user_id = ?
       UNION
       SELECT d.*, uda.access_type,
              (d.is_connected = 1 AND d.last_seen_at IS NOT NULL AND TIMESTAMPDIFF(SECOND, d.last_seen_at, NOW()) <= 90) AS is_connected_effective
         FROM device d
         JOIN user_device_access uda ON d.device_id = uda.device_id
         WHERE uda.user_id = ?
       ORDER BY device_id DESC`,
      [userId, userId]
    );

    // For each owned device, fetch the list of active viewers (used by the kebab menu)
    const ownedIds = devices.filter((d) => d.access_type === 'owner').map((d) => d.device_id);
    const viewersByDeviceId = {};
    if (ownedIds.length > 0) {
      const placeholders = ownedIds.map(() => '?').join(',');
      const [viewerRows] = await pool.query(
        `SELECT uda.device_id, uda.user_id, u.user_name
           FROM user_device_access uda
           JOIN \`user\` u ON uda.user_id = u.user_id
          WHERE uda.access_type = 'viewer' AND uda.device_id IN (${placeholders})`,
        ownedIds
      );
      for (const r of viewerRows) {
        if (!viewersByDeviceId[r.device_id]) viewersByDeviceId[r.device_id] = [];
        viewersByDeviceId[r.device_id].push({ user_id: r.user_id, user_name: r.user_name });
      }
    }

    res.render('dashboard', {
      username: req.session.user.username,
      role: req.session.user.role,
      devices,
      viewersByDeviceId
    });
  } catch (err) { next(err); }
});

module.exports = router;

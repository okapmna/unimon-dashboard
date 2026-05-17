const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  res.render('profile', { user: req.session.user });
});

router.post('/', requireLogin, async (req, res, next) => {
  const { current_password, new_password, confirm_password } = req.body;
  const userId = req.session.user.user_id;
  try {
    const [rows] = await pool.query('SELECT password FROM user WHERE user_id = ? LIMIT 1', [userId]);
    if (rows.length !== 1) {
      req.session.toast = { type: 'error', message: 'User tidak ditemukan.' };
      return res.redirect('/profile');
    }
    const ok = await bcrypt.compare(current_password || '', rows[0].password);
    if (!ok) {
      req.session.toast = { type: 'error', message: 'Password saat ini salah.' };
      return res.redirect('/profile');
    }
    if (new_password !== confirm_password) {
      req.session.toast = { type: 'error', message: 'Konfirmasi password baru tidak cocok.' };
      return res.redirect('/profile');
    }
    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE user SET password = ? WHERE user_id = ?', [hashed, userId]);
    req.session.toast = { type: 'success', message: 'Password berhasil diubah!' };
    return res.redirect('/profile');
  } catch (err) { next(err); }
});

module.exports = router;

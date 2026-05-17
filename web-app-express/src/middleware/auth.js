const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');

async function tryRememberMeLogin(req, res, next) {
  if (req.session.user || !req.cookies || !req.cookies.remember_me) return next();

  const cookieValue = req.cookies.remember_me;
  if (!cookieValue.includes(':')) return next();

  const [selector, validator] = cookieValue.split(':');
  if (!selector || !validator) return next();

  try {
    const [rows] = await pool.query(
      `SELECT ut.user_id, ut.hashed_validator, u.user_name, u.role
       FROM user_tokens ut
       JOIN user u ON ut.user_id = u.user_id
       WHERE ut.selector = ? AND ut.expiry > NOW()
       LIMIT 1`,
      [selector]
    );

    if (rows.length === 1) {
      const tokenData = rows[0];
      const ok = await bcrypt.compare(validator, tokenData.hashed_validator);
      if (ok) {
        req.session.user = {
          user_id: tokenData.user_id,
          username: tokenData.user_name,
          role: tokenData.role || 'user'
        };
      }
    }
  } catch (err) {
    console.error('Remember-me login error:', err);
  }

  next();
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  if (req.session.user.role !== 'admin') {
    req.session.toast = { type: 'error', message: 'Access Denied: Admin only area.' };
    return res.redirect('/dashboard');
  }
  next();
}

function redirectIfAuthed(req, res, next) {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  next();
}

module.exports = { tryRememberMeLogin, requireLogin, requireAdmin, redirectIfAuthed };

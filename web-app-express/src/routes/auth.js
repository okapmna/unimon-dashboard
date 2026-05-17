const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { redirectIfAuthed } = require('../middleware/auth');

const router = express.Router();
const REMEMBER_ME_MAX_AGE = 1000 * 60 * 60 * 24 * 30; // 30 days

router.get('/', redirectIfAuthed, (req, res) => {
  res.render('login', { error: '', message: req.query.pesan || '' });
});

router.post('/', async (req, res) => {
  const { username, password, remember } = req.body;

  try {
    const [rows] = await pool.query(
      'SELECT user_id, user_name, password, role FROM user WHERE user_name = ? LIMIT 1',
      [username]
    );

    if (rows.length === 0) {
      return res.status(401).render('login', { error: 'Username and password do not match', message: '' });
    }

    const data = rows[0];
    const ok = await bcrypt.compare(password || '', data.password);
    if (!ok) {
      return res.status(401).render('login', { error: 'Username and password do not match', message: '' });
    }

    req.session.user = {
      user_id: data.user_id,
      username: data.user_name,
      role: data.role || 'user'
    };

    if (remember) {
      const selector = crypto.randomBytes(6).toString('hex');
      const validator = crypto.randomBytes(32).toString('hex');
      const hashedValidator = await bcrypt.hash(validator, 10);
      const expiry = new Date(Date.now() + REMEMBER_ME_MAX_AGE);

      await pool.query(
        'INSERT INTO user_tokens (user_id, selector, hashed_validator, expiry) VALUES (?, ?, ?, ?)',
        [data.user_id, selector, hashedValidator, expiry]
      );

      res.cookie('remember_me', `${selector}:${validator}`, {
        maxAge: REMEMBER_ME_MAX_AGE,
        httpOnly: true,
        secure: req.secure,
        sameSite: 'lax',
        path: '/'
      });
    }

    return res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).render('login', { error: 'System error during login.', message: '' });
  }
});

router.get('/register', redirectIfAuthed, (req, res) => {
  res.render('register', { error: '' });
});

router.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).render('register', { error: 'Username and password required.' });
  }

  try {
    const [exists] = await pool.query('SELECT user_id FROM user WHERE user_name = ? LIMIT 1', [username]);
    if (exists.length > 0) {
      return res.status(409).render('register', { error: 'username is already registered' });
    }

    const hashed = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO user (user_name, password) VALUES (?, ?)', [username, hashed]);
    return res.redirect('/?pesan=' + encodeURIComponent('Registration Success'));
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).render('register', { error: 'Registration Failed' });
  }
});

router.get('/logout', async (req, res) => {
  const cookieValue = req.cookies && req.cookies.remember_me;
  if (cookieValue && cookieValue.includes(':')) {
    const [selector] = cookieValue.split(':');
    try {
      await pool.query('DELETE FROM user_tokens WHERE selector = ?', [selector]);
    } catch (err) { console.error('Logout token delete error:', err); }
  }
  res.clearCookie('remember_me', { path: '/' });
  req.session.destroy(() => {
    res.clearCookie('unimq.sid');
    res.redirect('/');
  });
});

module.exports = router;

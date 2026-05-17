const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session');

const { pool, dbConfig } = require('./config/db');
const { tryRememberMeLogin } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const profileRoutes = require('./routes/profile');
const actionsRoutes = require('./routes/actions');
const iotRoutes = require('./routes/iot');
const adminRoutes = require('./routes/admin');

const app = express();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Trust proxy for X-Forwarded-Proto when behind a reverse proxy
app.set('trust proxy', 1);

// Static
app.use(express.static(path.join(__dirname, '..', 'public')));

// Parsers
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// Session store backed by MariaDB
const MySQLStore = MySQLStoreFactory(session);
const sessionStore = new MySQLStore({
  ...dbConfig,
  createDatabaseTable: true,
  schema: {
    tableName: 'web_sessions',
    columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' }
  }
});

const isProduction = process.env.NODE_ENV === 'production';
app.use(session({
  name: 'unimq.sid',
  secret: process.env.SESSION_SECRET || 'unimq-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30 // 30 days
  }
}));

// Auto-login via remember_me cookie if there's no session
app.use(tryRememberMeLogin);

// Expose helpers to all views
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.toast = req.session.toast || null;
  if (req.session.toast) delete req.session.toast;
  next();
});

// Routes
app.use('/', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/profile', profileRoutes);
app.use('/actions', actionsRoutes);
app.use('/iot', iotRoutes);
app.use('/admin', adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).send('Internal Server Error');
});

module.exports = app;

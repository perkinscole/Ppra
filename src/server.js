const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const db = require('./db');
const ppra = require('./ppra');
const { csrf } = require('./security');

function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const database = db.open(options.dbFile || path.join(dataDir, 'ppra.db'));
  const uploadDir = path.join(dataDir, 'uploads');
  const secret = options.secret || process.env.SESSION_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set in production');
  }

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1);
  app.locals.db = database;
  app.locals.uploadDir = uploadDir;
  app.locals.ppra = ppra;
  app.locals.baseUrl = options.baseUrl || process.env.BASE_URL || '';

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));
  app.use(cookieSession({
    name: 'ppra_sess',
    secret: secret || crypto.randomBytes(32).toString('hex'),
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000,
  }));
  app.use((req, res, next) => {
    res.locals.title = '';
    res.locals.user = null;
    res.locals.school = null;
    res.locals.flash = req.session.flash || null;
    req.session.flash = null;
    req.flash = (type, text) => { req.session.flash = { type, text }; };
    if (req.session.userId) {
      const user = database.prepare('SELECT id, school_id, email, name, role FROM users WHERE id = ?').get(req.session.userId);
      if (user) {
        req.user = user;
        req.school = database.prepare('SELECT * FROM schools WHERE id = ?').get(user.school_id);
        res.locals.user = user;
        res.locals.school = req.school;
      }
    }
    // Absolute links for parent emails, honoring BASE_URL when behind a proxy.
    res.locals.absUrl = (p) => (app.locals.baseUrl || `${req.protocol}://${req.get('host')}`) + p;
    next();
  });
  app.use(csrf);

  app.use('/', require('./routes/auth'));
  app.use('/s', require('./routes/parent'));
  app.use('/app', require('./routes/staff'));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).render('error', { title: 'Something went wrong', message: err.expose ? err.message : 'An unexpected error occurred.' });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`PPRA Consent Manager listening on http://localhost:${port}`));
}

module.exports = { createApp };

const express = require('express');
const { hashPassword, verifyPassword } = require('../security');
const { tx, audit } = require('../db');

const router = express.Router();

// Parent portal paths that share the /s/ prefix with school slugs.
const RESERVED_SLUGS = new Set(['consent', 'inspect']);

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'school';
}

router.get('/', (req, res) => {
  if (req.user) return res.redirect('/app');
  res.render('home', { title: 'PPRA Consent Manager' });
});

router.get('/signup', (req, res) => res.render('signup', { title: 'Create your school account', values: {}, error: null }));

router.post('/signup', (req, res) => {
  const db = req.app.locals.db;
  const { school_name, contact_email, name, email, password } = req.body;
  const values = { school_name, contact_email, name, email };
  if (!school_name || !name || !email || !password) {
    return res.status(400).render('signup', { title: 'Create your school account', values, error: 'All fields are required.' });
  }
  if (password.length < 10) {
    return res.status(400).render('signup', { title: 'Create your school account', values, error: 'Use a password of at least 10 characters.' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(normalizedEmail)) {
    return res.status(400).render('signup', { title: 'Create your school account', values, error: 'An account with that email already exists.' });
  }

  const base = slugify(school_name);
  let slug = base;
  const taken = (sl) => RESERVED_SLUGS.has(sl) || db.prepare('SELECT 1 FROM schools WHERE slug = ?').get(sl);
  for (let i = 2; taken(slug); i++) slug = `${base}-${i}`;

  const userId = tx(db, () => {
    const school = db.prepare('INSERT INTO schools (name, slug, contact_email) VALUES (?, ?, ?)')
      .run(school_name.trim(), slug, (contact_email || normalizedEmail).trim());
    const user = db.prepare('INSERT INTO users (school_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(school.lastInsertRowid, normalizedEmail, name.trim(), 'admin', hashPassword(password));
    audit(db, { schoolId: school.lastInsertRowid, actor: normalizedEmail, action: 'created school', entity: 'school', entityId: Number(school.lastInsertRowid) });
    return Number(user.lastInsertRowid);
  });

  req.session.userId = userId;
  req.flash('ok', 'Welcome! Start by adding the surveys your school gives students.');
  res.redirect('/app');
});

router.get('/login', (req, res) => res.render('login', { title: 'Sign in', error: null, email: '' }));

router.post('/login', (req, res) => {
  const db = req.app.locals.db;
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).render('login', { title: 'Sign in', error: 'Incorrect email or password.', email });
  }
  req.session.userId = user.id;
  res.redirect('/app');
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

module.exports = router;

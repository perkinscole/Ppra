const crypto = require('node:crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Unguessable token for parent-facing links (consent forms, inspection access).
function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// Session-bound CSRF token, checked on every state-changing request.
// Multipart bodies aren't parsed yet at this point, so routes that accept
// uploads run verifyCsrf themselves after multer.
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = newToken();
  res.locals.csrf = req.session.csrf;
  if (req.method === 'POST' && !req.is('multipart/form-data')) return verifyCsrf(req, res, next);
  next();
}

function verifyCsrf(req, res, next) {
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  const a = Buffer.from(String(sent));
  const b = Buffer.from(req.session.csrf || '');
  if (!b.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).render('error', { title: 'Form expired', message: 'Your form expired. Go back, refresh the page, and try again.' });
  }
  next();
}

module.exports = { hashPassword, verifyPassword, newToken, csrf, verifyCsrf };

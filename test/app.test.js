const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');

// Minimal browser: keeps cookies and pulls the CSRF token out of each page.
function client(base) {
  let cookie = '';
  let csrf = '';
  async function request(method, url, form) {
    let body;
    if (form instanceof FormData) {
      if (!form.has('_csrf')) form.set('_csrf', csrf);
      body = form;
    } else if (form) {
      body = new URLSearchParams({ _csrf: csrf, ...form });
    }
    const res = await fetch(base + url, { method, redirect: 'manual', headers: { cookie }, body });
    const set = res.headers.getSetCookie();
    if (set.length) {
      const jar = Object.fromEntries(cookie.split('; ').filter(Boolean).map((c) => c.split(/=(.*)/s)));
      for (const c of set) { const [k, v] = c.split(';')[0].split(/=(.*)/s); jar[k] = v; }
      cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const text = await res.text();
    const m = text.match(/name="_csrf" value="([^"]+)"/);
    if (m) csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), body: text };
  }
  return { get: (u) => request('GET', u), post: (u, f = {}) => request('POST', u, f) };
}

test('end-to-end: survey review, opt-in consent, and parent inspection', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppra-test-'));
  const app = createApp({ dataDir, secret: 'test-secret' });
  const server = app.listen(0);
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const staff = client(base);
  const db = app.locals.db;

  await staff.get('/signup');
  let r = await staff.post('/signup', { school_name: 'Test Middle', name: 'Pat Admin', email: 'pat@test.org', password: 'long-enough-pw' });
  assert.equal(r.location, '/app');

  // Forged POST without the session's CSRF token is rejected.
  const outsider = client(base);
  r = await outsider.post('/login', { email: 'pat@test.org', password: 'long-enough-pw', _csrf: 'forged' });
  assert.equal(r.status, 403);

  await staff.get('/app/roster');
  r = await staff.post('/app/roster/import', {
    csv_text: 'student_id,first_name,last_name,grade,guardian_name,guardian_email\n1,Ann,Lee,7,Kim Lee,kim@x.org\n2,Bo,Park,7,Jo Park,jo@x.org\n3,Cy,Diaz,5,Al Diaz,al@x.org\n',
  });
  assert.match(r.body, /Imported 3 students/);

  // Third-party survey on religion: opt-out by law, opt-in by default policy.
  await staff.get('/app/surveys/new');
  const form = new FormData();
  form.set('title', 'Values Study');
  form.set('grades', '6-8');
  form.set('funding_source', 'third_party');
  form.set('protected_areas', 'religion');
  form.set('instrument_text', 'How often do you pray?');
  r = await staff.post('/app/surveys', form);
  assert.equal(r.status, 302);
  const surveyId = Number(r.location.split('/').pop());

  r = await staff.get(`/app/surveys/${surveyId}`);
  assert.match(r.body, /Prior written consent \(opt-in\)/);
  assert.match(r.body, /exceeds the legal minimum/);

  // Can't generate consent before approval.
  r = await staff.post(`/app/surveys/${surveyId}/consents`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM consents').get().n, 0);

  await staff.get(`/app/surveys/${surveyId}`);
  await staff.post(`/app/surveys/${surveyId}/submit`);
  await staff.get(`/app/surveys/${surveyId}`);
  await staff.post(`/app/surveys/${surveyId}/review`, { decision: 'approved' });
  assert.equal(db.prepare('SELECT status FROM surveys WHERE id = ?').get(surveyId).status, 'approved');

  // Approved surveys are locked.
  r = await staff.get(`/app/surveys/${surveyId}/edit`);
  assert.equal(r.location, `/app/surveys/${surveyId}`);

  await staff.get(`/app/surveys/${surveyId}`);
  await staff.post(`/app/surveys/${surveyId}/consents`);
  const consents = db.prepare('SELECT * FROM consents WHERE survey_id = ? ORDER BY student_id').all(surveyId);
  assert.equal(consents.length, 2, 'only grade 6-8 students get forms');

  // Parent grants consent through their link.
  const parent = client(base);
  r = await parent.get(`/s/consent/${consents[0].token}`);
  assert.match(r.body, /How often do you pray\?/);
  r = await parent.post(`/s/consent/${consents[0].token}`, { decision: 'granted', signer_name: 'Kim Lee', relationship: 'Parent' });
  assert.equal(r.status, 400, 'must confirm they reviewed the survey');
  r = await parent.post(`/s/consent/${consents[0].token}`, { decision: 'granted', signer_name: 'Kim Lee', relationship: 'Parent', reviewed: 'on' });
  assert.equal(r.status, 302);

  r = await staff.get(`/app/surveys/${surveyId}/roster`);
  assert.match(r.body, /Lee, Ann<\/td><td>7<\/td><td><strong>YES/);
  assert.match(r.body, /Park, Bo<\/td><td>7<\/td><td><strong>NO/, 'no response means no participation');

  r = await staff.get(`/app/surveys/${surveyId}/consents.csv`);
  assert.match(r.body, /kim@x\.org,parent\/guardian,http:\/\/127\.0\.0\.1:\d+\/s\/consent\//);

  // Public catalog -> inspection request -> staff grants -> parent reads.
  const slug = db.prepare('SELECT slug FROM schools').get().slug;
  r = await parent.get(`/s/${slug}`);
  assert.match(r.body, /Values Study/);
  r = await parent.get(`/s/${slug}/request/${surveyId}`);
  r = await parent.post(`/s/${slug}/request/${surveyId}`, { requester_name: 'Jo Park', requester_email: 'jo@x.org', student_name: 'Bo Park' });
  assert.match(r.body, /Request received/);
  const reqId = db.prepare('SELECT id FROM inspection_requests').get().id;
  await staff.get('/app/requests');
  await staff.post(`/app/requests/${reqId}`, { decision: 'fulfill', resolution_notes: 'verified' });
  const accessToken = db.prepare('SELECT access_token FROM inspection_requests WHERE id = ?').get(reqId).access_token;
  r = await parent.get(`/s/inspect/${accessToken}`);
  assert.equal(r.status, 200);
  assert.match(r.body, /How often do you pray\?/);
  r = await parent.get('/s/inspect/not-a-real-token');
  assert.equal(r.status, 404);

  // Another school's staff cannot see this school's survey.
  const other = client(base);
  await other.get('/signup');
  await other.post('/signup', { school_name: 'Other School', name: 'Eve', email: 'eve@other.org', password: 'long-enough-pw' });
  r = await other.get(`/app/surveys/${surveyId}`);
  assert.equal(r.status, 404);

  const actions = db.prepare('SELECT action FROM audit_log').all().map((a) => a.action);
  assert.ok(actions.includes('approved survey'));
  assert.ok(actions.includes('parent granted consent'));
  assert.ok(actions.includes('granted survey inspection'));
});

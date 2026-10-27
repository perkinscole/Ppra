const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const ppra = require('../ppra');
const { tx, audit, parseSurvey } = require('../db');
const { newToken, verifyCsrf, hashPassword } = require('../security');
const { parseCsvObjects, toCsv, gradeMatches, truthy } = require('../util');

const router = express.Router();

const INSTRUMENT_FILES = /\.(pdf|docx?|txt|rtf|odt|png|jpe?g)$/i;
const CSV_FILES = /\.(csv|txt)$/i;

function upload(field, allowed) {
  return (req, res, next) => {
    const dest = path.join(req.app.locals.uploadDir, String(req.user.school_id));
    fs.mkdirSync(dest, { recursive: true });
    multer({
      dest,
      limits: { fileSize: 15 * 1024 * 1024, files: 1 },
      fileFilter: (r, file, cb) => cb(null, allowed.test(file.originalname)),
    }).single(field)(req, res, (err) => {
      if (err) {
        err.status = 400;
        err.expose = true;
        return next(err);
      }
      next();
    });
  };
}

router.use((req, res, next) => {
  if (!req.user) return res.redirect('/login');
  next();
});

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).render('error', { title: 'Not allowed', message: 'Your role does not allow this action.' });
    }
    next();
  };
}

function actor(req) {
  return req.user.email;
}

function loadSurvey(req, res, next) {
  const row = req.app.locals.db
    .prepare('SELECT * FROM surveys WHERE id = ? AND school_id = ?')
    .get(Number(req.params.id), req.user.school_id);
  if (!row) return res.status(404).render('error', { title: 'Not found', message: 'Survey not found.' });
  req.survey = parseSurvey(row);
  req.classification = ppra.classify(req.survey, { opt_in_all_protected: Boolean(req.school.opt_in_all_protected) });
  next();
}

function consentCounts(db, surveyId) {
  const counts = { total: 0, pending: 0, granted: 0, declined: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM consents WHERE survey_id = ? GROUP BY status').all(surveyId)) {
    counts[r.status] = r.n;
    counts.total += r.n;
  }
  return counts;
}

// ---------- Dashboard ----------

router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const policy = { opt_in_all_protected: Boolean(req.school.opt_in_all_protected) };
  const surveys = db.prepare("SELECT * FROM surveys WHERE school_id = ? AND status != 'retired' ORDER BY updated_at DESC")
    .all(req.user.school_id).map(parseSurvey);
  const byStatus = { draft: 0, in_review: 0, approved: 0, rejected: 0 };
  let protectedCount = 0;
  const campaigns = [];
  for (const s of surveys) {
    byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    const c = ppra.classify(s, policy);
    if (c.touchesProtected) protectedCount++;
    if (s.status === 'approved' && c.required !== 'none') {
      campaigns.push({ survey: s, classification: c, counts: consentCounts(db, s.id) });
    }
  }
  const openRequests = db.prepare(`
    SELECT r.*, s.title AS survey_title FROM inspection_requests r JOIN surveys s ON s.id = r.survey_id
    WHERE r.school_id = ? AND r.status = 'open' ORDER BY r.created_at`).all(req.user.school_id);
  const studentCount = db.prepare('SELECT COUNT(*) AS n FROM students WHERE school_id = ?').get(req.user.school_id).n;
  res.render('staff/dashboard', {
    title: 'Dashboard', byStatus, total: surveys.length, protectedCount, campaigns, openRequests, studentCount,
  });
});

// ---------- Surveys ----------

router.get('/surveys', (req, res) => {
  const db = req.app.locals.db;
  const policy = { opt_in_all_protected: Boolean(req.school.opt_in_all_protected) };
  const status = req.query.status || '';
  const rows = status
    ? db.prepare('SELECT * FROM surveys WHERE school_id = ? AND status = ? ORDER BY title').all(req.user.school_id, status)
    : db.prepare("SELECT * FROM surveys WHERE school_id = ? AND status != 'retired' ORDER BY title").all(req.user.school_id);
  const surveys = rows.map(parseSurvey).map((s) => ({ ...s, classification: ppra.classify(s, policy) }));
  res.render('staff/surveys', { title: 'Survey registry', surveys, status });
});

function surveyFromBody(body) {
  const areas = [].concat(body.protected_areas || []).filter((k) => ppra.AREA_BY_KEY[k]);
  return {
    title: String(body.title || '').trim(),
    description: String(body.description || '').trim(),
    administered_by: String(body.administered_by || '').trim(),
    grades: String(body.grades || '').trim(),
    funding_source: ppra.FUNDING_SOURCES[body.funding_source] ? body.funding_source : 'state_local',
    requires_student_response: body.requires_student_response === 'no' ? 0 : 1,
    protected_areas: JSON.stringify(areas),
    instrument_text: String(body.instrument_text || ''),
    start_date: body.start_date || null,
    end_date: body.end_date || null,
  };
}

function renderForm(res, survey, error, status = 200) {
  res.status(status).render('staff/survey_form', {
    title: survey.id ? `Edit: ${survey.title}` : 'Add a survey',
    survey,
    error,
    suggestions: ppra.scanInstrument(survey.instrument_text),
  });
}

router.get('/surveys/new', (req, res) => {
  renderForm(res, { protected_areas: [], funding_source: 'state_local', requires_student_response: true }, null);
});

router.post('/surveys', upload('instrument_file', INSTRUMENT_FILES), verifyCsrf, (req, res) => {
  const db = req.app.locals.db;
  const data = surveyFromBody(req.body);
  if (!data.title) return renderForm(res, { ...data, protected_areas: JSON.parse(data.protected_areas) }, 'Title is required.', 400);
  const result = db.prepare(`
    INSERT INTO surveys (school_id, title, description, administered_by, grades, funding_source, requires_student_response,
      protected_areas, instrument_text, start_date, end_date, file_name, file_path, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.user.school_id, data.title, data.description, data.administered_by, data.grades, data.funding_source,
    data.requires_student_response, data.protected_areas, data.instrument_text, data.start_date, data.end_date,
    req.file ? req.file.originalname : null, req.file ? req.file.path : null, req.user.id,
  );
  const id = Number(result.lastInsertRowid);
  audit(db, { schoolId: req.user.school_id, actor: actor(req), action: 'added survey', entity: 'survey', entityId: id, detail: data.title });
  req.flash('ok', 'Survey added as a draft. Review the PPRA classification, then submit it for review.');
  res.redirect(`/app/surveys/${id}`);
});

router.get('/surveys/:id', loadSurvey, (req, res) => {
  const db = req.app.locals.db;
  const s = req.survey;
  const reviewer = s.reviewed_by ? db.prepare('SELECT name FROM users WHERE id = ?').get(s.reviewed_by) : null;
  const requests = db.prepare('SELECT * FROM inspection_requests WHERE survey_id = ? ORDER BY created_at DESC').all(s.id);
  const history = db.prepare("SELECT * FROM audit_log WHERE school_id = ? AND entity = 'survey' AND entity_id = ? ORDER BY id DESC LIMIT 20")
    .all(req.user.school_id, s.id);
  res.render('staff/survey_detail', {
    title: s.title,
    survey: s,
    c: req.classification,
    suggestions: ppra.scanInstrument(s.instrument_text),
    counts: consentCounts(db, s.id),
    reviewer,
    requests,
    history,
  });
});

const EDITABLE = new Set(['draft', 'rejected']);

router.get('/surveys/:id/edit', loadSurvey, (req, res) => {
  if (!EDITABLE.has(req.survey.status)) {
    req.flash('warn', 'Only drafts and rejected surveys can be edited. Approved instruments are locked so consent always matches what parents saw.');
    return res.redirect(`/app/surveys/${req.survey.id}`);
  }
  renderForm(res, req.survey, null);
});

router.post('/surveys/:id', loadSurvey, upload('instrument_file', INSTRUMENT_FILES), verifyCsrf, (req, res) => {
  const db = req.app.locals.db;
  if (!EDITABLE.has(req.survey.status)) return res.redirect(`/app/surveys/${req.survey.id}`);
  const data = surveyFromBody(req.body);
  if (!data.title) return renderForm(res, { ...req.survey, ...data, protected_areas: JSON.parse(data.protected_areas) }, 'Title is required.', 400);
  const fileName = req.file ? req.file.originalname : req.survey.file_name;
  const filePath = req.file ? req.file.path : req.survey.file_path;
  db.prepare(`
    UPDATE surveys SET title = ?, description = ?, administered_by = ?, grades = ?, funding_source = ?,
      requires_student_response = ?, protected_areas = ?, instrument_text = ?, start_date = ?, end_date = ?,
      file_name = ?, file_path = ?, status = 'draft', updated_at = datetime('now')
    WHERE id = ? AND school_id = ?`).run(
    data.title, data.description, data.administered_by, data.grades, data.funding_source, data.requires_student_response,
    data.protected_areas, data.instrument_text, data.start_date, data.end_date, fileName, filePath,
    req.survey.id, req.user.school_id,
  );
  audit(db, { schoolId: req.user.school_id, actor: actor(req), action: 'edited survey', entity: 'survey', entityId: req.survey.id });
  req.flash('ok', 'Survey saved.');
  res.redirect(`/app/surveys/${req.survey.id}`);
});

router.get('/surveys/:id/file', loadSurvey, (req, res) => {
  if (!req.survey.file_path) return res.status(404).render('error', { title: 'Not found', message: 'No file attached.' });
  res.download(req.survey.file_path, req.survey.file_name);
});

router.post('/surveys/:id/submit', loadSurvey, (req, res) => {
  const db = req.app.locals.db;
  if (!EDITABLE.has(req.survey.status)) return res.redirect(`/app/surveys/${req.survey.id}`);
  db.prepare("UPDATE surveys SET status = 'in_review', updated_at = datetime('now') WHERE id = ?").run(req.survey.id);
  audit(db, { schoolId: req.user.school_id, actor: actor(req), action: 'submitted for review', entity: 'survey', entityId: req.survey.id });
  req.flash('ok', 'Submitted for PPRA review.');
  res.redirect(`/app/surveys/${req.survey.id}`);
});

router.post('/surveys/:id/review', requireRole('admin', 'reviewer'), loadSurvey, (req, res) => {
  const db = req.app.locals.db;
  const decision = req.body.decision;
  const notes = String(req.body.review_notes || '').trim();
  if (req.survey.status !== 'in_review' || !['approved', 'rejected'].includes(decision)) {
    return res.redirect(`/app/surveys/${req.survey.id}`);
  }
  if (decision === 'rejected' && !notes) {
    req.flash('warn', 'Add a note explaining what needs to change before rejecting.');
    return res.redirect(`/app/surveys/${req.survey.id}`);
  }
  db.prepare(`UPDATE surveys SET status = ?, review_notes = ?, reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?`).run(decision, notes, req.user.id, req.survey.id);
  audit(db, { schoolId: req.user.school_id, actor: actor(req), action: decision === 'approved' ? 'approved survey' : 'rejected survey', entity: 'survey', entityId: req.survey.id, detail: notes });
  req.flash('ok', decision === 'approved' ? 'Survey approved.' : 'Survey returned to its owner with your notes.');
  res.redirect(`/app/surveys/${req.survey.id}`);
});

router.post('/surveys/:id/retire', requireRole('admin', 'reviewer'), loadSurvey, (req, res) => {
  const db = req.app.locals.db;
  db.prepare("UPDATE surveys SET status = 'retired', updated_at = datetime('now') WHERE id = ?").run(req.survey.id);
  audit(db, { schoolId: req.user.school_id, actor: actor(req), action: 'retired survey', entity: 'survey', entityId: req.survey.id });
  req.flash('ok', 'Survey retired. Its consent records are kept for your records.');
  res.redirect('/app/surveys');
});

// ---------- Consent campaigns ----------

router.post('/surveys/:id/consents', loadSurvey, (req, res) => {
  const db = req.app.locals.db;
  const s = req.survey;
  if (s.status !== 'approved' || req.classification.required === 'none') {
    req.flash('warn', 'Consent forms can only be generated for approved surveys that require parental consent or notice.');
    return res.redirect(`/app/surveys/${s.id}`);
  }
  const students = db.prepare('SELECT id, grade FROM students WHERE school_id = ?').all(req.user.school_id)
    .filter((st) => gradeMatches(s.grades, st.grade));
  const insert = db.prepare('INSERT OR IGNORE INTO consents (survey_id, student_id, token) VALUES (?, ?, ?)');
  const added = tx(db, () => students.reduce((n, st) => n + Number(insert.run(s.id, st.id, newToken()).changes), 0));
  audit(db, { schoolId: req.user.school_id, actor: actor(req), action: 'generated consent forms', entity: 'survey', entityId: s.id, detail: `${added} new` });
  req.flash('ok', added ? `Created ${added} consent form${added === 1 ? '' : 's'}. Export the links to send them to families.` : 'Every matching student already has a consent form.');
  res.redirect(`/app/surveys/${s.id}/consents`);
});

function consentRows(db, surveyId) {
  return db.prepare(`
    SELECT c.*, st.first_name, st.last_name, st.grade, st.local_id, st.is_eligible, st.email AS student_email,
      (SELECT group_concat(g.name || ' <' || g.email || '>', '; ') FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
        WHERE sg.student_id = st.id) AS guardians
    FROM consents c JOIN students st ON st.id = c.student_id
    WHERE c.survey_id = ? ORDER BY st.last_name, st.first_name`).all(surveyId);
}

router.get('/surveys/:id/consents', loadSurvey, (req, res) => {
  const db = req.app.locals.db;
  const filter = req.query.filter || '';
  let rows = consentRows(db, req.survey.id);
  if (filter === 'participating') rows = rows.filter((r) => ppra.mayParticipate(req.classification.required, r.status));
  else if (filter === 'excluded') rows = rows.filter((r) => !ppra.mayParticipate(req.classification.required, r.status));
  else if (filter) rows = rows.filter((r) => r.status === filter);
  res.render('staff/consents', {
    title: `Consent: ${req.survey.title}`, survey: req.survey, c: req.classification, rows, filter, counts: consentCounts(db, req.survey.id),
  });
});

// One row per recipient so the file drops straight into a mail merge.
router.get('/surveys/:id/consents.csv', loadSurvey, (req, res) => {
  const db = req.app.locals.db;
  const out = [['student_id', 'student_name', 'grade', 'recipient_name', 'recipient_email', 'recipient_role', 'consent_link', 'status']];
  const guardiansFor = db.prepare('SELECT g.name, g.email FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ?');
  for (const r of consentRows(db, req.survey.id)) {
    const link = res.locals.absUrl(`/s/consent/${r.token}`);
    const student = `${r.first_name} ${r.last_name}`;
    if (r.is_eligible) {
      out.push([r.local_id, student, r.grade, student, r.student_email || '', 'eligible student (18+)', link, r.status]);
    } else {
      const gs = guardiansFor.all(r.student_id);
      if (!gs.length) out.push([r.local_id, student, r.grade, '', '', 'NO GUARDIAN ON FILE', link, r.status]);
      for (const g of gs) out.push([r.local_id, student, r.grade, g.name, g.email, 'parent/guardian', link, r.status]);
    }
  }
  res.type('text/csv').attachment(`consent-links-survey-${req.survey.id}.csv`).send(toCsv(out));
});

// Printable list for the teacher administering the survey.
router.get('/surveys/:id/roster', loadSurvey, (req, res) => {
  const db = req.app.locals.db;
  const rows = consentRows(db, req.survey.id).map((r) => ({ ...r, allowed: ppra.mayParticipate(req.classification.required, r.status) }));
  res.render('staff/roster_print', { title: `Participation roster: ${req.survey.title}`, survey: req.survey, c: req.classification, rows });
});

// Record a paper form returned to the office.
router.post('/consents/:cid/record', (req, res) => {
  const db = req.app.locals.db;
  const row = db.prepare(`SELECT c.*, s.school_id FROM consents c JOIN surveys s ON s.id = c.survey_id WHERE c.id = ?`).get(Number(req.params.cid));
  if (!row || row.school_id !== req.user.school_id) return res.status(404).render('error', { title: 'Not found', message: 'Consent record not found.' });
  const status = req.body.status;
  const signer = String(req.body.signer_name || '').trim();
  if (!['granted', 'declined', 'pending'].includes(status) || (status !== 'pending' && !signer)) {
    req.flash('warn', 'Enter the name of the parent who signed the paper form.');
    return res.redirect(`/app/surveys/${row.survey_id}/consents`);
  }
  db.prepare(`UPDATE consents SET status = ?, signer_name = ?, signer_relationship = ?, signer_ip = NULL,
    responded_at = CASE WHEN ? = 'pending' THEN NULL ELSE datetime('now') END WHERE id = ?`)
    .run(status, status === 'pending' ? null : signer, status === 'pending' ? null : `paper form, entered by ${req.user.name}`, status, row.id);
  audit(db, { schoolId: req.user.school_id, actor: actor(req), action: `recorded paper consent: ${status}`, entity: 'survey', entityId: row.survey_id, detail: `consent #${row.id} ${signer}` });
  req.flash('ok', 'Paper form recorded.');
  res.redirect(`/app/surveys/${row.survey_id}/consents`);
});

// ---------- Roster ----------

function renderRoster(req, res, result) {
  const db = req.app.locals.db;
  const students = db.prepare(`
    SELECT st.*, (SELECT group_concat(g.name || ' <' || g.email || '>', '; ') FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
      WHERE sg.student_id = st.id) AS guardians
    FROM students st WHERE st.school_id = ? ORDER BY st.grade, st.last_name, st.first_name LIMIT 2000`).all(req.user.school_id);
  const total = db.prepare('SELECT COUNT(*) AS n FROM students WHERE school_id = ?').get(req.user.school_id).n;
  res.render('staff/roster', { title: 'Students & families', students, total, result });
}

router.get('/roster', (req, res) => {
  renderRoster(req, res, null);
});

router.post('/roster/import', requireRole('admin'), upload('roster_file', CSV_FILES), verifyCsrf, (req, res) => {
  const db = req.app.locals.db;
  let text = String(req.body.csv_text || '');
  if (req.file) {
    text = fs.readFileSync(req.file.path, 'utf8');
    fs.rmSync(req.file.path, { force: true });
  }
  const records = parseCsvObjects(text);
  const result = { students: 0, guardians: 0, skipped: [] };
  const schoolId = req.user.school_id;
  tx(db, () => {
    const upsertStudent = db.prepare(`
      INSERT INTO students (school_id, local_id, first_name, last_name, grade, is_eligible, email) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (school_id, local_id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name,
        grade = excluded.grade, is_eligible = excluded.is_eligible, email = excluded.email
      RETURNING id`);
    const upsertGuardian = db.prepare(`
      INSERT INTO guardians (school_id, name, email) VALUES (?, ?, ?)
      ON CONFLICT (school_id, email) DO UPDATE SET name = excluded.name RETURNING id`);
    const link = db.prepare('INSERT OR IGNORE INTO student_guardians (student_id, guardian_id) VALUES (?, ?)');
    records.forEach((r, i) => {
      const localId = r.student_id || r.local_id || r.id;
      if (!localId || !r.first_name || !r.last_name) {
        result.skipped.push(`Row ${i + 2}: needs student_id, first_name and last_name`);
        return;
      }
      const st = upsertStudent.get(schoolId, localId, r.first_name, r.last_name, r.grade || '', truthy(r.eligible) ? 1 : 0, r.student_email || null);
      result.students++;
      // Allow guardian_email, guardian2_email, ... columns.
      for (const prefix of ['guardian', 'guardian1', 'guardian2', 'guardian3']) {
        const email = (r[`${prefix}_email`] || '').toLowerCase();
        if (!email) continue;
        const g = upsertGuardian.get(schoolId, r[`${prefix}_name`] || email, email);
        link.run(st.id, g.id);
        result.guardians++;
      }
    });
  });
  audit(db, { schoolId, actor: actor(req), action: 'imported roster', entity: 'roster', detail: `${result.students} students, ${result.guardians} guardian links` });
  renderRoster(req, res, result);
});

// ---------- Parent inspection requests ----------

router.get('/requests', (req, res) => {
  const db = req.app.locals.db;
  const requests = db.prepare(`
    SELECT r.*, s.title AS survey_title FROM inspection_requests r JOIN surveys s ON s.id = r.survey_id
    WHERE r.school_id = ? ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC`).all(req.user.school_id);
  res.render('staff/requests', { title: 'Parent inspection requests', requests });
});

router.post('/requests/:rid', (req, res) => {
  const db = req.app.locals.db;
  const r = db.prepare('SELECT * FROM inspection_requests WHERE id = ? AND school_id = ?').get(Number(req.params.rid), req.user.school_id);
  if (!r || r.status !== 'open') return res.redirect('/app/requests');
  const notes = String(req.body.resolution_notes || '').trim();
  if (req.body.decision === 'fulfill') {
    const token = newToken();
    db.prepare(`UPDATE inspection_requests SET status = 'fulfilled', access_token = ?, resolution_notes = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`)
      .run(token, notes, req.user.id, r.id);
    audit(db, { schoolId: req.user.school_id, actor: actor(req), action: 'granted survey inspection', entity: 'survey', entityId: r.survey_id, detail: r.requester_email });
    req.flash('ok', `Access granted. Send this link to ${r.requester_email}: ${res.locals.absUrl(`/s/inspect/${token}`)}`);
  } else if (req.body.decision === 'decline') {
    if (!notes) {
      req.flash('warn', 'Add a note explaining why the request was declined (for example, the requester is not a parent of an enrolled student).');
      return res.redirect('/app/requests');
    }
    db.prepare(`UPDATE inspection_requests SET status = 'declined', resolution_notes = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?`)
      .run(notes, req.user.id, r.id);
    audit(db, { schoolId: req.user.school_id, actor: actor(req), action: 'declined survey inspection', entity: 'survey', entityId: r.survey_id, detail: `${r.requester_email}: ${notes}` });
    req.flash('ok', 'Request declined.');
  }
  res.redirect('/app/requests');
});

// ---------- Annual notice ----------

router.get('/notice', (req, res) => {
  const db = req.app.locals.db;
  const policy = { opt_in_all_protected: Boolean(req.school.opt_in_all_protected) };
  const surveys = db.prepare("SELECT * FROM surveys WHERE school_id = ? AND status = 'approved' ORDER BY start_date, title")
    .all(req.user.school_id).map(parseSurvey).map((s) => ({ ...s, classification: ppra.classify(s, policy) }))
    .filter((s) => s.classification.touchesProtected);
  res.render('staff/notice', { title: 'Annual PPRA notice', surveys, year: new Date().getFullYear() });
});

// ---------- Settings & users ----------

router.get('/settings', requireRole('admin'), (req, res) => {
  const users = req.app.locals.db.prepare('SELECT id, name, email, role FROM users WHERE school_id = ? ORDER BY name').all(req.user.school_id);
  res.render('staff/settings', { title: 'Settings', users });
});

router.post('/settings', requireRole('admin'), (req, res) => {
  const db = req.app.locals.db;
  const name = String(req.body.name || '').trim() || req.school.name;
  const optIn = req.body.opt_in_all_protected === 'on' ? 1 : 0;
  db.prepare('UPDATE schools SET name = ?, contact_email = ?, opt_in_all_protected = ? WHERE id = ?')
    .run(name, String(req.body.contact_email || '').trim(), optIn, req.user.school_id);
  audit(db, { schoolId: req.user.school_id, actor: actor(req), action: 'updated settings', entity: 'school', entityId: req.user.school_id, detail: `opt-in for all protected surveys: ${optIn ? 'on' : 'off'}` });
  req.flash('ok', 'Settings saved.');
  res.redirect('/app/settings');
});

router.post('/users', requireRole('admin'), (req, res) => {
  const db = req.app.locals.db;
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = ['admin', 'reviewer', 'staff'].includes(req.body.role) ? req.body.role : 'staff';
  const password = String(req.body.password || '');
  if (!email || !req.body.name || password.length < 10) {
    req.flash('warn', 'Name, email, and a temporary password of at least 10 characters are required.');
    return res.redirect('/app/settings');
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    req.flash('warn', 'A user with that email already exists.');
    return res.redirect('/app/settings');
  }
  db.prepare('INSERT INTO users (school_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.school_id, email, String(req.body.name).trim(), role, hashPassword(password));
  audit(db, { schoolId: req.user.school_id, actor: actor(req), action: 'added user', entity: 'user', detail: `${email} (${role})` });
  req.flash('ok', `Added ${email}. Share the temporary password with them securely.`);
  res.redirect('/app/settings');
});

router.get('/audit', requireRole('admin', 'reviewer'), (req, res) => {
  const entries = req.app.locals.db.prepare('SELECT * FROM audit_log WHERE school_id = ? ORDER BY id DESC LIMIT 500').all(req.user.school_id);
  res.render('staff/audit', { title: 'Audit log', entries });
});

module.exports = router;

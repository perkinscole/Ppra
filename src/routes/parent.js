const express = require('express');
const ppra = require('../ppra');
const { audit, parseSurvey } = require('../db');

const router = express.Router();

const INSPECTION_LINK_DAYS = 30;

function notFound(res, message = 'This link is not valid. Contact your school office for a new one.') {
  return res.status(404).render('error', { title: 'Link not found', message });
}

function loadConsent(req, res, next) {
  const db = req.app.locals.db;
  const consent = db.prepare(`
    SELECT c.*, st.first_name, st.last_name, st.grade, st.is_eligible
    FROM consents c JOIN students st ON st.id = c.student_id WHERE c.token = ?`).get(String(req.params.token));
  if (!consent) return notFound(res);
  const survey = parseSurvey(db.prepare('SELECT * FROM surveys WHERE id = ?').get(consent.survey_id));
  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(survey.school_id);
  req.consent = consent;
  req.survey = survey;
  req.portalSchool = school;
  req.classification = ppra.classify(survey, { opt_in_all_protected: Boolean(school.opt_in_all_protected) });
  next();
}

// ---------- Consent form (link sent to each family) ----------

router.get('/consent/:token', loadConsent, (req, res) => {
  res.render('parent/consent', {
    title: `Permission: ${req.survey.title}`,
    consent: req.consent, survey: req.survey, portal: req.portalSchool, c: req.classification, error: null, done: req.query.done === '1',
  });
});

router.post('/consent/:token', loadConsent, (req, res) => {
  const db = req.app.locals.db;
  const { consent, survey } = req;
  const decision = req.body.decision;
  const signer = String(req.body.signer_name || '').trim();
  const relationship = consent.is_eligible ? 'eligible student (self)' : String(req.body.relationship || '').trim();
  const closed = survey.status !== 'approved';
  let error = null;
  if (closed) error = 'This survey is no longer active, so responses are closed.';
  else if (!['granted', 'declined'].includes(decision)) error = 'Choose whether you give permission.';
  else if (!signer) error = 'Type your full name as your signature.';
  else if (!relationship) error = 'Tell us your relationship to the student.';
  else if (decision === 'granted' && req.body.reviewed !== 'on') error = 'Confirm that you have had the chance to review the survey.';
  if (error) {
    return res.status(400).render('parent/consent', {
      title: `Permission: ${survey.title}`, consent, survey, portal: req.portalSchool, c: req.classification, error, done: false,
    });
  }
  db.prepare(`UPDATE consents SET status = ?, signer_name = ?, signer_relationship = ?, signer_ip = ?, responded_at = datetime('now') WHERE id = ?`)
    .run(decision, signer, relationship, req.ip, consent.id);
  audit(db, {
    schoolId: survey.school_id, actor: `${signer} (${relationship})`,
    action: decision === 'granted' ? 'parent granted consent' : 'parent declined consent',
    entity: 'survey', entityId: survey.id, detail: `consent #${consent.id} for ${consent.first_name} ${consent.last_name}`,
  });
  res.redirect(`/s/consent/${consent.token}?done=1`);
});

router.get('/consent/:token/file', loadConsent, (req, res) => {
  if (!req.survey.file_path) return notFound(res, 'No file is attached to this survey.');
  res.download(req.survey.file_path, req.survey.file_name);
});

// ---------- Inspection access granted by staff ----------

function loadInspection(req, res, next) {
  const db = req.app.locals.db;
  const r = db.prepare(`SELECT * FROM inspection_requests WHERE access_token = ? AND status = 'fulfilled'
    AND resolved_at >= datetime('now', ?)`).get(String(req.params.token), `-${INSPECTION_LINK_DAYS} days`);
  if (!r) return notFound(res, `This inspection link is invalid or has expired (links last ${INSPECTION_LINK_DAYS} days). You can submit a new request.`);
  req.survey = parseSurvey(db.prepare('SELECT * FROM surveys WHERE id = ?').get(r.survey_id));
  req.portalSchool = db.prepare('SELECT * FROM schools WHERE id = ?').get(r.school_id);
  next();
}

router.get('/inspect/:token', loadInspection, (req, res) => {
  const c = ppra.classify(req.survey, { opt_in_all_protected: Boolean(req.portalSchool.opt_in_all_protected) });
  res.render('parent/inspect', { title: `Review: ${req.survey.title}`, survey: req.survey, portal: req.portalSchool, c, token: req.params.token });
});

router.get('/inspect/:token/file', loadInspection, (req, res) => {
  if (!req.survey.file_path) return notFound(res, 'No file is attached to this survey.');
  res.download(req.survey.file_path, req.survey.file_name);
});

// ---------- Public survey catalog for a school ----------

function loadSchool(req, res, next) {
  const school = req.app.locals.db.prepare('SELECT * FROM schools WHERE slug = ?').get(String(req.params.slug));
  if (!school) return notFound(res, 'School not found.');
  req.portalSchool = school;
  next();
}

function approvedSurvey(db, schoolId, id) {
  return parseSurvey(db.prepare("SELECT * FROM surveys WHERE id = ? AND school_id = ? AND status = 'approved'").get(Number(id), schoolId));
}

router.get('/:slug', loadSchool, (req, res) => {
  const db = req.app.locals.db;
  const school = req.portalSchool;
  const policy = { opt_in_all_protected: Boolean(school.opt_in_all_protected) };
  const surveys = db.prepare("SELECT * FROM surveys WHERE school_id = ? AND status = 'approved' ORDER BY start_date, title")
    .all(school.id).map(parseSurvey).map((s) => ({ ...s, classification: ppra.classify(s, policy) }));
  res.render('parent/catalog', { title: `${school.name} student surveys`, portal: school, surveys });
});

router.get('/:slug/request/:surveyId', loadSchool, (req, res) => {
  const survey = approvedSurvey(req.app.locals.db, req.portalSchool.id, req.params.surveyId);
  if (!survey) return notFound(res, 'Survey not found.');
  res.render('parent/request', { title: `Request to review: ${survey.title}`, portal: req.portalSchool, survey, values: {}, error: null, sent: false });
});

router.post('/:slug/request/:surveyId', loadSchool, (req, res) => {
  const db = req.app.locals.db;
  const survey = approvedSurvey(db, req.portalSchool.id, req.params.surveyId);
  if (!survey) return notFound(res, 'Survey not found.');
  const values = {
    requester_name: String(req.body.requester_name || '').trim().slice(0, 200),
    requester_email: String(req.body.requester_email || '').trim().toLowerCase().slice(0, 200),
    student_name: String(req.body.student_name || '').trim().slice(0, 200),
    message: String(req.body.message || '').trim().slice(0, 2000),
  };
  if (!values.requester_name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.requester_email) || !values.student_name) {
    return res.status(400).render('parent/request', {
      title: `Request to review: ${survey.title}`, portal: req.portalSchool, survey, values, sent: false,
      error: 'Please enter your name, a valid email address, and your student\'s name.',
    });
  }
  db.prepare(`INSERT INTO inspection_requests (school_id, survey_id, requester_name, requester_email, student_name, message)
    VALUES (?, ?, ?, ?, ?, ?)`).run(req.portalSchool.id, survey.id, values.requester_name, values.requester_email, values.student_name, values.message);
  audit(db, { schoolId: req.portalSchool.id, actor: values.requester_email, action: 'requested survey inspection', entity: 'survey', entityId: survey.id });
  res.render('parent/request', { title: `Request to review: ${survey.title}`, portal: req.portalSchool, survey, values, error: null, sent: true });
});

module.exports = router;

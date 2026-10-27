const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schools (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  contact_email TEXT,
  opt_in_all_protected INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'reviewer', 'staff')),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS surveys (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  administered_by TEXT NOT NULL DEFAULT '',
  grades TEXT NOT NULL DEFAULT '',
  funding_source TEXT NOT NULL DEFAULT 'state_local',
  requires_student_response INTEGER NOT NULL DEFAULT 1,
  protected_areas TEXT NOT NULL DEFAULT '[]',
  instrument_text TEXT NOT NULL DEFAULT '',
  file_name TEXT,
  file_path TEXT,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_review', 'approved', 'rejected', 'retired')),
  review_notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  local_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  grade TEXT NOT NULL DEFAULT '',
  -- Eligible student (18+ or emancipated): PPRA rights transfer to them.
  is_eligible INTEGER NOT NULL DEFAULT 0,
  email TEXT,
  UNIQUE (school_id, local_id)
);

CREATE TABLE IF NOT EXISTS guardians (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  UNIQUE (school_id, email)
);

CREATE TABLE IF NOT EXISTS student_guardians (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  guardian_id INTEGER NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  PRIMARY KEY (student_id, guardian_id)
);

-- One row per (survey, student). Absence of a "granted" response means the
-- student may not participate in an opt-in survey.
CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY,
  survey_id INTEGER NOT NULL REFERENCES surveys(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'declined')),
  signer_name TEXT,
  signer_relationship TEXT,
  signer_ip TEXT,
  responded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (survey_id, student_id)
);

CREATE TABLE IF NOT EXISTS inspection_requests (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  survey_id INTEGER NOT NULL REFERENCES surveys(id),
  requester_name TEXT NOT NULL,
  requester_email TEXT NOT NULL,
  student_name TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fulfilled', 'declined')),
  access_token TEXT UNIQUE,
  resolution_notes TEXT NOT NULL DEFAULT '',
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  school_id INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_surveys_school ON surveys(school_id, status);
CREATE INDEX IF NOT EXISTS idx_consents_survey ON consents(survey_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_school ON inspection_requests(school_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_school ON audit_log(school_id, created_at);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

// Run fn inside a transaction, rolling back on any error.
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function audit(db, { schoolId, actor, action, entity, entityId = null, detail = '' }) {
  db.prepare(
    'INSERT INTO audit_log (school_id, actor, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(schoolId, actor, action, entity, entityId, detail);
}

function parseSurvey(row) {
  if (!row) return row;
  return {
    ...row,
    protected_areas: JSON.parse(row.protected_areas || '[]'),
    requires_student_response: Boolean(row.requires_student_response),
  };
}

module.exports = { open, tx, audit, parseSurvey };

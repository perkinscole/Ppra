// Creates a demo school with sample surveys and a small roster.
//   npm run seed  ->  sign in as admin@demo.school / demo-password-1
const path = require('node:path');
const db = require('../src/db');
const { hashPassword, newToken } = require('../src/security');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const conn = db.open(path.join(dataDir, 'ppra.db'));

if (conn.prepare("SELECT 1 FROM schools WHERE slug = 'lincoln-ms'").get()) {
  console.log('Demo school already exists. Sign in as admin@demo.school / demo-password-1');
  process.exit(0);
}

db.tx(conn, () => {
  const schoolId = Number(conn.prepare("INSERT INTO schools (name, slug, contact_email) VALUES ('Lincoln Middle School', 'lincoln-ms', 'office@lincoln.example.org')").run().lastInsertRowid);
  const userId = Number(conn.prepare('INSERT INTO users (school_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
    .run(schoolId, 'admin@demo.school', 'Demo Admin', 'admin', hashPassword('demo-password-1')).lastInsertRowid);
  conn.prepare('INSERT INTO users (school_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
    .run(schoolId, 'counselor@demo.school', 'Demo Counselor', 'staff', hashPassword('demo-password-1'));

  const addSurvey = conn.prepare(`INSERT INTO surveys (school_id, title, description, administered_by, grades, funding_source,
    protected_areas, instrument_text, start_date, end_date, status, created_by, reviewed_by, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const approved = (fields) => addSurvey.run(schoolId, ...fields, 'approved', userId, userId, new Date().toISOString().slice(0, 19).replace('T', ' '));

  const climate = Number(approved([
    'Spring School Climate Survey',
    'Helps us understand how safe and connected students feel at school. Results are reported only in aggregate.',
    'Counseling Department', '6-8', 'us_ed', JSON.stringify(['mental_health', 'illegal_behavior']),
    '1. I feel safe at school. (Strongly agree … Strongly disagree)\n2. In the past two weeks, how often have you felt sad or hopeless?\n3. Have you ever been offered a vape or drugs at school?\n4. Is there an adult at school you can talk to?',
    '2027-03-15', '2027-03-26',
  ]).lastInsertRowid);
  approved([
    'Library Reading Interest Poll',
    'Helps the library choose new books.',
    'Library', '', 'state_local', '[]',
    '1. What genres do you enjoy?\n2. How many books did you read for fun last month?',
    '2026-11-03', '2026-11-07',
  ]);
  addSurvey.run(schoolId, 'Youth Wellness Study (State University)', 'University research on adolescent wellbeing.',
    'State University', '7-8', 'third_party', '[]',
    'Q1. How often do you attend religious services?\nQ2. Do your parents argue at home?\nQ3. How much money does your household earn?',
    '2027-01-10', '2027-01-20', 'draft', userId, null, null);

  const addStudent = conn.prepare('INSERT INTO students (school_id, local_id, first_name, last_name, grade) VALUES (?, ?, ?, ?, ?)');
  const addGuardian = conn.prepare('INSERT INTO guardians (school_id, name, email) VALUES (?, ?, ?)');
  const link = conn.prepare('INSERT INTO student_guardians (student_id, guardian_id) VALUES (?, ?)');
  const addConsent = conn.prepare('INSERT INTO consents (survey_id, student_id, token, status, signer_name, signer_relationship, responded_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const families = [
    ['1001', 'Ava', 'Martinez', '6', 'Rosa Martinez', 'granted'],
    ['1002', 'Liam', 'Chen', '6', 'Wei Chen', 'declined'],
    ['1003', 'Noah', 'Johnson', '7', 'Tanya Johnson', 'pending'],
    ['1004', 'Emma', 'Okafor', '7', 'Chidi Okafor', 'granted'],
    ['1005', 'Mia', 'Novak', '8', 'Petra Novak', 'pending'],
    ['1006', 'Lucas', 'Smith', '8', 'Dana Smith', 'pending'],
  ];
  for (const [id, first, last, grade, guardian, status] of families) {
    const sid = Number(addStudent.run(schoolId, id, first, last, grade).lastInsertRowid);
    const gid = Number(addGuardian.run(schoolId, guardian, `${guardian.toLowerCase().replace(' ', '.')}@example.com`).lastInsertRowid);
    link.run(sid, gid);
    const responded = status !== 'pending';
    addConsent.run(climate, sid, newToken(), status, responded ? guardian : null, responded ? 'Parent' : null,
      responded ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null);
  }
});

console.log('Demo school created. Sign in as admin@demo.school / demo-password-1 (parent page: /s/lincoln-ms)');

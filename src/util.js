// RFC 4180-ish CSV parser: handles quoted fields, escaped quotes, CRLF.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

// Parse CSV with a header row into objects keyed by normalized header names.
function parseCsvObjects(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] || '').trim()])));
}

function toCsv(rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    // Prefix formula-leading values so spreadsheets don't execute them.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

// "K, 3-5, 9" -> Set{'K','3','4','5','9'}; empty -> null (all grades).
function parseGrades(spec) {
  const parts = String(spec || '').split(/[,;\s]+/).map((p) => p.trim().toUpperCase()).filter(Boolean);
  if (!parts.length) return null;
  const set = new Set();
  for (const p of parts) {
    const m = p.match(/^(\d+)-(\d+)$/);
    if (m) for (let g = Number(m[1]); g <= Number(m[2]); g++) set.add(String(g));
    else set.add(p.replace(/^0+(?=\d)/, ''));
  }
  return set;
}

function gradeMatches(spec, grade) {
  const set = parseGrades(spec);
  if (!set) return true;
  return set.has(String(grade || '').trim().toUpperCase().replace(/^0+(?=\d)/, ''));
}

function truthy(v) {
  return /^(1|y|yes|true|x)$/i.test(String(v || '').trim());
}

module.exports = { parseCsv, parseCsvObjects, toCsv, parseGrades, gradeMatches, truthy };

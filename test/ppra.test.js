const test = require('node:test');
const assert = require('node:assert/strict');
const ppra = require('../src/ppra');
const { parseCsvObjects, toCsv, gradeMatches } = require('../src/util');

test('US ED-funded survey on a protected area requires opt-in by law', () => {
  const c = ppra.classify({ protected_areas: ['mental_health'], funding_source: 'us_ed' });
  assert.equal(c.legalMinimum, 'opt_in');
  assert.equal(c.required, 'opt_in');
});

test('non-ED protected survey is opt-out by law but opt-in under district policy', () => {
  const survey = { protected_areas: ['religion'], funding_source: 'third_party' };
  assert.equal(ppra.classify(survey).required, 'opt_out');
  const c = ppra.classify(survey, { opt_in_all_protected: true });
  assert.equal(c.legalMinimum, 'opt_out');
  assert.equal(c.required, 'opt_in');
});

test('survey with no protected areas needs no consent even under opt-in policy', () => {
  const c = ppra.classify({ protected_areas: [], funding_source: 'us_ed' }, { opt_in_all_protected: true });
  assert.equal(c.required, 'none');
});

test('unknown area keys are ignored', () => {
  assert.equal(ppra.classify({ protected_areas: ['nope'], funding_source: 'us_ed' }).required, 'none');
});

test('silence is not consent for opt-in surveys', () => {
  assert.equal(ppra.mayParticipate('opt_in', 'pending'), false);
  assert.equal(ppra.mayParticipate('opt_in', 'declined'), false);
  assert.equal(ppra.mayParticipate('opt_in', 'granted'), true);
  assert.equal(ppra.mayParticipate('opt_out', 'pending'), true);
  assert.equal(ppra.mayParticipate('opt_out', 'declined'), false);
});

test('instrument scan flags cues at word starts only', () => {
  const hits = ppra.scanInstrument('Do you pray? How much does your household earn? Have you felt depressed?');
  assert.deepEqual(Object.keys(hits).sort(), ['income', 'mental_health', 'religion']);
  assert.deepEqual(ppra.scanInstrument('What did you learn today? Is updating easy? Good job.'), {});
});

test('CSV round trip handles quotes and neutralizes formulas', () => {
  const rows = parseCsvObjects('Student ID,First Name\r\n"1,2","say ""hi"""\n');
  assert.deepEqual(rows, [{ student_id: '1,2', first_name: 'say "hi"' }]);
  assert.equal(toCsv([['=SUM(A1)', 'a,b']]), "'=SUM(A1),\"a,b\"\r\n");
});

test('grade specs support ranges, lists, and K', () => {
  assert.ok(gradeMatches('6-8', '07'));
  assert.ok(!gradeMatches('6-8', '9'));
  assert.ok(gradeMatches('K, 3', 'k'));
  assert.ok(gradeMatches('', '12'));
});

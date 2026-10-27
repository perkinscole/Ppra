// PPRA domain rules (20 U.S.C. § 1232h; 34 CFR Part 98).
// This module encodes the statute's categories and consent tiers. It is a
// compliance aid, not legal advice — districts should confirm with counsel.

const PROTECTED_AREAS = [
  {
    key: 'political',
    label: 'Political affiliations or beliefs',
    help: 'Political affiliations or beliefs of the student or the student\'s parent.',
    cues: ['political', 'politics', 'democrat', 'republican', 'vote', 'voting', 'election', 'liberal', 'conservative', 'party affiliation'],
  },
  {
    key: 'mental_health',
    label: 'Mental or psychological problems',
    help: 'Mental or psychological problems of the student or the student\'s family.',
    cues: ['depress', 'anxiety', 'anxious', 'suicid', 'self-harm', 'self harm', 'mental health', 'therapy', 'counseling', 'hopeless', 'eating disorder', 'psycholog'],
  },
  {
    key: 'sex',
    label: 'Sex behavior or attitudes',
    help: 'Sexual behavior or attitudes.',
    cues: ['sex', 'sexual', 'intercourse', 'condom', 'pregnan', 'birth control', 'contracepti', 'dating'],
  },
  {
    key: 'illegal_behavior',
    label: 'Illegal, anti-social, self-incriminating, or demeaning behavior',
    help: 'Illegal, anti-social, self-incriminating, or demeaning behavior.',
    cues: ['alcohol', 'drink', 'drug', 'marijuana', 'vape', 'vaping', 'cigarette', 'tobacco', 'steal', 'stolen', 'weapon', 'gun', 'fight', 'arrest', 'shoplift', 'cheat'],
  },
  {
    key: 'family_appraisal',
    label: 'Critical appraisals of close family members',
    help: 'Critical appraisals of others with whom the respondent has close family relationships.',
    cues: ['your parent', 'your mother', 'your father', 'your sibling', 'your brother', 'your sister', 'family conflict', 'argue with', 'parents fight', 'home life'],
  },
  {
    key: 'privileged_relationships',
    label: 'Legally privileged relationships',
    help: 'Legally recognized privileged or analogous relationships, such as with lawyers, physicians, and ministers.',
    cues: ['lawyer', 'attorney', 'doctor', 'physician', 'minister', 'pastor', 'priest', 'clergy', 'rabbi', 'imam'],
  },
  {
    key: 'religion',
    label: 'Religious practices, affiliations, or beliefs',
    help: 'Religious practices, affiliations, or beliefs of the student or the student\'s parent.',
    cues: ['religio', 'church', 'mosque', 'synagogue', 'temple', 'pray', 'faith', 'god', 'worship', 'spiritual'],
  },
  {
    key: 'income',
    label: 'Income',
    help: 'Income, other than as required by law to determine program eligibility.',
    cues: ['income', 'salary', 'earn', 'free lunch', 'reduced lunch', 'afford', 'money at home', 'paycheck', 'household income'],
  },
];

const AREA_KEYS = PROTECTED_AREAS.map((a) => a.key);
const AREA_BY_KEY = Object.fromEntries(PROTECTED_AREAS.map((a) => [a.key, a]));

const FUNDING_SOURCES = {
  us_ed: 'U.S. Department of Education funded (in whole or part)',
  other_federal: 'Other federal funding',
  state_local: 'State / local / district funded',
  third_party: 'Third party (vendor, university, nonprofit)',
};

const CONSENT_TIERS = {
  none: {
    label: 'No PPRA consent required',
    short: 'None',
  },
  opt_out: {
    label: 'Notice + opportunity to opt out',
    short: 'Opt-out',
  },
  opt_in: {
    label: 'Prior written consent (opt-in)',
    short: 'Opt-in',
  },
};

// Suggest protected areas from instrument text. Heuristic only: it exists to
// speed up human review of an existing survey backlog, never to replace it.
function scanInstrument(text) {
  const haystack = ` ${String(text || '').toLowerCase()} `;
  const hits = {};
  for (const area of PROTECTED_AREAS) {
    // Cues match at the start of a word, so "earn" doesn't hit "learn" and
    // "dating" doesn't hit "updating", but "pray" still hits "prayer".
    const matched = area.cues.filter((cue) => new RegExp(`\\b${cue}`).test(haystack));
    if (matched.length) hits[area.key] = matched;
  }
  return hits;
}

// Decide the consent tier for a survey.
//   survey.protected_areas: array of area keys
//   survey.funding_source:  key of FUNDING_SOURCES
//   survey.requires_student_response: whether students must submit it
//   policy.opt_in_all_protected: district policy to require opt-in for any
//     survey touching a protected area, regardless of funding
function classify(survey, policy = {}) {
  const areas = (survey.protected_areas || []).filter((k) => AREA_BY_KEY[k]);
  const touchesProtected = areas.length > 0;
  const usEd = survey.funding_source === 'us_ed';
  const reasons = [];

  let legalMinimum = 'none';
  if (touchesProtected && usEd && survey.requires_student_response !== false) {
    legalMinimum = 'opt_in';
    reasons.push('Funded by the U.S. Department of Education and asks about a protected area: PPRA requires prior written parental consent for minors (20 U.S.C. § 1232h(b)).');
  } else if (touchesProtected) {
    legalMinimum = 'opt_out';
    reasons.push('Asks about a protected area: PPRA requires direct notice to parents, the right to inspect the survey, and an opportunity to opt out (20 U.S.C. § 1232h(c)).');
  } else {
    reasons.push('No protected areas selected. Confirm by reviewing every question in the instrument.');
  }

  let required = legalMinimum;
  if (touchesProtected && policy.opt_in_all_protected && required !== 'opt_in') {
    required = 'opt_in';
    reasons.push('District policy requires opt-in consent for every survey touching a protected area, which exceeds the legal minimum.');
  }

  return {
    areas,
    touchesProtected,
    legalMinimum,
    required,
    needsConsentCampaign: required === 'opt_in',
    inspectionRight: touchesProtected || usEd,
    reasons,
  };
}

// A student may take a survey only if no consent is needed or a guardian (or
// the eligible student, 18+) has affirmatively granted it. Silence is "no".
function mayParticipate(tier, consentStatus) {
  if (tier === 'opt_in') return consentStatus === 'granted';
  if (tier === 'opt_out') return consentStatus !== 'declined';
  return true;
}

module.exports = {
  PROTECTED_AREAS,
  AREA_KEYS,
  AREA_BY_KEY,
  FUNDING_SOURCES,
  CONSENT_TIERS,
  scanInstrument,
  classify,
  mayParticipate,
};

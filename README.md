# PPRA Consent Manager

A web app that helps schools comply with the **Protection of Pupil Rights Amendment** (PPRA, 20 U.S.C. § 1232h; 34 CFR Part 98):

- **Survey registry**: one place for every survey students take. Each one records its instrument (pasted text and/or file), funding source, grades, dates, and the eight PPRA protected areas it touches.
- **PPRA classification**: works out the legal minimum (none / opt-out / prior written consent) and applies district policy. By default the policy requires **opt-in for every survey that touches a protected area**, whatever the funding.
- **Keyword scan**: flags questions that look like they touch a protected area that isn't marked. This is a prompt for the reviewer, not a decision.
- **Review workflow**: draft → in review → approved / needs changes. Approved instruments are locked, so consent always matches what parents saw.
- **Opt-in consent campaigns**: one personal link per student, sent to guardians, or to the student if they are an eligible student (18+ or emancipated). Silence = no participation. Paper forms can be recorded too. Exports a mail-merge CSV and a printable YES/NO participation roster for teachers.
- **Parent portal** (`/s/<school>`): a public list of approved surveys. Parents request to inspect one, staff verify and grant, and the parent gets a 30-day private link.
- **Annual notice**: drafts the PPRA notice to families from your approved surveys.
- **Audit log** of every review decision, consent response, and inspection request. Multi-school (each school is a separate tenant) with admin / reviewer / staff roles.

## Run it

```bash
npm install
npm run seed     # optional demo: admin@demo.school / demo-password-1
npm start        # http://localhost:3000
npm test
```

Requires Node 22.13+ (uses the built-in `node:sqlite`). Configuration: `PORT`, `DATA_DIR` (database and uploads, default `./data`), `SESSION_SECRET` (required when `NODE_ENV=production`), `BASE_URL` (used in parent links when behind a proxy).

## Before selling to districts

- **Email delivery**: links are currently exported as CSV for mail merge. Add SMTP or a provider (SES, Postmark) and reminders for families who haven't responded.
- **SIS / SSO integration**: Clever, ClassLink, OneRoster rosters; Google / Microsoft staff login; password reset.
- **Hosting**: Postgres instead of SQLite, object storage for uploads, backups, rate limiting on the public request form.
- **Student data privacy**: a signed data privacy agreement (many states require one, e.g. the Student Data Privacy Consortium NDPA), a FERPA "school official" posture, encryption at rest, a retention policy, and an accessibility (WCAG 2.1 AA) audit.
- **Translations** of parent-facing pages.
- **Legal review** of the classification rules and notice template by education counsel. This tool is a compliance aid, not legal advice.

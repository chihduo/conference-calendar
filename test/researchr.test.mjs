#!/usr/bin/env node
/* researchr label and date parsing, pinned with strings copied off the live
   /dates pages. Four of them were importing wrong data until they were fixed:
     "Paper Registration" (VMCAI 2027, SAS 2026) became a conference registration;
     "Initial Notification (Including Early Reject)" (ISSTA 2027) became an early
       rejection, which a submitted paper never lists as pending;
     "Revised papers" (ICFP 2027) matched nothing and was dropped;
     "Mon 22 Mar - Thu 25 Mar 2027" (ISSTA 2027) lost its start date.
   The rest pin the neighbours those fixes could have broken.
     npm run test:researchr
*/
import { labelToKind, parseWhen } from '../scripts/adapters/researchr.mjs';

let pass = 0, total = 0;
const check = (n, c, got = '') => { total++; if (c) pass++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${got ? '  → ' + got : ''}`); };
const kinds = (rows) => rows.forEach(([label, want]) => {
  const got = labelToKind(label);
  check(`${label}`, got === want, String(got));
});

console.log('=== 報名：論文、artifact、會議是三件事 ===');
kinds([
  ['Paper Registration',               'abstract'],
  ['Paper registration',               'abstract'],
  ['Abstract Registration',            'abstract'],
  ['(Optional) Abstract registration', 'abstract'],
  ['Artifact Registration',            'artifact_registration'],
  ['Artifact registration deadline',   'artifact_registration'],
  // no page we read lists these today; they guard the generic rule the fix sits in front of
  ['Registration deadline',            'registration'],
  ['Early registration deadline',      'early_registration'],
]);

console.log('\n=== 通知 ===');
kinds([
  ['Initial Notification (Including Early Reject)', 'notification'],
  ['Initial notification',                          'notification'],
  ['Early-rejection notification',                  'early_rejection_notification'],
  ['Notification of conditional acceptance',        'notification'],
  ['Final Notification',                            'final_notification'],
  ['Final decision (of major revision papers)',     'final_notification'],
]);

console.log('\n=== 修訂與定稿 ===');
kinds([
  ['Revised papers',                                    'revision'],
  ['Major Revision Submission',                         'revision'],
  ['Revision due',                                      'revision'],
  ['Camera-ready (of accepted major revision papers)',  'camera_ready_after_revision'],
  ['Camera-ready (of directly accepted papers)',        'camera_ready'],
  ['Final Version',                                     'camera_ready'],
]);

console.log('\n=== 投稿，以及不是里程碑的列 ===');
kinds([
  ['Paper Submission',               'submission'],
  ['Titles + Abstracts due',         'abstract'],
  ['Artifact Submission',            'artifact_submission'],
  ['Tool paper artifact submission', 'tool_artifact_submission'],
  ['Author response period',         'rebuttal'],
  ['Main conference',                null],
  ['Reviews released',               null],
]);

console.log('\n=== 日期 ===');
for (const [when, want] of [
  ['Wed 16 Sep 2026',              { from: '2026-09-16' }],
  ['Mon 14 - Fri 18 Dec 2026',     { from: '2026-12-14', to: '2026-12-18' }],
  ['Mon 22 Mar - Thu 25 Mar 2027', { from: '2027-03-22', to: '2027-03-25' }],
  ['Mon 30 Nov - Fri 4 Dec 2026',  { from: '2026-11-30', to: '2026-12-04' }],
  ['Mon 28 Dec - Fri 1 Jan 2027',  { from: '2026-12-28', to: '2027-01-01' }],
]) {
  const got = JSON.stringify(parseWhen(when));
  check(when, got === JSON.stringify(want), got);
}

console.log(`\n${pass}/${total} 通過`);
process.exit(pass === total ? 0 : 1);

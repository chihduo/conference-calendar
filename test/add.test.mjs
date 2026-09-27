#!/usr/bin/env node
/* The pieces that decide what an added venue looks like, pinned with entries
   copied from ccf-deadlines. They are what the S&P issue ran into:
     the title "S&P" is no file name, and no source keys it that way;
     ccf-deadlines lists S&P's two rounds as two timeline entries, and reading
       only the first made S&P 2027 look closed while November was still open;
     once rounds are known, a flat deadline of the same kind is a round seen
       blurred - OOPSLA 2027 showed its October deadline twice.
     npm run test:add
*/
import { idFromAcronym, supersededByRounds } from '../scripts/lib.mjs';
import { milestonesOf } from '../scripts/adapters/ccfddl.mjs';

let pass = 0, total = 0;
const check = (n, c, got = '') => { total++; if (c) pass++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${got ? '  → ' + got : ''}`); };
const brief = (ms) => ms.map((m) => `${m.kind} ${m.date}`).join(', ');

console.log('=== 縮寫 → id（檔名與屆別 id 只能是 [a-z0-9-]）===');
for (const [acro, want] of [['S&P', 'sp'], ['EuroS&P', 'eurosp'], ['NeurIPS', 'neurips'], ['IJCAI-ECAI', 'ijcai-ecai'], [' CAV ', 'cav']]) {
  const got = idFromAcronym(acro);
  check(`${acro}`, got === want, got);
}

console.log('\n=== ccf-deadlines：幾個 timeline 項目，是幾輪還是一輪兩步 ===');
const cases = [
  ['S&P 2027：兩輪，各有摘要', [
    { abstract_deadline: '2026-06-04 23:59:59', deadline: '2026-06-11 23:59:59', comment: 'First Paper submission deadline' },
    { abstract_deadline: '2026-11-10 23:59:59', deadline: '2026-11-17 23:59:59', comment: 'Second Paper submission deadline' }],
   'abstract_cycle1 2026-06-04, submission_cycle1 2026-06-11, abstract_cycle2 2026-11-10, submission_cycle2 2026-11-17'],
  ['OOPSLA 2027：兩輪，跨年', [
    { deadline: '2026-10-14 23:59:59', comment: 'Submission Deadline Round 1' },
    { deadline: '2027-04-07 23:59:59', comment: 'Submission Deadline Round 2' }],
   'submission_cycle1 2026-10-14, submission_cycle2 2027-04-07'],
  ['NDSS 2027：Summer / Fall 也是兩輪', [
    { deadline: '2026-05-06 23:59:59', comment: 'Summer' },
    { deadline: '2026-08-19 23:59:59', comment: 'Fall' }],
   'submission_cycle1 2026-05-06, submission_cycle2 2026-08-19'],
  ['VMCAI 2027：一輪兩步，不是兩輪', [
    { deadline: '2026-09-23 23:59:59', comment: 'Paper Registration' },
    { deadline: '2026-09-30 23:59:59', comment: 'Paper Submission' }],
   'abstract 2026-09-23, submission 2026-09-30'],
  ['ICALP 2027：只有一項，提到 round 也還是單一日期', [
    { deadline: '2026-09-15 23:59:59', comment: 'Track B first round; Track A and Track B second round TBA' }],
   'submission 2026-09-15'],
  ['FSE 2027：沒有註解的單一項目', [{ deadline: '2026-10-02 23:59:59' }], 'submission 2026-10-02'],
  ['還沒公布的項目不算一輪', [{ deadline: 'TBA', comment: 'Second round' }, { deadline: '2026-10-02 23:59:59' }], 'submission 2026-10-02'],
];
for (const [name, timeline, want] of cases) {
  const got = brief(milestonesOf(timeline));
  check(name, got === want, got);
}
check('時間跟著日期走', milestonesOf(cases[0][1]).every((m) => m.time === '23:59:59'));

console.log('\n=== 分輪之後，同類的單一日期由分輪取代 ===');
const CCF = 'https://raw.githubusercontent.com/ccfddl/ccf-deadlines/main/conference/SE/oopsla.yml';
const RR = 'https://conf.researchr.org/dates/splash-2027';
const gone = (milestones) => supersededByRounds({ milestones }).map((m) => `${m.kind} ${m.date}`).join(', ') || '(無)';
check('OOPSLA 2027：ccf-deadlines 的單一日期與 researchr 的第 1 輪重複 → 拿掉',
  gone([{ kind: 'submission', date: '2026-10-14', confidence: 'announced', source_url: CCF },
        { kind: 'submission_cycle1', date: '2026-10-14', confidence: 'confirmed', source_url: RR },
        { kind: 'submission_cycle2', date: '2027-04-07', confidence: 'confirmed', source_url: RR }]) === 'submission 2026-10-14');
check('手填的單一日期留著（那是人讀過 CFP 的判斷）',
  gone([{ kind: 'submission', date: '2026-10-14', confidence: 'confirmed' },
        { kind: 'submission_cycle1', date: '2026-10-14', confidence: 'confirmed', source_url: RR }]) === '(無)');
check('locked 的留著',
  gone([{ kind: 'submission', date: '2026-10-14', confidence: 'announced', source_url: CCF, locked: true },
        { kind: 'submission_cycle1', date: '2026-10-14', confidence: 'confirmed', source_url: RR }]) === '(無)');
check('只有投稿分輪時，單一的通知日期不受影響',
  gone([{ kind: 'notification', date: '2025-09-09', confidence: 'announced', source_url: CCF },
        { kind: 'submission_cycle1', date: '2025-06-05', confidence: 'announced', source_url: CCF }]) === '(無)');
check('推估的單一日期照舊由分輪取代',
  gone([{ kind: 'submission', date: '2027-06-10', confidence: 'estimated', derived_from: 'sp-2026/submission' },
        { kind: 'submission_cycle1', date: '2026-06-11', confidence: 'announced', source_url: CCF }]) === 'submission 2027-06-10');
check('沒有分輪就什麼都不動',
  gone([{ kind: 'submission', date: '2026-10-02', confidence: 'announced', source_url: CCF }]) === '(無)');

console.log(`\n${pass}/${total} 通過`);
process.exit(pass === total ? 0 : 1);

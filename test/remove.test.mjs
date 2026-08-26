#!/usr/bin/env node
/* Removal, including the cleanup around it.
   Deleting the file is the easy half; the half that bites is leaving something
   pointing at a venue that is gone - a wishlist line the nightly cron would use
   to recreate it, review-queue items about a file nobody can open.
   Uses a throwaway fixture and restores every file it touches.
     npm run test:remove
*/
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CONF = path.join(ROOT, 'data/conferences');
const WISH = path.join(ROOT, 'data/wishlist.txt');
const QUEUE = path.join(ROOT, 'data/_review_queue.json');
const ACKS = path.join(ROOT, 'data/_acknowledged.json');
const ID = 'zzremovetest';   // must match what remove.mjs derives from the acronym

const snapshot = Object.fromEntries([WISH, QUEUE, ACKS].map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null]));
const restore = () => { for (const [f, v] of Object.entries(snapshot)) if (v !== null) fs.writeFileSync(f, v); };

let pass = 0, total = 0;
const check = (n, c, got = '') => { total++; if (c) pass++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${got ? '  → ' + got : ''}`); };

try {
  fs.writeFileSync(path.join(CONF, `${ID}.yml`), `id: ${ID}
name: ZZREMOVETEST
areas: [FM]
editions:
  - year: 2027
    id: ${ID}-2027
    timezone: AoE
    status: confirmed
    milestones:
      - {kind: submission, date: 2026-10-01, confidence: confirmed, locked: true, note: 手填的}
`);
  fs.writeFileSync(WISH, (snapshot[WISH] || '') + `\nZZREMOVETEST\n`);
  fs.writeFileSync(QUEUE, JSON.stringify([
    ...JSON.parse(snapshot[QUEUE] || '[]'),
    { conference: ID, reason: 'guard', severity: 'action', detail: 'x' },
  ], null, 2));
  fs.writeFileSync(ACKS, JSON.stringify([
    ...JSON.parse(snapshot[ACKS] || '[]'),
    { fingerprint: `guard|${ID}|||x`, reason: 'guard', conference: ID, detail: 'x', on: '2026-01-01' },
  ], null, 2));

  const out = execFileSync('node', ['scripts/remove.mjs', 'ZZREMOVETEST'], { cwd: ROOT, encoding: 'utf8' });

  check('先列出即將失去什麼', /1 個官方確認、1 個 locked、1 條註記/.test(out), out.split('\n')[2]?.trim());
  check('說明怎麼還原', /git revert/.test(out));
  check('提到可逆的 --hide', /--hide/.test(out));
  check('檔案已刪除', !fs.existsSync(path.join(CONF, `${ID}.yml`)));
  check('從 wishlist 移除（否則今晚 cron 會加回來）',
        !fs.readFileSync(WISH, 'utf8').split('\n').some((l) => l.trim() === 'ZZREMOVETEST'));
  check('清掉待確認項目',
        !JSON.parse(fs.readFileSync(QUEUE, 'utf8')).some((r) => r.conference === ID));
  check('清掉確認紀錄',
        !JSON.parse(fs.readFileSync(ACKS, 'utf8')).some((a) => a.conference === ID));

  let missing = '';
  try { execFileSync('node', ['scripts/remove.mjs', 'ZZNOSUCH'], { cwd: ROOT, encoding: 'utf8' }); }
  catch (e) { missing = (e.stdout || '') + (e.stderr || ''); }
  check('找不到時說清楚而不是當掉', /找不到 ZZNOSUCH/.test(missing));
} finally {
  fs.rmSync(path.join(CONF, `${ID}.yml`), { force: true });
  restore();
}

console.log(`\n${pass}/${total} 通過`);
process.exit(pass === total ? 0 : 1);

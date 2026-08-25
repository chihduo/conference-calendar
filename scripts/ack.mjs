#!/usr/bin/env node
/* Acknowledge review-queue findings so they stop being reported.
   Acknowledging is not deleting: the finding stays in the queue marked
   'acknowledged', and comes back on its own if the detail changes materially -
   a conflict whose dates move is a new decision, not the one you already made.

     npm run ack                      列出待處理
     npm run ack 1 3 5                確認第 1、3、5 筆
     npm run ack --conference=cade    確認某個會議的全部
     npm run ack --reason=wrong-venue 確認某一類
     npm run ack --list-acked         看已確認的
     npm run ack --forget=cade        取消確認,讓它重新出現
*/
import { readReviewQueue, loadAcks, saveAcks, fingerprint, applyAcks } from './lib.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const nums = args.filter((a) => /^\d+$/.test(a)).map(Number);
const note = flag('note') || '';

const acks = loadAcks();
const queue = applyAcks(readReviewQueue(), acks);
const open = queue.filter((r) => r.severity === 'action');

if (args.includes('--list-acked')) {
  if (!acks.length) { console.log('沒有已確認的項目。'); process.exit(0); }
  console.log(`${acks.length} 筆已確認：\n`);
  for (const a of acks) console.log(`  ${a.on}  [${a.reason}] ${a.conference}\n     ${a.detail.slice(0, 90)}${a.note ? '\n     備註：' + a.note : ''}`);
  process.exit(0);
}

const forget = flag('forget');
if (forget) {
  const before = acks.length;
  const kept = acks.filter((a) => a.conference !== forget && a.reason !== forget);
  saveAcks(kept);
  console.log(`取消確認 ${before - kept.length} 筆（下次 refresh / build 會重新出現）。`);
  process.exit(0);
}

const byConf = flag('conference');
const byReason = flag('reason');

let target = [];
if (nums.length) target = nums.map((n) => open[n - 1]).filter(Boolean);
else if (byConf) target = open.filter((r) => r.conference === byConf);
else if (byReason) target = open.filter((r) => r.reason === byReason);

if (!target.length) {
  if (!open.length) { console.log('沒有待處理的項目。'); process.exit(0); }
  console.log(`${open.length} 筆待處理：\n`);
  open.forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. [${r.reason}] ${r.conference}${r.edition ? '/' + r.edition : ''}`);
    console.log(`      ${r.detail}`);
  });
  console.log('\n確認方式：npm run ack 1 2 3   或   npm run ack --conference=cade');
  console.log('確認代表「我看過了，這是已知狀況」，不是修正資料；細節有實質變動時會自己回來。');
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
const have = new Set(acks.map((a) => a.fingerprint));
for (const r of target) {
  const fp = fingerprint(r);
  if (have.has(fp)) continue;
  acks.push({ fingerprint: fp, reason: r.reason, conference: r.conference,
              detail: r.detail, on: today, ...(note ? { note } : {}) });
  have.add(fp);
  console.log(`已確認  [${r.reason}] ${r.conference}: ${r.detail.slice(0, 70)}`);
}
saveAcks(acks);
/* Count findings silenced, not records written: one wrong-venue record can
   cover several years' worth of findings, and reporting the record count would
   understate what just happened. */
const stillOpen = applyAcks(readReviewQueue(), acks).filter((r) => r.severity === 'action').length;
console.log(`\n靜音了 ${open.length - stillOpen} 筆，剩下 ${stillOpen} 筆待處理。重新 build 後橫幅會更新。`);

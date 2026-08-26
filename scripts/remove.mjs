#!/usr/bin/env node
/* Remove a conference.
   Deleting loses hand-curation that the fetchers cannot regenerate - locked
   values, official dates read off a CFP by a person, pinned researchr tracks -
   so this reports exactly what is going before it goes, and names the way back.

     npm run remove CIAA          刪除檔案
     npm run remove CIAA --hide   保留檔案，只是不顯示（可逆）
     npm run remove CIAA --dry-run
*/
import fs from 'node:fs';
import path from 'node:path';
import {
  CONF_DIR, loadYaml, saveConference, readReviewQueue, writeReviewQueue,
  loadAcks, saveAcks,
} from './lib.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const HIDE = args.includes('--hide');
const acronym = args.find((a) => !a.startsWith('--'));

if (!acronym) { console.error('usage: remove.mjs <acronym> [--hide] [--dry-run]'); process.exit(2); }

const id = acronym.toLowerCase();
const file = path.join(CONF_DIR, `${id}.yml`);
if (!fs.existsSync(file)) {
  console.log(`找不到 ${acronym}（${path.relative(process.cwd(), file)} 不存在）。`);
  const near = fs.readdirSync(CONF_DIR).map((f) => f.replace(/\.ya?ml$/, ''))
    .filter((n) => n.startsWith(id[0])).slice(0, 12);
  if (near.length) console.log(`同字母開頭的有：${near.join(', ')}`);
  process.exit(1);
}

const doc = loadYaml(fs.readFileSync(file, 'utf8'));

/* What the fetchers could not rebuild if this were re-added tomorrow. */
const stats = { editions: doc.editions.length, dated: 0, confirmed: 0, locked: 0, notes: 0 };
for (const e of doc.editions) for (const m of e.milestones || []) {
  if (m.date) stats.dated++;
  if (m.confidence === 'confirmed') stats.confirmed++;
  if (m.locked) stats.locked++;
  if (m.note) stats.notes++;
}
const pinned = (doc.sources || []).filter((s) => s.track || s.adapter?.startsWith('custom'));

console.log(`${doc.name}${doc.full_name ? ' — ' + doc.full_name : ''}`);
console.log(`  ${stats.editions} 屆、${stats.dated} 個有日期的里程碑`);
console.log(`  其中 ${stats.confirmed} 個官方確認、${stats.locked} 個 locked、${stats.notes} 條註記`);
if (pinned.length) console.log(`  ${pinned.length} 個手動設定的來源（track / 自訂 adapter）`);
if (doc.rank?.value) console.log(`  排名 ${doc.rank.value}（${doc.rank.source}）`);

if (HIDE && doc.hidden) { console.log('\n已經是隱藏狀態，沒有變更。'); process.exit(0); }

if (DRY) { console.log(`\n(dry run) 會${HIDE ? '設為隱藏' : '刪除檔案'}，未實際變更。`); process.exit(0); }

if (HIDE) {
  doc.hidden = true;
  saveConference({ ...doc, _file: `${id}.yml` });
  console.log(`\n已設為 hidden: true。檔案保留，資料一個都沒少；把那一行拿掉就會回來。`);
} else {
  fs.unlinkSync(file);
  console.log(`\n已刪除 data/conferences/${id}.yml`);
  console.log(`要救回來：git revert <這次的 commit>，或 git checkout <前一個 commit> -- data/conferences/${id}.yml`);
  console.log(`只是想讓它不顯示的話，下次用 --hide：資料留著，隨時可以復原。`);
}

/* Leave nothing pointing at a venue that is gone. */
const wishlist = path.join(CONF_DIR, '..', 'wishlist.txt');
if (fs.existsSync(wishlist)) {
  const before = fs.readFileSync(wishlist, 'utf8');
  const after = before.split('\n')
    .filter((l) => l.replace(/#.*/, '').trim().toLowerCase() !== id).join('\n');
  if (after !== before && !HIDE) {
    fs.writeFileSync(wishlist, after);
    console.log('也從 wishlist.txt 移除了（否則今晚的 cron 會把它加回來）。');
  }
}

if (!HIDE) {
  const q = readReviewQueue();
  const keptQ = q.filter((r) => r.conference !== id);
  if (keptQ.length !== q.length) { writeReviewQueue(keptQ); console.log(`清掉 ${q.length - keptQ.length} 筆待確認項目。`); }

  const acks = loadAcks();
  const keptA = acks.filter((a) => a.conference !== id);
  if (keptA.length !== acks.length) { saveAcks(keptA); console.log(`清掉 ${acks.length - keptA.length} 筆確認紀錄。`); }
}

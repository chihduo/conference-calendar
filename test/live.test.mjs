#!/usr/bin/env node
/* The one suite that reads live data. It asserts only what stays true of any
   correct data - every view renders without an error, even with a paper
   tracked at every edition in every status - so nothing here goes stale when
   a date is announced or passes. That walks pending() and the empty-state
   reasons over whatever shapes the nightly refresh writes. Facts about a
   particular venue belong in the fixture suites (see page.mjs).
     npm run build && npm run test:live
*/
import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

if (!fs.existsSync('dist/index.html')) {
  console.error('找不到 dist/index.html，先跑 npm run build');
  process.exit(1);
}
const html = fs.readFileSync('dist/index.html', 'utf8');

function boot(subs = []) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  vc.on('error', (...a) => errors.push(a.join(' ')));
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
    { runScripts: 'dangerously', url: 'https://example.org/', virtualConsole: vc });
  const w = dom.window;
  w.confirm = () => false;
  w.localStorage.setItem('cc-submissions', JSON.stringify({ schema: 1, submissions: subs }));
  w.document.body.innerHTML = html.replace(/<script>[\s\S]*<\/script>/, '');
  // Local-only: the built page carries the real sync config, and this suite is about the data.
  try {
    w.eval(html.match(/<script>([\s\S]*)<\/script>/)[1]
      .replace(/window\.__SYNC_CONFIG__ = [\s\S]*?;/, 'window.__SYNC_CONFIG__ = null;')
      + '\nglobalThis.__live = { DATA, STATUSES };');
  } catch (e) { errors.push(String(e)); }
  return { dom, w, errors };
}
const tab = (w, name) => [...w.document.querySelectorAll('.tab')].find((t) => t.textContent.includes(name)).click();
const toggle = (w, name) => [...w.document.querySelectorAll('#main label.toggle')]
  .find((l) => l.textContent.includes(name)).querySelector('input').click();

let pass = 0, total = 0;
const check = (n, c, got = '') => { total++; if (c) pass++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${got ? '  → ' + got : ''}`); };

let DATA, STATUSES;
console.log('=== 每個分頁都畫得出來 ===');
{
  const { dom, w, errors } = boot();
  if (!w.__live) {   // the script died before its last line; nothing below can run
    console.log(`  FAIL 頁面載入就出錯  → ${errors.slice(0, 3).join(' | ')}`);
    process.exit(1);
  }
  ({ DATA, STATUSES } = w.__live);
  const nEd = DATA.conferences.reduce((n, c) => n + c.editions.length, 0);
  console.log(`  資料產生於 ${DATA.generated_at.slice(0, 10)}：${DATA.conferences.length} 個會議、${nEd} 屆`);
  const rows = w.document.querySelectorAll('#main .row').length;
  check('時間軸有列', rows > 0, `${rows} 列`);
  toggle(w, '顯示已過期');
  const withPast = w.document.querySelectorAll('#main .row').length;
  check('顯示已過期之後列數不減', withPast >= rows, `${withPast} 列`);
  tab(w, '依會議');
  const cards = w.document.querySelectorAll('#main .card').length;
  check('依會議：每個會議一張卡', cards === DATA.conferences.length, `${cards}/${DATA.conferences.length}`);
  tab(w, '我的投稿');
  check('我的投稿：空狀態', !!w.document.querySelector('#main .empty'));
  check('過程中沒有任何錯誤', errors.length === 0, errors.slice(0, 3).join(' | '));
  dom.window.close();
}

console.log('\n=== 每一屆、每種狀態各追蹤一篇 ===');
{
  const subs = DATA.conferences.flatMap((c) => c.editions.flatMap((e) =>
    STATUSES.map(([status]) => ({ id: `${e.id}~${status}`, paper: `${e.id} ${status}`, venue: e.id, status, history: [] }))));
  const { dom, w, errors } = boot(subs);
  tab(w, '我的投稿');
  const cards = [...w.document.querySelectorAll('#main .card')].filter((c) => c.querySelector('h3'));
  check('每篇都有一張卡', cards.length === subs.length, `${cards.length}/${subs.length}`);
  const blank = cards.filter((c) => !c.querySelector('.ms-table, .note'));
  check('每張卡不是列出待辦，就是說明為什麼沒有', blank.length === 0,
        blank.slice(0, 3).map((c) => c.querySelector('h3').textContent).join(', '));
  tab(w, '截稿時間軸');
  const mine = w.document.querySelectorAll('#main .row.mine').length;
  check('時間軸標出追蹤中的列', mine > 0, `${mine} 列`);
  tab(w, '依會議');
  check('過程中沒有任何錯誤', errors.length === 0, errors.slice(0, 3).join(' | '));
  dom.window.close();
}

console.log(`\n${pass}/${total} 通過`);
process.exit(pass === total ? 0 : 1);

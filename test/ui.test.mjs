#!/usr/bin/env node
/* Browser-level regression tests, run against the built dist/index.html in a
   real DOM. A hand-rolled stub is not enough here: it dispatches no events and
   implements every API, so it happily passed code that was dead in a browser.
   window.confirm is stubbed to return false throughout, which is exactly what a
   sandboxed iframe without allow-modals does - the published artifact runs in
   one, and that is how the delete button came to look broken.
     npm run test:ui
*/
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

function boot() {
  const html = fs.readFileSync('dist/index.html', 'utf8');
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
    { runScripts: 'dangerously', url: 'https://example.org/' });
  const { window } = dom;
  window.localStorage.setItem('cc-submissions', JSON.stringify({ schema: 1, submissions: [
    { id: 'p1', paper: 'Paper ONE', venue: 'vmcai-2027', status: 'submitted', history: [] },
    { id: 'p2', paper: 'Paper TWO', venue: 'tacas-2027', status: 'planned',   history: [] },
  ]}));
  // what a sandboxed iframe without allow-modals actually does
  window.confirm = () => false;
  window.alert = () => {};
  window.document.body.innerHTML = html.replace(/<script>[\s\S]*<\/script>/, '');
  window.eval(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  [...window.document.querySelectorAll('.tab')].find(t => t.textContent.includes('我的投稿')).click();
  return { dom, window };
}
const subsOf = (w) => JSON.parse(w.localStorage.getItem('cc-submissions')).submissions;
const titles = (w) => [...w.document.querySelectorAll('#main .card')]
  .filter(c => c.querySelector('h3')).map(c => c.querySelector('h3').textContent);
const btns = (w) => [...w.document.querySelectorAll('#main button')].filter(b => /刪除|再按一次/.test(b.textContent));

let pass = 0, total = 0;
const check = (name, cond, detail = '') => { total++; if (cond) pass++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };

console.log('=== 兩段式刪除(confirm 被封鎖)===');
{
  const { dom, window: w } = boot();
  const before = titles(w);
  console.log('  卡片順序(依下一個待辦排序): ' + before.join(', '));
  btns(w)[0].click();
  check('第一次點只是待確認', subsOf(w).length === 2, `按鈕變成「${btns(w)[0].textContent}」`);
  btns(w)[0].click();
  const after = subsOf(w).map(x => x.paper);
  check('第二次點才真的刪除', after.length === 1 && after[0] !== before[0].trim(),
        `剩下 ${after.join(', ')}`);
  check('畫面同步更新', titles(w).length === 1);
  dom.window.close();
}

console.log('\n=== 4 秒未確認自動還原 ===');
{
  const { dom, window: w } = boot();
  btns(w)[0].click();
  check('已進入待確認', btns(w)[0].textContent === '再按一次確認');
  await new Promise(r => setTimeout(r, 4300));
  check('逾時還原成「刪除」', btns(w)[0].textContent === '刪除');
  check('資料未被動到', subsOf(w).length === 2);
  dom.window.close();
}

console.log('\n=== 刪光之後 ===');
{
  const { dom, window: w } = boot();
  for (let i = 0; i < 2; i++) { btns(w)[0].click(); btns(w)[0].click(); }
  check('兩筆都刪掉', subsOf(w).length === 0);
  check('顯示空狀態提示', (w.document.querySelector('#main .empty')?.textContent || '').includes('還沒有投稿紀錄'));
  dom.window.close();
}

console.log(`\n${pass}/${total} 通過`);
process.exit(pass === total ? 0 : 1);

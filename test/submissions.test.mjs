#!/usr/bin/env node
/* Empty-state behaviour in 我的投稿, driven through a real DOM.
   pending() returning nothing has three causes and they must not share one
   message: POPL 2027's dates are confirmed and past, not unpublished.
     npm run test:subs
*/
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

function boot(subs) {
  const html = fs.readFileSync('dist/index.html', 'utf8');
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
    { runScripts: 'dangerously', url: 'https://example.org/' });
  const { window } = dom;
  window.localStorage.setItem('cc-submissions', JSON.stringify({ schema: 1, submissions: subs }));
  window.confirm = () => false; window.alert = () => {};
  window.document.body.innerHTML = html.replace(/<script>[\s\S]*<\/script>/, '');
  window.eval(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  [...window.document.querySelectorAll('.tab')].find(t => t.textContent.includes('我的投稿')).click();
  return { dom, window };
}
const noteOf = (w) => (w.document.querySelector('#main .card .note')?.textContent || '').trim();
const venueOf = (w) => JSON.parse(w.localStorage.getItem('cc-submissions')).submissions[0].venue;

let pass = 0, total = 0;
const check = (name, cond, got = '') => { total++; if (cond) pass++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${got ? '  → 「' + got + '」' : ''}`); };

console.log('=== 三種空集合成因要說三種話 ===');
{
  // POPL 2027: dates confirmed, submission closed 2026-07-09
  const { dom, window: w } = boot([{ id: 'a', paper: 'P', venue: 'popl-2027', status: 'planned', history: [] }]);
  const n = noteOf(w);
  check('已截止 → 說出截止日，不再謊稱未公布', /已於 2026-07-09 截止/.test(n) && !/還沒公布/.test(n), n.slice(0, 40));
  dom.window.close();
}
{
  // ECAI 2027: milestones exist but carry no dates
  const { dom, window: w } = boot([{ id: 'a', paper: 'P', venue: 'ecai-2027', status: 'planned', history: [] }]);
  check('真的未公布 → 維持原訊息', /還沒公布/.test(noteOf(w)), noteOf(w));
  dom.window.close();
}
{
  const { dom, window: w } = boot([{ id: 'a', paper: 'P', venue: 'vmcai-2027', status: 'registered', history: [] }]);
  check('流程走完 → 不是「未公布」', /等著去開會/.test(noteOf(w)), noteOf(w));
  dom.window.close();
}

console.log('\n=== 截止後給出路 ===');
{
  const { dom, window: w } = boot([{ id: 'a', paper: 'P', venue: 'popl-2027', status: 'planned', history: [] }]);
  const btn = [...w.document.querySelectorAll('#main .note button')][0];
  check('提供改投下一屆的按鈕', !!btn && /改投 POPL 2028/.test(btn.textContent), btn?.textContent);
  btn.click();
  check('按下後真的換成 popl-2028', venueOf(w) === 'popl-2028', venueOf(w));
  const after = w.document.querySelector('#main .ms-table');
  check('換屆後出現待辦日期', !!after);
  dom.window.close();
}

console.log('\n=== 下拉選單先標示,降低誤選 ===');
{
  const { dom, window: w } = boot([]);
  const opts = [...w.document.querySelectorAll('#main select option')].map(o => o.textContent);
  check('POPL 2027 標為已截止', opts.some(o => /POPL 2027（投稿已截止）/.test(o)),
        opts.find(o => o.startsWith('POPL 2027')));
  check('POPL 2028 未標為已截止', opts.some(o => /^POPL 2028/.test(o) && !/已截止/.test(o)),
        opts.find(o => o.startsWith('POPL 2028')));
  dom.window.close();
}

console.log(`\n${pass}/${total} 通過`);
process.exit(pass === total ? 0 : 1);

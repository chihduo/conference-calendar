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

console.log('\n=== 改標題 ===');
{
  const { dom, window: w } = boot([{ id: 'a', paper: '舊標題', venue: 'vmcai-2027', status: 'submitted', history: [] }]);
  const doc = w.document;
  const titleOf = () => doc.querySelector('#main .card h3')?.textContent.trim();
  const btn = (t) => [...doc.querySelectorAll('#main .card button')].find((b) => b.textContent === t);
  const field = () => doc.querySelector('#main .title-edit');
  const stored = () => JSON.parse(w.localStorage.getItem('cc-submissions')).submissions[0].paper;

  check('一開始顯示標題', titleOf() === '舊標題', titleOf());
  btn('改標題').click();
  check('點「改標題」出現輸入框並帶入原值', field()?.value === '舊標題', field()?.value);

  field().value = '新的標題';
  btn('儲存').click();
  check('儲存後畫面更新', titleOf() === '新的標題', titleOf());
  check('儲存後寫進 localStorage', stored() === '新的標題', stored());

  btn('改標題').click();
  field().value = '不該存下的東西';
  btn('取消').click();
  check('取消不會改到資料', stored() === '新的標題', stored());
  check('取消後回到純文字', titleOf() === '新的標題' && !field());

  btn('改標題').click();
  field().value = '   ';
  btn('儲存').click();
  check('空白標題不接受（卡片會變得無法辨識）', stored() === '新的標題' && !!field());
  dom.window.close();
}

{
  // the timeline chip reads the same field, so a rename must show up there too
  const { dom, window: w } = boot([{ id: 'a', paper: '原標題', venue: 'vmcai-2027', status: 'submitted', history: [] }]);
  const doc = w.document;
  [...doc.querySelectorAll('#main .card button')].find((b) => b.textContent === '改標題').click();
  doc.querySelector('#main .title-edit').value = '改過的標題';
  [...doc.querySelectorAll('#main .card button')].find((b) => b.textContent === '儲存').click();
  [...doc.querySelectorAll('.tab')].find((t) => t.textContent.includes('截稿時間軸')).click();
  const chips = [...doc.querySelectorAll('#main .mine-chip')].map((c) => c.textContent.replace('▸ ', ''));
  check('時間軸上的標籤跟著改名', chips.length > 0 && chips.every((c) => c === '改過的標題'),
        chips[0]);
  dom.window.close();
}

console.log(`\n${pass}/${total} 通過`);
process.exit(pass === total ? 0 : 1);

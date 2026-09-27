#!/usr/bin/env node
/* The conference-requests Edge Function, run under Node against a stand-in for
   Supabase Auth and the GitHub API. The live function holds a real token and
   answers to a real login, so what can be pinned here is everything around
   them: who is turned away and when, what reaches GitHub, and how a thread of
   bot replies reads back as a request's state.
     npm run test:function
*/
import fs from 'node:fs';
import { makeHandler, summarize } from '../supabase/functions/conference-requests/index.ts';

const OWNER = { id: 19280052, login: 'chihduo' };
const REPO = '/repos/chihduo/conference-calendar';

function world({ caller = OWNER.id, tokenOk = true } = {}) {
  const issues = new Map(), comments = new Map(), calls = [];
  let next = 100, clock = Date.parse('2026-09-28T00:00:00Z');
  const tick = () => new Date(clock += 60000).toISOString();
  const res = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(url);
    if (u.pathname === '/auth/v1/user') {
      return init.headers.Authorization === 'Bearer good-jwt'
        ? res(200, { id: 'u1', identities: [{ provider: 'github', identity_data: { sub: String(caller) } }] })
        : res(401, { msg: 'invalid JWT' });
    }
    calls.push(`${method} ${u.pathname}`);
    if (!tokenOk) return res(401, { message: 'Bad credentials' });
    if (u.pathname === '/user') return res(200, OWNER);
    let m;
    if (u.pathname === `${REPO}/issues` && method === 'POST') {
      const b = JSON.parse(init.body);
      const i = { number: ++next, html_url: `https://github.com/i/${next}`, title: b.title, body: b.body, state: 'open',
                  labels: b.labels.map((name) => ({ name })), created_at: tick(), comments: 0 };
      issues.set(i.number, i);
      return res(201, i);
    }
    if (u.pathname === `${REPO}/issues`) {
      const label = u.searchParams.get('labels');
      return res(200, [...issues.values()].filter((i) => i.labels.some((l) => l.name === label)));
    }
    if ((m = new RegExp(`^${REPO}/issues/(\\d+)$`).exec(u.pathname))) {
      const i = issues.get(Number(m[1]));
      if (!i) return res(404, { message: 'Not Found' });
      if (method === 'PATCH') Object.assign(i, JSON.parse(init.body));
      return res(200, i);
    }
    if ((m = new RegExp(`^${REPO}/issues/(\\d+)/comments$`).exec(u.pathname))) {
      const n = Number(m[1]), list = comments.get(n) || [];
      if (method === 'POST') {
        list.push({ body: JSON.parse(init.body).body, user: { type: 'User', login: OWNER.login }, created_at: tick() });
        comments.set(n, list); issues.get(n).comments = list.length;
        return res(201, list[list.length - 1]);
      }
      return res(200, list);
    }
    return res(500, { message: `stub has no ${method} ${u.pathname}` });
  };
  const bot = (n, body) => {
    const list = comments.get(n) || [];
    list.push({ body, user: { type: 'Bot', login: 'github-actions[bot]' }, created_at: tick() });
    comments.set(n, list); issues.get(n).comments = list.length;
  };
  const env = (k) => ({ SUPABASE_URL: 'https://proj.supabase.co', CC_GITHUB_TOKEN: 'pat' })[k];
  const handler = makeHandler({ env, fetch });
  const call = async (method, { path = '', auth = 'Bearer good-jwt', origin = 'https://chihduo.github.io', body } = {}) => {
    const r = await handler(new Request(`https://proj.supabase.co/functions/v1/conference-requests${path}`, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { ...(auth ? { Authorization: auth } : {}), Origin: origin, apikey: 'publishable' },
    }));
    const text = await r.text();
    return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : null };
  };
  return { call, bot, issues, comments, calls };
}

let pass = 0, total = 0;
const check = (n, c, got = '') => { total++; if (c) pass++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${got ? '  → ' + got : ''}`); };

console.log('=== 誰可以用 ===');
{
  const w = world();
  let r = await w.call('OPTIONS');
  check('預檢：網站來源拿到 CORS 許可', r.status === 204 && r.headers.get('access-control-allow-origin') === 'https://chihduo.github.io');
  r = await w.call('OPTIONS', { origin: 'https://evil.example' });
  check('預檢：別的來源沒有', !r.headers.get('access-control-allow-origin'));
  r = await w.call('GET', { auth: '' });
  check('沒登入 → 401，也沒碰 GitHub', r.status === 401 && w.calls.length === 0, r.json.error);
  r = await w.call('GET', { auth: 'Bearer forged' });
  check('登入無效 → 401', r.status === 401, r.json.error);
}
{
  const w = world({ caller: 999 });
  const r = await w.call('POST', { body: { action: 'add', acronym: 'S&P' } });
  check('登入的不是 token 主人 → 403', r.status === 403, r.json.error);
  check('而且沒有開出任何 issue', !w.calls.some((c) => c.startsWith('POST')));
}
{
  const w = world({ tokenOk: false });
  const r = await w.call('GET');
  check('token 失效時說清楚要去哪裡換', r.status === 502 && /CC_GITHUB_TOKEN/.test(r.json.error), r.json.error);
}

console.log('\n=== 開出去的 issue 要跟 workflow 對得上 ===');
{
  const w = world();
  let r = await w.call('POST', { body: { action: 'add', acronym: 'S&P' } });
  const add = w.issues.get(r.json.issue);
  check('新增：標題是縮寫、標籤 add-conference', r.status === 201 && add.title === 'S&P' &&
        add.labels.map((l) => l.name).join() === 'add-conference', `#${r.json.issue} ${add.title}`);
  check('剛開出來是等待中', r.json.phase === 'waiting' && r.json.kind === 'add');

  // the remove workflow's own test for "hide": a ticked box on its own line
  const hides = (body) => body.split('\n').some((l) => /^[\s]*-[\s]*\[[xX]\]/.test(l));
  r = await w.call('POST', { body: { action: 'remove', acronym: 'CAV' } });
  const rm = w.issues.get(r.json.issue);
  check('移除：標籤 remove-conference，內文沒有勾選（會真的刪）',
        rm.labels.map((l) => l.name).join() === 'remove-conference' && !hides(rm.body) && r.json.kind === 'remove');
  r = await w.call('POST', { body: { action: 'hide', acronym: 'CAV' } });
  const hd = w.issues.get(r.json.issue);
  check('隱藏：同一個標籤，內文勾了「只隱藏」', hd.labels.map((l) => l.name).join() === 'remove-conference' &&
        hides(hd.body) && r.json.kind === 'hide');

  const before = w.calls.filter((c) => c.startsWith('POST')).length;
  for (const bad of ['USENIX Security', "x'; rm -rf /", '', 'A'.repeat(20)]) {
    r = await w.call('POST', { body: { action: 'add', acronym: bad } });
    if (r.status !== 400) check(`擋下「${bad}」`, false, String(r.status));
  }
  check('不像縮寫的四種輸入都在碰 GitHub 之前擋下', w.calls.filter((c) => c.startsWith('POST')).length === before);
  r = await w.call('POST', { body: { action: 'merge' } });
  check('不認得的動作 → 400', r.status === 400, r.json.error);
}
{
  // the function and both workflows must share one whitelist, or a request
  // passes here and dies there with nothing for the page to show
  const src = fs.readFileSync('supabase/functions/conference-requests/index.ts', 'utf8');
  const fn = /const ACRONYM = \/(.+?)\/;/.exec(src)[1];
  const wf = ['add', 'remove'].map((k) => /grep -oE '([^']+)'/.exec(fs.readFileSync(`.github/workflows/${k}-conference.yml`, 'utf8'))[1]);
  check('函式和兩支 workflow 用同一個縮寫白名單', wf.every((p) => p === fn), `${fn} | ${wf.join(' | ')}`);
}

console.log('\n=== 從 bot 的回覆讀出進度 ===');
{
  const w = world();
  const n = (await w.call('POST', { body: { action: 'add', acronym: 'FSE' } })).json.issue;
  w.bot(n, '已建立 `data/conferences/fse.yml`，但有一處需要你決定。\n\n### ICORE 裡有 2 筆叫 FSE 的會議，是哪一個？\n\n**1.** A* — ACM FSE\n**2.** B — Fast Software Encryption\n\n' +
           '<!-- cc-choices: {"acronym":"FSE","id":"fse","choices":[{"field":"icore_id","question":"ICORE 裡有 2 筆叫 FSE 的會議，是哪一個？","options":[{"value":"1","label":"A* — ACM FSE"},{"value":"2","label":"B — Fast Software Encryption"}]}]} -->');
  w.issues.get(n).labels.push({ name: 'needs-choice' });
  let r = await w.call('GET', { path: `?issue=${n}` });
  check('問選擇題時是 needs-choice，選項讀得出來',
        r.json.phase === 'needs-choice' && r.json.choices?.[0]?.options?.length === 2, r.json.choices?.[0]?.question);

  r = await w.call('POST', { body: { action: 'reply', issue: n, text: '1' } });
  check('回覆之後回到等待中', r.json.phase === 'waiting' && w.comments.get(n).at(-1).body === '1');

  w.bot(n, '看不懂「3」對應到哪個選項。請回覆選項編號（例如 1），或選項的完整名稱。');
  r = await w.call('GET', { path: `?issue=${n}` });
  check('看不懂的回覆：題目還在，並顯示 bot 的說明',
        r.json.phase === 'needs-choice' && r.json.choices?.length === 1 && /看不懂/.test(r.json.message), r.json.message);

  w.bot(n, '已套用：icore_id = 1\n\n不需要其他處理。');
  w.issues.get(n).state = 'closed';
  r = await w.call('GET', { path: `?issue=${n}` });
  check('關掉了就是完成', r.json.phase === 'done' && /已套用/.test(r.json.message), r.json.message);
  r = await w.call('POST', { body: { action: 'reply', issue: n, text: '2' } });
  check('已結束的不能再回覆', r.status === 409, r.json.error);
}
{
  const w = world();
  const n = (await w.call('POST', { body: { action: 'add', acronym: 'ZZQ' } })).json.issue;
  w.bot(n, '**沒有新增 ZZQ**：沒有寫出任何檔案。\n\n**需要你處理 1 件事：**\n- 1. 沒有任何來源有日期。\n\n<details><summary>完整輸出</summary>\n\n```\nlog\n```\n</details>');
  let r = await w.call('GET', { path: `?issue=${n}` });
  check('回了但沒關：卡住，訊息去掉 markdown 和收起來的輸出',
        r.json.phase === 'stuck' && r.json.message.startsWith('沒有新增 ZZQ') && !/details|\*\*|log/.test(r.json.message), r.json.message.split('\n')[0]);
  r = await w.call('POST', { body: { action: 'dismiss', issue: n } });
  check('卡住的可以關掉', r.json.dismissed === true && w.issues.get(n).state === 'closed');

  r = await w.call('GET');
  check('清單：帶上 owner 和最近的請求', r.json.owner === 'chihduo' && r.json.requests.length === 1, `${r.json.requests.length} 筆`);
}
{
  const w = world();
  w.issues.set(7, { number: 7, title: 'typo in README', body: '', state: 'open', labels: [{ name: 'bug' }], created_at: '2026-09-01T00:00:00Z', comments: 0 });
  let r = await w.call('GET', { path: '?issue=7' });
  check('別的 issue 讀不到', r.status === 404, r.json.error);
  r = await w.call('POST', { body: { action: 'reply', issue: 7, text: 'hi' } });
  check('也不能代你回覆', r.status === 404 && !(w.comments.get(7) || []).length);
  r = await w.call('POST', { body: { action: 'dismiss', issue: 7 } });
  check('也不能關掉', r.status === 404 && w.issues.get(7).state === 'open');
}

console.log('\n=== 單看一則 thread ===');
{
  const issue = { number: 1, state: 'open', labels: [{ name: 'add-conference' }], created_at: '2026-09-28T00:00:00Z' };
  const s = summarize(issue, [{ user: { type: 'Bot' }, created_at: '2026-09-27T23:59:00Z', body: '舊的回覆' }]);
  check('比請求還早的 bot 留言不算回覆', s.phase === 'waiting' && s.message === '');
}

console.log(`\n${pass}/${total} 通過`);
process.exit(pass === total ? 0 : 1);

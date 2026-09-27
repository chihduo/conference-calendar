/* Owner-only bridge from the site to the issue-driven add/remove workflows.

   The site cannot run the discovery cascade itself: ICORE, researchr and
   WikiCFP send no CORS headers, and the result has to be committed. The
   workflows already do both when an issue is labelled, so the site only has to
   open that issue and read the bot's replies. This function does it with a
   token that never reaches the browser.

   Two gates, both required. The caller must be signed in (Supabase Auth says
   who they are), and that GitHub account must be the one that owns
   CC_GITHUB_TOKEN - asked of GitHub, so no account id is configured anywhere.
   Everyone else gets 403 before any GitHub call made on their behalf.

   It can do nothing but this: open an issue labelled add-conference or
   remove-conference with a whitelisted title, read such issues, answer the
   bot's pending question on one, or close one. The token needs Issues:
   read/write on this one repository and nothing else.

   One file with no imports, so it pastes into the dashboard editor as is.
   makeHandler takes env and fetch so test/function.test.mjs can drive the
   real handler under Node. */

const LABELS = { add: 'add-conference', remove: 'remove-conference' };
const ACRONYM = /^[A-Za-z][A-Za-z0-9&+-]{1,15}$/;        // the workflows' own whitelist
// the remove workflow reads a ticked box, exactly as the issue template renders it
const HIDE_BODY = '### 選項\n\n- [x] 只隱藏，不要刪除（檔案與資料完整保留，隨時可以恢復）\n\n從網站送出。';
const CHOICES = /<!--\s*cc-choices:\s*(\{[\s\S]*?\})\s*-->/;
const RECENT_DAYS = 14;

class Fail extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/* The bot's reply as plain text: what comes before the collapsed log and the
   choices marker, with the markdown that would show as noise stripped. */
export function plain(body: string): string {
  return String(body || '')
    .split(/<details>|<!--\s*cc-choices/)[0]
    .replace(/^#+\s*/gm, '').replace(/[*`]/g, '')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, 1200);
}

/* Where a request stands, read off the issue and its thread.
   waiting       the bot has not answered the latest thing the owner did
   needs-choice  the bot asked a pick-from-a-list question and awaits a reply
   done          the issue is closed: the bot closes only on a real result
   stuck         answered and still open - failed or rejected, see message */
export function summarize(issue: any, comments: any[]) {
  const labels = (issue.labels || []).map((l: any) => (typeof l === 'string' ? l : l.name));
  const bot = comments.filter((c) => c.user?.type === 'Bot');
  const last = bot[bot.length - 1] || null;
  const owner = comments.filter((c) => c.user?.type !== 'Bot').map((c) => Date.parse(c.created_at));
  const lastAsk = Math.max(Date.parse(issue.created_at), ...owner);
  const answered = !!last && Date.parse(last.created_at) >= lastAsk;
  const asked = bot.filter((c) => CHOICES.test(c.body || '')).pop();
  const phase = !answered ? 'waiting'
    : issue.state === 'closed' ? 'done'
    : labels.includes('needs-choice') && asked ? 'needs-choice'
    : 'stuck';
  let choices = null;
  if (phase === 'needs-choice') {
    try { choices = JSON.parse(CHOICES.exec(asked.body)![1]).choices; } catch { choices = null; }
  }
  return {
    issue: issue.number, url: issue.html_url, title: issue.title,
    kind: labels.includes(LABELS.add) ? 'add' : /^\s*-\s*\[[xX]\]/m.test(issue.body || '') ? 'hide' : 'remove',
    phase, created_at: issue.created_at,
    message: last && answered ? plain(last.body) : '',
    choices,
  };
}

export function makeHandler({ env, fetch }: { env: (key: string) => string | undefined; fetch: typeof globalThis.fetch }) {
  const repo = () => env('CC_REPO') || 'chihduo/conference-calendar';
  const origins = () => new Set((env('CC_ALLOWED_ORIGINS') || 'https://chihduo.github.io').split(',').map((s) => s.trim()));
  let tokenOwner: { id: number; login: string } | null = null;

  async function gh(path: string, init: any = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env('CC_GITHUB_TOKEN') || ''}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'conference-calendar',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (res.status === 401) throw new Fail(502, 'GitHub token 無效或已過期：到 Supabase 的 Edge Function Secrets 更新 CC_GITHUB_TOKEN。');
    if (res.status === 403 || res.status === 404) {
      throw new Fail(502, `GitHub 拒絕了這個動作（${res.status}）：token 需要這個 repo 的 Issues 讀寫權限。`);
    }
    if (!res.ok) throw new Fail(502, `GitHub 回應 ${res.status}：${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  }

  async function requireOwner(req: Request) {
    const auth = req.headers.get('Authorization') || '';
    if (!/^Bearer\s+\S+/.test(auth)) throw new Fail(401, '請先登入');
    const who = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
      headers: { Authorization: auth, apikey: req.headers.get('apikey') || env('SUPABASE_ANON_KEY') || '' },
    });
    if (!who.ok) throw new Fail(401, '登入已過期，請重新登入');
    const user = await who.json();
    const github = (user.identities || []).find((i: any) => i.provider === 'github');
    const id = String(github?.identity_data?.sub ?? github?.id ?? user.user_metadata?.provider_id ?? '');
    tokenOwner ??= await gh('/user');
    if (!id || id !== String(tokenOwner!.id)) throw new Fail(403, `只有 ${tokenOwner!.login} 可以管理會議`);
    return tokenOwner!;
  }

  const ours = (issue: any) => {
    const labels = (issue.labels || []).map((l: any) => (typeof l === 'string' ? l : l.name));
    if (issue.pull_request || !labels.some((l: string) => l === LABELS.add || l === LABELS.remove)) {
      throw new Fail(404, `#${issue.number} 不是增刪會議的 issue`);
    }
    return issue;
  };
  const issueNo = (v: any) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Fail(400, 'issue 編號不對');
    return n;
  };
  const thread = (n: number) => gh(`/repos/${repo()}/issues/${n}/comments?per_page=100`);

  async function one(n: number) {
    const issue = ours(await gh(`/repos/${repo()}/issues/${n}`));
    return summarize(issue, await thread(n));
  }

  async function recent() {
    const lists = await Promise.all(Object.values(LABELS).map((l) =>
      gh(`/repos/${repo()}/issues?labels=${l}&state=all&sort=created&direction=desc&per_page=6`)));
    const since = Date.now() - RECENT_DAYS * 86400e3;
    const issues = lists.flat()
      .filter((i: any) => !i.pull_request && Date.parse(i.created_at) > since)
      .sort((a: any, b: any) => b.number - a.number).slice(0, 6);
    return Promise.all(issues.map(async (i: any) => summarize(i, i.comments ? await thread(i.number) : [])));
  }

  async function open(action: string, acronym: any) {
    const title = String(acronym ?? '').trim();
    if (!ACRONYM.test(title)) {
      throw new Fail(400, `「${title}」不像會議縮寫：英文字母開頭、2 到 16 個字元，可以有數字和 & + -`);
    }
    const issue = await gh(`/repos/${repo()}/issues`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        labels: [action === 'add' ? LABELS.add : LABELS.remove],
        body: action === 'hide' ? HIDE_BODY : action === 'remove' ? '從網站送出：刪除。' : '從網站送出。',
      }),
    });
    return summarize(issue, []);
  }

  async function answer(n: number, text: any) {
    const t = String(text ?? '').trim();
    if (!t || t.length > 200) throw new Fail(400, '回覆要是 1 到 200 個字');
    const issue = ours(await gh(`/repos/${repo()}/issues/${n}`));
    if (issue.state !== 'open') throw new Fail(409, `#${n} 已經結束了`);
    await gh(`/repos/${repo()}/issues/${n}/comments`, { method: 'POST', body: JSON.stringify({ body: t }) });
    return one(n);
  }

  async function dismiss(n: number) {
    ours(await gh(`/repos/${repo()}/issues/${n}`));
    await gh(`/repos/${repo()}/issues/${n}`, {
      method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }),
    });
    return { issue: n, dismissed: true };
  }

  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get('Origin') || '';
    const cors: Record<string, string> = origins().has(origin)
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin',
          'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }
      : { Vary: 'Origin' };
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
    });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      const me = await requireOwner(req);
      if (req.method === 'GET') {
        const n = new URL(req.url).searchParams.get('issue');
        return reply(200, n ? await one(issueNo(n)) : { owner: me.login, requests: await recent() });
      }
      if (req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        switch (body.action) {
          case 'add': case 'remove': case 'hide': return reply(201, await open(body.action, body.acronym));
          case 'reply': return reply(200, await answer(issueNo(body.issue), body.text));
          case 'dismiss': return reply(200, await dismiss(issueNo(body.issue)));
        }
        throw new Fail(400, `不認得的動作：${body.action}`);
      }
      throw new Fail(405, `不支援 ${req.method}`);
    } catch (e: any) {
      if (e instanceof Fail) return reply(e.status, { error: e.message });
      return reply(500, { error: String(e?.message || e) });
    }
  };
}

const D = (globalThis as any).Deno;
if (D) D.serve(makeHandler({ env: (k: string) => D.env.get(k), fetch }));

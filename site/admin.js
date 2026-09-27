/* ---------- managing conferences from the site ----------

   Adding or removing a venue still runs as the issue-driven workflow: the
   discovery cascade needs sources that refuse browser requests, and the result
   has to be committed. The Edge Function conference-requests opens that issue
   and reads the bot's replies on our behalf, with a GitHub token the browser
   never sees. This module asks it and keeps the answers; app.js draws them.

   It stays invisible until the function says the signed-in account is its
   owner. For everyone else, and before the function is deployed, the page is
   exactly what it was. */

const ADMIN = (() => {
  const CFG = window.__SYNC_CONFIG__ || null;
  let pollMs = 6000;
  const POLLS = 60;                           // six minutes; a cascade takes one or two

  let state = 'off';                          // off | checking | owner | not-owner
  let owner = null;
  let requests = [];                          // newest first, as the function summarizes them
  let note = null;                            // the last failure, shown by the form
  const watching = new Set();
  const listeners = [];
  const emit = () => listeners.forEach((f) => { try { f(); } catch { /* a bad listener must not stall the rest */ } });

  async function call(method, { query = '', body } = {}) {
    const s = SYNC.session;
    if (!CFG || !s) throw Object.assign(new Error('請先登入'), { status: 401 });
    const res = await fetch(`${CFG.url}/functions/v1/conference-requests${query}`, {
      method,
      headers: {
        apikey: CFG.anonKey, Authorization: `Bearer ${s.access_token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  }

  function keep(r) {
    const i = requests.findIndex((x) => x.issue === r.issue);
    if (i >= 0) requests[i] = r; else requests.unshift(r);
    if (r.phase === 'waiting') watch(r.issue);
  }

  /* The bot answers in a minute or two, so ask until it has. A failed poll is
     not an answer - keep asking - but give up after POLLS so a tab left open
     does not spend the token's rate limit all night. */
  function watch(issue) {
    if (watching.has(issue)) return;
    watching.add(issue);
    let left = POLLS;
    const tick = async () => {
      if (state !== 'owner' || left-- <= 0) { watching.delete(issue); return; }
      try {
        const r = await call('GET', { query: `?issue=${issue}` });
        const i = requests.findIndex((x) => x.issue === issue);
        if (i >= 0) requests[i] = r; else requests.unshift(r);
        emit();
        if (r.phase !== 'waiting') { watching.delete(issue); return; }
      } catch { /* retry on the next tick */ }
      setTimeout(tick, pollMs);
    };
    setTimeout(tick, pollMs);
  }

  async function probe() {
    if (SYNC.status() !== 'live') { state = 'off'; requests = []; emit(); return; }
    state = 'checking';
    try {
      const r = await call('GET');
      state = 'owner'; owner = r.owner; requests = [];
      (r.requests || []).slice().reverse().forEach(keep);
    } catch (e) {
      // 403: signed in, but not the owner. Anything else - 404 before the
      // function is deployed, a CORS refusal off the real site - means off.
      state = e.status === 403 ? 'not-owner' : 'off';
    }
    emit();
  }

  async function act(body, after = keep) {
    note = null;
    try { after(await call('POST', { body })); }
    catch (e) { note = e.message; }
    emit();
  }

  // sign-in, sign-out, and going on or offline all change the answer
  SYNC.onChange(() => { probe(); });

  return {
    get state() { return state; },
    get owner() { return owner; },
    get requests() { return requests; },
    get note() { return note; },
    probe,
    submit: (action, acronym) => act({ action, acronym }),
    reply: (issue, text) => act({ action: 'reply', issue, text }),
    dismiss: (issue) => act({ action: 'dismiss', issue }, () => { requests = requests.filter((r) => r.issue !== issue); }),
    onChange: (f) => listeners.push(f),
    _pollMs: (ms) => { pollMs = ms; },          // tests
  };
})();

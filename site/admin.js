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

  let state = 'off';                          // off | checking | owner | not-owner | error
  let owner = null;
  let requests = [];                          // newest first, as the function summarizes them
  let note = null;                            // the last failure, shown by the form
  const watching = new Set();
  const listeners = [];
  const emit = () => listeners.forEach((f) => { try { f(); } catch { /* a bad listener must not stall the rest */ } });

  /* The card only exists for the owner, so the owner signed out gets no hint
     that it is there - which is how it went missing the first time. A browser
     that has seen you as the owner remembers it, and only there does 依會議
     remind you to sign in. Anyone else's page stays as it always was. */
  const OWNER_KEY = 'cc-admin-owner';
  const wasOwner = () => { try { return localStorage.getItem(OWNER_KEY) === '1'; } catch { return false; } };
  const rememberOwner = (yes) => {
    try { if (yes) localStorage.setItem(OWNER_KEY, '1'); else localStorage.removeItem(OWNER_KEY); } catch { /* storage blocked: no reminder */ }
  };

  async function call(method, { query = '', body } = {}) {
    const tok = CFG ? await SYNC.token() : null;
    if (!tok) throw Object.assign(new Error('請先登入'), { status: 401 });
    const res = await fetch(`${CFG.url}/functions/v1/conference-requests${query}`, {
      method,
      headers: {
        apikey: CFG.anonKey, Authorization: `Bearer ${tok}`,
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
      state = 'owner'; owner = r.owner; requests = []; note = null;
      rememberOwner(true);
      (r.requests || []).slice().reverse().forEach(keep);
    } catch (e) {
      // 403: signed in as someone else. 404 before the function is deployed,
      // or no status at all (a CORS refusal off the real site): the feature
      // is simply off. Anything else is a fault worth saying out loud, such as
      // an expired GitHub token.
      if (e.status === 403) { state = 'not-owner'; rememberOwner(false); }
      else if (e.status === 404 || !e.status) state = 'off';
      else { state = 'error'; note = e.message; }
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
    get wasOwner() { return wasOwner(); },
    probe,
    submit: (action, acronym) => act({ action, acronym }),
    reply: (issue, text) => act({ action: 'reply', issue, text }),
    dismiss: (issue) => act({ action: 'dismiss', issue }, () => { requests = requests.filter((r) => r.issue !== issue); }),
    onChange: (f) => listeners.push(f),
    _pollMs: (ms) => { pollMs = ms; },          // tests
  };
})();

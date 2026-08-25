/* ---------- B1 sync: online writes, read-only cache ----------

   Writes always go to the database; the browser never holds a writable copy.
   Two devices therefore cannot diverge, so there is no merge step and no
   conflict resolution - the complexity that a local-first design would force.
   What remains is the stale-tab hazard: a page opened this morning writing over
   a change made at noon that it never saw. updated_at handles that as a
   compare-and-set token.

   The cache exists purely so a phone with no signal still shows what you
   submitted. It is never written back, which is exactly why divergence cannot
   start. Controls are disabled while offline.

   Talks to Supabase over plain REST (PostgREST + GoTrue). The official SDK
   would be ~150KB of bundle for calls that are four fetches, and the page's
   single-file, no-CDN property is worth more than the convenience. */

const SYNC = (() => {
  const CFG = window.__SYNC_CONFIG__ || null;      // {url, anonKey}; absent = feature off
  const SESSION_KEY = 'cc-session';
  const CACHE_KEY = 'cc-subs-cache';

  let session = null;
  let online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  const listeners = [];
  const emit = () => listeners.forEach((f) => { try { f(); } catch { /* a bad listener must not stall sync */ } });

  const configured = () => !!(CFG && CFG.url && CFG.anonKey);

  /* ---- session ---- */
  const readSession = () => {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (!s?.access_token) return null;
      if (s.expires_at && s.expires_at * 1000 < Date.now()) return null;
      return s;
    } catch { return null; }
  };
  const writeSession = (s) => {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
    session = s;
  };

  /* GoTrue hands the tokens back in the URL fragment. Strip them immediately:
     a fragment survives in history and in anything the user pastes. */
  function consumeRedirect() {
    if (typeof location === 'undefined' || !location.hash.includes('access_token=')) return false;
    const p = new URLSearchParams(location.hash.slice(1));
    const token = p.get('access_token');
    if (!token) return false;
    writeSession({
      access_token: token,
      refresh_token: p.get('refresh_token'),
      expires_at: Number(p.get('expires_at')) || Math.floor(Date.now() / 1000) + Number(p.get('expires_in') || 3600),
    });
    history.replaceState(null, '', location.pathname + location.search);
    return true;
  }

  const signIn = () => {
    const back = location.origin + location.pathname;
    location.href = `${CFG.url}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent(back)}`;
  };
  const signOut = () => { writeSession(null); emit(); };

  /* ---- transport ---- */
  async function api(path, opts = {}) {
    if (!session) throw new Error('not signed in');
    const res = await fetch(`${CFG.url}/rest/v1/${path}`, {
      ...opts,
      headers: {
        apikey: CFG.anonKey,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (res.status === 401) { writeSession(null); emit(); throw new Error('session expired'); }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`${res.status} ${body.slice(0, 200)}`);
      err.status = res.status;
      err.stale = body.includes('stale_write');
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  /* ---- cache: display only, never a write source ---- */
  const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]'); } catch { return []; } };
  const writeCache = (rows) => localStorage.setItem(CACHE_KEY, JSON.stringify(rows));

  /* ---- operations ---- */
  async function pull() {
    const rows = await api('submissions?select=*&order=updated_at.desc');
    writeCache(rows);
    return rows;
  }

  async function save(rec) {
    const row = await api('rpc/save_submission', {
      method: 'POST',
      body: JSON.stringify({
        p_id: rec.id, p_paper: rec.paper, p_venue: rec.venue, p_status: rec.status,
        p_history: rec.history || [], p_notes: rec.notes || '',
        p_expected: rec.updated_at || null,
      }),
    });
    return row;
  }

  const remove = (id) => api(`submissions?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });

  /* ---- state for the UI ---- */
  const status = () => {
    if (!configured()) return 'off';        // no project set up: pure local behaviour
    if (!session) return 'signed-out';
    return online ? 'live' : 'offline';
  };

  if (typeof window !== 'undefined') {
    window.addEventListener?.('online', () => { online = true; emit(); });
    window.addEventListener?.('offline', () => { online = false; emit(); });
  }

  return {
    configured, status, signIn, signOut, consumeRedirect,
    init: () => { consumeRedirect(); session = readSession(); },
    get session() { return session; },
    pull, save, remove, readCache, writeCache,
    onChange: (f) => listeners.push(f),
    _setOnline: (v) => { online = v; emit(); },     // tests
  };
})();

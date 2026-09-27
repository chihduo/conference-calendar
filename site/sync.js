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

  /* ---- session ----
     The access token lasts an hour; the refresh token that comes with it lasts
     until you sign out. The page used to drop the session once the access
     token ran out, so any visit more than an hour after logging in found you
     signed out - on 依會議 that just meant the management card was missing.
     An expired session that still carries a refresh token now counts as
     signed in, and token() renews it before use. */
  const stored = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } };
  const expired = (s, slackMs = 0) => !!s.expires_at && s.expires_at * 1000 - slackMs < Date.now();
  const readSession = () => {
    const s = stored();
    if (!s?.access_token) return null;
    return expired(s) && !s.refresh_token ? null : s;
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

  /* One renewal at a time: refresh tokens rotate, and presenting a used one
     can get the whole session revoked. */
  let refreshing = null;
  function refresh() {
    refreshing ??= (async () => {
      const s = stored();
      if (!s?.refresh_token) return null;
      let res;
      try {
        res = await fetch(`${CFG.url}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST',
          headers: { apikey: CFG.anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: s.refresh_token }),
        });
      } catch { return null; }                         // no network: keep it for later
      if (!res.ok) { writeSession(null); emit(); return null; }   // revoked: sign in again
      const t = await res.json();
      writeSession({
        access_token: t.access_token, refresh_token: t.refresh_token || s.refresh_token,
        expires_at: t.expires_at || Math.floor(Date.now() / 1000) + Number(t.expires_in || 3600),
      });
      return session;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  /** An access token good for at least another minute; null when there is none to be had. */
  async function token() {
    if (!session) return null;
    if (!expired(session, 60e3)) return session.access_token;
    return (await refresh())?.access_token || null;
  }

  /* ---- transport ---- */
  async function api(path, opts = {}) {
    const tok = await token();
    if (!tok) throw new Error(session ? '登入暫時無法更新，請稍後再試' : 'not signed in');
    const send = (t) => fetch(`${CFG.url}/rest/v1/${path}`, {
      ...opts,
      headers: {
        apikey: CFG.anonKey,
        Authorization: `Bearer ${t}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    let res = await send(tok);
    // an access token can die before its stated expiry; renew once, then give up
    if (res.status === 401 && session?.refresh_token) {
      const s = await refresh();
      if (s) res = await send(s.access_token);
    }
    if (res.status === 401) {
      if (session) { writeSession(null); emit(); }
      throw new Error('session expired');
    }
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
    token,
    pull, save, remove, readCache, writeCache,
    onChange: (f) => listeners.push(f),
    _setOnline: (v) => { online = v; emit(); },     // tests
  };
})();

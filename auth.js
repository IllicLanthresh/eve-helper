/* EVE SSO (OAuth2 PKCE) + skills/standings for EVE Helper — fully client-side, no server.
   Tokens and the Client ID live in localStorage and never leave the browser.
   Several characters can be logged in at once ("+ alt" in the top bar); one of them is
   ACTIVE and drives every page (fees/standings on Sell, refine skills on Mine).
   Requires a (free) app at https://developers.eveonline.com with:
   - Callback URL: this site's index page URL (exactly, incl. trailing slash)
   - Scopes: esi-skills.read_skills.v1 esi-characters.read_standings.v1
*/
'use strict';
(function(){
  const LS_KEY = 'eveHelper.auth.v1';
  const SSO = 'https://login.eveonline.com/v2/oauth';
  const SCOPES = 'esi-skills.read_skills.v1 esi-characters.read_standings.v1';

  const SKILL_IDS = {
    accounting: 16622,
    brokerRelations: 3446,
    reprocessing: 3385,
    reprocessingEfficiency: 3389,
  };
  // ore-group reprocessing skills (post-2021 consolidation) — resolved by NAME at fetch
  // time via /universe/ids so no hardcoded type-id can rot
  const ORE_GROUP_SKILLS = [
    'Simple Ore Processing', 'Coherent Ore Processing', 'Variegated Ore Processing',
    'Complex Ore Processing', 'Abyssal Ore Processing', 'Mercoxit Ore Processing',
    'Ubiquitous Moon Ore Processing', 'Common Moon Ore Processing',
    'Uncommon Moon Ore Processing', 'Rare Moon Ore Processing',
    'Exceptional Moon Ore Processing',
  ];
  // social skills shaping NPC broker fees — resolved by name in the same lookup
  const SOCIAL_SKILLS = { connections: 'Connections', diplomacy: 'Diplomacy' };

  /* Storage schema v2:
     { v:2, clientId, active:<charId>, chars:{ [charId]:{ tokens, character, skills, standings } } }
     The old v1 shape { clientId, tokens, character, skills } is migrated on load — that
     character becomes the (only) entry and the active one. */
  function migrate(a){
    if (a.v === 2){ a.chars = a.chars || {}; return a; }
    const v2 = { v: 2, clientId: a.clientId, active: null, chars: {} };
    if (a.pkce) v2.pkce = a.pkce;
    if (a.tokens && a.character && a.character.id){
      v2.chars[a.character.id] = { tokens: a.tokens, character: a.character, skills: a.skills };
      v2.active = a.character.id;
    }
    return v2;
  }
  function load(){
    let a;
    try{ a = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }catch(_e){ a = {}; }
    return migrate(a || {});
  }
  function save(a){ try{ localStorage.setItem(LS_KEY, JSON.stringify(a)); }catch(_e){} }
  let auth = load();

  const activeChar = () => (auth.active != null && auth.chars[auth.active]) || null;
  const characters = () => Object.values(auth.chars)
    .map(c => ({ id: c.character.id, name: c.character.name }));

  const listeners = [];
  function onChange(cb){ listeners.push(cb); }
  function fireChange(){
    for (const cb of listeners){ try{ cb(); }catch(e){ console.error('EveAuth listener failed:', e); } }
  }

  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
  async function sha256(str){
    return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
  }
  function jwtPayload(token){
    try{
      const b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(b))));
    }catch(_e){ return null; }
  }

  // The callback URL is always the site root page, so one registered URL covers every tool.
  function callbackUrl(){
    return location.origin + location.pathname.replace(/[^/]*$/, '') + 'index.html';
  }

  // the site's own SSO app — used automatically on the canonical deployment; a fork on
  // another domain needs its own app (the callback URL must match) and gets the prompt
  const DEFAULT_CLIENT_ID = 'dc5bfbf28db646b48553946fbfcde17c';
  const CANONICAL_HOST = 'illiclanthresh.github.io';
  function resolveClientId(){
    return auth.clientId || (location.hostname === CANONICAL_HOST ? DEFAULT_CLIENT_ID : null);
  }

  async function login(){
    let clientId = resolveClientId();
    if (!clientId){
      clientId = (window.prompt(
        'EVE SSO Client ID needed (one-time setup):\n\n' +
        '1. https://developers.eveonline.com → Create application\n' +
        '2. Client/app type: public NATIVE (PKCE) — NOT web/confidential\n' +
        '3. Scopes: esi-skills.read_skills.v1 esi-characters.read_standings.v1\n' +
        `4. Callback URL exactly: ${callbackUrl()}\n\n` +
        'Paste the Client ID here (stored only in your browser):') || '').trim();
      if (!clientId) return;
    }
    // persist whatever was resolved (prompt OR the canonical default) — the callback's
    // token exchange reads it back, and an unset client_id there means HTTP 401
    if (auth.clientId !== clientId){ auth.clientId = clientId; save(auth); }
    const verifier = randomString();
    const state = randomString();
    auth.pkce = { verifier, state, returnTo: location.href.split('?')[0] };
    save(auth);
    const q = new URLSearchParams({
      response_type: 'code',
      redirect_uri: callbackUrl(),
      client_id: clientId,
      scope: SCOPES,
      code_challenge: await sha256(verifier),
      code_challenge_method: 'S256',
      state,
    });
    location.href = `${SSO}/authorize/?${q}`;
  }

  async function tokenRequest(body){
    const res = await fetch(`${SSO}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    if (!res.ok){
      let detail = '';
      try{ const j = await res.json(); detail = j.error_description || j.error || ''; }catch(_e){}
      // 401/invalid_client with PKCE = the SSO wanted a client secret, i.e. the app is
      // registered as a confidential (web) client instead of a public/native one
      if (res.status === 401) detail += (detail ? ' — ' : '') +
        'the app must be a PUBLIC/NATIVE (PKCE) client in the EVE developer portal; a web/confidential app requires its secret key, which a browser-only site cannot use (or the Client ID was missing from the request)';
      throw new Error('SSO token endpoint: HTTP ' + res.status + (detail ? ' (' + detail + ')' : ''));
    }
    return res.json();
  }

  // keepActive: a background token refresh must not steal the active slot
  function storeTokens(t, keepActive){
    const p = jwtPayload(t.access_token) || {};
    const id = Number(String(p.sub || '').split(':').pop()) || null;
    const prev = auth.chars[id] || {};
    // a fresh login carries the current scope list — a "log in again for standings" marker is obsolete
    if (!keepActive && prev.standings && prev.standings.needsRelogin) delete prev.standings;
    auth.chars[id] = { ...prev,
      tokens: {
        access: t.access_token,
        refresh: t.refresh_token,
        exp: Date.now() + (t.expires_in - 60) * 1000,
      },
      character: { id, name: p.name || 'unknown pilot' },
    };
    if (!keepActive) auth.active = id;
    delete auth.pkce;
    save(auth);
  }

  async function handleCallback(){
    const q = new URLSearchParams(location.search);
    const code = q.get('code');
    if (!code || !auth.pkce) return false;
    if (q.get('state') !== auth.pkce.state){
      console.error('SSO state mismatch — ignoring callback');
      return false;
    }
    const returnTo = auth.pkce.returnTo;
    try{
      storeTokens(await tokenRequest({
        grant_type: 'authorization_code',
        code,
        client_id: resolveClientId(),
        code_verifier: auth.pkce.verifier,
      }));
    }catch(e){
      alert('EVE login failed: ' + e.message +
        '\nIf this is a CORS error, double-check the app type and callback URL in the EVE developer portal.');
      return false;
    }
    history.replaceState(null, '', location.pathname);   // strip ?code=… from the URL
    fireChange();
    if (returnTo && !returnTo.endsWith(location.pathname)) location.href = returnTo;
    return true;
  }

  async function getToken(charId = auth.active){
    const c = auth.chars[charId];
    if (!c || !c.tokens) throw new Error('not logged in');
    if (Date.now() < c.tokens.exp) return c.tokens.access;
    storeTokens(await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: c.tokens.refresh,
      client_id: resolveClientId(),
    }), true);
    return (auth.chars[charId] || c).tokens.access;
  }

  async function fetchSkills(charId = auth.active){
    const c = auth.chars[charId];
    if (!c) throw new Error('not logged in');
    const token = await getToken(charId);
    const res = await fetch(`https://esi.evetech.net/latest/characters/${c.character.id}/skills/?datasource=tranquility`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!res.ok) throw new Error('ESI skills: HTTP ' + res.status);
    const data = await res.json();
    const byId = {};
    for (const s of data.skills) byId[s.skill_id] = s.active_skill_level;
    const skills = {};
    for (const [k, id] of Object.entries(SKILL_IDS)) skills[k] = byId[id] || 0;
    // resolve the ore-group + social skill ids by name (public endpoint), then read the levels
    const groups = {};
    try{
      const r2 = await fetch('https://esi.evetech.net/latest/universe/ids/?datasource=tranquility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([...ORE_GROUP_SKILLS, ...Object.values(SOCIAL_SKILLS)]),
      });
      if (r2.ok){
        for (const t of ((await r2.json()).inventory_types || [])){
          if (ORE_GROUP_SKILLS.includes(t.name)) groups[t.name] = byId[t.id] || 0;
          else for (const [k, name] of Object.entries(SOCIAL_SKILLS))
            if (t.name === name) skills[k] = byId[t.id] || 0;
        }
      }
    }catch(_e){ /* groups stay empty — pages fall back to the flat refine input */ }
    c.skills = { ...skills, groups, fetched: new Date().toISOString() };
    save(auth);
    return c.skills;
  }

  // standings toward agents / NPC corps / factions → { [from_id]: standing, fetched }.
  // HTTP 403 = the stored token predates the standings scope: flag needsRelogin so pages
  // can say "log in again to grant standings access" and fall back to 0.
  async function fetchStandings(charId = auth.active){
    const c = auth.chars[charId];
    if (!c) throw new Error('not logged in');
    const token = await getToken(charId);
    const res = await fetch(`https://esi.evetech.net/latest/characters/${c.character.id}/standings/?datasource=tranquility`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (res.status === 403){
      c.standings = { needsRelogin: true, fetched: new Date().toISOString() };
      save(auth);
      return c.standings;
    }
    if (!res.ok) throw new Error('ESI standings: HTTP ' + res.status);
    const standings = { fetched: new Date().toISOString() };
    for (const s of await res.json()) standings[s.from_id] = s.standing;
    c.standings = standings;
    save(auth);
    return c.standings;
  }

  function setActive(charId){
    const id = Number(charId);
    if (!auth.chars[id] || auth.active === id) return;
    auth.active = id;
    save(auth);
    renderUI();
    fireChange();
  }

  // logout(charId) drops one character (the active slot moves on if needed);
  // no argument — or the last remaining character — drops everything but the client id
  function logout(charId){
    const id = charId != null ? Number(charId) : null;
    if (id == null || !auth.chars[id] || Object.keys(auth.chars).length <= 1){
      auth = { v: 2, clientId: auth.clientId, active: null, chars: {} };
    } else {
      delete auth.chars[id];
      if (Number(auth.active) === id) auth.active = Number(Object.keys(auth.chars)[0]);
    }
    save(auth);
    renderUI();
    fireChange();
  }

  function renderUI(){
    const bar = document.getElementById('topbar');
    if (!bar) return;
    let box = document.getElementById('authBox');
    if (!box){
      box = document.createElement('span');
      box.id = 'authBox';
      box.style.cssText = 'margin-left:auto;display:flex;gap:10px;align-items:center;font-size:12px';
      bar.appendChild(box);
    }
    box.textContent = '';
    const c = activeChar();
    if (c && c.tokens){
      const chars = characters();
      const bolt = document.createElement('span');
      bolt.style.color = 'var(--green)';
      if (chars.length > 1){
        bolt.textContent = '⚡';
        const sel = document.createElement('select');
        sel.style.cssText = 'font-size:12px;padding:2px 4px;max-width:150px';
        sel.title = 'active character — their skills and standings drive every tool';
        for (const ch of chars){
          const o = document.createElement('option');
          o.value = ch.id; o.textContent = ch.name;
          sel.appendChild(o);
        }
        sel.value = String(auth.active);
        sel.addEventListener('change', () => setActive(sel.value));
        box.append(bolt, sel);
      } else {
        bolt.textContent = '⚡ ' + c.character.name;
        box.appendChild(bolt);
      }
      const alt = document.createElement('a');
      alt.href = '#'; alt.textContent = '+ alt';
      alt.title = 'log in another character (pick a different one on the SSO page)';
      alt.addEventListener('click', e => { e.preventDefault(); login(); });
      const out = document.createElement('a');
      out.href = '#'; out.textContent = 'log out';
      out.title = 'log out the active character';
      out.addEventListener('click', e => { e.preventDefault(); logout(auth.active); });
      box.append(alt, out);
    } else {
      // CCP's standardized SSO button (required branding); black variant for the dark topbar
      const a = document.createElement('a');
      a.href = '#';
      a.title = 'EVE SSO (PKCE) — pulls your skill levels and standings to auto-fill fees and refine yields; nothing leaves your browser';
      a.style.padding = '0';
      const img = document.createElement('img');
      img.src = 'https://web.ccpgamescdn.com/eveonlineassets/developers/eve-sso-login-black-small.png';
      img.alt = 'Log in with EVE Online';
      img.style.cssText = 'height:30px;display:block';
      a.appendChild(img);
      a.addEventListener('click', e => { e.preventDefault(); login(); });
      box.appendChild(a);
    }
  }

  window.EveAuth = {
    login, logout, fetchSkills, fetchStandings, setActive, onChange, SKILL_IDS,
    isLoggedIn: () => { const c = activeChar(); return !!(c && c.tokens && c.character); },
    character: () => { const c = activeChar(); return (c && c.character) || null; },
    characters,
    active: () => (auth.active != null ? auth.active : null),
    skills: id => { const c = auth.chars[id != null ? id : auth.active]; return (c && c.skills) || null; },
    standings: id => { const c = auth.chars[id != null ? id : auth.active]; return (c && c.standings) || null; },
  };

  const init = async () => { await handleCallback(); renderUI(); };
  // pages await this before reading login state (the callback token exchange is async)
  window.EveAuth.ready = (document.readyState === 'loading')
    ? new Promise(res => document.addEventListener('DOMContentLoaded', () => res(init())))
    : init();
})();

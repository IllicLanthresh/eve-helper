/* EVE SSO (OAuth2 PKCE) + skills/standings for EVE Helper — fully client-side, no server.
   Tokens and the Client ID live in localStorage and never leave the browser.
   Several characters can be logged in at once ("+ alt" in the top bar); one of them is
   ACTIVE and drives every page (fees/standings on Sell, refine skills on Mine).
   Requires a (free) app at https://developers.eveonline.com with:
   - Callback URL: this site's index page URL (exactly, incl. trailing slash)
   - Scopes: esi-skills.read_skills.v1 esi-characters.read_standings.v1
     esi-markets.structure_markets.v1 esi-universe.read_structures.v1
     esi-search.search_structures.v1 (scopes the SSO no longer publishes are dropped
     from the login request automatically)
*/
'use strict';
(function(){
  const LS_KEY = 'eveHelper.auth.v1';
  const SSO = 'https://login.eveonline.com/v2/oauth';
  const STANDINGS_SCOPE = 'esi-characters.read_standings.v1';
  const STRUCTURE_SCOPES = [
    'esi-markets.structure_markets.v1',   // player-structure order books (Sell tool)
    'esi-universe.read_structures.v1',    // structure name/system lookup
    'esi-search.search_structures.v1',    // find structures by name
  ];
  const BLUEPRINTS_SCOPE = 'esi-characters.read_blueprints.v1';  // owned BPs with real ME/TE (Industry tool)
  const SKILLS_SCOPE = 'esi-skills.read_skills.v1';
  const SCOPES = [SKILLS_SCOPE, STANDINGS_SCOPE, ...STRUCTURE_SCOPES, BLUEPRINTS_SCOPE].join(' ');

  /* What the user actually loses when a scope is missing, in plain language. These
     strings are shown verbatim in the permissions modal and in the inline notes next to
     the feature that degraded, so they must read as consequences, not as scope names. */
  const SCOPE_FEATURES = {
    [SKILLS_SCOPE]: [
      'auto-filled fees, refine yields, job times and invention chance — without it every skill-derived number falls back to a manual input',
    ],
    [STANDINGS_SCOPE]: [
      'the standings part of the NPC broker fee — without it the fee is computed as if your standings were zero',
    ],
    'esi-markets.structure_markets.v1': ['prices from player-structure markets'],
    'esi-universe.read_structures.v1': [
      'structure names and systems in the picker (Sell market, Mine refinery, Industry facilities)',
    ],
    'esi-search.search_structures.v1': ['searching for your structures by name'],
    [BLUEPRINTS_SCOPE]: [
      "your real researched ME/TE and which BPOs you own — without it the Industry tab uses the profile's assumed ME/TE",
    ],
  };
  const featuresOf = scope => SCOPE_FEATURES[scope] || [];

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
  // the scp claim can be a single string or an array — normalize to an array
  function scopesOf(token){
    const scp = (jwtPayload(token) || {}).scp;
    return Array.isArray(scp) ? scp : scp ? [scp] : [];
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

  // EVE's published OAuth metadata: CCP removes scopes server-side now and then (e.g.
  // esi-characterstats.read.v1 in mid-2025), and the authorize step then rejects the
  // WHOLE login with invalid_scope — so ask which scopes still exist, cached for a day
  const META_KEY = 'eveHelper.ssoMeta.v1';
  async function ssoScopes(){
    let meta = null;
    try{ meta = JSON.parse(localStorage.getItem(META_KEY) || 'null'); }catch(_e){}
    const cached = meta && Array.isArray(meta.scopes) ? meta.scopes : null;
    if (cached && Date.now() - meta.at < 86400e3) return cached;
    try{
      const res = await fetch('https://login.eveonline.com/.well-known/oauth-authorization-server');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const scopes = (await res.json()).scopes_supported;
      if (!Array.isArray(scopes)) return cached;
      try{ localStorage.setItem(META_KEY, JSON.stringify({ at: Date.now(), scopes })); }catch(_e){}
      return scopes;
    }catch(_e){ return cached; }   // metadata unavailable → caller requests the full list
  }

  async function login(){
    let clientId = resolveClientId();
    if (!clientId){
      clientId = (window.prompt(
        'EVE SSO Client ID needed (one-time setup):\n\n' +
        '1. https://developers.eveonline.com → create an application (any kind — the secret key is never used)\n' +
        '2. Scopes (tick the ones the portal still offers): esi-skills.read_skills.v1, esi-characters.read_standings.v1, esi-markets.structure_markets.v1, esi-universe.read_structures.v1, esi-search.search_structures.v1\n' +
        `3. Callback URL exactly: ${callbackUrl()}\n\n` +
        'Paste the Client ID here (stored only in your browser):') || '').trim();
      if (!clientId) return;
    }
    // persist whatever was resolved (prompt OR the canonical default) — the callback's
    // token exchange reads it back, and an unset client_id there means HTTP 401
    if (auth.clientId !== clientId){ auth.clientId = clientId; save(auth); }
    // request only scopes the SSO still supports; remember what got dropped so pages
    // can explain why (e.g. standings unavailable rather than silently zero)
    const want = SCOPES.split(' ');
    const supported = await ssoScopes();
    let scopes = supported ? want.filter(s => supported.includes(s)) : want;
    if (!scopes.length) scopes = want;   // metadata anomaly — never strip everything
    auth.droppedScopes = want.filter(s => !scopes.includes(s));
    const verifier = randomString();
    const state = randomString();
    auth.pkce = { verifier, state, returnTo: location.href.split('?')[0] };
    save(auth);
    const q = new URLSearchParams({
      response_type: 'code',
      redirect_uri: callbackUrl(),
      client_id: clientId,
      scope: scopes.join(' '),
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
      // 401/invalid_client at the token exchange = the client_id was missing or wrong
      if (res.status === 401) detail += (detail ? ' — ' : '') +
        'check the Client ID and callback URL in the EVE developer portal (a missing client_id in the request also causes this)';
      throw new Error('SSO token endpoint: HTTP ' + res.status + (detail ? ' (' + detail + ')' : ''));
    }
    return res.json();
  }

  // keepActive: a background token refresh must not steal the active slot
  function storeTokens(t, keepActive){
    const p = jwtPayload(t.access_token) || {};
    const id = Number(String(p.sub || '').split(':').pop()) || null;
    const prev = auth.chars[id] || {};
    // a fresh login carries the current scope list — degraded-standings markers are obsolete
    if (!keepActive && prev.standings && (prev.standings.needsRelogin || prev.standings.unavailable))
      delete prev.standings;
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
    // a login that got all the way to a token supersedes any earlier authorize failure
    if (!keepActive) delete auth.lastAuthError;
    save(auth);
  }

  async function handleCallback(){
    const q = new URLSearchParams(location.search);
    const err = q.get('error');
    if (err){
      // The SSO bounced the login — most often invalid_scope, which means the scope is
      // not assigned to the APPLICATION in the developer portal (a portal fix), not that
      // the character merely needs to log in again. Remember it: the permissions report
      // uses it to tell those two very different situations apart.
      const description = q.get('error_description') || '';
      auth.lastAuthError = {
        error: err,
        description,
        at: Date.now(),
        // the SSO usually names the offending scope in the description
        scope: SCOPES.split(' ').find(s => description.includes(s)) || null,
      };
      delete auth.pkce;
      save(auth);
      history.replaceState(null, '', location.pathname);
      renderUI();
      alert('EVE login failed: ' + (description || err)
        + '\nSee the ⚠ permissions panel in the top bar for what this disables and how to fix it.');
      return false;
    }
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
        '\nIf this is a CORS error, double-check the Client ID and callback URL in the EVE developer portal.');
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
    // full trained-skill list {typeId: level} — the Industry tool feeds it to the calc
    // engine and the "only if skilled" filter, which need arbitrary skills by type id
    c.allSkills = byId;
    save(auth);
    return c.skills;
  }

  // standings toward agents / NPC corps / factions → { [from_id]: standing, fetched }.
  // Degraded outcomes are recorded instead of thrown, so pages can explain and use 0:
  //   { needsRelogin:true }  — the token predates the standings scope (log in again)
  //   { unavailable:true }   — the SSO itself no longer offers the scope (nothing to grant)
  async function fetchStandings(charId = auth.active){
    const c = auth.chars[charId];
    if (!c) throw new Error('not logged in');
    const token = await getToken(charId);
    // only call ESI when the token actually carries the scope
    if (!scopesOf(token).includes(STANDINGS_SCOPE)){
      c.standings = (auth.droppedScopes || []).includes(STANDINGS_SCOPE)
        ? { unavailable: true, fetched: new Date().toISOString() }
        : { needsRelogin: true, fetched: new Date().toISOString() };
      save(auth);
      return c.standings;
    }
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

  /* ---------- permissions report ----------
     One place that answers "what can this site not do right now, and whose fault is it".
     Three very different situations get three different reasons:
       'not-granted' — the site asks for the scope and the app offers it, but THIS
                       character's token predates it: they just need to log in again.
       'app-missing' — the SSO rejected the scope at the authorize step, i.e. it is not
                       ticked on the application in the developer portal: a portal fix,
                       and logging in again changes nothing until it is done.
       'sso-removed' — CCP no longer publishes the scope at all (it vanished from the
                       SSO metadata). Not the user's fault and not fixable by them.

     @typedef {Object} MissingScope
     @property {string} scope                       ESI scope name
     @property {string[]} features                  plain-language consequences
     @property {'not-granted'|'app-missing'|'sso-removed'} reason

     @typedef {Object} CharPermissions
     @property {number} id
     @property {string} name
     @property {string[]} granted
     @property {MissingScope[]} missing

     @typedef {Object} AppIssue
     @property {string} scope
     @property {'app-missing'|'sso-removed'} reason
     @property {string} detail                      human-readable explanation

     @typedef {Object} PermissionsReport
     @property {CharPermissions[]} chars
     @property {AppIssue[]} appIssues
     @property {boolean} allGood                    nothing missing anywhere

     @returns {PermissionsReport} */
  function permissions(){
    const want = SCOPES.split(' ');
    const dropped = auth.droppedScopes || [];
    const authErr = auth.lastAuthError || null;
    const appMissing = authErr && authErr.scope ? [authErr.scope] : [];

    const reasonFor = scope => dropped.includes(scope) ? 'sso-removed'
      : appMissing.includes(scope) ? 'app-missing'
      : 'not-granted';

    const chars = Object.values(auth.chars).map(c => {
      const granted = c.tokens ? scopesOf(c.tokens.access) : [];
      return {
        id: c.character.id,
        name: c.character.name,
        granted,
        missing: want.filter(s => !granted.includes(s))
          .map(scope => ({ scope, features: featuresOf(scope), reason: reasonFor(scope) })),
      };
    });

    const appIssues = [];
    for (const scope of dropped) appIssues.push({
      scope, reason: 'sso-removed',
      detail: 'EVE SSO no longer publishes this scope, so it cannot be requested at all. '
        + 'CCP retired it server-side — there is nothing you can do about it, and nothing you did wrong.',
    });
    if (authErr && !dropped.includes(authErr.scope)) appIssues.push({
      scope: authErr.scope,
      reason: 'app-missing',
      detail: 'The SSO rejected the last login with "' + (authErr.error || 'error') + '"'
        + (authErr.description ? ': ' + authErr.description : '')
        + '. That means your SSO application does not have this scope ticked in the developer '
        + 'portal. Add it there first — logging in again will keep failing until you do.',
    });

    return {
      chars,
      appIssues,
      allGood: !appIssues.length && chars.every(c => !c.missing.length),
    };
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

  /* ---------- shared modal chrome ----------
     One stylesheet for every modal on the site (this one and the structure picker),
     injected once from here because auth.js loads first on every page. Anything wanting
     a modal builds .eveModal > .panel and calls EveAuth.modalCss(). */
  let cssDone = false;
  function modalCss(){
    if (cssDone) return;
    cssDone = true;
    const s = document.createElement('style');
    s.textContent = `
.eveModal{position:fixed;inset:0;background:rgba(4,6,10,.72);z-index:100;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}
.eveModal .panel{width:480px;max-width:92vw;background:var(--panel,#121722);border:1px solid var(--line,#232c3d);border-radius:10px;padding:14px 16px 16px;box-shadow:0 14px 44px rgba(0,0,0,.55);font-size:13px;color:var(--text,#d5dce8)}
.eveModal .panel.wide{width:640px}
.eveModal h3{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--cyan,#5bc8e8);display:flex;align-items:center}
.eveModal .x{margin-left:auto;cursor:pointer;color:var(--dim,#8b96a8);font-size:17px;line-height:1;text-transform:none;padding:0 3px;border-radius:4px}
.eveModal .x:hover{color:var(--text,#d5dce8);background:#1b2434}
.eveModal input{width:100%;background:var(--panel2,#0e131d);color:var(--text,#d5dce8);border:1px solid var(--line,#232c3d);border-radius:6px;padding:6px 9px;font:13px var(--mono,ui-monospace,monospace)}
.eveModal .rows{margin-top:6px;max-height:38vh;overflow-y:auto}
.eveModal .row{display:flex;gap:8px;align-items:center;padding:6px 8px;border-radius:6px;cursor:pointer}
.eveModal .row:hover,.eveModal .row.active{background:#1b2434}
.eveModal .row .sub{color:var(--dim,#8b96a8);font-size:12px;margin-left:6px}
.eveModal .msg{color:var(--dim,#8b96a8);margin-top:8px;min-height:16px}
.eveModal .msg a{color:var(--cyan,#5bc8e8)}
.eveModal .msg.err{color:var(--red,#e06c75)}
.eveModal .sect{color:var(--dim,#8b96a8);font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:2px 0 4px}
.eveModal .spin{display:inline-block;width:11px;height:11px;border:2px solid var(--line,#232c3d);border-top-color:var(--cyan,#5bc8e8);border-radius:50%;animation:evemodalspin .8s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes evemodalspin{to{transform:rotate(360deg)}}
/* permissions panel */
.eveModal .body{max-height:60vh;overflow-y:auto;margin-top:4px}
.eveModal .pchar{border:1px solid var(--line,#232c3d);border-radius:8px;padding:8px 10px;margin-bottom:8px}
.eveModal .pchar .hd{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.eveModal .pchar .hd b{color:var(--text,#d5dce8)}
.eveModal .pscope{display:flex;gap:7px;align-items:flex-start;padding:3px 0;line-height:1.45}
.eveModal .pscope .ic{flex:0 0 auto;width:13px}
.eveModal .pscope.ok .ic{color:var(--green,#7ec699)}
.eveModal .pscope.bad .ic{color:var(--amber,#e5b567)}
.eveModal .pscope code{font:12px var(--mono,ui-monospace,monospace);color:var(--dim,#8b96a8)}
.eveModal .pscope .why{display:block;color:var(--dim,#8b96a8);font-size:12px}
.eveModal .app{border:1px solid var(--red,#e06c75);border-radius:8px;padding:8px 10px;margin:10px 0 8px}
.eveModal .app .sect{color:var(--red,#e06c75)}
.eveModal .fix{border-top:1px solid var(--line,#232c3d);margin-top:8px;padding-top:8px}
.eveModal .fix ol{margin:6px 0 0;padding-left:18px;line-height:1.6}
.eveModal .fix code{font:12px var(--mono,ui-monospace,monospace);color:var(--cyan,#5bc8e8);word-break:break-all}
.eveModal button{background:#1b2434;color:var(--text,#d5dce8);border:1px solid var(--line,#232c3d);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
.eveModal button:hover{background:#242e42}
.eveModal button.primary{border-color:var(--cyan,#5bc8e8);color:var(--cyan,#5bc8e8)}
.evePermLink{color:var(--amber,#e5b567);cursor:pointer;text-decoration:underline dotted}`;
    document.head.appendChild(s);
  }

  const REASON_LABEL = {
    'not-granted': 'this character has not granted it — log in again',
    'app-missing': 'your SSO application does not have this scope — fix it in the developer portal',
    'sso-removed': 'CCP retired this scope — nothing you can do, and nothing you did wrong',
  };

  /* The permissions panel: what is missing, what it costs you, and exactly how to fix
     it. Never opens by itself — everything keeps working degraded. */
  function showPermissions(){
    modalCss();
    const stale = document.getElementById('evePerms');
    if (stale) stale.remove();
    const rep = permissions();

    const overlay = document.createElement('div');
    overlay.id = 'evePerms';
    overlay.className = 'eveModal';
    const panel = document.createElement('div');
    panel.className = 'panel wide';
    overlay.appendChild(panel);

    const h = document.createElement('h3');
    h.textContent = 'ESI permissions';
    const x = document.createElement('span');
    x.className = 'x'; x.textContent = '×'; x.title = 'close (Esc)';
    h.appendChild(x);
    panel.appendChild(h);

    const body = document.createElement('div');
    body.className = 'body';
    panel.appendChild(body);

    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    };
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    x.addEventListener('click', close);
    function onKey(e){ if (e.key === 'Escape'){ e.stopPropagation(); close(); } }
    document.addEventListener('keydown', onKey, true);

    if (rep.allGood && rep.chars.length){
      const ok = document.createElement('div');
      ok.className = 'msg';
      ok.textContent = 'Everything this site asks for has been granted. Nothing is degraded.';
      body.appendChild(ok);
    }

    // the application's own problems come first — they block every character
    if (rep.appIssues.length){
      const box = document.createElement('div');
      box.className = 'app';
      const cap = document.createElement('div');
      cap.className = 'sect';
      cap.textContent = 'your SSO application';
      box.appendChild(cap);
      for (const iss of rep.appIssues){
        const line = document.createElement('div');
        line.className = 'pscope bad';
        const ic = document.createElement('span');
        ic.className = 'ic'; ic.textContent = '⚠';
        const txt = document.createElement('span');
        if (iss.scope){
          const c = document.createElement('code');
          c.textContent = iss.scope;
          txt.append(c, document.createElement('br'));
        }
        const why = document.createElement('span');
        why.className = 'why';
        why.textContent = iss.detail;
        txt.appendChild(why);
        line.append(ic, txt);
        box.appendChild(line);
      }
      body.appendChild(box);
    }

    for (const c of rep.chars){
      const box = document.createElement('div');
      box.className = 'pchar';
      const hd = document.createElement('div');
      hd.className = 'hd';
      const nm = document.createElement('b');
      nm.textContent = c.name;
      const cnt = document.createElement('span');
      cnt.className = 'sub';
      cnt.style.color = 'var(--dim,#8b96a8)';
      cnt.textContent = c.missing.length
        ? c.missing.length + ' of ' + (c.granted.length + c.missing.length) + ' missing'
        : 'all granted';
      hd.append(nm, cnt);
      // re-login only helps when the app actually offers the scope
      if (c.missing.some(m => m.reason === 'not-granted')){
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'primary';
        btn.style.marginLeft = 'auto';
        btn.textContent = 're-login to grant';
        btn.title = 'log in again as ' + c.name + ' to grant the missing scopes';
        btn.addEventListener('click', () => { close(); login(); });
        hd.appendChild(btn);
      }
      box.appendChild(hd);

      for (const m of c.missing){
        const line = document.createElement('div');
        line.className = 'pscope bad';
        const ic = document.createElement('span');
        ic.className = 'ic'; ic.textContent = '⚠';
        const txt = document.createElement('span');
        const code = document.createElement('code');
        code.textContent = m.scope;
        txt.append(code);
        for (const f of m.features){
          const why = document.createElement('span');
          why.className = 'why';
          why.textContent = 'disables: ' + f;
          txt.appendChild(why);
        }
        const rz = document.createElement('span');
        rz.className = 'why';
        rz.textContent = REASON_LABEL[m.reason] || m.reason;
        txt.appendChild(rz);
        line.append(ic, txt);
        box.appendChild(line);
      }
      for (const g of c.granted){
        const line = document.createElement('div');
        line.className = 'pscope ok';
        const ic = document.createElement('span');
        ic.className = 'ic'; ic.textContent = '✓';
        const code = document.createElement('code');
        code.textContent = g;
        line.append(ic, code);
        box.appendChild(line);
      }
      body.appendChild(box);
    }

    if (!rep.chars.length){
      const none = document.createElement('div');
      none.className = 'msg';
      none.textContent = 'Nobody is logged in yet, so there is nothing to report. '
        + 'The scopes below are what the site asks for when you do log in.';
      body.appendChild(none);
    }

    // the concrete fix, always shown — it is the thing people come here for
    const fix = document.createElement('div');
    fix.className = 'fix';
    const fcap = document.createElement('div');
    fcap.className = 'sect';
    fcap.textContent = 'how to fix';
    fix.appendChild(fcap);

    const ol = document.createElement('ol');
    const li = t => { const e = document.createElement('li'); e.append(t); ol.appendChild(e); return e; };

    const l1 = li('Open ');
    const a = document.createElement('a');
    a.href = 'https://developers.eveonline.com';
    a.target = '_blank'; a.rel = 'noopener';
    a.textContent = 'developers.eveonline.com';
    a.style.color = 'var(--cyan,#5bc8e8)';
    l1.append(a, ' and edit your application.');

    const l2 = li('Tick every one of these scopes:');
    const scopeBox = document.createElement('div');
    scopeBox.style.margin = '4px 0';
    const scopeCode = document.createElement('code');
    scopeCode.textContent = SCOPES.split(' ').join('  ');
    scopeBox.appendChild(scopeCode);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'copy list';
    copy.style.marginLeft = '8px';
    copy.addEventListener('click', async () => {
      try{
        await navigator.clipboard.writeText(SCOPES.split(' ').join('\n'));
        copy.textContent = 'copied ✓';
      }catch(_e){ copy.textContent = 'copy failed'; }
      setTimeout(() => { copy.textContent = 'copy list'; }, 1500);
    });
    scopeBox.appendChild(copy);
    l2.appendChild(scopeBox);

    const l3 = li('Set the callback URL to exactly:');
    const cbBox = document.createElement('div');
    cbBox.style.margin = '4px 0';
    const cbCode = document.createElement('code');
    cbCode.textContent = callbackUrl();
    cbBox.appendChild(cbCode);
    const cbCopy = document.createElement('button');
    cbCopy.type = 'button';
    cbCopy.textContent = 'copy URL';
    cbCopy.style.marginLeft = '8px';
    cbCopy.addEventListener('click', async () => {
      try{
        await navigator.clipboard.writeText(callbackUrl());
        cbCopy.textContent = 'copied ✓';
      }catch(_e){ cbCopy.textContent = 'copy failed'; }
      setTimeout(() => { cbCopy.textContent = 'copy URL'; }, 1500);
    });
    cbBox.appendChild(cbCopy);
    l3.appendChild(cbBox);

    li('Save the application, then log in again with EACH character — a token only '
      + 'carries the scopes that existed when it was issued.');
    fix.appendChild(ol);
    panel.appendChild(fix);

    document.body.appendChild(overlay);
    return overlay;
  }

  /* Inline degradation note: a short warn line naming what is unavailable, linking to
     the panel. Returns the element (already appended when targetEl is given), or null
     when the scope IS granted — so callers can just say
       EveAuth.permissionNote(SCOPE, someEl)
     without checking first. */
  function permissionNote(scope, targetEl, opts){
    opts = opts || {};
    const c0 = activeChar();
    if (!(c0 && c0.tokens) && !opts.whenLoggedOut) return null;
    const rep = permissions();
    let worst = null;
    for (const c of rep.chars){
      const m = c.missing.find(x => x.scope === scope);
      if (m && (!worst || m.reason !== 'not-granted')) worst = m;
    }
    if (!worst) return null;
    const span = document.createElement('span');
    span.className = 'evePermLink';
    span.setAttribute('data-perm-scope', scope);
    span.title = REASON_LABEL[worst.reason] || '';
    span.textContent = '⚠ ' + (opts.label || (worst.features[0] || scope)) + ' — see permissions';
    span.addEventListener('click', e => { e.preventDefault(); showPermissions(); });
    if (targetEl) targetEl.appendChild(span);
    return span;
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
      // permissions indicator — only when something IS missing; nothing to nag about otherwise
      const rep = permissions();
      const shortfall = rep.appIssues.length
        + rep.chars.reduce((n, ch) => n + ch.missing.length, 0);
      if (shortfall){
        const warn = document.createElement('a');
        warn.href = '#';
        warn.id = 'authPermWarn';
        warn.style.color = 'var(--amber, #e5b567)';
        warn.textContent = `⚠ ${shortfall} permission${shortfall > 1 ? 's' : ''}`;
        warn.title = 'some ESI permissions are missing — click to see what is disabled and how to fix it';
        warn.addEventListener('click', e => { e.preventDefault(); showPermissions(); });
        box.appendChild(warn);
      }
      const ref = document.createElement('a');
      ref.href = '#'; ref.textContent = '↻';
      ref.title = 'refresh ESI data — re-pull skills & standings for every logged-in character and clear cached station/structure metadata (market prices refetch with each tool’s own Fetch button)';
      ref.addEventListener('click', async e => {
        e.preventDefault();
        if (ref.dataset.busy) return;
        ref.dataset.busy = '1'; ref.style.opacity = '.4';
        for (const k of ['eveHelper.ssoMeta.v1', 'eveHelper.stationOwners.v1', 'eveHelper.structInfo.v1'])
          try{ localStorage.removeItem(k); }catch(_e){}
        for (const ch of characters()){
          try{ await fetchSkills(ch.id); }catch(err){ console.error('skills refresh failed for ' + ch.name + ':', err); }
          try{ await fetchStandings(ch.id); }catch(err){ console.error('standings refresh failed for ' + ch.name + ':', err); }
        }
        delete ref.dataset.busy; ref.style.opacity = '';
        fireChange();
      });
      const alt = document.createElement('a');
      alt.href = '#'; alt.textContent = '+ alt';
      alt.title = 'log in another character (pick a different one on the SSO page)';
      alt.addEventListener('click', e => { e.preventDefault(); login(); });
      const out = document.createElement('a');
      out.href = '#'; out.textContent = 'log out';
      out.title = 'log out the active character';
      out.addEventListener('click', e => { e.preventDefault(); logout(auth.active); });
      box.append(ref, alt, out);
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
    // permissions layer: the report, the panel, the inline note and the shared modal CSS
    permissions, showPermissions, permissionNote, modalCss,
    SCOPES: SCOPES.split(' '), SCOPE_FEATURES,
    isLoggedIn: () => { const c = activeChar(); return !!(c && c.tokens && c.character); },
    character: () => { const c = activeChar(); return (c && c.character) || null; },
    characters,
    active: () => (auth.active != null ? auth.active : null),
    skills: id => { const c = auth.chars[id != null ? id : auth.active]; return (c && c.skills) || null; },
    // {skillTypeId: activeLevel} for every trained skill — null until skills were
    // (re)fetched by this version (topbar ↻ or a fresh login backfills it)
    allSkills: id => { const c = auth.chars[id != null ? id : auth.active]; return (c && c.allSkills) || null; },
    standings: id => { const c = auth.chars[id != null ? id : auth.active]; return (c && c.standings) || null; },
    // for pages that call authenticated ESI endpoints themselves (structure markets)
    token: id => getToken(id != null ? id : auth.active),
    tokenScopes: id => {
      const c = auth.chars[id != null ? id : auth.active];
      return c && c.tokens ? scopesOf(c.tokens.access) : [];
    },
  };

  const init = async () => { await handleCallback(); renderUI(); };
  // pages await this before reading login state (the callback token exchange is async)
  window.EveAuth.ready = (document.readyState === 'loading')
    ? new Promise(res => document.addEventListener('DOMContentLoaded', () => res(init())))
    : init();
})();

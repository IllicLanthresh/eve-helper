/* EVE SSO (OAuth2 PKCE) + skills for EVE Helper — fully client-side, no server.
   Tokens and the Client ID live in localStorage and never leave the browser.
   Requires a (free) app at https://developers.eveonline.com with:
   - Callback URL: this site's index page URL (exactly, incl. trailing slash)
   - Scope: esi-skills.read_skills.v1
*/
'use strict';
(function(){
  const LS_KEY = 'eveHelper.auth.v1';
  const SSO = 'https://login.eveonline.com/v2/oauth';
  const SCOPES = 'esi-skills.read_skills.v1';

  const SKILL_IDS = {
    accounting: 16622,
    brokerRelations: 3446,
    reprocessing: 3385,
    reprocessingEfficiency: 3389,
  };

  function load(){
    try{ return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }catch(_e){ return {}; }
  }
  function save(a){ try{ localStorage.setItem(LS_KEY, JSON.stringify(a)); }catch(_e){} }
  let auth = load();

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

  async function login(){
    let clientId = auth.clientId;
    if (!clientId){
      clientId = (window.prompt(
        'EVE SSO Client ID needed (one-time setup):\n\n' +
        '1. https://developers.eveonline.com → Create application\n' +
        '2. Connection type: Authentication & API Access\n' +
        '3. Scope: esi-skills.read_skills.v1\n' +
        `4. Callback URL exactly: ${callbackUrl()}\n\n` +
        'Paste the Client ID here (stored only in your browser):') || '').trim();
      if (!clientId) return;
      auth.clientId = clientId; save(auth);
    }
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
    if (!res.ok) throw new Error('SSO token endpoint: HTTP ' + res.status);
    return res.json();
  }

  function storeTokens(t){
    const p = jwtPayload(t.access_token) || {};
    auth.tokens = {
      access: t.access_token,
      refresh: t.refresh_token,
      exp: Date.now() + (t.expires_in - 60) * 1000,
    };
    auth.character = {
      id: Number(String(p.sub || '').split(':').pop()) || null,
      name: p.name || 'unknown pilot',
    };
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
        client_id: auth.clientId,
        code_verifier: auth.pkce.verifier,
      }));
    }catch(e){
      alert('EVE login failed: ' + e.message +
        '\nIf this is a CORS error, double-check the app type and callback URL in the EVE developer portal.');
      return false;
    }
    history.replaceState(null, '', location.pathname);   // strip ?code=… from the URL
    if (returnTo && !returnTo.endsWith(location.pathname)) location.href = returnTo;
    return true;
  }

  async function getToken(){
    if (!auth.tokens) throw new Error('not logged in');
    if (Date.now() < auth.tokens.exp) return auth.tokens.access;
    storeTokens(await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: auth.tokens.refresh,
      client_id: auth.clientId,
    }));
    return auth.tokens.access;
  }

  async function fetchSkills(){
    const token = await getToken();
    const res = await fetch(`https://esi.evetech.net/latest/characters/${auth.character.id}/skills/?datasource=tranquility`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!res.ok) throw new Error('ESI skills: HTTP ' + res.status);
    const data = await res.json();
    const byId = {};
    for (const s of data.skills) byId[s.skill_id] = s.active_skill_level;
    const skills = {};
    for (const [k, id] of Object.entries(SKILL_IDS)) skills[k] = byId[id] || 0;
    auth.skills = { ...skills, fetched: new Date().toISOString() };
    save(auth);
    return auth.skills;
  }

  function logout(){
    auth = { clientId: auth.clientId };   // keep the client id, drop tokens/skills
    save(auth);
    renderUI();
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
    if (auth.tokens && auth.character){
      const name = document.createElement('span');
      name.style.color = 'var(--green)';
      name.textContent = '⚡ ' + auth.character.name;
      const out = document.createElement('a');
      out.href = '#'; out.textContent = 'log out';
      out.addEventListener('click', e => { e.preventDefault(); logout(); });
      box.append(name, out);
    } else {
      const a = document.createElement('a');
      a.href = '#'; a.textContent = 'Log in with EVE';
      a.title = 'EVE SSO (PKCE) — pulls your skill levels to auto-fill fees and refine yields; nothing leaves your browser';
      a.addEventListener('click', e => { e.preventDefault(); login(); });
      box.appendChild(a);
    }
  }

  window.EveAuth = {
    login, logout, fetchSkills, SKILL_IDS,
    isLoggedIn: () => !!(auth.tokens && auth.character),
    character: () => auth.character || null,
    skills: () => auth.skills || null,
  };

  const init = async () => { await handleCallback(); renderUI(); };
  // pages await this before reading login state (the callback token exchange is async)
  window.EveAuth.ready = (document.readyState === 'loading')
    ? new Promise(res => document.addEventListener('DOMContentLoaded', () => res(init())))
    : init();
})();

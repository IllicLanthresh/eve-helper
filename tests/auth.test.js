/* auth.js — EVE SSO PKCE, multi-character login, storage migration and scope handling.

   Every SSO/ESI call is intercepted; nothing leaves the machine. The access tokens are
   fabricated JWTs (auth.js only base64-decodes the payload, it never verifies a
   signature), which is what lets the callback and the scope logic be exercised end to
   end without a real login. */
'use strict';
const H = require('./helper');
const { check, eq, section } = H;

const MAIN = { id: 93813310, name: 'Miquel Dreamer' };
const ALT = { id: 91000001, name: 'Second Pilot' };
const STANDINGS_SCOPE = 'esi-characters.read_standings.v1';

const authBlob = page => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('eveHelper.auth.v1') || 'null'); } catch (_e) { return null; }
});

async function open(browser, server, opts) {
  opts = opts || {};
  const context = await browser.newContext();
  if (opts.storage) await H.seedStorage(context, server.url, opts.storage);
  const counters = await H.mockEsi(context, opts);
  const page = await context.newPage();
  if (!opts.allowPageErrors) H.watchPage(page, 'auth');
  page.on('dialog', d => d.dismiss().catch(() => {}));   // alert() on a failed login
  await page.goto(server.url + (opts.path || '/index.html'));
  await page.evaluate(() => window.EveAuth && EveAuth.ready);
  return { context, page, counters, close: () => context.close() };
}

H.run('auth', async () => {
  const server = await H.startServer();
  const browser = await H.launch();
  try {
    /* ---------- the PKCE callback ---------- */
    section('SSO PKCE callback');
    let context = await browser.newContext();
    await H.seedStorage(context, server.url, [['eveHelper.auth.v1', {
      v: 2, clientId: 'test-client-id', active: null, chars: {},
      pkce: { verifier: 'test-verifier', state: 'test-state', returnTo: server.url + '/index.html' },
    }]]);
    await H.mockEsi(context, {
      tokenResponse: { charId: MAIN.id, charName: MAIN.name, scopes: H.ALL_SCOPES },
      skills: { accounting: 5, brokerRelations: 5 }, standings: {},
    });
    let page = await context.newPage();
    let tokenBody = null;
    page.on('request', r => {
      if (r.url().includes('/oauth/token')) tokenBody = r.postData();
    });
    await page.goto(server.url + '/index.html?code=test-auth-code&state=test-state');
    await page.evaluate(() => EveAuth.ready);
    await page.waitForFunction(() => EveAuth.isLoggedIn(), null, { timeout: 10000 });

    check('the callback logs the character in', await page.evaluate(() => EveAuth.isLoggedIn()));
    eq('the character id comes from the JWT sub CHARACTER:EVE:<id>',
      await page.evaluate(() => EveAuth.character().id), MAIN.id);
    eq('the character name comes from the JWT name claim',
      await page.evaluate(() => EveAuth.character().name), MAIN.name);
    check('the token exchange sent the PKCE verifier',
      /code_verifier=test-verifier/.test(tokenBody || ''), tokenBody);
    check('...and the authorization code', /code=test-auth-code/.test(tokenBody || ''), tokenBody);
    check('...and the client id', /client_id=test-client-id/.test(tokenBody || ''), tokenBody);
    check('the ?code= is stripped from the URL afterwards',
      !/code=/.test(await page.evaluate(() => location.search)),
      await page.evaluate(() => location.search));
    let blob = await authBlob(page);
    check('the one-shot PKCE material is discarded', !blob.pkce, JSON.stringify(blob.pkce));
    eq('all six scopes ride along on the stored token',
      (await page.evaluate(() => EveAuth.tokenScopes())).length, H.ALL_SCOPES.length);
    await context.close();

    /* ---------- a mismatched state must be ignored ---------- */
    section('callback state mismatch');
    context = await browser.newContext();
    await H.seedStorage(context, server.url, [['eveHelper.auth.v1', {
      v: 2, clientId: 'test-client-id', active: null, chars: {},
      pkce: { verifier: 'v', state: 'the-real-state', returnTo: server.url + '/index.html' },
    }]]);
    await H.mockEsi(context, { tokenResponse: { charId: MAIN.id, charName: MAIN.name } });
    page = await context.newPage();
    let tokenCalled = false;
    page.on('request', r => { if (r.url().includes('/oauth/token')) tokenCalled = true; });
    await page.goto(server.url + '/index.html?code=abc&state=forged-state');
    await page.evaluate(() => EveAuth.ready);
    check('a forged state does not log anyone in', !(await page.evaluate(() => EveAuth.isLoggedIn())));
    check('...and never reaches the token endpoint', !tokenCalled);
    await context.close();

    /* ---------- multi-character ---------- */
    section('multiple characters');
    let s = await open(browser, server, {
      storage: [['eveHelper.auth.v1', H.authState([MAIN, ALT])]],
      skills: { accounting: 5, brokerRelations: 5 }, standings: {},
    });
    eq('both characters are logged in', await s.page.evaluate(() => EveAuth.characters().length), 2);
    eq('the first is active', await s.page.evaluate(() => EveAuth.active()), MAIN.id);
    check('the topbar offers a character selector',
      await s.page.evaluate(() => !!document.querySelector('#authBox select')));
    await s.page.evaluate(id => EveAuth.setActive(id), ALT.id);
    eq('setActive switches the active character',
      await s.page.evaluate(() => EveAuth.active()), ALT.id);
    eq('...and the character() accessor follows',
      await s.page.evaluate(() => EveAuth.character().name), ALT.name);
    blob = await authBlob(s.page);
    eq('...and it is persisted', blob.active, ALT.id);
    check('each character keeps its own token',
      blob.chars[MAIN.id].tokens.access !== blob.chars[ALT.id].tokens.access);

    section('logout');
    await s.page.evaluate(id => EveAuth.logout(id), ALT.id);
    eq('logging one character out leaves the other', await s.page.evaluate(() => EveAuth.characters().length), 1);
    eq('...and moves the active slot', await s.page.evaluate(() => EveAuth.active()), MAIN.id);
    await s.page.evaluate(() => EveAuth.logout());
    check('logging the last one out empties the session',
      !(await s.page.evaluate(() => EveAuth.isLoggedIn())));
    blob = await authBlob(s.page);
    eq('...but keeps the client id, so no re-setup is needed', blob.clientId, 'test-client-id');
    eq('...and drops every character', Object.keys(blob.chars).length, 0);
    await s.close();

    /* ---------- v1 -> v2 storage migration ---------- */
    section('v1 -> v2 storage migration');
    const v1Token = H.fakeJwt({ sub: 'CHARACTER:EVE:' + MAIN.id, name: MAIN.name, scp: H.ALL_SCOPES });
    s = await open(browser, server, {
      storage: [['eveHelper.auth.v1', {
        clientId: 'legacy-client-id',
        tokens: { access: v1Token, refresh: 'legacy-refresh', exp: Date.now() + 3600e3 },
        character: { id: MAIN.id, name: MAIN.name },
        skills: { accounting: 4, brokerRelations: 3, fetched: new Date().toISOString() },
      }]],
      skills: { accounting: 4, brokerRelations: 3 }, standings: {},
    });
    check('a v1 blob still logs the character in', await s.page.evaluate(() => EveAuth.isLoggedIn()));
    eq('...as the active character', await s.page.evaluate(() => EveAuth.active()), MAIN.id);
    eq('...with their skills carried over', await s.page.evaluate(() => EveAuth.skills().brokerRelations), 3);
    blob = await authBlob(s.page);
    eq('the client id survives the migration', blob.clientId, 'legacy-client-id');
    // the migrated shape is only written back on the next save(); the in-memory view is what matters
    eq('the migrated character sits under chars{}',
      await s.page.evaluate(() => EveAuth.characters()[0].name), MAIN.name);
    await s.close();

    /* ---------- scope dropping driven by the SSO metadata ---------- */
    section('scopes dropped from the login request when the SSO no longer offers them');
    const kept = H.ALL_SCOPES.filter(x => x !== STANDINGS_SCOPE);
    context = await browser.newContext();
    await H.seedStorage(context, server.url, [['eveHelper.auth.v1', { v: 2, clientId: 'test-client-id', active: null, chars: {} }]]);
    await H.mockEsi(context, { ssoScopes: kept });
    page = await context.newPage();
    let authorizeUrl = null;
    await context.route('**/login.eveonline.com/v2/oauth/authorize/**', route => {
      authorizeUrl = route.request().url();
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>sso</body></html>' });
    });
    await page.goto(server.url + '/index.html');
    await page.evaluate(() => EveAuth.ready);
    await page.evaluate(() => EveAuth.login());
    await page.waitForFunction(() => /login\.eveonline\.com/.test(location.href), null, { timeout: 10000 });
    const scopeParam = authorizeUrl ? new URL(authorizeUrl).searchParams.get('scope') : '';
    check('the authorize request was made', !!authorizeUrl, String(authorizeUrl));
    check('the unsupported scope is dropped from the request',
      !scopeParam.includes(STANDINGS_SCOPE), scopeParam);
    check('...while every supported scope is still asked for',
      kept.every(x => scopeParam.includes(x)), scopeParam);
    check('PKCE uses S256',
      new URL(authorizeUrl).searchParams.get('code_challenge_method') === 'S256');
    check('...with a challenge, not the raw verifier',
      (new URL(authorizeUrl).searchParams.get('code_challenge') || '').length >= 43);
    await context.close();

    /* ---------- a token without the standings scope must not call ESI ---------- */
    section('a token lacking the standings scope degrades instead of calling ESI');
    s = await open(browser, server, {
      storage: [['eveHelper.auth.v1', H.authState([{ id: MAIN.id, name: MAIN.name, scopes: kept }])]],
      skills: { accounting: 5, brokerRelations: 5 }, standings: {},
    });
    const st = await s.page.evaluate(() => EveAuth.fetchStandings());
    check('standings come back marked needsRelogin', st && st.needsRelogin === true, JSON.stringify(st));
    eq('the standings endpoint was never called', s.counters.standings, 0);
    await s.page.waitForFunction(
      "[...document.querySelectorAll('fieldset.grp .hint')].some(n=>/⚡/.test(n.textContent))",
      null, { timeout: 15000 });
    const feeNote = await s.page.evaluate(() =>
      [...document.querySelectorAll('fieldset.grp .hint')].map(n => n.textContent).find(t => /⚡/.test(t)) || '');
    check('the Sell page explains it rather than silently using 0',
      /as if they were zero/.test(feeNote), feeNote);
    check('...and routes to the permissions panel (see permissions.test.js)',
      await s.page.evaluate(() => !!document.querySelector('.evePermLink[data-perm-scope="esi-characters.read_standings.v1"]')));
    await s.close();

    /* ---------- the SSO itself no longer offering the scope reads differently ---------- */
    section('a scope the SSO dropped reads as unavailable, not as a missing grant');
    s = await open(browser, server, {
      storage: [['eveHelper.auth.v1', Object.assign(
        H.authState([{ id: MAIN.id, name: MAIN.name, scopes: kept }]),
        { droppedScopes: [STANDINGS_SCOPE] })]],
      skills: { accounting: 5, brokerRelations: 5 }, standings: {},
    });
    const st2 = await s.page.evaluate(() => EveAuth.fetchStandings());
    check('standings come back marked unavailable', st2 && st2.unavailable === true, JSON.stringify(st2));
    eq('...still without calling the endpoint', s.counters.standings, 0);
    await s.close();

    /* ---------- an ESI 403 also degrades ---------- */
    section('ESI 403 on standings degrades to needsRelogin');
    s = await open(browser, server, {
      storage: [['eveHelper.auth.v1', H.authState([MAIN])]],
      skills: { accounting: 5, brokerRelations: 5 }, standingsStatus: 403,
    });
    const st3 = await s.page.evaluate(() => EveAuth.fetchStandings());
    check('a 403 is recorded rather than thrown', st3 && st3.needsRelogin === true, JSON.stringify(st3));
    check('...and the endpoint really was called', s.counters.standings >= 1, s.counters.standings);
    await s.close();

    /* ---------- happy path: standings are fetched and indexed ---------- */
    section('standings fetch');
    const stFixture = {}; stFixture[1000035] = 7.5; stFixture[500001] = -2.25;
    s = await open(browser, server, {
      storage: [['eveHelper.auth.v1', H.authState([MAIN])]],
      skills: { accounting: 5, brokerRelations: 5 }, standings: stFixture,
    });
    const st4 = await s.page.evaluate(() => EveAuth.fetchStandings());
    eq('a corp standing is indexed by from_id', st4 && st4[1000035], 7.5);
    eq('...including negative ones', st4 && st4[500001], -2.25);
    await s.close();
  } finally {
    await browser.close();
    await server.close();
  }
});

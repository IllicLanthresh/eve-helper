/* The shared ESI-permissions layer: EveAuth.permissions(), the topbar indicator, the
   permissions panel and the inline degradation notes on each page — Sell, Industry and
   the Structure Manager, whose only ESI-backed feature is the structure search.

   The point of this layer is that a missing capability is never silent, and that the
   three reasons a scope can be missing are never conflated: the character hasn't
   re-logged in, the SSO application doesn't have the scope, or CCP retired it. */
'use strict';
const H = require('./helper');
const { check, eq, section } = H;

const MAIN = { id: 93813310, name: 'Miquel Dreamer' };
const ALT = { id: 91000001, name: 'Second Pilot' };
const BP_SCOPE = 'esi-characters.read_blueprints.v1';
const STANDINGS_SCOPE = 'esi-characters.read_standings.v1';
const SKILLS_SCOPE = 'esi-skills.read_skills.v1';

const without = (...drop) => H.ALL_SCOPES.filter(s => !drop.includes(s));

async function open(browser, server, opts) {
  opts = opts || {};
  const context = await browser.newContext();
  await H.seedStorage(context, server.url, opts.storage || []);
  const counters = await H.mockEsi(context, Object.assign(
    { skills: { accounting: 5, brokerRelations: 5 }, standings: {} }, opts.esi));
  if (opts.industryFixture) {
    await context.route('**/data/industry.json', route => route.fulfill(H.json(opts.industryFixture)));
  }
  const page = await context.newPage();
  H.watchPage(page, 'perms');
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.goto(server.url + (opts.path || '/index.html'));
  await page.evaluate(() => window.EveAuth && EveAuth.ready);
  return { context, page, counters, close: () => context.close() };
}

const report = page => page.evaluate(() => EveAuth.permissions());
const openPanel = async page => {
  await page.evaluate(() => EveAuth.showPermissions());
  await page.waitForSelector('#evePerms');
  return page.evaluate(() => document.getElementById('evePerms').textContent);
};

/* minimal SDE fixture, enough for the Industry page to boot */
const FIXTURE = {
  v: 'perm-fixture',
  types: { 1001: ['Test Widget', 5, 5, 100, 200, null], 3001: ['Test Mineral', 0.01, 0.01, 102, 202, null] },
  groups: { 100: ['Widgets', 6], 102: ['Minerals', 4] },
  marketGroups: { 200: ['Manufactured', 0], 202: ['Minerals', 0] },
  skills: {}, rigs: {},
  blueprints: { 9001: { limit: 20, man: { t: 1200, m: [[3001, 100]], p: [[1001, 1]], s: [] } } },
};

H.run('permissions', async () => {
  const server = await H.startServer();
  const browser = await H.launch();
  try {
    /* ================= a token missing one scope ================= */
    section('a token whose scp lacks the blueprints scope');
    let s = await open(browser, server, {
      storage: [['eveHelper.auth.v1', H.authState([{ id: MAIN.id, name: MAIN.name, scopes: without(BP_SCOPE) }])]],
    });
    let rep = await report(s.page);
    eq('one character is reported', rep.chars.length, 1);
    eq('...by name', rep.chars[0].name, MAIN.name);
    eq('...with exactly one missing scope', rep.chars[0].missing.length, 1);
    eq('...naming the blueprints scope', rep.chars[0].missing[0].scope, BP_SCOPE);
    eq('...with reason not-granted', rep.chars[0].missing[0].reason, 'not-granted');
    check('...and a plain-language consequence, not just the scope name',
      /assumed ME\/TE/.test(rep.chars[0].missing[0].features.join(' ')),
      JSON.stringify(rep.chars[0].missing[0].features));
    eq('...while the other five are granted', rep.chars[0].granted.length, H.ALL_SCOPES.length - 1);
    check('the report is not all-good', rep.allGood === false, JSON.stringify(rep.allGood));
    eq('...and the application itself is fine', rep.appIssues.length, 0);

    section('the topbar says so');
    const warn = await s.page.$eval('#authPermWarn', el => el.textContent).catch(() => null);
    eq('the topbar shows a compact permissions warning', warn, '⚠ 1 permission');
    await s.page.click('#authPermWarn');
    await s.page.waitForSelector('#evePerms');
    check('...and clicking it opens the panel', await s.page.isVisible('#evePerms'));
    let text = await s.page.evaluate(() => document.getElementById('evePerms').textContent);
    check('the panel names the missing scope', text.includes(BP_SCOPE), text.slice(0, 200));
    check('...with its consequence spelled out', /assumed ME\/TE/.test(text), text.slice(0, 400));
    check('...and tells the user to log in again', /log in again/.test(text), text.slice(0, 400));
    check('...listing the granted scopes too', text.includes(SKILLS_SCOPE), text.slice(0, 400));
    check('the panel gives the exact callback URL',
      text.includes('/index.html'), text.slice(-400));
    check('...and offers to copy the scope list',
      await s.page.evaluate(() => [...document.querySelectorAll('#evePerms button')].some(b => /copy list/.test(b.textContent))));
    check('...and the developer-portal link',
      await s.page.evaluate(() => !!document.querySelector('#evePerms a[href*="developers.eveonline.com"]')));

    section('the re-login button starts the real login flow');
    // catch the SSO redirect rather than stubbing: the button must actually authorize
    let authorizeUrl = null;
    await s.context.route('**/login.eveonline.com/v2/oauth/authorize/**', route => {
      authorizeUrl = route.request().url();
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>sso</body></html>' });
    });
    const btnState = await s.page.evaluate(() => {
      const btn = [...document.querySelectorAll('#evePerms button')].find(b => /re-login/.test(b.textContent));
      if (btn) btn.click();
      return { hadButton: !!btn, closed: !document.getElementById('evePerms') };
    });
    check('a re-login button is offered for the character', btnState.hadButton);
    check('...closing the panel on the way out', btnState.closed);
    await s.page.waitForFunction(() => /login\.eveonline\.com/.test(location.href), null, { timeout: 10000 });
    check('...and it really sends the character to the SSO', !!authorizeUrl, String(authorizeUrl));
    check('...asking for the scope that was missing',
      (authorizeUrl && new URL(authorizeUrl).searchParams.get('scope') || '').includes(BP_SCOPE),
      authorizeUrl);
    await s.close();

    /* ================= the Industry inline note ================= */
    section('the Industry page says its table is using assumed ME/TE');
    s = await open(browser, server, {
      path: '/industry.html',
      industryFixture: FIXTURE,
      storage: [['eveHelper.auth.v1', H.authState([{ id: MAIN.id, name: MAIN.name, scopes: without(BP_SCOPE) }])]],
    });
    await s.page.waitForFunction(() => {
      const el = document.getElementById('bpNote');
      return el && el.textContent.length > 0;
    }, null, { timeout: 15000 });
    const bpNote = await s.page.$eval('#bpNote', el => ({ text: el.textContent, cls: el.className }));
    check('the owned-blueprints area warns', /warn/.test(bpNote.cls), bpNote.cls);
    check('...saying the table uses the profile\'s ASSUMED ME/TE',
      /ASSUMED ME/.test(bpNote.text), bpNote.text);
    check('...and links to the permissions panel',
      await s.page.evaluate(() => !!document.querySelector('#bpNote .evePermLink')));
    await s.page.click('#bpNote .evePermLink');
    await s.page.waitForSelector('#evePerms');
    check('...which opens it', await s.page.isVisible('#evePerms'));
    await s.page.keyboard.press('Escape');
    await s.page.waitForFunction(() => {
      const lab = document.getElementById('fltOwned').closest('label');
      const n = lab.querySelector('.evePermLink');
      return !!n && /can't be trusted/.test(n.textContent);
    }, null, { timeout: 15000 });
    check('the "only owned BPs" filter is flagged as untrustworthy', true);
    await s.close();

    /* ================= the Structure Manager ================= */
    section('the Structure Manager degrades the same way every other page does');
    {
      const SEARCH_SCOPES = ['esi-search.search_structures.v1', 'esi-universe.read_structures.v1'];
      s = await open(browser, server, {
        path: '/structures.html',
        industryFixture: FIXTURE,
        storage: [['eveHelper.auth.v1',
          H.authState([{ id: MAIN.id, name: MAIN.name, scopes: without(...SEARCH_SCOPES) }])]],
      });
      // the shared topbar box is injected by auth.js — wait for it before asserting on it
      await s.page.waitForFunction(() => {
        const box = document.getElementById('authBox');
        return box && box.children.length > 0;
      }, null, { timeout: 15000 });
      eq('the manager gets the same topbar shortfall count',
        await s.page.$eval('#authPermWarn', el => el.textContent), '⚠ 2 permissions');
      rep = await report(s.page);
      check('...naming the two structure scopes',
        rep.chars[0].missing.map(m => m.scope).sort().join(',') === SEARCH_SCOPES.slice().sort().join(','),
        JSON.stringify(rep.chars[0].missing.map(m => m.scope)));

      await s.page.click('#btnAdd');
      await s.page.waitForSelector('#structPicker #structMsg.err');
      const msg = await s.page.$eval('#structPicker #structMsg', el => el.textContent);
      check('adding a structure says the search is unavailable',
        /structure search is unavailable/.test(msg), msg);
      check('...naming both missing scopes',
        SEARCH_SCOPES.every(sc => msg.includes(sc)), msg);
      check('...and the search box is disabled rather than silently useless',
        await s.page.$eval('#structSearch', el => el.disabled));
      check('...with a link to the panel that fixes it',
        await s.page.evaluate(() => !!document.querySelector('#structPicker .evePermLink')));
      await s.page.click('#structPicker .evePermLink');
      await s.page.waitForSelector('#evePerms');
      check('...which closes the picker and opens the permissions panel',
        await s.page.evaluate(() => !document.getElementById('structPicker')));
      await s.page.keyboard.press('Escape');
      await s.close();
    }

    section('...and a fully granted token leaves the manager clean');
    s = await open(browser, server, {
      path: '/structures.html',
      industryFixture: FIXTURE,
      storage: [['eveHelper.auth.v1', H.authState([MAIN])]],
    });
    await s.page.waitForFunction(() => {
      const box = document.getElementById('authBox');
      return box && box.children.length > 0;
    }, null, { timeout: 15000 });
    check('no topbar warning', await s.page.evaluate(() => !document.getElementById('authPermWarn')));
    await s.page.click('#btnAdd');
    await s.page.waitForSelector('#structSearch');
    check('the structure search is enabled', await s.page.$eval('#structSearch', el => !el.disabled));
    check('...and nothing is flagged in the picker',
      await s.page.evaluate(() => !document.querySelector('#structPicker .evePermLink')));
    await s.page.keyboard.press('Escape');
    await s.close();

    section('...and logged out it says to log in, rather than failing silently');
    s = await open(browser, server, { path: '/structures.html', industryFixture: FIXTURE });
    await s.page.waitForFunction(() => typeof D !== 'undefined' && D !== null, null, { timeout: 20000 });
    await s.page.click('#btnAdd');
    await s.page.waitForSelector('#structPicker #structMsg.err');
    check('the picker asks for a login',
      /log in with EVE first/.test(await s.page.$eval('#structPicker #structMsg', el => el.textContent)));
    check('...and the search box is disabled',
      await s.page.$eval('#structSearch', el => el.disabled));
    await s.page.keyboard.press('Escape');
    await s.close();

    /* ================= app-missing: a stored invalid_scope ================= */
    section('a stored invalid_scope authorize error is an APPLICATION problem');
    const blob = H.authState([{ id: MAIN.id, name: MAIN.name, scopes: without(BP_SCOPE) }]);
    blob.lastAuthError = {
      error: 'invalid_scope',
      description: "The scope 'esi-characters.read_blueprints.v1' is not assigned to the application",
      at: Date.now(),
      scope: BP_SCOPE,
    };
    s = await open(browser, server, { storage: [['eveHelper.auth.v1', blob]] });
    rep = await report(s.page);
    eq('the application section reports one issue', rep.appIssues.length, 1);
    eq('...for the rejected scope', rep.appIssues[0].scope, BP_SCOPE);
    eq('...with reason app-missing', rep.appIssues[0].reason, 'app-missing');
    check('...explaining it is a developer-portal fix',
      /developer\s*\n?\s*portal/.test(rep.appIssues[0].detail), rep.appIssues[0].detail);
    check('...and that logging in again will not help',
      /keep failing until/.test(rep.appIssues[0].detail), rep.appIssues[0].detail);
    eq('the character-level reason changes to app-missing too',
      rep.chars[0].missing.find(m => m.scope === BP_SCOPE).reason, 'app-missing');
    text = await openPanel(s.page);
    check('the panel has a separate application section', /your SSO application/i.test(text), text.slice(0, 300));
    check('...worded differently from the not-granted case',
      /not assigned to the application/.test(text), text.slice(0, 600));
    check('...and no longer offers a pointless re-login button for that scope',
      await s.page.evaluate(() =>
        ![...document.querySelectorAll('#evePerms button')].some(b => /re-login/.test(b.textContent))));
    await s.close();

    /* ================= sso-removed: CCP retired the scope ================= */
    section('a scope CCP retired is reported as not the user\'s fault');
    const blob2 = H.authState([{ id: MAIN.id, name: MAIN.name, scopes: without(STANDINGS_SCOPE) }]);
    blob2.droppedScopes = [STANDINGS_SCOPE];
    s = await open(browser, server, { storage: [['eveHelper.auth.v1', blob2]] });
    rep = await report(s.page);
    eq('the retired scope is an application-level issue', rep.appIssues.length, 1);
    eq('...for the standings scope', rep.appIssues[0].scope, STANDINGS_SCOPE);
    eq('...with reason sso-removed', rep.appIssues[0].reason, 'sso-removed');
    check('...saying CCP retired it', /retired it server-side/.test(rep.appIssues[0].detail), rep.appIssues[0].detail);
    check('...and that the user did nothing wrong',
      /nothing you did wrong/.test(rep.appIssues[0].detail), rep.appIssues[0].detail);
    eq('the character-level reason matches',
      rep.chars[0].missing.find(m => m.scope === STANDINGS_SCOPE).reason, 'sso-removed');
    text = await openPanel(s.page);
    check('the panel says it cannot be fixed by the user',
      /nothing you can do/.test(text), text.slice(0, 600));
    await s.page.keyboard.press('Escape');

    section('the Sell fee note routes to the panel when standings are missing');
    await s.page.waitForFunction(
      "[...document.querySelectorAll('fieldset.grp .hint')].some(n=>/⚡/.test(n.textContent))",
      null, { timeout: 15000 });
    const feeNote = await s.page.evaluate(() =>
      [...document.querySelectorAll('fieldset.grp .hint')].map(n => n.textContent).find(t => /⚡/.test(t)) || '');
    check('the fee note says the fee assumes zero standings',
      /as if they were zero/.test(feeNote), feeNote);
    check('...and carries a link to the panel',
      await s.page.evaluate(() =>
        !!document.querySelector('fieldset.grp .evePermLink[data-perm-scope="esi-characters.read_standings.v1"]')));
    await s.close();

    /* ================= everything granted ================= */
    section('a fully granted token is silent');
    s = await open(browser, server, {
      storage: [['eveHelper.auth.v1', H.authState([MAIN])]],
    });
    rep = await report(s.page);
    check('the report is all good', rep.allGood === true, JSON.stringify(rep));
    eq('...with nothing missing', rep.chars[0].missing.length, 0);
    eq('...and no application issues', rep.appIssues.length, 0);
    eq('every requested scope is granted', rep.chars[0].granted.length, H.ALL_SCOPES.length);
    // absence is only meaningful once the topbar has actually rendered — otherwise this
    // would pass just as happily on an empty page
    await s.page.waitForFunction(() => {
      const box = document.getElementById('authBox');
      return box && box.children.length > 0;
    }, null, { timeout: 15000 });
    check('the topbar shows NO warning',
      await s.page.evaluate(() => !document.getElementById('authPermWarn')));
    await s.page.waitForFunction(
      "[...document.querySelectorAll('fieldset.grp .hint')].some(n=>/⚡/.test(n.textContent))",
      null, { timeout: 15000 });
    check('...and the Sell page shows no inline permission note',
      await s.page.evaluate(() => !document.querySelector('.evePermLink')));
    check('the panel still opens and says everything is granted',
      /Nothing is degraded/.test(await openPanel(s.page)));
    await s.close();

    section('a fully granted token leaves the Industry page clean too');
    s = await open(browser, server, {
      path: '/industry.html',
      industryFixture: FIXTURE,
      storage: [['eveHelper.auth.v1', H.authState([MAIN])]],
    });
    await s.page.waitForFunction(() => typeof D !== 'undefined' && D !== null, null, { timeout: 20000 });
    // renderBpNote()/renderOwnedFilterNote() run from renderAges(), which fills #dataAges.
    // Wait for that to have happened, or "no warning" would be a false green.
    await s.page.waitForFunction(
      () => document.getElementById('dataAges').children.length > 0, null, { timeout: 20000 });
    eq('the owned-blueprints note stays empty',
      (await s.page.$eval('#bpNote', el => el.textContent)).trim(), '');
    check('...and the owned filter is unflagged',
      await s.page.evaluate(() => !document.getElementById('fltOwned').closest('label').querySelector('.evePermLink')));
    await s.close();

    /* ================= multi-character ================= */
    section('two characters with different grants are reported separately');
    s = await open(browser, server, {
      storage: [['eveHelper.auth.v1', H.authState([
        { id: MAIN.id, name: MAIN.name, scopes: H.ALL_SCOPES },
        { id: ALT.id, name: ALT.name, scopes: without(BP_SCOPE, STANDINGS_SCOPE) },
      ])]],
    });
    rep = await report(s.page);
    eq('both characters appear', rep.chars.length, 2);
    const main = rep.chars.find(c => c.id === MAIN.id);
    const alt = rep.chars.find(c => c.id === ALT.id);
    eq('the fully granted one has nothing missing', main.missing.length, 0);
    eq('...and the other is missing two', alt.missing.length, 2);
    check('...named individually',
      alt.missing.map(m => m.scope).sort().join(',') === [BP_SCOPE, STANDINGS_SCOPE].sort().join(','),
      JSON.stringify(alt.missing.map(m => m.scope)));
    check('the report is not all-good', rep.allGood === false);
    eq('the topbar counts the shortfall across characters',
      await s.page.$eval('#authPermWarn', el => el.textContent), '⚠ 2 permissions');
    text = await openPanel(s.page);
    check('the panel shows both characters', text.includes(MAIN.name) && text.includes(ALT.name), text.slice(0, 300));
    check('...marking the complete one as all granted', /all granted/.test(text), text.slice(0, 400));
    await s.close();

    /* ================= the modal chrome is shared, not duplicated ================= */
    section('one stylesheet serves both modals');
    s = await open(browser, server, { storage: [['eveHelper.auth.v1', H.authState([MAIN])]] });
    await s.page.evaluate(() => EveAuth.showPermissions());
    await s.page.waitForSelector('#evePerms');
    check('the permissions panel uses the shared modal class',
      await s.page.evaluate(() => document.getElementById('evePerms').classList.contains('eveModal')));
    await s.page.keyboard.press('Escape');
    // pick() resolves only when the modal closes — fire and forget, then inspect the DOM
    await s.page.evaluate(() => { EveStructures.pick({ title: 'x', list: true }); });
    await s.page.waitForSelector('#structPicker');
    check('...and so does the structure picker',
      await s.page.evaluate(() => document.getElementById('structPicker').classList.contains('eveModal')));
    check('the shared panel styling actually applies to it',
      await s.page.evaluate(() => {
        const p = document.querySelector('#structPicker .panel');
        return p && getComputedStyle(p).borderRadius === '10px';
      }));
    eq('there is exactly one copy of the modal CSS',
      await s.page.evaluate(() =>
        [...document.querySelectorAll('style')].filter(st => st.textContent.includes('.eveModal .panel')).length), 1);
    await s.page.keyboard.press('Escape');
    await s.close();
  } finally {
    await browser.close();
    await server.close();
  }
});

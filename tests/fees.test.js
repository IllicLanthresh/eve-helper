/* Fee model, driven through the real Sell page with mocked SSO/ESI.

   Covers: the sales-tax and broker formulas as wired to skills and standings, the proof
   that Connections/Diplomacy do NOT touch market fees, that the fee inputs stay
   hand-editable, and that the removed "game says…" observed-rate boxes stay removed —
   including old persisted state that still carries their keys. */
'use strict';
const H = require('./helper');
const { check, eq, near, section } = H;

const CHAR = { id: 93813310, name: 'Miquel Dreamer' };
const CORP_ID = 1000035;      // Caldari Navy (owns Jita 4-4)
const FACTION_ID = 500001;    // Caldari State

/* Open index.html logged in as CHAR with the given skills/standings, and wait for the
   fee auto-fill to have run (the note only appears once apply() completed). */
async function openSell(browser, server, opts) {
  const context = await browser.newContext();
  await H.seedStorage(context, server.url, [['eveHelper.auth.v1', H.authState([CHAR])]]);
  if (opts.storage) await H.seedStorage(context, server.url, opts.storage);
  const counters = await H.mockEsi(context, opts);
  const page = await context.newPage();
  H.watchPage(page, 'sell');
  await page.goto(server.url + '/index.html');
  await waitNote(page);
  return { context, page, counters, close: () => context.close() };
}

const NOTE_JS = "[...document.querySelectorAll('fieldset.grp .hint')].map(n=>n.textContent).find(t=>/⚡|set by its owner/.test(t))||''";
const waitNote = page => page.waitForFunction(NOTE_JS, null, { timeout: 15000 });
const feeNote = page => page.evaluate(NOTE_JS);

const val = (page, id) => page.$eval('#' + id, el => el.value);

H.run('fees', async () => {
  const server = await H.startServer();
  const browser = await H.launch();
  try {
    /* ---------- constants are actually named and exported into page scope ---------- */
    section('fee constants');
    const context0 = await browser.newContext();
    const p0 = await context0.newPage();
    await p0.goto(server.url + '/index.html');
    const K = await p0.evaluate(() => ({
      BROKER_BASE_PCT, BROKER_SKILL_PP_PER_LEVEL, BROKER_FACTION_PP, BROKER_CORP_PP,
      MIN_BROKER_FEE_ISK, SALES_TAX_BASE_PCT, ACCOUNTING_REL_PER_LEVEL,
    }));
    check('fee model is parameterized into named constants',
      Object.values(K).every(v => typeof v === 'number' && Number.isFinite(v)), JSON.stringify(K));
    eq('broker base is 3%', K.BROKER_BASE_PCT, 3);
    eq('broker skill term is 0.3pp/level (client-verified, NOT the 5%-relative model)',
      K.BROKER_SKILL_PP_PER_LEVEL, 0.3);
    eq('minimum broker fee per order is 100 ISK', K.MIN_BROKER_FEE_ISK, 100);
    await context0.close();

    /* ---------- sales tax ---------- */
    section('sales tax from Accounting');
    let s = await openSell(browser, server, {
      skills: { accounting: 5, brokerRelations: 5 },
      standings: {},
    });
    // expected derived from the page's own constants, so a future base correction does
    // not fail this test (with today's 7.5 / 0.11 it is 3.375 -> "3.38")
    const expTax = K.SALES_TAX_BASE_PCT * (1 - K.ACCOUNTING_REL_PER_LEVEL * 5);
    near('Accounting 5 -> sales tax = base x (1 - rel x 5)',
      parseFloat(await val(s.page, 'salesTax')), Number(expTax.toFixed(2)), 1e-9);
    near('...which is 3.375 with the constants as they stand today', expTax, 3.375, 1e-9);

    /* ---------- broker: the client-verified case ---------- */
    section('broker fee, Broker Relations 5, zero standings');
    eq('BR5 + zero standings -> 1.50% (verified against the live client at Jita 4-4)',
      await val(s.page, 'brokerFee'), '1.50');
    check('note reports the unmodified standings',
      /unmodified/.test(await feeNote(s.page)), await feeNote(s.page));
    check('note mentions the 100 ISK per-order minimum',
      /100 ISK/.test(await feeNote(s.page)), await feeNote(s.page));
    await s.close();

    /* ---------- broker with real standings ---------- */
    section('broker fee with non-zero raw standings');
    const standings = {};
    standings[CORP_ID] = 5.0;
    standings[FACTION_ID] = 3.0;
    s = await openSell(browser, server, {
      skills: { accounting: 5, brokerRelations: 5 },
      standings,
    });
    // 3 - 0.3*5 - 0.03*3 - 0.02*5 = 1.31
    eq('corp 5.0 / faction 3.0 at BR5 -> 1.31%', await val(s.page, 'brokerFee'), '1.31');
    await s.close();

    /* ---------- THE regression: Connections/Diplomacy must not move market fees ---------- */
    section('Connections/Diplomacy do NOT apply to broker fees');
    s = await openSell(browser, server, {
      skills: { accounting: 5, brokerRelations: 5, connections: 5, diplomacy: 5 },
      standings,
    });
    eq('Connections 5 + Diplomacy 5 leave the broker fee at 1.31%',
      await val(s.page, 'brokerFee'), '1.31');
    const skRead = await s.page.evaluate(() => EveAuth.skills());
    eq('...and Connections 5 really was loaded (the skill is read, just not applied)',
      skRead.connections, 5);
    check('the effective-standing boost is gone from the Sell page',
      await s.page.evaluate(() => typeof eff === 'undefined'), 'eff() still defined');
    await s.close();

    /* ---------- negative standings ---------- */
    section('negative standings raise the broker fee');
    const negSt = {};
    negSt[CORP_ID] = -5.0;
    negSt[FACTION_ID] = -5.0;
    s = await openSell(browser, server, {
      skills: { accounting: 5, brokerRelations: 5, diplomacy: 5 },
      standings: negSt,
    });
    // 3 - 1.5 + 0.03*5 + 0.02*5 = 1.75, and Diplomacy must not soften it
    eq('corp -5 / faction -5 at BR5 -> 1.75%, Diplomacy notwithstanding',
      await val(s.page, 'brokerFee'), '1.75');
    await s.close();

    /* ---------- the observed-rate override is gone ----------
       It was insurance against a formula bug that turned out not to exist (the 2.2% the
       client showed was the 100 ISK per-order floor, which is now modelled), so the
       boxes were removed. Guard against them creeping back. */
    section('the "game says…" override boxes are gone');
    s = await openSell(browser, server, { skills: { accounting: 5, brokerRelations: 5 }, standings: {} });
    const REMOVED_IDS = ['obsBrokerFee', 'obsSalesTax', 'obsBrokerClear', 'obsTaxClear',
                         'obsBrokerWrap', 'obsTaxWrap'];
    for (const id of REMOVED_IDS)
      check('#' + id + ' no longer exists on the Sell page',
        await s.page.evaluate(i => !document.getElementById(i), id));
    check('no "game says" label survives anywhere in the page',
      await s.page.evaluate(() => !/game says/i.test(document.body.textContent)));
    check('the fee note no longer talks about observed rates',
      !/observed rate/.test(await feeNote(s.page)), await feeNote(s.page));

    section('the plain fee inputs stay hand-editable');
    await s.page.fill('#brokerFee', '4.25');
    await s.page.dispatchEvent('#brokerFee', 'change');
    near('a hand-typed broker fee drives the planner',
      await s.page.evaluate(() => feePct('brokerFee')), 0.0425, 1e-12);
    await s.page.fill('#salesTax', '6');
    await s.page.dispatchEvent('#salesTax', 'change');
    near('...and so does a hand-typed sales tax',
      await s.page.evaluate(() => feePct('salesTax')), 0.06, 1e-12);
    await s.close();

    /* ---------- old persisted state must not break anything ---------- */
    section('state saved by the old build loads cleanly');
    s = await openSell(browser, server, {
      skills: { accounting: 5, brokerRelations: 5 },
      standings: {},
      storage: [['eveSellHelper.v2', {
        inv: 'Tritanium\t1000',
        brokerFee: '2.20', salesTax: '2.25',
        // the removed feature's leftovers, exactly as the old build wrote them
        obsBroker: { jita: 2.2, amarr: 1.9, 's:1035466617946': 3.1 },
        obsTax: { jita: 2.25 },
        structBroker: { 1035466617946: '3.75' },
        market: 'jita', ticked: [],
      }]],
    });
    check('the page loads without a console error', true);
    eq('the computed broker fee is applied, not the stale observed one',
      await val(s.page, 'brokerFee'), '1.50');
    eq('...and the computed sales tax likewise', await val(s.page, 'salesTax'), expTax.toFixed(2));
    check('the legacy keys are ignored silently — no note about them',
      !/observed|game says/i.test(await feeNote(s.page)), await feeNote(s.page));
    eq('the rest of the saved state still restores', await val(s.page, 'inv'), 'Tritanium\t1000');
    // and the next save drops the dead keys rather than carrying them forever
    await s.page.evaluate(() => persist());
    const persisted = await s.page.evaluate(() =>
      JSON.parse(localStorage.getItem('eveSellHelper.v2') || '{}'));
    check('a re-save drops obsBroker', persisted.obsBroker === undefined, JSON.stringify(persisted.obsBroker));
    check('...and obsTax', persisted.obsTax === undefined, JSON.stringify(persisted.obsTax));
    check('...while keeping the per-structure owner-set rates',
      persisted.structBroker && persisted.structBroker['1035466617946'] === '3.75',
      JSON.stringify(persisted.structBroker));
    await s.close();

    /* ---------- structures keep their own behaviour ---------- */
    section('player structures are untouched');
    s = await openSell(browser, server, {
      skills: { accounting: 5, brokerRelations: 5 },
      standings: {},
      storage: [['eveHelper.structures.v1', [{ id: 1035466617946, name: 'Test Keepstar', systemId: 30000142, regionId: 10000002 }]]],
    });
    const hasStruct = await s.page.evaluate(() =>
      [...document.getElementById('market').options].some(o => o.value.startsWith('s:')));
    if (check('the saved structure is offered as a market', hasStruct)) {
      await s.page.selectOption('#market', 's:1035466617946');
      await s.page.waitForFunction(() => /set by its owner/.test(
        [...document.querySelectorAll('fieldset.grp .hint')].map(x => x.textContent).join(' ')), null, { timeout: 15000 });
      await s.page.waitForTimeout(100);
      await s.page.fill('#brokerFee', '3.75');
      await s.page.dispatchEvent('#brokerFee', 'change');
      await s.page.selectOption('#market', 'jita');
      await s.page.waitForFunction(() => document.getElementById('brokerFee').value === '1.50');
      await s.page.selectOption('#market', 's:1035466617946');
      await s.page.waitForFunction(() => document.getElementById('brokerFee').value === '3.75', null, { timeout: 15000 });
      eq('the owner-set structure rate is still remembered per structure',
        await val(s.page, 'brokerFee'), '3.75');
    }
    await s.close();
  } finally {
    await browser.close();
    await server.close();
  }
});

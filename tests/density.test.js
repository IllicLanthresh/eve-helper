/* The density rules, enforced.

   The tool's copy is deliberately terse: a cell states a number and its unit, a reason is
   a short chip with its arithmetic on the tooltip, a status line is a dot-separated fact
   string, and the long-form explanation lives behind a "?" that starts CLOSED (and, in
   full, in the README). Prose creeps back one helpful sentence at a time, so this suite
   is the ratchet:

     - every ? disclosure on every page is closed by default, and its one-line summary
       stays a one-liner;
     - the always-visible copy carries none of the connectives that turn a fact string
       back into a sentence ("of which", "because", "so that", "which means");
     - table cells stay short — the number and its unit, nothing else;
     - a flag/chip is at most CHIP_MAX characters AND carries a tooltip, because a chip
       with no tooltip is a fact that was lost rather than moved;
     - the arithmetic tooltips are key: value lines, not paragraphs.

   The live checks run against the same fixture shape the Sell and My-orders suites use,
   so "N characters" is measured on real rendered rows rather than on an empty table. */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./helper');
const { check, eq, section } = H;

const PAGES = ['index.html', 'mine.html', 'industry.html', 'structures.html'];

/* the connectives that mark a fact string relapsing into prose */
const FORBIDDEN = ['of which', 'because', 'so that', 'which means'];
const forbiddenIn = s => FORBIDDEN.filter(w => new RegExp(w, 'i').test(String(s || '')));

const CHIP_MAX = 12;        // a reason code, not a sentence
const CELL_MAX = 24;        // a number and its unit
const SUMMARY_LINE_MAX = 130;   // the one-liner under a heading
const TIP_LINE_MAX = 130;   // one key: value line

const CHAR = { id: 93813310, name: 'Miquel Dreamer' };
const MAIN = CHAR;
const JITA = 60003760;

const day = t => new Date(Date.now() - t * 86400e3).toISOString().slice(0, 10);
const iso = t => new Date(Date.now() - t * 86400e3).toISOString();
const series = (n, f) => {
  const out = [];
  for (let t = n - 1; t >= 0; t--) out.push(Object.assign({ date: day(t) }, f(t)));
  return out;
};

const TYPE_IDS = { Tritanium: 34, Pyerite: 35, 'Cheap Trinket': 9002, 'Thin Widget': 9011 };

/* Books chosen so the rendered table carries every chip shape at once: a min-fee row, a
   depth shortfall, a bookless side, a falling trend and a duplicate-order flag. */
const FALLING = series(400, t => ({
  average: 1000 * Math.pow(1.0101, t), highest: 1200 * Math.pow(1.0101, t),
  lowest: 900 * Math.pow(1.0101, t), volume: 5000,
}));
const FLAT = series(400, () => ({ average: 1000, highest: 1200, lowest: 900, volume: 5000 }));

const BOOKS = {
  Tritanium: { buys: [{ p: 900, v: 2000 }], sells: [{ p: 1000, v: 4000 }], hist: FLAT },
  Pyerite: { buys: [{ p: 950, v: 5 }], sells: [{ p: 1000, v: 10 }], hist: FALLING },
  'Cheap Trinket': { buys: [{ p: 30, v: 10 }], sells: [{ p: 45, v: 900 }], hist: FLAT },
  'Thin Widget': { buys: [], sells: [], hist: [] },
};

const PASTE = ['Tritanium\t1000', 'Pyerite\t500', 'Cheap Trinket\t100', 'Thin Widget\t5'].join('\n');

const CHAR_ORDERS = {
  [MAIN.id]: [
    { order_id: 1, type_id: 34, location_id: JITA, region_id: 10000002, price: 1000,
      volume_remain: 10, volume_total: 10, duration: 90, issued: iso(2), is_buy_order: false, range: 'station' },
    { order_id: 2, type_id: 35, location_id: JITA, region_id: 10000002, price: 2000,
      volume_remain: 10, volume_total: 10, duration: 90, issued: iso(2), is_buy_order: false, range: 'station' },
  ],
};

async function openPage(browser, server, file, opts) {
  const context = await browser.newContext();
  await H.seedStorage(context, server.url, [['eveHelper.auth.v1', H.authState([CHAR])]]);
  await H.mockEsi(context, Object.assign({
    skills: { accounting: 5, brokerRelations: 5 },
    standings: {},
    typeIds: TYPE_IDS,
    books: BOOKS,
    namedIds: { [JITA]: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant' },
  }, opts || {}));
  const page = await context.newPage();
  H.watchPage(page, file);
  await page.goto(server.url + '/' + file);
  return { context, page, close: () => context.close() };
}

/* every ? disclosure the page renders, as the browser sees it */
const helpDisclosures = page => page.evaluate(() =>
  [...document.querySelectorAll('details.help')].map(d => ({
    open: d.open,
    summary: (d.previousSibling && d.previousSibling.textContent || '').trim(),
    body: (d.querySelector('.helpbody') || { textContent: '' }).textContent.trim().length,
  })));

/* the copy that is ALWAYS on screen: everything except the ? bodies and the collapsed
   Notes lists, which are disclosures and may keep their long form */
const visibleCopy = page => page.evaluate(() => {
  const clone = document.body.cloneNode(true);
  // script/style are not copy; ? bodies and the collapsed Notes lists are disclosures
  for (const d of clone.querySelectorAll('script, style, .helpbody, details.notes, details > ul.plain'))
    d.remove();
  return clone.textContent.replace(/\s+/g, ' ');
});

H.run('density', async () => {
  section('every ? disclosure ships closed');
  for (const f of PAGES) {
    const src = fs.readFileSync(path.join(H.REPO, f), 'utf8');
    const opens = (src.match(/<details[^>]*class="help"[^>]*\sopen/g) || []).length;
    eq(f + ' has no ? disclosure marked open in the markup', opens, 0);
    check(f + ' does carry at least one ? disclosure',
      /class="help"/.test(src), 'no details.help found');
  }

  const server = await H.startServer();
  const browser = await H.launch();
  try {
    /* ---------- (a) every page, at rest ---------- */
    for (const f of PAGES) {
      section(f + ' at rest');
      const s = await openPage(browser, server, f);
      const help = await helpDisclosures(s.page);
      check('...every ? disclosure renders closed', help.length > 0 && help.every(h => !h.open),
        JSON.stringify(help.map(h => h.open)));
      check('...each one has a long form to disclose', help.every(h => h.body > 40),
        JSON.stringify(help.map(h => h.body)));
      check('...and the line it hangs off stays a one-liner',
        help.every(h => h.summary.length <= SUMMARY_LINE_MAX),
        JSON.stringify(help.map(h => h.summary.length)));
      const copy = await visibleCopy(s.page);
      eq('...no connective turns the visible copy back into prose',
        forbiddenIn(copy).join(','), '');
      await s.close();
    }

    /* ---------- (a2) every column heading explains itself ----------
       A heading is copy like any other, and the tightest copy in the tool: one glyph is
       allowed to stand for a column only if a tooltip says what the glyph means. The `#`
       column shipped without one, which is how an ordering nobody could see stayed
       invisible. This is the ratchet for that. */
    section('every column heading carries its explanation');
    for (const [file, tables] of [['index.html', ['#tbl', '#ordTbl']]]) {
      const hp = await openPage(browser, server, file, {});
      const hs = await hp.page.evaluate(sel => sel.map(id =>
        [...document.querySelectorAll(id + ' thead th')]
          .map(th => ({ tbl: id, t: th.textContent.trim(), tip: th.title }))), tables);
      const all = [].concat.apply([], hs);
      check('there are headings to measure', all.length > 20, String(all.length));
      const bare = all.filter(h => !h.tip.trim()).map(h => h.tbl + ' ' + h.t);
      eq('no column heading is left unexplained', JSON.stringify(bare), '[]');
      const wordy = all.filter(h => h.tip.split('\n').some(l => l.length > TIP_LINE_MAX)
        || /\. [A-Z]/.test(h.tip)).map(h => h.t);
      eq('...and every heading tooltip is short lines, not a paragraph', JSON.stringify(wordy), '[]');
      await hp.close();
    }

    /* ---------- (b) the Sell table, with rows in it ---------- */
    section('the Sell table states numbers, not sentences');
    const s = await openPage(browser, server, 'index.html');
    await s.page.waitForFunction("typeof rebuild === 'function'");
    await s.page.fill('#inv', PASTE);
    await s.page.dispatchEvent('#inv', 'input');
    await s.page.click('#btnEsi');
    await s.page.waitForFunction(() => !document.getElementById('btnEsi').disabled && !state.esiRunning,
      null, { timeout: 20000 });
    await s.page.waitForFunction(() => document.querySelectorAll('#tblBody tr').length >= 3,
      null, { timeout: 20000 });

    const sell = await s.page.evaluate(() => {
      /* An item is two <tr>s and a cell can group several related values, each carrying
         its own data-cell name. The rule is unchanged — a VALUE is a number and its unit,
         never a sentence — so it is the named values that get measured, not the container
         that happens to hold three of them side by side. */
      const skip = new Set(['name', 'spark']);          // item name + chips, and the chart
      const cells = [];
      for (const el of document.querySelectorAll('#tblBody [data-cell]')) {
        const col = el.dataset.cell;
        if (skip.has(col)) continue;
        // a cell that holds named children is a container: measure the children instead
        if (el.querySelector('[data-cell]')) continue;
        cells.push({ col, t: el.textContent.trim() });
      }
      return {
        cells,
        chips: [...document.querySelectorAll('#tblBody .flag')].map(f => ({ t: f.textContent, tip: f.title })),
        planTips: [...document.querySelectorAll('#tblBody .badge')].map(b => b.title),
        summary: document.getElementById('summary').textContent,
        statLabels: [...document.querySelectorAll('#summary .stat span')].map(x => x.textContent),
        fltCount: document.getElementById('fltCount').textContent,
        impEcho: document.getElementById('impEcho').textContent,
        esiStatus: document.getElementById('esiStatus').textContent,
        unpriced: document.getElementById('unpricedBox').textContent,
      };
    });
    check('there are rows to measure', sell.cells.length > 20, String(sell.cells.length));
    const longCells = sell.cells.filter(c => c.t.length > CELL_MAX);
    eq('no value cell is longer than ' + CELL_MAX + ' characters',
      JSON.stringify(longCells), '[]');

    check('the rendered rows carry chips at all', sell.chips.length > 0, String(sell.chips.length));
    const longChips = sell.chips.filter(c => c.t.length > CHIP_MAX).map(c => c.t);
    eq('no flag chip is longer than ' + CHIP_MAX + ' characters', JSON.stringify(longChips), '[]');
    const muteChips = sell.chips.filter(c => !c.tip || !c.tip.trim()).map(c => c.t);
    eq('...and every chip carries the detail it replaced, on its tooltip',
      JSON.stringify(muteChips), '[]');
    check('...as key: value lines',
      sell.chips.every(c => c.tip.split('\n').every(l => /^[^:]{1,24}: /.test(l) || l.length <= 60)),
      JSON.stringify(sell.chips.map(c => c.tip)));

    check('the plan tooltip is lines, not a paragraph',
      sell.planTips.length > 0 && sell.planTips.every(t =>
        t.split('\n').every(l => l.length <= TIP_LINE_MAX) && !/\. [A-Z]/.test(t)),
      JSON.stringify(sell.planTips));
    for (const [what, txt] of [['the summary', sell.summary], ['the filter count', sell.fltCount],
      ['the import echo', sell.impEcho], ['the fetch status', sell.esiStatus],
      ['the unpriced list', sell.unpriced]])
      eq(what + ' is a fact string, with no connectives', forbiddenIn(txt).join(','), '');
    check('the summary stat labels stay short',
      sell.statLabels.every(l => l.length <= CELL_MAX), JSON.stringify(sell.statLabels));
    check('the fetch status reads as facts: market · count · time',
      /· \d+ items · /.test(sell.esiStatus), sell.esiStatus);
    await s.close();

    /* ---------- (c) the My-orders table ---------- */
    section('the My-orders table states numbers, not sentences');
    const o = await openPage(browser, server, 'index.html', { charOrders: CHAR_ORDERS });
    await o.page.waitForFunction("typeof runOrders === 'function'");
    await o.page.click('#modeOrders');
    await o.page.click('#btnOrders');
    await o.page.waitForFunction(() => state.orders.fetched && !state.orders.running,
      null, { timeout: 25000 });
    await o.page.waitForFunction(() => document.querySelectorAll('#ordBody tr').length >= 2,
      null, { timeout: 20000 });

    const ord = await o.page.evaluate(() => {
      const heads = [...document.querySelectorAll('#ordTbl thead th')].map(th => th.dataset.key || '');
      const skip = new Set(['name', 'locName', '']);          // item, location, sparkline
      const cells = [];
      for (const tr of document.querySelectorAll('#ordBody tr')) {
        [...tr.children].forEach((td, i) => {
          if (skip.has(heads[i])) return;
          cells.push({ col: heads[i], t: td.textContent.trim() });
        });
      }
      return {
        cells,
        chips: [...document.querySelectorAll('#ordBody .flag')].map(f => ({ t: f.textContent, tip: f.title })),
        verdictTips: [...document.querySelectorAll('#ordBody .badge')].map(b => b.title).filter(Boolean),
        summary: document.getElementById('ordSummary').textContent,
        status: document.getElementById('ordStatus').textContent,
        relist: document.getElementById('relistSrc').textContent,
        chars: document.getElementById('ordChars').textContent,
      };
    });
    check('there are order rows to measure', ord.cells.length > 10, String(ord.cells.length));
    const longOrd = ord.cells.filter(c => c.t.length > CELL_MAX);
    eq('no order cell is longer than ' + CELL_MAX + ' characters', JSON.stringify(longOrd), '[]');
    const longOrdChips = ord.chips.filter(c => c.t.length > CHIP_MAX).map(c => c.t);
    eq('no stalled chip is longer than ' + CHIP_MAX + ' characters', JSON.stringify(longOrdChips), '[]');
    eq('...and every one carries its arithmetic on hover',
      JSON.stringify(ord.chips.filter(c => !c.tip || !c.tip.trim()).map(c => c.t)), '[]');
    check('the verdict tooltip is lines, not a paragraph',
      ord.verdictTips.length > 0 && ord.verdictTips.every(t =>
        t.split('\n').length >= 4 && t.split('\n').every(l => l.length <= 160)),
      JSON.stringify(ord.verdictTips));
    for (const [what, txt] of [['the orders summary', ord.summary], ['the fetch status', ord.status],
      ['the relist note', ord.relist], ['the character list', ord.chars]])
      eq(what + ' is a fact string, with no connectives', forbiddenIn(txt).join(','), '');
    check('the fetch status reads as facts: orders · to act on · time',
      /^\d+ orders · \d+ to act on · /.test(ord.status), ord.status);

    /* the TSV is where the long numbers went — the terse table must not be the only copy */
    const tsvHead = await o.page.evaluate(() => ordTsv().split('\n')[0].split('\t'));
    // REWRITTEN: the odds column is 'Fill %' now — a share of the units on the order, not
    // a coin flip on all of them — and 'Fill bound' says which kind of number it is.
    check('the triage TSV still carries the diagnostics the table compresses',
      ['Queue ahead', 'Fill est. d', 'Fill %', 'Fill bound', 'Trend %/wk', 'Hold ISK',
        'Reprice ISK', 'Dump ISK', 'Relist fee ISK'].every(h => tsvHead.includes(h)),
      tsvHead.join('|'));
    await o.close();
  } finally {
    await browser.close();
    await server.close();
  }
});

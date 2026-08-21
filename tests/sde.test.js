/* sde.test.js — the Static Data Export, read by the client.

   Covers the machinery that replaced the deploy-time bake: reading a zip over
   HTTP byte ranges, streaming JSONL out of it, deriving the two blobs the tools
   eat, refusing data that fails an in-game anchor, and the status line that
   tells you a newer build exists and replaces your copy when you ask.

   Nothing here touches CCP. A miniature SDE (tests/fixtures/sde-fixture.js) is
   served from a local range-capable server, and the browser half is pointed at
   it by rewriting SDE.HOST — the same code path, the same zip format, the same
   DecompressionStream. */
'use strict';
const http = require('http');
const path = require('path');
const { check, eq, near, section, run, startServer, launch, watchPage } = require('./helper');
const fixture = require('./fixtures/sde-fixture');

const SDE = require(path.resolve(__dirname, '..', 'sde.js'));

/* ---------- a server that honours byte ranges, as CCP's does ---------- */
function startSdeServer(opts) {
  const o = opts || {};
  const state = { zip: o.zip || fixture.buildZip(), build: o.build == null ? fixture.BUILD : o.build,
    ranges: [], latestHits: 0, noRanges: !!o.noRanges };
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (/latest\.jsonl$/.test(url)) {
      state.latestHits++;
      res.writeHead(200, { 'Content-Type': 'application/jsonlines+json', 'Access-Control-Allow-Origin': '*' });
      res.end(fixture.latestJsonl(state.build));
      return;
    }
    if (!/\.zip$/.test(url)) { res.writeHead(404); res.end('nope'); return; }
    const buf = state.zip;
    const m = /^bytes=(\d+)-(\d+)?$/.exec(req.headers.range || '');
    if (!m || state.noRanges) {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': buf.length,
        'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' });
      res.end(buf);
      return;
    }
    const start = Number(m[1]);
    const end = Math.min(m[2] != null ? Number(m[2]) : buf.length - 1, buf.length - 1);
    state.ranges.push([start, end]);
    const slice = buf.subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Type': 'application/zip',
      'Content-Length': slice.length,
      'Content-Range': `bytes ${start}-${end}/${buf.length}`,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': '*',
      'Accept-Ranges': 'bytes',
    });
    res.end(slice);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      state.host = 'http://127.0.0.1:' + server.address().port + '/static-data';
      state.close = () => new Promise(r => server.close(r));
      resolve(state);
    });
  });
}

async function withHost(host, fn) {
  const before = SDE.HOST;
  SDE.HOST = host;
  try { return await fn(); } finally { SDE.HOST = before; }
}

const collect = async (stream) => {
  const lines = [];
  await SDE.eachLine(stream, l => lines.push(l));
  return lines;
};

run('sde', async () => {

  /* ================= reading the archive ================= */
  section('a zip read over byte ranges, without downloading the zip');
  const srv = await startSdeServer();
  await withHost(srv.host, async () => {
    const zip = await SDE.openZip(SDE.zipUrl(fixture.BUILD));
    eq('the central directory lists every member', zip.entries.size, 13);
    check('...including the big one', zip.entries.has('types.jsonl'));
    eq('the archive length came from Content-Range', zip.total, srv.zip.length);

    const asked = srv.ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);
    check('opening it read far less than the whole archive', asked < srv.zip.length,
      asked + ' of ' + srv.zip.length + ' bytes');

    const before = srv.ranges.length;
    const lines = await collect(await SDE.entryStream(zip, 'categories.jsonl'));
    eq('one member costs one more range request', srv.ranges.length - before, 2); // header + body
    eq('...and inflates to its own lines', lines.length, 9);
    eq('...parsed back to what went in', JSON.parse(lines[0]).name.en, 'Asteroid');

    let threw = null;
    try { await SDE.entryStream(zip, 'nope.jsonl'); } catch (e) { threw = e.message; }
    check('asking for a member that is not there says so', /has no nope\.jsonl/.test(threw || ''), threw);
  });

  section('the line reader');
  {
    const chunks = ['{"a":1}\n{"b":', '2}\n{"c":3}'];   // a record split across two chunks, no final newline
    const stream = new ReadableStream({
      start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); },
    });
    const lines = await collect(stream);
    eq('a record split across chunks is rejoined', lines.length, 3);
    eq('...correctly', lines[1], '{"b":2}');
    eq('a last line with no newline is still delivered', lines[2], '{"c":3}');

    const empty = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('\n\n')); c.close(); } });
    eq('blank lines are dropped', (await collect(empty)).length, 0);
  }

  /* ================= the derivation ================= */
  section('the two blobs, derived from the archive');
  let out = null;
  await withHost(srv.host, async () => { out = await SDE.build(); });
  const I = out.industry, O = out.ores;

  eq('the build number comes from CCP\'s index', out.build, fixture.BUILD);
  eq('the version is the release date', out.v, '2026-08-20');
  eq('...and is stamped on both blobs', I.v + '|' + O.v, '2026-08-20|2026-08-20');

  section('blueprints');
  check('a manufacturing blueprint survives', !!I.blueprints[999]);
  eq('...with its run limit', I.blueprints[999].limit, 300);
  eq('...its time', I.blueprints[999].man.t, 6000);
  eq('...its materials as [tid, qty]', JSON.stringify(I.blueprints[999].man.m), '[[34,24000],[35,4500]]');
  eq('...its product', JSON.stringify(I.blueprints[999].man.p), '[[645,1]]');
  eq('...and its skill as [tid, level]', JSON.stringify(I.blueprints[999].man.s), '[[3380,1]]');
  eq('a reaction lands under its own key', I.blueprints[45732].rea.t, 360);
  eq('invention keeps the probability', I.blueprints[1000].inv.p[0][2], 0.3);
  eq('research activities keep only their time', JSON.stringify(I.blueprints[999].me), '{"t":2100}');
  check('a blueprint whose material no longer exists is dropped', !I.blueprints[1001]);
  check('...and so is its own type', !I.types[1001]);

  section('types');
  eq('a type is [name, volume, packagedVolume, group, marketGroup, metaGroup]', I.types[645].length, 6);
  eq('...the name is the English one', I.types[645][0], 'Dominix');
  eq('...the assembled volume', I.types[645][1], 454500);
  eq('...and the packaged volume comes from the SDE, not a table', I.types[645][2], 50000);
  eq('a type that repackages to its own volume carries null', I.types[34][2], null);
  check('a skill referenced by a blueprint is named', I.skills[3380] === 'Battleship Construction');
  eq('the market-group chain is walked to the root', JSON.stringify(I.marketGroups[81]), '["Battleships",4]');
  check('...including the root itself', !!I.marketGroups[4]);

  section('rigs: the numbers from dogma, what they touch from CCP');
  const xl = I.rigs[37180];
  check('the XL ship rig is in the catalog', !!xl);
  eq('...its size', xl.sz, 'XL');
  eq('...its material bonus, sign-flipped to a positive percent', xl.me, 2);
  eq('...its time bonus', xl.te, 20);
  near('...which in nullsec is the in-game 4.20%', xl.me * xl.sec.ns, 4.2, 1e-9);
  eq('...it changes manufacturing', JSON.stringify(xl.act), '["man"]');
  eq('...and its scope is the produced ship groups behind CCP\'s "Ships" filter',
    JSON.stringify(xl.scope), '[' + fixture.G.battleship + ']');
  eq('...fitting the structure groups its dogma names',
    JSON.stringify(xl.fit), '[' + fixture.G.citadel + ',' + fixture.G.engComplex + ']');

  const rea = I.rigs[46496];
  eq('a reactor rig reads its bonus from the reactor attributes', rea.me, 2);
  eq('...and is a reaction rig', JSON.stringify(rea.act), '["rea"]');
  eq('...with no highsec multiplier at all, because reactions cannot run there', rea.sec.hs, 0);

  const thuk = I.rigs[45640];
  check('a Thukker rig carries its enhanced bonus separately', !!thuk.thuk);
  eq('...at the larger number', thuk.thuk.me, 3.7);
  eq('...scoped to capital components only', JSON.stringify(thuk.thuk.scope), '[913]');
  eq('...while the ordinary bonus stays', thuk.me, 2);

  check('a rig with no market group cannot be bought, so it is not offered', !I.rigs[47883]);
  eq('the catalog is exactly the buyable rigs', Object.keys(I.rigs).length, 3);
  check('every rig has a display label', Object.values(I.rigs).every(r => !!r.dom));

  section('structures');
  eq('all five anchors are there', [35825, 35835, 35826, 35836, 35827].filter(t => I.structures[t]).length, 5);
  eq('a structure is [name, group, size, rig slots]', JSON.stringify(I.structures[35827]),
    '["Sotiyo",' + fixture.G.engComplex + ',"XL",3]');

  section('ores');
  eq('every published asteroid type is in', Object.keys(O.ores).length, 14);
  check('the unpublished one is not', !O.ores[1244]);
  eq('the name index is lowercased', O.names['veldspar ii-grade'], 1231);
  eq('reprocessing outputs are per portion, straight from the SDE',
    JSON.stringify(O.ores[1230].m), '[[34,400]]');
  eq('...and the portion size comes with them', O.ores[1230].p, 100);
  eq('the compressed counterpart comes from CCP\'s own mapping', O.ores[1230].c, 1232);
  eq('...with its volume', O.ores[1230].cv, 0.01);
  eq('an ore with no compressed form says so', O.ores[1237].c, null);
  eq('ice is flagged from its group name', O.ores[1238].ice, 1);
  eq('...and rock is not', O.ores[1230].ice, 0);
  eq('the reprocessing skill is the type\'s own', O.types[O.ores[1234].s], 'Ubiquitous Moon Ore Processing');

  section('ore families, all three rules');
  eq('rule 1: the market group that carries a type of its own name', O.ores[1231].b, 'Veldspar');
  eq('...names the whole group, compressed forms included', O.ores[1233].b, 'Veldspar');
  eq('rule 2: strip the grade when the market group is pluralised', O.ores[1240].b, 'Blue Ice');
  eq('...and strip "Compressed" with it', O.ores[1241].b, 'Blue Ice');
  eq('rule 3: the older adjective-in-front names', O.ores[1242].b, 'Clear Icicle');
  eq('a one-off ore is its own family', O.ores[1243].b, 'Banidine');
  eq('the base of a family reports itself', O.ores[1230].b, 'Veldspar');
  {
    const byFamily = {};
    for (const o of Object.values(O.ores)) (byFamily[o.b] = byFamily[o.b] || []).push(o);
    const headless = Object.entries(byFamily).filter(([, l]) => l.filter(o => o.n === o.b).length !== 1);
    eq('every family has exactly one head, which is how the tools find the base', headless.length, 0);
  }

  /* ================= refusing bad data ================= */
  section('an SDE that fails an in-game anchor is refused, not installed');
  const brokenCases = [
    ['Veldspar reprocesses in hundreds', { 'types.jsonl': null }, /missing types\.jsonl|no Veldspar/],
    ['a renumbered dogma attribute', {
      'dogmaAttributes.jsonl': fixture.jsonl([{ _key: 790, name: 'somethingElse' }]),
    }, /dogma attribute 790/],
  ];
  for (const [label, override, want] of brokenCases) {
    const bad = await startSdeServer({ zip: fixture.buildZip(override) });
    let msg = null;
    await withHost(bad.host, async () => {
      try { await SDE.build(); } catch (e) { msg = e.message; }
    });
    check('refused: ' + label, want.test(msg || ''), msg);
    await bad.close();
  }
  {
    // the anchor itself: move Veldspar's batch size and the build must stop
    const rows = fixture.types().map(t => (t._key === 1230 ? Object.assign({}, t, { portionSize: 42 }) : t));
    const bad = await startSdeServer({ zip: fixture.buildZip({ 'types.jsonl': fixture.jsonl(rows) }) });
    let msg = null;
    await withHost(bad.host, async () => { try { await SDE.build(); } catch (e) { msg = e.message; } });
    check('refused: Veldspar\'s batch size moved', /batches of 42, expected 100/.test(msg || ''), msg);
    await bad.close();
  }
  {
    // and the rig anchor
    const dogma = JSON.parse(JSON.stringify(fixture.members()['typeDogma.jsonl'].trim().split('\n').map(JSON.parse)));
    for (const d of dogma) if (d._key === 37180) for (const a of d.dogmaAttributes) if (a.attributeID === 2594) a.value = -9;
    const bad = await startSdeServer({ zip: fixture.buildZip({ 'typeDogma.jsonl': fixture.jsonl(dogma) }) });
    let msg = null;
    await withHost(bad.host, async () => { try { await SDE.build(); } catch (e) { msg = e.message; } });
    check('refused: the XL rig no longer reads 4.20%/42.0%', /XL ship rig reads/.test(msg || ''), msg);
    await bad.close();
  }

  section('a server that will not serve ranges');
  {
    const flat = await startSdeServer({ noRanges: true });
    let msg = null;
    await withHost(flat.host, async () => { try { await SDE.build(); } catch (e) { msg = e.message; } });
    check('says so plainly rather than reading a truncated archive',
      /would not serve a byte range/.test(msg || ''), msg);
    await flat.close();
  }

  section('the build index');
  await withHost(srv.host, async () => {
    const l = await SDE.latest();
    eq('the latest build is read out of the index', l.build, fixture.BUILD);
    eq('...with its release date', l.released, fixture.RELEASED);
  });

  /* ================= in the browser ================= */
  section('the status line, in a real page');
  const server = await startServer();
  const browser = await launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    watchPage(page, 'industry');

    // point the page's SDE at the fixture, before any page script runs
    await ctx.addInitScript(host => { window.__SDE_HOST = host; }, srv.host);
    await ctx.addInitScript(() => {
      const patch = () => {
        if (!window.SDE) return false;
        window.SDE.HOST = window.__SDE_HOST;
        return true;
      };
      if (!patch()) {
        Object.defineProperty(window, 'SDE', {
          configurable: true,
          set(v) { delete window.SDE; window.SDE = v; v.HOST = window.__SDE_HOST; },
          get() { return undefined; },
        });
      }
    });
    // the fixture host is cross-origin to the page; let the page reach it
    await page.route('**/*', route => route.continue());

    await page.goto(server.url + '/industry.html');
    await page.waitForFunction(() => document.querySelector('#sdeStatus .sdemsg')
      && document.querySelector('#sdeStatus .sdemsg').textContent.length > 0, null, { timeout: 20000 });

    const bar = () => page.$eval('#sdeStatus', el => ({
      text: el.textContent,
      hasButton: !!el.querySelector('button.sdeupd') && !el.querySelector('button.sdeupd').hidden,
      button: el.querySelector('button.sdeupd') ? el.querySelector('button.sdeupd').textContent : null,
    }));

    let b = await bar();
    check('it names what loaded', /blueprints/.test(b.text), b.text);
    check('...and which SDE that came from', /SDE \d{4}-\d{2}-\d{2}/.test(b.text), b.text);
    check('...marking it as the copy the site was deployed with',
      /as shipped/.test(b.text), b.text);
    check('...and comparing that build against CCP\'s, by number',
      new RegExp('CCP has build ' + fixture.BUILD).test(b.text), b.text);
    check('...and offering to replace it', b.hasButton && /Update/.test(b.button), JSON.stringify(b));

    await page.click('#sdeStatus button.sdeupd');
    await page.waitForFunction(() => /updated to build/.test(document.getElementById('sdeStatus').textContent),
      null, { timeout: 60000 });
    b = await bar();
    check('after the update it names the build it fetched',
      new RegExp('updated to build ' + fixture.BUILD).test(b.text), b.text);
    check('...and stops calling it the shipped copy', !/as shipped/.test(b.text), b.text);
    check('...and hides the button', !b.hasButton, JSON.stringify(b));

    const stored = await page.evaluate(async () => {
      const rec = await window.SDE.readLocal('data');
      return rec && {
        build: rec.build, v: rec.v,
        blueprints: Object.keys(rec.industry.blueprints).length,
        ores: Object.keys(rec.ores.ores).length,
        hasFetchedAt: !!rec.fetchedAt,
      };
    });
    eq('the local copy is the one that was just derived', stored.build, fixture.BUILD);
    eq('...carrying the industry blob', stored.blueprints, 3);
    eq('...and the ore blob, which this page never asked for', stored.ores, 14);
    check('...stamped with when it was fetched', stored.hasFetchedAt);

    // the page now reads the local copy rather than the shipped one
    await page.reload();
    await page.waitForFunction(() => /SDE \d{4}/.test(document.getElementById('sdeStatus').textContent),
      null, { timeout: 20000 });
    b = await bar();
    check('a reload reads the local copy, not the shipped one', !/as shipped/.test(b.text), b.text);
    check('...and says it is current', /current/.test(b.text), b.text);
    check('...with no update on offer', !b.hasButton, JSON.stringify(b));

    // CCP publishes a newer build
    srv.build = fixture.BUILD + 1;
    await page.reload();
    await page.waitForFunction(() => /CCP has build/.test(document.getElementById('sdeStatus').textContent),
      null, { timeout: 20000 });
    b = await bar();
    check('a newer build upstream is reported', /CCP has build \d+/.test(b.text), b.text);
    check('...and offered', b.hasButton && /Update/.test(b.button), JSON.stringify(b));

    await ctx.close();
  } finally {
    await browser.close();
    await server.close();
  }
  await srv.close();
});

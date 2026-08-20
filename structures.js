/* Shared player-structure registry + picker modal for EVE Helper.

   ONE record per structure, shared by every tool. A record carries the auto-detected
   IDENTITY (name/type/system/security/region/size) and the structure-INTRINSIC facts a
   human has to supply because ESI does not publish them (owner-set market broker %,
   facility tax %, installed rigs, reprocessing rig tier, which industry activities the
   structure can run, free-text notes). Per-tool PREFERENCES — which profile routes what
   here, product scopes, the pilot's implant, cost-index overrides — stay with the tool.
   The manager UI is structures.html; every other page merely SELECTS a structure.

   window.EveStructures:
   - pick({title, list}) → Promise<entry|null> — modal with live search (as the ACTIVE
     character), keyboard selection, and (list) the saved structures to pick from; it is
     a SELECTOR only — editing and removing happen in the manager it links to
   - info(id)   → Promise<entry> — structure name/type/system/security/region, cached
   - refresh(id) → Promise<entry> — re-resolve identity from ESI, bypassing the cache
   - saved()/remember(entry)/remove(id) — one saved list shared by every tool
   - get(id) → record|null · facts(id) → managed facts with type defaults filled in
   - update(id, patch) → record — validated write of the managed facts
   - addConflict(id, text)/dismissConflict(id, cid) — migration conflict notes
   - roleBonuses(typeId) — the hull's ME/TE/cost role bonuses (presets, verify in game)
   - useTypeMap(map)/typeInfo(typeId)/defaultActivities(typeId) — the structure map from
     data/industry.json (size, rig slots, hull kind); pages that load that file hand it
     over once and it is cached in localStorage for the pages that don't
   - subscribe(fn) → unsubscribe
   - ACTIVITIES/ACT_LABELS/REPRO_RIGS — the managed-fact vocabularies

   CHANGE NOTIFICATION: subscribe(fn) fires after every mutation made through this API
   in THIS page (fn gets {reason, id}), AND when another tab or page writes the store —
   a `storage` event listener on the list key reloads the list first, so a record edited
   in structures.html is picked up live by an open Sell/Mine/Industry tab.

   entry/record = {
     id, name, typeId, typeName, refinery, systemId, systemName, security, regionId,
     size, groupId, rigSlots,                 // identity (auto-detected)
     marketBroker, facilityTax, rigs, reproRig, industryActivities, notes, conflicts
   }
*/
'use strict';
(function(){
  const ESI = 'https://esi.evetech.net/latest';
  const LIST_KEY = 'eveHelper.structures.v1';
  const INFO_KEY = 'eveHelper.structInfo.v1';
  const TYPES_KEY = 'eveHelper.structTypes.v1';       // cached data/industry.json structure map
  const MIG_KEY = 'eveHelper.structMigration.v1';     // which legacy sources were imported
  const SCHEMA = 2;
  const REFINERY_TYPES = { 35835: 'athanor', 35836: 'tatara' };
  const NEEDED_SCOPES = ['esi-search.search_structures.v1', 'esi-universe.read_structures.v1'];

  const ACTIVITIES = ['man', 'rea', 'inv', 'cop', 'me', 'te'];
  const ACT_LABELS = { man: 'Manufacturing', rea: 'Reactions', inv: 'Invention',
                       cop: 'Copying', me: 'ME research', te: 'TE research' };
  const REPRO_RIGS = { none: 'no reprocessing rig', t1: 'T1 reprocessing rig +1%', t2: 'T2 reprocessing rig +3%' };
  // hull kind drives the sensible activity default; derived from the structure map's
  // group id when it is loaded, from this fallback otherwise (the same known Upwell
  // hulls the refinery table above already covers)
  const GROUP_KIND = { 1404: 'eng', 1406: 'ref', 1657: 'cit' };
  const HULL_KIND = { 35825: 'eng', 35826: 'eng', 35827: 'eng', 35835: 'ref', 35836: 'ref',
                      35832: 'cit', 35833: 'cit', 35834: 'cit', 40340: 'cit',
                      47512: 'cit', 47513: 'cit', 47514: 'cit', 47515: 'cit', 47516: 'cit' };
  const KIND_ACTS = { eng: ['man', 'inv', 'cop', 'me', 'te'], ref: ['rea'], cit: [] };
  const DEFAULT_RIG_SLOTS = 3;
  // structure role bonuses by hull type — presets, verify in game. Intrinsic to the
  // hull, so they live here rather than in any one tool.
  const ROLE_BONUSES = {
    35825: { me: 1, te: 15, cost: 3 },   // Raitaru
    35826: { me: 1, te: 20, cost: 4 },   // Azbel
    35827: { me: 1, te: 30, cost: 5 },   // Sotiyo
    35835: { me: 0, te: 25, cost: 0 },   // Athanor
    35836: { me: 0, te: 25, cost: 0 },   // Tatara
  };
  const roleBonuses = typeId => Object.assign({ me: 0, te: 0, cost: 0 }, ROLE_BONUSES[typeId] || {});

  const readJson = key => { try{ return JSON.parse(localStorage.getItem(key) || 'null'); }catch(_e){ return null; } };
  const writeJson = (key, v) => { try{ localStorage.setItem(key, JSON.stringify(v)); }catch(_e){} };
  // null/''/garbage all mean "not known" — Number(null) is 0, which would silently invent
  // a 0% rate, so those cases must map to null and not to a number
  const num = v => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  /* ---------- structure type map (data/industry.json "structures": tid → [name, groupId, size, slots]) ---------- */
  let typeMap = readJson(TYPES_KEY) || null;
  function useTypeMap(map){
    if (!map || typeof map !== 'object') return;
    const compact = {};
    for (const [tid, v] of Object.entries(map))
      if (Array.isArray(v) && v.length >= 4) compact[tid] = [String(v[0]), Number(v[1]), String(v[2]), Number(v[3])];
    if (!Object.keys(compact).length) return;
    typeMap = compact;
    writeJson(TYPES_KEY, compact);
    // backfill the identity bits the map is the only source for
    let changed = false;
    for (const r of list){
      const t = typeInfo(r.typeId);
      if (!t) continue;
      if (r.size !== t.size || r.rigSlots !== t.slots || r.groupId !== t.groupId){
        r.size = t.size; r.rigSlots = t.slots; r.groupId = t.groupId;
        changed = true;
      }
    }
    if (changed){ saveList(); notify('typemap'); }
  }
  function typeInfo(typeId){
    const v = typeMap && typeId != null ? typeMap[typeId] : null;
    return v ? { name: v[0], groupId: v[1], size: v[2], slots: v[3] } : null;
  }
  function hullKind(typeId){
    const t = typeInfo(typeId);
    if (t && GROUP_KIND[t.groupId]) return GROUP_KIND[t.groupId];
    return HULL_KIND[typeId] || null;
  }
  const defaultActivities = typeId => (KIND_ACTS[hullKind(typeId)] || []).slice();

  /* ---------- the store ---------- */
  function blankFacts(){
    return { marketBroker: null, facilityTax: null, rigs: [], reproRig: 'none',
             industryActivities: null, notes: '', conflicts: [] };
  }
  // fills in the managed keys and coerces every field — safe to run on a v1 record,
  // on a freshly picked entry and on anything a page hands to remember()
  function normalize(rec){
    if (!rec || rec.id == null || !rec.name) return null;
    const r = Object.assign({}, blankFacts(), rec);
    r.id = Number(r.id);
    r.name = String(r.name);
    r.typeId = r.typeId != null ? Number(r.typeId) : null;
    r.typeName = r.typeName != null ? String(r.typeName) : null;
    r.refinery = REFINERY_TYPES[r.typeId] || null;
    r.systemId = r.systemId != null ? Number(r.systemId) : null;
    r.systemName = r.systemName != null ? String(r.systemName) : null;
    r.security = typeof r.security === 'number' ? r.security : null;
    r.regionId = r.regionId != null ? Number(r.regionId) : null;
    const t = typeInfo(r.typeId);
    r.size = t ? t.size : (typeof r.size === 'string' ? r.size : null);
    r.rigSlots = t ? t.slots : (Number.isFinite(r.rigSlots) ? r.rigSlots : null);
    r.groupId = t ? t.groupId : (Number.isFinite(r.groupId) ? r.groupId : null);
    r.marketBroker = num(r.marketBroker);
    r.facilityTax = num(r.facilityTax);
    r.rigs = Array.isArray(r.rigs) ? [...new Set(r.rigs.map(Number).filter(Number.isFinite))] : [];
    const slots = r.rigSlots || DEFAULT_RIG_SLOTS;
    if (r.rigs.length > slots) r.rigs = r.rigs.slice(0, slots);
    r.reproRig = REPRO_RIGS[r.reproRig] ? r.reproRig : 'none';
    r.industryActivities = Array.isArray(r.industryActivities)
      ? ACTIVITIES.filter(a => r.industryActivities.includes(a)) : null;
    r.notes = typeof r.notes === 'string' ? r.notes : '';
    r.conflicts = Array.isArray(r.conflicts)
      ? r.conflicts.filter(c => c && typeof c.text === 'string')
        .map(c => ({ cid: String(c.cid || ('c' + Math.random().toString(36).slice(2, 8))), text: String(c.text), at: num(c.at) }))
      : [];
    return r;
  }

  function loadList(){
    const raw = readJson(LIST_KEY);
    let arr = null;
    if (Array.isArray(raw)) arr = raw;                                   // v1: a bare array
    else if (raw && Array.isArray(raw.structures)) arr = raw.structures; // v2: {v, structures}
    if (!arr){
      // one-time migration: the Sell tool used to keep its own list in its own blob
      const old = readJson('eveSellHelper.v2');
      arr = old && Array.isArray(old.structures) ? old.structures : [];
    }
    return arr.map(normalize).filter(Boolean);
  }
  let list = loadList();
  const saveList = () => writeJson(LIST_KEY, { v: SCHEMA, structures: list });

  /* ---------- change notification ---------- */
  const subs = new Set();
  function subscribe(fn){
    if (typeof fn !== 'function') return () => {};
    subs.add(fn);
    return () => subs.delete(fn);
  }
  function notify(reason, id){
    for (const fn of [...subs]){
      try{ fn({ reason, id: id == null ? null : Number(id) }); }
      catch(e){ console.error('EveStructures subscriber failed:', e); }
    }
  }
  // another tab (typically the manager page) wrote the store — reload and tell the page
  window.addEventListener('storage', e => {
    if (e.key !== LIST_KEY) return;
    list = loadList();
    notify('storage');
  });

  const saved = () => list.map(s => ({ ...s }));
  const idx = id => list.findIndex(s => s.id === Number(id));
  const get = id => { const i = idx(id); return i < 0 ? null : { ...list[i] }; };

  function remember(entry){
    const i = idx(entry.id);
    const merged = normalize(i >= 0 ? { ...list[i], ...entry } : entry);
    if (!merged) return entry;
    if (i >= 0) list[i] = merged; else list.push(merged);
    saveList();
    notify('remember', merged.id);
    return merged;
  }
  function remove(id){
    list = list.filter(s => s.id !== Number(id));
    saveList();
    notify('remove', id);
  }

  /* managed facts with the type-derived defaults filled in (never null activities) */
  function facts(id){
    const r = get(id);
    if (!r) return null;
    return {
      marketBroker: r.marketBroker, facilityTax: r.facilityTax,
      rigs: r.rigs.slice(), reproRig: r.reproRig, notes: r.notes,
      industryActivities: r.industryActivities || defaultActivities(r.typeId),
      activitiesAreDefault: !r.industryActivities,
      rigSlots: r.rigSlots || DEFAULT_RIG_SLOTS, size: r.size, conflicts: r.conflicts.slice(),
    };
  }
  const MANAGED = ['marketBroker', 'facilityTax', 'rigs', 'reproRig', 'industryActivities', 'notes', 'conflicts'];
  function update(id, patch){
    const i = idx(id);
    if (i < 0 || !patch) return null;
    const next = { ...list[i] };
    for (const k of MANAGED) if (k in patch) next[k] = patch[k];
    list[i] = normalize(next);
    saveList();
    notify('update', id);
    return { ...list[i] };
  }
  function addConflict(id, text){
    const r = get(id);
    if (!r) return null;
    const conflicts = r.conflicts.concat([{ cid: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                                            text: String(text), at: Date.now() }]);
    return update(id, { conflicts });
  }
  function dismissConflict(id, cid){
    const r = get(id);
    if (!r) return null;
    return update(id, { conflicts: r.conflicts.filter(c => c.cid !== cid) });
  }

  async function getJson(url, withAuth){
    const opts = withAuth ? { headers: { Authorization: 'Bearer ' + await EveAuth.token() } } : undefined;
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(url.split('/latest/')[1].split('?')[0] + ': HTTP ' + res.status);
    return res.json();
  }

  // full identity of a structure — cached forever (names/types/systems barely change)
  async function info(id){
    let cache;
    try{ cache = JSON.parse(localStorage.getItem(INFO_KEY) || '{}') || {}; }catch(_e){ cache = {}; }
    if (cache[id]) return cache[id];
    const st = await getJson(`${ESI}/universe/structures/${id}/?datasource=tranquility`, true);
    const sys = await getJson(`${ESI}/universe/systems/${st.solar_system_id}/?datasource=tranquility`);
    const con = await getJson(`${ESI}/universe/constellations/${sys.constellation_id}/?datasource=tranquility`);
    let typeName = null;
    try{
      if (st.type_id) typeName = (await getJson(`${ESI}/universe/types/${st.type_id}/?datasource=tranquility`)).name;
    }catch(_e){ /* cosmetic only */ }
    const entry = {
      id, name: st.name, typeId: st.type_id || null, typeName,
      refinery: REFINERY_TYPES[st.type_id] || null,
      systemId: st.solar_system_id, systemName: sys.name || null,
      security: typeof sys.security_status === 'number' ? sys.security_status : null,
      regionId: con.region_id,
    };
    try{ cache[id] = entry; localStorage.setItem(INFO_KEY, JSON.stringify(cache)); }catch(_e){}
    return entry;
  }

  // re-resolve a saved structure's identity from ESI, ignoring (and refreshing) the cache
  async function refresh(id){
    let cache;
    try{ cache = JSON.parse(localStorage.getItem(INFO_KEY) || '{}') || {}; }catch(_e){ cache = {}; }
    delete cache[id];
    try{ localStorage.setItem(INFO_KEY, JSON.stringify(cache)); }catch(_e){}
    const entry = await info(id);
    return idx(id) >= 0 ? remember(entry) : entry;
  }

  /* ---------- legacy import ------------------------------------------------------
     The same structure's facts used to be smeared across three tools. This pulls them
     into the central record, once per source (a marker key makes it idempotent — later
     manual edits are never clobbered), and NEVER drops anything: a structure that only
     ever lived in a tool's own blob is created here, and two profiles disagreeing about
     the same structure keep the most recently saved value plus a conflict note the
     manager surfaces. A concise summary goes to the console. ----- */
  // the record a legacy fact belongs to, created from whatever identity is around (the
  // ESI identity cache first, then the tool's own snapshot) if it was never saved
  function ensureRecord(id, identity){
    const have = get(id);
    if (have) return have;
    const cache = readJson(INFO_KEY) || {};
    const base = { id: Number(id) };
    for (const src of [cache[id], identity])
      for (const [k, v] of Object.entries(src || {})) if (v !== undefined) base[k] = v;
    base.id = Number(id);
    if (!base.name) base.name = 'structure ' + id;
    remember(base);
    return get(id) || normalize(base);
  }
  function migrateLegacy(){
    const mark = readJson(MIG_KEY) || {};
    const log = [];
    let touched = false;
    const setFact = (id, key, value) => { update(id, { [key]: value }); touched = true; };

    if (!mark.sell){
      const sell = readJson('eveSellHelper.v2');
      const map = sell && sell.structBroker && typeof sell.structBroker === 'object' ? sell.structBroker : {};
      for (const [sid, v] of Object.entries(map)){
        const pct = num(v);
        if (pct == null) continue;
        const rec = ensureRecord(sid);
        if (rec.marketBroker == null){
          setFact(rec.id, 'marketBroker', pct);
          log.push(`Sell: broker ${pct}% → ${rec.name}`);
        }
      }
      mark.sell = 1;
    }

    if (!mark.mine){
      const mine = readJson('eveHelper.mine.v1');
      const fac = mine && mine.fac && typeof mine.fac === 'object' ? mine.fac : null;
      const sid = fac && /^s:\d+$/.test(String(fac.struct)) ? String(fac.struct).slice(2) : null;
      if (sid && REPRO_RIGS[fac.rig] && fac.rig !== 'none'){
        const rec = ensureRecord(sid, fac.structInfo && fac.structInfo.id ? fac.structInfo : null);
        if (rec.reproRig === 'none'){
          setFact(rec.id, 'reproRig', fac.rig);
          log.push(`Mine: ${fac.rig} reprocessing rig → ${rec.name}`);
        }
      }
      mark.mine = 1;
    }

    if (!mark.industry){
      const store = readJson('eveHelper.industryProfiles.v1');
      const profiles = store && Array.isArray(store.profiles) ? store.profiles.slice() : [];
      // no timestamps are kept per profile, so "most recently saved" is read as: the
      // ACTIVE profile last (it is the one being worked in), the rest in store order
      profiles.sort((a, b) => (a.id === store.active ? 1 : 0) - (b.id === store.active ? 1 : 0));
      const owner = {};   // "<id>:<field>" → profile name that supplied it
      for (const p of profiles){
        for (const f of (p.facilities || [])){
          if (!f || f.npc || f.id == null) continue;
          const rec = ensureRecord(f.id, {
            id: Number(f.id), name: f.label || ('structure ' + f.id), typeId: f.typeId, typeName: f.typeName,
            systemId: f.system, systemName: f.systemName, security: f.security,
          });
          const tids = (f.rigs || []).map(r => r && r.tid).map(Number).filter(Number.isFinite);
          if (tids.length){
            const cur = (get(rec.id) || rec).rigs;
            const key = rec.id + ':rigs';
            const same = cur.length === tids.length && cur.every(t => tids.includes(t));
            if (cur.length && !same && owner[key]){
              addConflict(rec.id, `profile "${owner[key]}" and "${p.name}" disagreed about rigs; `
                + `kept "${p.name}"'s (${tids.length} rig${tids.length > 1 ? 's' : ''}, `
                + `dropped ${cur.length} from "${owner[key]}")`);
            }
            if (!same){
              setFact(rec.id, 'rigs', tids);
              log.push(`Industry "${p.name}": ${tids.length} rig(s) → ${rec.name}`);
            }
            owner[key] = p.name;
          }
          const tax = num(f.tax);
          if (tax != null){
            const cur = (get(rec.id) || rec).facilityTax;
            const key = rec.id + ':tax';
            if (cur != null && cur !== tax && owner[key])
              addConflict(rec.id, `profile "${owner[key]}" said facility tax ${cur}% and "${p.name}" said ${tax}%; `
                + `kept "${p.name}"'s ${tax}%`);
            if (cur !== tax){
              setFact(rec.id, 'facilityTax', tax);
              log.push(`Industry "${p.name}": facility tax ${tax}% → ${rec.name}`);
            }
            owner[key] = p.name;
          }
        }
      }
      mark.industry = 1;
    }

    mark.v = 1;
    writeJson(MIG_KEY, mark);
    if (log.length)
      console.info('[EveStructures] central structure records: imported ' + log.length
        + ' fact(s) from the tools —\n  ' + log.join('\n  '));
    return { imported: log.length, touched };
  }
  try{ migrateLegacy(); }
  catch(e){ console.error('[EveStructures] legacy import failed (nothing was dropped):', e); }
  // a v1 store (bare array), or a list rescued from the Sell tool's own old blob, is
  // rewritten in the v2 shape on first load so every page agrees on the schema; an empty
  // store is left alone rather than created for nothing
  {
    const rawStore = readJson(LIST_KEY);
    if (Array.isArray(rawStore) || (!rawStore && list.length)) saveList();
  }

  // the modal chrome is shared with the permissions panel and lives in auth.js, which
  // every page loads first — no second copy of the same CSS
  const injectCss = () => { if (window.EveAuth && EveAuth.modalCss) EveAuth.modalCss(); };

  // modal picker — resolves the chosen entry, or null on cancel (never rejects)
  function pick(opts = {}){
    injectCss();
    const stale = document.getElementById('structPicker');
    if (stale) stale.remove();
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.id = 'structPicker';
      overlay.className = 'eveModal';
      const panel = document.createElement('div');
      panel.className = 'panel';
      overlay.appendChild(panel);

      const h = document.createElement('h3');
      h.textContent = opts.title || 'Pick a structure';
      const x = document.createElement('span');
      x.className = 'x'; x.textContent = '×'; x.title = 'close (Esc)';
      h.appendChild(x);
      const savedBox = document.createElement('div');
      savedBox.id = 'structSaved';
      const input = document.createElement('input');
      input.id = 'structSearch';
      input.type = 'text';
      input.placeholder = 'structure name (min 3 characters)…';
      const msg = document.createElement('div');
      msg.className = 'msg'; msg.id = 'structMsg';
      const results = document.createElement('div');
      results.className = 'rows'; results.id = 'structResults';
      panel.append(h, savedBox, input, msg, results);
      document.body.appendChild(overlay);

      const done = val => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(val || null);
      };
      overlay.addEventListener('mousedown', e => { if (e.target === overlay) done(null); });
      x.addEventListener('click', () => done(null));

      // search needs a logged-in character with the right scopes — errors stay inline
      const loggedIn = window.EveAuth && EveAuth.isLoggedIn();
      const missing = loggedIn ? NEEDED_SCOPES.filter(s => !EveAuth.tokenScopes().includes(s)) : [];
      const searchable = loggedIn && !missing.length;
      if (!loggedIn){
        msg.textContent = 'log in with EVE first — the search runs as your character';
        msg.className = 'msg err';
      } else if (missing.length){
        // don't just describe the problem — hand the user the panel that fixes it
        msg.className = 'msg err';
        msg.textContent = `structure search is unavailable: your login lacks ${missing.join(' + ')} — `;
        const link = document.createElement('span');
        link.className = 'evePermLink';
        link.textContent = 'see permissions';
        link.addEventListener('click', () => {
          done(null);
          if (window.EveAuth && EveAuth.showPermissions) EveAuth.showPermissions();
        });
        msg.appendChild(link);
      }
      input.disabled = !searchable;

      const spinner = text => {
        msg.className = 'msg';
        msg.textContent = '';
        const sp = document.createElement('span');
        sp.className = 'spin';
        msg.append(sp, text);
      };

      function rowEl(entry){
        const row = document.createElement('div');
        row.className = 'row';
        const main = document.createElement('span');
        const b = document.createElement('b');
        b.textContent = entry.name;
        const sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = [entry.systemName, entry.typeName].filter(Boolean).join(' · ');
        main.append(b, sub);
        row.appendChild(main);
        row.addEventListener('click', async () => {
          let full = entry;
          if (entry.typeId == null || entry.security == null || !entry.regionId){
            // saved before type/security were tracked — complete it from ESI
            try{
              spinner('resolving…');
              full = { ...entry, ...await info(entry.id) };
            }catch(e){
              msg.textContent = 'could not resolve the structure: ' + (e.message || e);
              msg.className = 'msg err';
              return;
            }
          }
          done(remember(full));
        });
        return row;
      }

      // the saved list is offered for selection only — editing and removing a structure
      // happen in one place, the manager, which is what the footer link opens
      function renderSaved(){
        savedBox.textContent = '';
        if (!opts.list || !list.length) return;
        const cap = document.createElement('div');
        cap.className = 'sect';
        cap.textContent = 'saved';
        const rows = document.createElement('div');
        rows.className = 'rows';
        for (const s of saved()) rows.appendChild(rowEl(s));
        const foot = document.createElement('div');
        foot.className = 'msg';
        const link = document.createElement('a');
        link.href = 'structures.html';
        link.textContent = 'manage structures →';
        link.title = 'the Structure Manager — rename, edit or remove a structure in one place';
        foot.appendChild(link);
        savedBox.append(cap, rows, foot);
      }
      renderSaved();

      let seq = 0, timer = null, items = [], active = -1;
      function setActive(i){
        items.forEach((el, j) => el.classList.toggle('active', j === i));
        active = i;
        if (items[i]) items[i].scrollIntoView({ block: 'nearest' });
      }
      async function runSearch(q){
        const my = ++seq;
        results.textContent = '';
        items = []; active = -1;
        spinner('searching…');
        try{
          const token = await EveAuth.token();
          const res = await fetch(`${ESI}/characters/${EveAuth.character().id}/search/?categories=structure&datasource=tranquility&search=${encodeURIComponent(q)}&strict=false`,
            { headers: { Authorization: 'Bearer ' + token } });
          if (!res.ok) throw new Error('ESI search: HTTP ' + res.status);
          const ids = ((await res.json()).structure || []).slice(0, 10);
          if (my !== seq) return;
          if (!ids.length){
            msg.className = 'msg';
            msg.textContent = `nothing found — the search only sees structures ${EveAuth.character().name} can access`;
            return;
          }
          const entries = [];
          for (const id of ids){
            try{ entries.push(await info(id)); }catch(_e){ /* unresolvable — skip */ }
          }
          if (my !== seq) return;
          msg.className = 'msg';
          msg.textContent = entries.length ? '' : 'matches found, but none could be resolved (no access?)';
          items = entries.map(e => { const el = rowEl(e); results.appendChild(el); return el; });
          if (items.length) setActive(0);
        }catch(e){
          if (my !== seq) return;
          msg.textContent = String(e.message || e);
          msg.className = 'msg err';
        }
      }
      input.addEventListener('input', () => {
        clearTimeout(timer);
        seq++; items = []; active = -1;
        const q = input.value.trim();
        if (q.length < 3){
          results.textContent = '';
          if (searchable){ msg.className = 'msg'; msg.textContent = q ? 'type at least 3 characters' : ''; }
          return;
        }
        timer = setTimeout(() => runSearch(q), 400);
      });
      function onKey(e){
        if (e.key === 'Escape'){ e.stopPropagation(); done(null); }
        else if (e.key === 'ArrowDown' && items.length){ e.preventDefault(); setActive(Math.min(active + 1, items.length - 1)); }
        else if (e.key === 'ArrowUp' && items.length){ e.preventDefault(); setActive(Math.max(active - 1, 0)); }
        else if (e.key === 'Enter' && items[active]){ e.preventDefault(); items[active].click(); }
      }
      document.addEventListener('keydown', onKey, true);
      if (!input.disabled) setTimeout(() => input.focus(), 0);
    });
  }

  window.EveStructures = {
    pick, info, refresh, remember, saved, remove,
    get, facts, update, addConflict, dismissConflict,
    useTypeMap, typeInfo, defaultActivities, roleBonuses, subscribe, migrateLegacy,
    ACTIVITIES: ACTIVITIES.slice(), ACT_LABELS, REPRO_RIGS, SCHEMA,
  };
})();

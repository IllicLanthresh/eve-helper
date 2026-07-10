/* Shared player-structure registry + picker modal for EVE Helper.
   window.EveStructures:
   - pick({title, manage}) → Promise<entry|null> — modal with live search (as the ACTIVE
     character), keyboard selection, and (manage) the saved list with remove buttons
   - info(id)   → Promise<entry> — structure name/type/system/security/region, cached
   - saved()/remember(entry)/remove(id) — one saved list shared by every tool
   entry = { id, name, typeId, typeName, refinery, systemId, systemName, security, regionId }
*/
'use strict';
(function(){
  const ESI = 'https://esi.evetech.net/latest';
  const LIST_KEY = 'eveHelper.structures.v1';
  const INFO_KEY = 'eveHelper.structInfo.v1';
  const REFINERY_TYPES = { 35835: 'athanor', 35836: 'tatara' };
  const NEEDED_SCOPES = ['esi-search.search_structures.v1', 'esi-universe.read_structures.v1'];

  function loadList(){
    try{
      const l = JSON.parse(localStorage.getItem(LIST_KEY) || 'null');
      if (Array.isArray(l)) return l.filter(s => s && s.id && s.name);
    }catch(_e){}
    // one-time migration: the Sell tool used to keep its own list in its own blob
    try{
      const old = JSON.parse(localStorage.getItem('eveSellHelper.v2') || 'null');
      if (old && Array.isArray(old.structures) && old.structures.length){
        const l = old.structures.filter(s => s && s.id && s.name);
        localStorage.setItem(LIST_KEY, JSON.stringify(l));
        return l;
      }
    }catch(_e){}
    return [];
  }
  let list = loadList();
  const saveList = () => { try{ localStorage.setItem(LIST_KEY, JSON.stringify(list)); }catch(_e){} };

  const saved = () => list.slice();
  function remember(entry){
    const i = list.findIndex(s => s.id === entry.id);
    if (i >= 0) list[i] = { ...list[i], ...entry }; else list.push(entry);
    saveList();
    return entry;
  }
  function remove(id){
    list = list.filter(s => s.id !== id);
    saveList();
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

  let cssDone = false;
  function injectCss(){
    if (cssDone) return;
    cssDone = true;
    const s = document.createElement('style');
    s.textContent = `
#structPicker{position:fixed;inset:0;background:rgba(4,6,10,.72);z-index:100;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}
#structPicker .panel{width:480px;max-width:92vw;background:var(--panel,#121722);border:1px solid var(--line,#232c3d);border-radius:10px;padding:14px 16px 16px;box-shadow:0 14px 44px rgba(0,0,0,.55);font-size:13px;color:var(--text,#d5dce8)}
#structPicker h3{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--cyan,#5bc8e8);display:flex;align-items:center}
#structPicker .x{margin-left:auto;cursor:pointer;color:var(--dim,#8b96a8);font-size:17px;line-height:1;text-transform:none;padding:0 3px;border-radius:4px}
#structPicker .x:hover{color:var(--text,#d5dce8);background:#1b2434}
#structPicker input{width:100%;background:var(--panel2,#0e131d);color:var(--text,#d5dce8);border:1px solid var(--line,#232c3d);border-radius:6px;padding:6px 9px;font:13px var(--mono,ui-monospace,monospace)}
#structPicker .rows{margin-top:6px;max-height:38vh;overflow-y:auto}
#structPicker .row{display:flex;gap:8px;align-items:center;padding:6px 8px;border-radius:6px;cursor:pointer}
#structPicker .row:hover,#structPicker .row.active{background:#1b2434}
#structPicker .row .sub{color:var(--dim,#8b96a8);font-size:12px;margin-left:6px}
#structPicker .row .del{margin-left:auto;color:var(--dim,#8b96a8);padding:0 6px;border-radius:4px;font-size:15px}
#structPicker .row .del:hover{color:var(--red,#e06c75);background:#242e42}
#structPicker .msg{color:var(--dim,#8b96a8);margin-top:8px;min-height:16px}
#structPicker .msg.err{color:var(--red,#e06c75)}
#structPicker .sect{color:var(--dim,#8b96a8);font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:2px 0 4px}
#structPicker .spin{display:inline-block;width:11px;height:11px;border:2px solid var(--line,#232c3d);border-top-color:var(--cyan,#5bc8e8);border-radius:50%;animation:structspin .8s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes structspin{to{transform:rotate(360deg)}}`;
    document.head.appendChild(s);
  }

  // modal picker — resolves the chosen entry, or null on cancel (never rejects)
  function pick(opts = {}){
    injectCss();
    const stale = document.getElementById('structPicker');
    if (stale) stale.remove();
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.id = 'structPicker';
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
        msg.textContent = `your login lacks ${missing.join(' + ')} — add them to the app in the EVE developer portal and log in again`;
        msg.className = 'msg err';
      }
      input.disabled = !searchable;

      const spinner = text => {
        msg.className = 'msg';
        msg.textContent = '';
        const sp = document.createElement('span');
        sp.className = 'spin';
        msg.append(sp, text);
      };

      function rowEl(entry, removable){
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
        if (removable){
          const del = document.createElement('span');
          del.className = 'del'; del.textContent = '×';
          del.title = 'remove from saved structures';
          del.addEventListener('click', e => { e.stopPropagation(); remove(entry.id); renderSaved(); });
          row.appendChild(del);
        }
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
          remember(full);
          done(full);
        });
        return row;
      }

      function renderSaved(){
        savedBox.textContent = '';
        if (!opts.manage || !list.length) return;
        const cap = document.createElement('div');
        cap.className = 'sect';
        cap.textContent = 'saved';
        const rows = document.createElement('div');
        rows.className = 'rows';
        for (const s of saved()) rows.appendChild(rowEl(s, true));
        savedBox.append(cap, rows);
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
          items = entries.map(e => { const el = rowEl(e, false); results.appendChild(el); return el; });
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

  window.EveStructures = { pick, info, remember, saved, remove };
})();

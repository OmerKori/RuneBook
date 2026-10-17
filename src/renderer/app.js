// RuneBook UI. Plain JS, no build step.
const TREE_COLORS = { 8000: '#c8aa6e', 8100: '#d44242', 8200: '#9faafc', 8300: '#49aab9', 8400: '#a1d586' };

const state = {
  data: null, // { version, cdn, champions, styles, shards }
  pages: [],
  lcu: { connected: false, inChampSelect: false, championKey: 0, locked: false },
  view: 'grid', // grid | champion | editor
  champ: null,
  draft: null,
  offer: null, // a page you built in the client that RuneBook has no copy of yet
  recSeen: {}, // Riot's recommended pages, once downloaded (used only for the empty-state text)
};


const POPUP = location.hash === '#popup'; // the small champ select window
const $ = (sel) => document.querySelector(sel);
const viewEl = $('#view');

// Tiny element helper: h('div', {class: 'x', onclick: fn}, child, child...)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const stripTags = (s) => (s || '').replace(/<[^>]*>/g, '');
const runeIcon = (icon) => `${state.data.cdn}/cdn/img/${icon}`;

// ---- Lookups ----
let perkById = new Map();
let styleById = new Map();
function indexData() {
  perkById = new Map();
  styleById = new Map();
  for (const style of state.data.styles) {
    styleById.set(style.id, style);
    style.slots.forEach((slot, row) =>
      slot.runes.forEach((r) => perkById.set(r.id, { ...r, img: runeIcon(r.icon), styleId: style.id, row }))
    );
  }
  for (const row of state.data.shards)
    for (const s of row) perkById.set(s.id, { ...s, img: s.icon, shortDesc: s.desc, isShard: true });
}
const champByKey = (key) => state.data.champions.find((c) => c.key === key);
const pagesFor = (champ) => state.pages.filter((p) => p.championKey === champ.key);

// ---- Toast / modal ----
let toastTimer;
function toast(msg) {
  if (POPUP) return; // the pick window is too small; rows show their own state
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}
function modal(content) {
  const m = $('#modal');
  m.replaceChildren(h('div', { class: 'box' }, content));
  m.classList.remove('hidden');
}
const closeModal = () => $('#modal').classList.add('hidden');

// ---- Navigation ----
function go(view, extra = {}) {
  Object.assign(state, { view }, extra);
  render();
}
document.addEventListener('click', (e) => {
  if (openMenuId !== null && !e.target.closest('.menu') && !e.target.closest('.more')) { openMenuId = null; render(); }
});
function render() {
  if (!state.data) return;
  renderOffer();
  if (POPUP) {
    // Clicking outside closes the picker, but not while you're editing or searching.
    window.rb.popupSticky(state.view !== 'champion');
    if (state.view === 'editor') renderEditor();
    else if (state.view === 'grid') renderPickerGrid();
    else renderPopup();
  } else if (state.view === 'grid') renderGrid();
  else if (state.view === 'champion') renderChampion();
  else if (state.view === 'editor') renderEditor();
}

// ---- Screen 1: champion grid ----
function renderGrid() {
  const q = $('#search').value.trim().toLowerCase();
  const counts = new Map();
  state.pages.forEach((p) => counts.set(p.championKey, (counts.get(p.championKey) || 0) + 1));

  const list = state.data.champions.filter(
    (c) => !q || c.name.toLowerCase().includes(q)
  );
  viewEl.replaceChildren(
    list.length
      ? h('div', { class: 'grid' },
          list.map((c) =>
            h('button', { class: 'champ', title: c.name, onclick: () => go('champion', { champ: c }) },
              h('img', { src: c.image, alt: '', loading: 'lazy' }),
              c.name
            )
          ))
      : h('div', { class: 'empty' }, 'No champion matches.')
  );
}

// ---- Screen 2: one champion's pages ----
const treeColor = (styleId) => TREE_COLORS[styleId] || '#c8aa6e';
const splashUrl = (c) => `${state.data.cdn}/cdn/img/champion/splash/${c.id}_0.jpg`;

function perkImg(id, cls) {
  const p = perkById.get(id);
  if (!p) return h('span', { class: `rimg ${cls || ''} missing` }, '?');
  const img = h('img', { src: p.img, class: `rimg ${cls || ''}`, title: p.name, alt: p.name });
  img.addEventListener('error', () => img.replaceWith(h('span', { class: `rimg ${cls || ''} missing`, title: p.name }, p.label || p.name.slice(0, 2))));
  return img;
}

let openMenuId = null;

function renderChampion() {
  const c = state.champ;
  const pages = pagesFor(c).sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
  const inSelectForThis = state.lcu.inChampSelect && state.lcu.championKey === c.key;

  viewEl.replaceChildren(
    h('div', { class: 'champ-page' },
      h('div', { class: 'champ-banner', style: `background-image: linear-gradient(90deg, rgba(10,14,19,.95) 0%, rgba(10,14,19,.55) 45%, rgba(10,14,19,.1) 100%), url("${splashUrl(c)}")` },
        h('button', { class: 'back', onclick: () => go('grid') }, '← All champions'),
        h('div', { class: 'champ-title' },
          h('h1', {}, c.name),
          h('div', { class: 'muted' }, c.tags.join(' · ')),
          inSelectForThis ? h('div', { class: 'select-chip' }, '● In champ select') : null
        )
      ),
      h('div', { class: 'pages-section' },
        h('div', { class: 'section-head' },
          h('h2', {}, 'Rune pages'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'add-btn', onclick: () => openEditor(newDraft(c)) }, '+ New page')
        ),
        pages.length
          ? h('div', { class: 'cards' }, pages.map(pageCard))
          : h('div', { class: 'empty' }, emptyMessage(c))
      )
    )
  );
}

function styleImg(styleId, cls) {
  const s = styleById.get(styleId);
  if (!s) return null;
  const img = h('img', { src: runeIcon(s.icon), class: `simg ${cls || ''}`, title: s.name, alt: '' });
  img.addEventListener('error', () => img.remove());
  return img;
}

// Vertical card: size and position carry the importance, so the runes read without text.
// Keystone big on top, primary minors under it, then the smaller secondary pair, then tiny shards.
function pageCard(p) {
  const ids = p.selectedPerkIds;
  const alt = altSlots(p);
  const img = (i, cls) => perkImg(ids[i], cls + (alt.has(i) ? ' conf' : ''));
  const broken = pageProblem(p);
  return h('div', {
    class: 'card' + (p.isDefault ? ' default' : '') + (broken ? ' broken' : ''),
    title: broken ? BROKEN_TIP : null,
    style: `--tree:${treeColor(p.primaryStyleId)};--sub:${treeColor(p.subStyleId)}`,
    onclick: (e) => { if (!e.target.closest('button') && !e.target.closest('.menu')) openEditor(draftFromPage(p)); },
  },
    p.isDefault ? h('div', { class: 'star', title: 'Default page' }, '★') : null,
    broken ? h('div', { class: 'broken-badge', title: BROKEN_TIP }, '!') : null,
    h('div', { class: 'c-primary' },
      perkImg(ids[0], 'ks'),
      h('div', { class: 'c-minors' }, [1, 2, 3].map((i) => img(i, 'minor')))
    ),
    h('div', { class: 'c-secondary' }, [4, 5].map((i) => h('span', { class: 'sec-wrap' }, img(i, 'sec')))),
    h('div', { class: 'c-shards' }, [6, 7, 8].map((i) => img(i, 'shard'))),
    h('div', { class: 'c-foot' },
      h('div', { class: 'name', title: p.name }, p.name),
      h('div', { class: 'card-actions' },
        h('button', { class: 'edit-btn', onclick: () => openEditor(draftFromPage(p)) }, 'Edit')
      )
    ),
    h('button', { class: 'more', 'aria-label': 'More actions', onclick: () => { openMenuId = openMenuId === p.id ? null : p.id; render(); } }, '⋯'),
    openMenuId === p.id
      ? h('div', { class: 'menu' },
          h('button', { onclick: () => { openMenuId = null; setDefault(p); } }, p.isDefault ? '☆ Remove default' : '★ Make default'),
          h('button', { onclick: () => { openMenuId = null; duplicate(p); } }, 'Duplicate'),
          h('button', { class: 'danger', onclick: () => { openMenuId = null; removePage(p); } }, 'Delete'))
      : null
  );
}

// Pages start as Riot's recommendations (copied in by the main process once per champion).
function emptyMessage(c) {
  if (!state.lcu.connected && !Object.keys(state.recSeen).length) {
    return 'Open the League client once and RuneBook will fill every champion with Riot\'s recommended pages. After that they are here even with League closed.';
  }
  return `No pages for ${c.name}. Create one or import your current client page.`;
}

async function refreshPages() {
  state.pages = await window.rb.listPages();
}
async function setDefault(p) {
  await window.rb.savePage({ ...p, isDefault: !p.isDefault });
  await refreshPages();
  render();
}
async function duplicate(p) {
  const { id, ...rest } = p;
  await window.rb.savePage({ ...rest, name: `${p.name} (copy)`, nameAuto: false, isDefault: false });
  await refreshPages();
  render();
}
function removePage(p) {
  modal([
    h('div', {}, `Delete "${p.name}"?`),
    h('div', { class: 'modal-actions' },
      h('span', { class: 'spacer' }),
      h('button', { onclick: closeModal }, 'Cancel'),
      h('button', { class: 'danger', onclick: async () => {
        closeModal();
        await window.rb.deletePage(p.id);
        await refreshPages();
        render();
      } }, 'Delete')
    ),
  ]);
}

async function apply(p, replaceId, perkIds) {
  // Saved pages are applied by id; recommended pages are sent as they are.
  // perkIds, when given, is the page with its alternatives already chosen.
  const res = p.id ? await window.rb.applyPage(p.id, replaceId, perkIds) : await window.rb.applyRawPage(p, replaceId);
  if (res.ok) return toast(`Applied "${p.name}" to the client`);
  if (res.error) return toast(`Apply failed: ${res.error}`);
  if (res.needsReplace) {
    modal([
      h('div', {}, 'Your rune page slots are full. Which client page should RuneBook replace? From now on RuneBook will reuse that slot.'),
      res.needsReplace.map((cp) => h('button', { onclick: () => { closeModal(); apply(p, cp.id, perkIds); } }, cp.name)),
      h('button', { class: 'ghost', onclick: closeModal }, 'Cancel'),
    ]);
  }
}

async function importFromClient() {
  const cur = await window.rb.getCurrentPage();
  if (!cur || cur.error) return toast(`Couldn't read the client page: ${cur ? cur.error : 'unknown error'}`);
  if (!Array.isArray(cur.selectedPerkIds) || cur.selectedPerkIds.length !== 9)
    return toast('The current client page is incomplete.');
  const draft = draftFromPage({
    championKey: state.champ.key,
    name: cur.name.replace(/^RuneBook:\s*/, ''),
    primaryStyleId: cur.primaryStyleId,
    subStyleId: cur.subStyleId,
    selectedPerkIds: cur.selectedPerkIds,
  });
  openEditor(draft);
}

// ---- Screen 3: rune editor ----
function newDraft(c) {
  return {
    id: null, championKey: c.key, name: '', isDefault: pagesFor(c).length === 0,
    primaryStyleId: 8000, subStyleId: 8100,
    primary: [null, null, null, null],
    secondary: [], // [{ row, id }], max 2, different rows
    shards: [null, null, null],
    alts: {},
  };
}
// What's wrong with a saved page after a patch, or null. Same rules as the main process uses.
const rowIn = (style, id) => (style ? style.slots.findIndex((slot) => slot.runes.some((r) => r.id === id)) : -1);
function pageProblem(p) {
  const ids = p.selectedPerkIds || [];
  const pri = styleById.get(p.primaryStyleId), sub = styleById.get(p.subStyleId);
  if (ids.length !== 9 || !pri || !sub || pri === sub) return true;
  for (let r = 0; r < 4; r++) if (rowIn(pri, ids[r]) !== r) return true;
  const a = rowIn(sub, ids[4]), b = rowIn(sub, ids[5]);
  if (a < 1 || b < 1 || a === b) return true;
  return [0, 1, 2].some((r) => !shardRowHas(r, ids[6 + r]));
}
const BROKEN_TIP = 'Some runes on this page changed in a patch. Click to fix it.';

function draftFromPage(p) {
  // Runes that no longer exist (or moved rows) after a patch come back empty, so you pick again.
  const pri = styleById.get(p.primaryStyleId) ? p.primaryStyleId : 8000;
  const subId = styleById.get(p.subStyleId) && p.subStyleId !== pri ? p.subStyleId : state.data.styles.find((s) => s.id !== pri).id;
  const prim = styleById.get(pri);
  const raw = p.selectedPerkIds || [];
  const ids = [
    ...[0, 1, 2, 3].map((r) => (rowIn(prim, raw[r]) === r ? raw[r] : null)),
    raw[4], raw[5],
    ...[0, 1, 2].map((r) => (shardRowHas(r, raw[6 + r]) ? raw[6 + r] : null)),
  ];
  p = { ...p, primaryStyleId: pri, subStyleId: subId };
  const sub = styleById.get(subId);
  const secondary = ids.slice(4, 6).map((id) => ({ row: rowIn(sub, id), id }))
    .filter((s, i, all) => s.row > 0 && all.findIndex((x) => x.row === s.row) === i);
  return {
    id: p.id || null, championKey: p.championKey,
    // Auto-named pages open with an empty name so the name keeps following the runes.
    name: p.nameAuto || !p.name ? '' : p.name,
    isDefault: !!p.isDefault,
    primaryStyleId: p.primaryStyleId, subStyleId: p.subStyleId,
    primary: ids.slice(0, 4), secondary, shards: ids.slice(6, 9),
    alts: JSON.parse(JSON.stringify(cleanAlts(p.alts))),
  };
}
function openEditor(draft) {
  state.draft = draft;
  go('editor');
}

// "Electrocute · Sorcery": keystone plus secondary tree.
function autoName(d) {
  const ks = perkById.get(d.primary[0]);
  const sub = styleById.get(d.subStyleId);
  return `${ks ? ks.name : 'New page'} · ${sub ? sub.name : ''}`;
}
function draftValid(d) {
  return d.primary.every(Boolean) && d.secondary.length === 2 && d.shards.every(Boolean)
    && d.primaryStyleId !== d.subStyleId;
}
function draftToPerkIds(d) {
  const sec = [...d.secondary].sort((a, b) => a.row - b.row).map((s) => s.id);
  return [...d.primary, ...sec, ...d.shards];
}

// ---- Alternatives ----
// A page can list alternative runes for its small runes and shards (never the keystone or the trees):
// alts = { p1, p2, p3: primary rows 1-3, sec: secondary runes, s0, s1, s2: shard rows }, each a list of ids.
// In the picker you choose between them before the page goes in the client.
const ALT_KEYS = ['p1', 'p2', 'p3', 'sec', 's0', 's1', 's2'];
function cleanAlts(a) {
  const out = {};
  for (const k of ALT_KEYS) if (a && Array.isArray(a[k]) && a[k].length) out[k] = [...new Set(a[k])];
  return out;
}
const shardRowHas = (row, id) => (state.data.shards[row] || []).some((s) => s.id === id);
// The choices a page asks for, dropping alternatives that no longer fit its runes.
function altGroups(p) {
  const ids = p.selectedPerkIds, a = p.alts || {};
  const groups = [];
  const fits = (id, styleId, ok) => { const x = perkById.get(id); return x && x.styleId === styleId && ok(x); };
  for (let r = 1; r <= 3; r++) {
    const extra = (a['p' + r] || []).filter((id) => id !== ids[r] && fits(id, p.primaryStyleId, (x) => x.row === r));
    if (extra.length) groups.push({ key: 'p' + r, slots: [r], options: [ids[r], ...extra], pick: 1, color: treeColor(p.primaryStyleId) });
  }
  const sec = (a.sec || []).filter((id) => id !== ids[4] && id !== ids[5] && fits(id, p.subStyleId, (x) => x.row > 0));
  if (sec.length) groups.push({ key: 'sec', slots: [4, 5], options: [ids[4], ids[5], ...sec], pick: 2, color: treeColor(p.subStyleId) });
  for (let r = 0; r < 3; r++) {
    const extra = (a['s' + r] || []).filter((id) => id !== ids[6 + r] && shardRowHas(r, id));
    if (extra.length) groups.push({ key: 's' + r, slots: [6 + r], options: [ids[6 + r], ...extra], pick: 1, color: '#c8aa6e' });
  }
  return groups;
}
const hasAlts = (p) => altGroups(p).length > 0;
const altSlots = (p) => new Set(altGroups(p).flatMap((g) => g.slots));
const subRow = (id) => (perkById.get(id) || {}).row;

// Rune tooltip, like the client's: short description, or the full one while Shift is held.
let tipEl = null;
let tipFor = null; // { perk, anchor }
const descText = (html) => (html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/\n{3,}/g, '\n\n').trim();
function showTip(perk, anchor, full) {
  if (!tipEl) { tipEl = h('div', { class: 'rune-tip hidden' }); document.body.append(tipEl); }
  tipFor = { perk, anchor };
  const long = perk.longDesc && perk.longDesc !== perk.shortDesc;
  tipEl.replaceChildren(
    h('b', {}, perk.name),
    h('p', {}, descText(full && long ? perk.longDesc : perk.shortDesc || perk.desc)),
    long ? h('div', { class: 'tip-hint' }, full ? 'Release Shift for less' : 'Hold Shift for full details') : ''
  );
  tipEl.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  let x = r.right + 10, y = r.top;
  if (x + t.width > innerWidth - 8) x = r.left - t.width - 10;
  if (y + t.height > innerHeight - 8) y = innerHeight - t.height - 8;
  tipEl.style.left = `${Math.max(8, x)}px`;
  tipEl.style.top = `${Math.max(8, y)}px`;
}
function hideTip() { tipFor = null; if (tipEl) tipEl.classList.add('hidden'); }
for (const ev of ['keydown', 'keyup']) {
  document.addEventListener(ev, (e) => {
    if (e.key === 'Shift' && tipFor && document.body.contains(tipFor.anchor)) showTip(tipFor.perk, tipFor.anchor, ev === 'keydown');
  });
}

// alt: { on, toggle } makes right-click mark the rune as an alternative.
function runeButton(p, selected, color, onPick, extraClass = '', alt = null) {
  const btn = h('button', {
    class: `pick ${extraClass}${selected ? ' sel' : ''}${alt && alt.on && !selected ? ' alt' : ''}`, style: `--tc:${color}`, 'aria-label': p.name,
    onclick: onPick,
    oncontextmenu: (e) => { e.preventDefault(); if (alt && !selected) alt.toggle(); },
    onmouseenter: (e) => showTip(p, btn, e.shiftKey),
    onmouseleave: hideTip,
  });
  const img = h('img', { src: p.img, alt: '' });
  img.addEventListener('error', () => img.replaceWith(h('span', { class: 'fallback' }, p.label || p.name)));
  btn.append(img);
  return btn;
}

function styleTabs(selectedId, disabledId, onPick) {
  return h('div', { class: 'tree-tabs' },
    state.data.styles.map((s) =>
      h('button', {
        class: 'tree-tab' + (s.id === selectedId ? ' active' : ''),
        title: s.id === disabledId ? `${s.name} (already primary)` : s.name,
        'aria-disabled': s.id === disabledId ? 'true' : null,
        style: `--tc:${treeColor(s.id)}`,
        onclick: () => { if (s.id !== disabledId) onPick(s.id); },
      }, h('img', { src: runeIcon(s.icon), alt: s.name }))
    )
  );
}

function renderEditor() {
  const d = state.draft;
  const c = champByKey(d.championKey);
  const primary = styleById.get(d.primaryStyleId);
  const sub = styleById.get(d.subStyleId);
  const pc = treeColor(primary.id), sc = treeColor(sub.id);
  const rerender = () => renderEditor();
  // Right-click toggles a rune as an alternative. Picking an alternative as the main rune swaps them:
  // the rune it replaced becomes the alternative.
  const altRemove = (key, id, replaced = []) => {
    const list = d.alts[key];
    if (!list || !list.includes(id)) return;
    d.alts[key] = [...list.filter((x) => x !== id), ...replaced.filter((x) => x && x !== id && !list.includes(x))];
  };
  // A conflict on a row: every other rune of that row (or of the whole secondary tree) is an alternative,
  // so you choose in champ select. The rune picked here stays the one auto-apply uses.
  const rowChoices = (key) => {
    if (key === 'sec') {
      const sub = styleById.get(d.subStyleId);
      const sel = d.secondary.map((x) => x.id);
      return sub.slots.slice(1).flatMap((sl) => sl.runes.map((r) => r.id)).filter((id) => !sel.includes(id));
    }
    if (key[0] === 'p') {
      const row = +key[1];
      return styleById.get(d.primaryStyleId).slots[row].runes.map((r) => r.id).filter((id) => id !== d.primary[row]);
    }
    const row = +key[1];
    return state.data.shards[row].map((x) => x.id).filter((id) => id !== d.shards[row]);
  };
  const conflictState = (key) => {
    const list = d.alts[key] || [];
    if (!list.length) return 'off';
    return rowChoices(key).every((id) => list.includes(id)) ? 'on' : 'some';
  };
  const conflictBtn = (key) => {
    const st = conflictState(key);
    return h('button', {
      class: `conflict-btn ${st}`,
      title: st === 'off'
        ? 'Make this row a conflict: when you pick this page in champ select, you choose which rune to use here. To offer only some runes, right-click them instead.'
        : 'Remove the conflict (this row always uses the rune you set)',
      onclick: (e) => {
        e.stopPropagation();
        if (st === 'off') d.alts[key] = rowChoices(key); else delete d.alts[key];
        hideTip();
        rerender();
      },
    }, '⇄');
  };
  const altCtl = (key, id) => ({
    on: (d.alts[key] || []).includes(id),
    toggle: () => {
      const list = d.alts[key] || [];
      d.alts[key] = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      rerender();
    },
  });

  // A row hangs off the tree's spine; its node lights up once the row has a pick.
  const treeRow = (cls, filled, picks, extra = null) =>
    h('div', { class: `rrow ${cls}${filled ? ' done' : ''}` }, h('span', { class: 'node' }), h('div', { class: 'picks' }, picks), extra);
  const colHead = (style, label) =>
    h('div', { class: 'col-head' }, h('div', { class: 'col-label' }, label), h('div', { class: 'col-name' }, style.name));

  const setPrimaryTree = (id) => {
    if (id === d.primaryStyleId) return;
    d.primaryStyleId = id;
    d.primary = [null, null, null, null];
    delete d.alts.p1; delete d.alts.p2; delete d.alts.p3;
    if (d.subStyleId === id) {
      d.subStyleId = state.data.styles.find((s) => s.id !== id).id;
      d.secondary = [];
      delete d.alts.sec;
    }
    d.open = undefined;
    rerender();
  };
  const setSubTree = (id) => {
    if (id === d.subStyleId) return;
    d.subStyleId = id;
    d.secondary = [];
    delete d.alts.sec;
    d.open = undefined;
    rerender();
  };
  // Picking a secondary rune: two from different rows; a pick from a third row drops the oldest, like the client.
  const pickSecondary = (row, id) => {
    const before = d.secondary.map((s) => s.id);
    const others = d.secondary.filter((s) => s.row !== row);
    d.secondary = [...(others.length >= 2 ? others.slice(1) : others), { row, id }];
    altRemove('sec', id, before.filter((x) => !d.secondary.some((s) => s.id === x)));
  };

  const primaryCol = h('div', { class: 'col col-primary', style: `--tc:${pc}` },
    styleTabs(primary.id, null, setPrimaryTree),
    colHead(primary, 'Primary'),
    h('div', { class: 'spine' },
      primary.slots.map((slot, row) =>
        treeRow(row === 0 ? 'ks-row' : 'minor-row', !!d.primary[row],
          slot.runes.map((r) => runeButton(perkById.get(r.id), d.primary[row] === r.id, pc, () => {
            const was = d.primary[row];
            d.primary[row] = r.id;
            if (row > 0) altRemove('p' + row, r.id, [was]);
            rerender();
          }, row === 0 ? 'ks' : '', row > 0 ? altCtl('p' + row, r.id) : null)), row > 0 ? conflictBtn('p' + row) : null)
      )
    )
  );

  const subCol = h('div', { class: 'col col-sub', style: `--tc:${sc}` },
    styleTabs(sub.id, primary.id, setSubTree),
    h('div', { class: 'col-head-row' }, colHead(sub, 'Secondary'), conflictBtn('sec')),
    h('div', { class: 'spine' },
      sub.slots.slice(1).map((slot, i) => {
        const row = i + 1;
        return treeRow('sec-row', d.secondary.some((s) => s.row === row),
          slot.runes.map((r) => runeButton(perkById.get(r.id), d.secondary.some((s) => s.id === r.id), sc, () => {
            pickSecondary(row, r.id);
            rerender();
          }, '', altCtl('sec', r.id))));
      })
    )
  );

  hideTip();
  const shardCol = h('div', { class: 'col col-shards', style: '--tc:#c8aa6e' },
    h('div', { class: 'col-head' }, h('div', { class: 'col-label' }, 'Shards')),
    h('div', { class: 'shard-grid' },
      state.data.shards.map((rowShards, row) =>
        treeRow('shard-row', !!d.shards[row],
          rowShards.map((s) => runeButton(perkById.get(s.id), d.shards[row] === s.id, '#c8aa6e', () => {
            const was = d.shards[row];
            d.shards[row] = s.id;
            altRemove('s' + row, s.id, [was]);
            rerender();
          }, 'shard', altCtl('s' + row, s.id))), conflictBtn('s' + row))
      )
    )
  );

  const nameInput = h('input', { type: 'text', id: 'pageName', placeholder: autoName(d), value: d.name, maxlength: 30 });
  nameInput.addEventListener('input', () => { d.name = nameInput.value; });
  const defBox = h('input', { type: 'checkbox', checked: d.isDefault });
  defBox.addEventListener('change', () => { d.isDefault = defBox.checked; });

  const saveBtn = h('button', { class: 'save-btn', disabled: !draftValid(d), onclick: async () => {
    const custom = d.name.trim();
    const name = custom || autoName(d);
    await window.rb.savePage({
      id: d.id || undefined, championKey: d.championKey, championId: c.id,
      name, nameAuto: !custom, isDefault: d.isDefault,
      primaryStyleId: d.primaryStyleId, subStyleId: d.subStyleId,
      selectedPerkIds: draftToPerkIds(d), alts: cleanAlts(d.alts), patch: state.data.version,
    });
    await refreshPages();
    toast(`Saved "${name}"`);
    go('champion', { champ: c });
  } }, 'Save');

  viewEl.replaceChildren(
    h('div', { class: 'editor', style: `--tree:${pc}` },
      h('div', { class: 'ed-head' },
        h('button', { class: 'back', onclick: () => go('champion', { champ: c }) }, `← ${c.name}`),
        nameInput
      ),
      state.editorStyle === 'classic'
        ? h('div', { class: 'trees' }, primaryCol, subCol, shardCol)
        : guidedTrees(d, { setPrimaryTree, setSubTree, pickSecondary, altCtl, altRemove, conflictBtn, rerender }),
      h('div', { class: 'ed-foot' },
        h('label', { class: 'check' }, defBox, `Default page for ${c.name}`),
        h('span', { class: 'spacer' }),
        h('button', { class: 'ghost-btn', onclick: () => go('champion', { champ: c }) }, 'Cancel'),
        saveBtn
      )
    )
  );
}

// ---- Step-by-step editor, like the client's: one slot per rune down each tree. ----
// A slot shows its rune with name and description; clicking it opens the choices for that slot only.
// After a pick the next empty slot opens. Right-click a choice to add it as an alternative.
const GUIDED_SLOTS = ['p0', 'p1', 'p2', 'p3', 'sec0', 'sec1', 's0', 's1', 's2'];
function slotFilled(d, key) {
  if (key[0] === 'p') return !!d.primary[+key[1]];
  if (key.startsWith('sec')) return d.secondary.length > +key[3];
  return !!d.shards[+key[1]];
}
function guidedTrees(d, fn) {
  const primary = styleById.get(d.primaryStyleId), sub = styleById.get(d.subStyleId);
  const pc = treeColor(primary.id), sc = treeColor(sub.id);
  if (d.open === undefined) d.open = GUIDED_SLOTS.find((k) => !slotFilled(d, k)) || null;
  const after = () => { d.open = GUIDED_SLOTS.find((k) => !slotFilled(d, k)) || null; hideTip(); fn.rerender(); };
  const toggle = (key) => { d.open = d.open === key ? null : key; hideTip(); fn.rerender(); };

  const slot = (key, perkId, color, choices, { cls = '', altKey = null, conflict = false } = {}) => {
    const open = d.open === key;
    const perk = perkId ? perkById.get(perkId) : null;
    const alts = altKey ? (d.alts[altKey] || []).filter((id) => perkById.has(id)) : [];
    const node = h('button', {
      class: 'gnode', 'aria-label': perk ? perk.name : 'Select a rune', onclick: () => toggle(key),
      onmouseenter: (e) => perk && showTip(perk, node, e.shiftKey), onmouseleave: hideTip,
    }, perk ? h('img', { src: perk.img, alt: '' }) : '');
    return h('div', { class: `gslot ${cls}${open ? ' open' : ''}${perk ? ' done' : ''}`, style: `--tc:${color}` },
      node,
      open
        ? h('div', { class: 'gopts' }, choices)
        : h('button', { class: 'gtext', onclick: () => toggle(key) },
            perk ? [h('div', { class: 'gname' }, perk.name), h('div', { class: 'gdesc' }, descText(perk.shortDesc || perk.desc))]
              : h('div', { class: 'gempty' }, 'Select a rune'),
            alts.length ? h('div', { class: 'galts' }, 'or', alts.map((id) => perkImg(id, 'galt'))) : ''),
      conflict && altKey ? fn.conflictBtn(altKey) : ''
    );
  };
  const head = (style, color, label) => h('div', { class: 'ghead', style: `--tc:${color}` },
    h('img', { src: runeIcon(style.icon), alt: '' }),
    h('div', {}, h('div', { class: 'col-label' }, label), h('div', { class: 'gtree' }, style.name)));

  const primarySlots = primary.slots.map((s, row) => slot('p' + row, d.primary[row], pc,
    s.runes.map((r) => runeButton(perkById.get(r.id), d.primary[row] === r.id, pc, () => {
      const was = d.primary[row];
      d.primary[row] = r.id;
      if (row > 0) fn.altRemove('p' + row, r.id, [was]);
      after();
    }, row === 0 ? 'ks' : '', row > 0 ? fn.altCtl('p' + row, r.id) : null)),
    { cls: row === 0 ? 'ks' : '', altKey: row > 0 ? 'p' + row : null, conflict: row > 0 }));

  // Both secondary slots offer every row of the secondary tree.
  const secChoices = () => sub.slots.slice(1).map((s, i) => h('div', { class: 'grow' },
    s.runes.map((r) => runeButton(perkById.get(r.id), d.secondary.some((x) => x.id === r.id), sc, () => {
      fn.pickSecondary(i + 1, r.id);
      after();
    }, '', fn.altCtl('sec', r.id)))));
  const secSlots = [0, 1].map((i) => slot('sec' + i, d.secondary[i] && d.secondary[i].id, sc,
    h('div', { class: 'gsec' }, secChoices()), { altKey: i === 0 ? 'sec' : null, conflict: i === 0 }));

  const shardSlots = state.data.shards.map((row, r) => slot('s' + r, d.shards[r], '#c8aa6e',
    row.map((x) => runeButton(perkById.get(x.id), d.shards[r] === x.id, '#c8aa6e', () => {
      const was = d.shards[r];
      d.shards[r] = x.id;
      fn.altRemove('s' + r, x.id, [was]);
      after();
    }, 'shard', fn.altCtl('s' + r, x.id))),
    { cls: 'small', altKey: 's' + r, conflict: true }));

  return h('div', { class: 'guided' },
    h('div', { class: 'gcol', style: `--tc:${pc}` },
      styleTabs(primary.id, null, fn.setPrimaryTree),
      head(primary, pc, 'Primary'),
      h('div', { class: 'gslots' }, primarySlots)),
    h('div', { class: 'gcol', style: `--tc:${sc}` },
      styleTabs(sub.id, primary.id, fn.setSubTree),
      head(sub, sc, 'Secondary'),
      h('div', { class: 'gslots' }, secSlots),
      h('div', { class: 'gslots gshards', style: '--tc:#c8aa6e' }, shardSlots))
  );
}

// ---- Champ select popup window ----
let popupApplied = null; // id of the page RuneBook last put in the client
let popupOpen = false; // page list shown under the bar

// One compact row for a page: the whole page as icons, sized by importance
// (keystone, primary runes, secondary runes, shards). The page in the bar is the one in the client;
// clicking a page in the list puts it in the client and moves it into the bar.
function popRow(p, cls) {
  const ids = p.selectedPerkIds;
  return h('button', {
    class: `prow ${cls}`,
    style: `--tree:${treeColor(p.primaryStyleId)};--sub:${treeColor(p.subStyleId)}`,
    title: p.name,
    onclick: async () => {
      popupApplied = p.id;
      await apply(p);
      window.rb.popupHide();
    },
  },
    perkImg(ids[0], 'pks'),
    h('span', { class: 'pgrp' }, ids.slice(1, 4).map((id) => perkImg(id, 'pmin'))),
    h('span', { class: 'pgrp' }, ids.slice(4, 6).map((id) => perkImg(id, 'psec'))),
    h('span', { class: 'pshards' }, ids.slice(6, 9).map((id) => perkImg(id, 'psh')))
  );
}

function popupOfferPanel(c) {
  const o = state.offer;
  if (!o) return '';
  const edit = o.editOf && state.pages.some((p) => p.id === o.editOf);
  return h('div', { class: 'pop-panel pop-offer', style: `--tree:${treeColor(o.primaryStyleId)}` },
    h('div', { class: 'pop-offer-top' },
      perkImg(o.selectedPerkIds[0], 'oks'),
      h('span', { class: 'pname' }, edit ? 'Page changed in the client' : 'New page in the client'),
      h('button', { class: 'icon-btn', title: 'Don\'t save', onclick: () => window.rb.dismissClientOffer() }, '✕')
    ),
    edit
      ? h('div', { class: 'pop-offer-btns' },
          h('button', { class: 'save-btn', onclick: () => window.rb.saveClientOffer(c.key, 'update') }, 'Save changes'),
          h('button', { class: 'ghost-btn', onclick: () => window.rb.saveClientOffer(c.key, 'new') }, 'Save as new'))
      : h('button', { class: 'save-btn', onclick: () => window.rb.saveClientOffer(c.key, 'new') }, `Save for ${c.name}`)
  );
}

// The page picker that opens over the client from the in-client button, laid out like the client's
// rune recommender: one tall card per page, side by side. The page that's in the client is framed.
// Clicking a card puts that page in the client and closes the picker.
function pickCard(p, current) {
  const ids = p.selectedPerkIds;
  const alt = altSlots(p);
  const img = (i, cls) => perkImg(ids[i], cls + (alt.has(i) ? ' conf' : ''));
  const broken = pageProblem(p);
  return h('div', {
    class: 'bcard' + (current ? ' current' : '') + (broken ? ' broken' : ''),
    style: `--tree:${treeColor(p.primaryStyleId)};--sub:${treeColor(p.subStyleId)}`,
    title: broken ? BROKEN_TIP : p.name,
    onclick: async (e) => {
      if (e.target.closest('.bactions')) return;
      if (broken) return openEditor(draftFromPage(p));
      // A page with alternatives asks you to choose them first.
      if (alt.size) { choosing = { pageId: p.id, picks: {} }; return render(); }
      applyChosen(p);
    },
  },
    broken ? h('div', { class: 'broken-badge', title: BROKEN_TIP }, '!') : null,
    perkImg(ids[0], 'bks'),
    h('div', { class: 'bminors' }, [1, 2, 3].map((i) => img(i, 'bmin' + (i === 2 ? ' low' : '')))),
    h('div', { class: 'bsec' }, [4, 5].map((i) => h('span', { class: 'bsec-wrap' }, img(i, 'bsecimg')))),
    h('div', { class: 'bshards' }, [6, 7, 8].map((i) => img(i, 'bsh'))),
    h('div', { class: 'bactions' },
      h('button', { class: 'bact', title: 'Edit this page', onclick: () => openEditor(draftFromPage(p)) }, '✎'),
      h('button', { class: 'bact danger', title: 'Delete this page', onclick: () => removePage(p) }, '🗑')
    )
  );
}

async function applyChosen(p, perkIds) {
  choosing = null;
  popupApplied = p.id;
  render();
  await apply(p, undefined, perkIds);
  window.rb.popupHide();
}

// Choosing a page's alternatives in the picker. picks: { groupKey: [ids] }.
let choosing = null; // { pageId, picks }
let pickerScroll = null; // { key, left }
function resolveChoice(p, picks) {
  const ids = [...p.selectedPerkIds];
  for (const g of altGroups(p)) {
    const chosen = picks[g.key] || [];
    if (chosen.length !== g.pick) return null;
    if (g.key === 'sec') chosen.slice().sort((a, b) => subRow(a) - subRow(b)).forEach((id, i) => { ids[4 + i] = id; });
    else ids[g.slots[0]] = chosen[0];
  }
  return ids;
}
function choosePanel(p) {
  const picks = choosing.picks;
  const groups = altGroups(p);
  const tryApply = () => {
    const ids = resolveChoice(p, picks);
    if (ids) applyChosen(p, ids); else render();
  };
  return h('div', { class: 'choose', style: `--tree:${treeColor(p.primaryStyleId)}` },
    h('div', { class: 'choose-title' }, perkImg(p.selectedPerkIds[0], 'cks'), h('span', {}, p.name)),
    groups.map((g) => {
      const chosen = picks[g.key] || [];
      // Options in the client's order; the secondary ones in their rows.
      const order = (id) => { const x = perkById.get(id); return x && x.styleId ? x.row * 10 + styleById.get(x.styleId).slots[x.row].runes.findIndex((r) => r.id === id) : 0; };
      const opts = g.key[0] === 's' && g.key !== 'sec'
        ? state.data.shards[+g.key[1]].map((x) => x.id).filter((id) => g.options.includes(id))
        : [...g.options].sort((a, b) => order(a) - order(b));
      const lines = g.key === 'sec' ? [1, 2, 3].map((r) => opts.filter((id) => subRow(id) === r)).filter((l) => l.length) : [opts];
      return h('div', { class: 'choose-row' + (chosen.length === g.pick ? ' done' : '') + (g.key === 'sec' ? ' sec' : '') },
        h('div', { class: 'choose-lines' }, lines.map((line) => h('div', { class: 'choose-line' }, line.map((id) => {
          const perk = perkById.get(id);
          const b = h('button', {
            class: 'choose-opt' + (g.key[0] === 's' && g.key !== 'sec' ? ' small' : '') + (chosen.includes(id) ? ' on' : ''),
            style: `--tc:${g.color}`,
            onmouseenter: (e) => perk && showTip(perk, b, e.shiftKey),
            onmouseleave: hideTip,
            onclick: () => {
              hideTip();
              if (g.pick === 1) picks[g.key] = [id];
              else if (chosen.includes(id)) picks[g.key] = chosen.filter((x) => x !== id);
              else {
                // Two secondary runes from different rows: a pick from the same row replaces it.
                const rest = chosen.filter((x) => subRow(x) !== subRow(id));
                picks[g.key] = [...(rest.length >= 2 ? rest.slice(1) : rest), id];
              }
              tryApply();
            },
          }, perkImg(id, 'copt'));
          return b;
        })))),
        g.key === 'sec' ? h('span', { class: 'choose-note' }, `pick 2 (${chosen.length}/2)`) : ''
      );
    }),
    h('button', { class: 'choose-cancel', onclick: () => { choosing = null; hideTip(); render(); } }, 'Cancel')
  );
}

// The champion whose pages the picker shows: the one you chose in the picker, else the one you're hovering.
const pickerChamp = () => state.champ || (state.lcu.championKey ? champByKey(state.lcu.championKey) : null);

function pickerFrame(c, ...body) {
  return h('div', { class: 'picker', style: c ? `--splash:url("${splashUrl(c)}")` : '' },
    h('div', { class: 'picker-head' },
      ...body.shift(),
      h('span', { class: 'spacer' }),
      h('button', { class: 'picker-close gear', title: 'Settings', onclick: openSettings }, '⚙'),
      h('button', { class: 'picker-close', title: 'Close', onclick: () => window.rb.popupHide() }, '✕')
    ),
    ...body
  );
}

function renderPopup() {
  const c = pickerChamp();
  if (!c) return go('grid');
  const pages = pagesFor(c).sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
  const current = pages.find((p) => p.id === popupApplied) || (c.key === state.lcu.championKey ? pages[0] : null);
  const choosingPage = choosing && pages.find((p) => p.id === choosing.pageId);
  if (!choosingPage) choosing = null;
  const cards = h('div', { class: 'picker-cards' + (current ? ' has-current' : '') },
    pages.map((p) => pickCard(p, p === current)),
    h('div', { class: 'bcard add', title: 'New page', onclick: () => openEditor(newDraft(c)) }, h('span', { class: 'plus' }, '+'))
  );
  // The mouse wheel scrolls the row of pages sideways.
  cards.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { cards.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });
  // Arrows on both sides when the pages don't all fit.
  const step = (dir) => cards.scrollBy({ left: dir * Math.max(240, cards.clientWidth * 0.6), behavior: 'smooth' });
  const left = h('button', { class: 'strip-arrow left', title: 'Scroll left', onclick: () => step(-1) }, '‹');
  const right = h('button', { class: 'strip-arrow right', title: 'Scroll right', onclick: () => step(1) }, '›');
  const arrows = () => {
    left.classList.toggle('hidden', cards.scrollLeft <= 2);
    right.classList.toggle('hidden', cards.scrollLeft + cards.clientWidth >= cards.scrollWidth - 2);
  };
  const strip = h('div', { class: 'picker-strip' }, cards, left, right);
  // Drag the row with the mouse, like a touch list. A drag doesn't count as a click on a page.
  let drag = null;
  cards.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    drag = { x: e.clientX, left: cards.scrollLeft, moved: false, id: e.pointerId };
  });
  cards.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > 6) {
      drag.moved = true;
      cards.setPointerCapture(drag.id);
      cards.classList.add('dragging');
    }
    if (drag.moved) cards.scrollLeft = drag.left - dx;
  });
  const endDrag = () => {
    if (drag && drag.moved) {
      cards.classList.remove('dragging');
      dragEnded = Date.now();
    }
    drag = null;
  };
  // Swallow the click that follows a drag.
  let dragEnded = 0;
  cards.addEventListener('click', (ev) => {
    if (Date.now() - dragEnded < 100) { ev.stopPropagation(); ev.preventDefault(); }
  }, { capture: true });
  cards.addEventListener('pointerup', endDrag);
  cards.addEventListener('pointercancel', endDrag);
  // Keep the scroll position across re-renders; a new champion starts at the framed page.
  cards.addEventListener('scroll', () => { pickerScroll = { key: c.key, left: cards.scrollLeft }; arrows(); });
  new ResizeObserver(arrows).observe(cards);
  viewEl.replaceChildren(
    pickerFrame(c,
      [
        h('button', { class: 'picker-nav', title: 'All champions', onclick: () => go('grid') }, '▦ All champions'),
        h('div', { class: 'picker-champ' }, c.name),
      ],
      choosingPage ? choosePanel(choosingPage) : strip,
      state.offer ? h('div', { class: 'picker-offer' }, popupOfferPanel(c)) : ''
    )
  );
  if (!choosingPage) {
    if (pickerScroll && pickerScroll.key === c.key) cards.scrollTo({ left: pickerScroll.left, behavior: 'instant' });
    else {
      const cur = cards.querySelector('.bcard.current');
      if (cur) cur.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'instant' });
      else cards.scrollTo({ left: cards.scrollWidth, behavior: 'instant' });
    }
    arrows();
  }
}

// All champions, inside the picker. Picking one shows its pages.
let pickerQuery = '';
function renderPickerGrid() {
  const c = pickerChamp();
  const listEl = h('div', { class: 'picker-grid' });
  const fill = () => {
    const q = pickerQuery.trim().toLowerCase();
    listEl.replaceChildren(...state.data.champions
      .filter((x) => !q || x.name.toLowerCase().includes(q))
      .map((x) => h('button', { class: 'champ', title: x.name, onclick: () => go('champion', { champ: x }) },
        h('img', { src: x.image, alt: '', loading: 'lazy' }), x.name)));
  };
  const search = h('input', { type: 'search', class: 'picker-search', placeholder: 'Search champion…', value: pickerQuery, autocomplete: 'off' });
  search.addEventListener('input', () => { pickerQuery = search.value; fill(); });
  fill();
  viewEl.replaceChildren(
    pickerFrame(null,
      [
        c ? h('button', { class: 'picker-nav', onclick: () => go('champion', { champ: c }) }, `← ${c.name}`) : '',
        search,
      ],
      listEl
    )
  );
  search.focus();
}

// ---- The round button that sits in the client's bottom bar ----
// Danger-ping style alert, made with WebAudio (RuneBook can't ship Riot's own sound file).
// Plays twice as long as one ping; volume 0-1 from the settings.
function playWarning(volume = 0.7) {
  try {
    const ctx = new AudioContext();
    const beep = (at, f1, f2) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(f1, ctx.currentTime + at);
      o.frequency.exponentialRampToValueAtTime(f2, ctx.currentTime + at + 0.16);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, 0.7 * volume), ctx.currentTime + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.28);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + 0.3);
    };
    for (let i = 0; i < 4; i++) {
      beep(i * 0.45, 1480, 1100);
      beep(i * 0.45 + 0.14, 1180, 760);
    }
    setTimeout(() => ctx.close(), 2500);
  } catch {}
}

// Small 2x2 grid of champion tiles, shown when no champion is hovered (opens the champion list).
const GRID_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="#c8aa6e" stroke-width="1.6">'
  + '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/>'
  + '<rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/></g></svg>';

// RuneBook's diamond on its own (without the ring in icon.png), sized like the glyphs on the client's buttons.
const LOGO_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M12 2.5 L19 12 L12 21.5 L5 12 Z" fill="#c8aa6e"/>'
  + '<path d="M12 7.5 L15.3 12 L12 16.5 L8.7 12 Z" fill="#0ac8b9"/></svg>';

// ---- The round button that sits in the client's bottom bar ----
function renderButton(st) {
  const alert = st.highlight;
  const b = h('button', {
    class: 'rb-btn' + (st.enabled ? '' : ' off') + (alert ? ' alert' : '') + (st.open ? ' open' : ''),
    title: !st.enabled ? 'RuneBook' : st.champ ? 'Rune pages' : 'All champions',
    onclick: () => window.rb.clickButton(),
    onmouseenter: () => window.rb.buttonHover(true),
    onmouseleave: () => window.rb.buttonHover(false),
  });
  const g = h('span', { class: 'rb-gridicon' + (st.enabled ? '' : ' off') });
  g.innerHTML = st.champ || !st.enabled ? LOGO_ICON : GRID_ICON;
  b.append(g);
  if (alert) b.append(h('span', { class: 'rb-bang' }, '!'));
  viewEl.replaceChildren(
    h('div', { class: 'rb-wrap' + (alert ? ' alert' : '') },
      alert ? [h('span', { class: 'ripple' }), h('span', { class: 'ripple r2' })] : '',
      b)
  );
}

// Riot's required notice for community projects.
const RIOT_DISCLAIMER = "RuneBook isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.";

// ---- Settings (from the ⚙ in the main window and in the picker) ----
async function openSettings() {
  const s = await window.rb.getSettings();
  const mode = s.autoApplyMode || (s.autoApply === false ? 'off' : 'hover');
  const set = (patch) => { Object.assign(s, patch); window.rb.setSettings(patch); };
  const select = (value, options, onChange) => {
    const el = h('select', {}, options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));
    el.addEventListener('change', () => onChange(el.value));
    return el;
  };
  const check = (checked, onChange) => {
    const el = h('input', { type: 'checkbox', checked: !!checked });
    el.addEventListener('change', () => onChange(el.checked));
    return el;
  };
  const vol = h('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round((s.warnVolume ?? 0.7) * 100) });
  const volText = h('span', { class: 'set-val' }, `${vol.value}%`);
  vol.addEventListener('input', () => { volText.textContent = `${vol.value}%`; });
  vol.addEventListener('change', () => set({ warnVolume: vol.value / 100 }));
  const row = (label, ...control) => h('label', { class: 'set-row' }, h('span', { class: 'set-label' }, label), ...control);
  modal(h('div', { class: 'settings' },
    h('h3', {}, 'Settings'),
    h('div', { class: 'set-group' },
      h('div', { class: 'set-title' }, 'Champ select'),
      row('Put the default page in the client', select(mode, [['hover', 'When I hover a champion'], ['lock', 'When I lock in'], ['off', 'Never']], (v) => set({ autoApplyMode: v, autoApply: v !== 'off' })))
    ),
    h('div', { class: 'set-group' },
      h('div', { class: 'set-title' }, 'Warning if I haven\'t opened RuneBook'),
      row('Play a warning sound', check(s.warnSound !== false, (v) => set({ warnSound: v }))),
      row('Volume', vol, volText,
        h('button', { class: 'ghost tiny', title: 'Play it', onclick: (e) => { e.preventDefault(); playWarning(vol.value / 100); } }, '▶')),
      row('When', select(s.warnSeconds || 15, [5, 10, 15, 20, 30].map((n) => [n, `${n} seconds before the game`]), (v) => set({ warnSeconds: Number(v) }))),
      row('Repeat', select(s.warnRepeat || 'once', [['once', 'Once'], ['repeat', 'Until the game starts']], (v) => set({ warnRepeat: v })))
    ),
    h('div', { class: 'set-group' },
      h('div', { class: 'set-title' }, 'App'),
      row('Rune editor', select(s.editorStyle || 'guided', [['guided', 'Step by step (like the client)'], ['classic', 'All runes at once']], (v) => {
        set({ editorStyle: v });
        state.editorStyle = v;
        if (state.view === 'editor') renderEditor();
      })),
      row('Start with Windows', check(s.startWithWindows !== false, (v) => set({ startWithWindows: v }))),
      row('Something not working?', h('button', { class: 'ghost-btn', onclick: (e) => { e.preventDefault(); openBugReport(); } }, 'Report a bug'))
    ),
    h('div', { class: 'modal-actions' }, h('button', { class: 'save-btn', onclick: closeModal }, 'Done')),
    h('p', { class: 'legal' }, RIOT_DISCLAIMER)
  ));
}

// What happened, in your words; the main process adds versions and the log, then opens a GitHub issue
// (or copies the report and shows the file when there's no GitHub page yet).
function openBugReport() {
  const text = h('textarea', { class: 'bug-text', rows: 6, placeholder: 'What happened, and what did you expect? Steps to make it happen again help a lot.' });
  const send = h('button', { class: 'save-btn', onclick: async () => {
    send.disabled = true;
    const res = await window.rb.reportBug(text.value.trim());
    modal([
      h('h3', { class: 'bug-title' }, 'Thanks!'),
      h('p', {}, res && res.via === 'github'
        ? 'A GitHub page opened with your report. Check it and press "Submit new issue". The full report with the log is in the folder that opened, so you can attach it.'
        : 'The report is copied, and the folder with the report file is open. Send the file to the developer.'),
      h('div', { class: 'modal-actions' }, h('button', { class: 'save-btn', onclick: closeModal }, 'Done')),
    ]);
  } }, 'Send report');
  modal([
    h('h3', { class: 'bug-title' }, 'Report a bug'),
    text,
    h('p', { class: 'muted small' }, 'The report includes RuneBook\'s version, your settings and the recent log. It doesn\'t include your rune pages or any account details.'),
    h('div', { class: 'modal-actions' }, h('button', { class: 'ghost-btn', onclick: closeModal }, 'Cancel'), send),
  ]);
  text.focus();
}

// Errors in a window go to the log file, so bug reports show them.
window.addEventListener('error', (e) => { try { window.rb.logError(`${e.message} at ${e.filename}:${e.lineno}`); } catch {} });
window.addEventListener('unhandledrejection', (e) => { try { window.rb.logError(`Unhandled: ${e.reason && e.reason.stack || e.reason}`); } catch {} });

// Size the frameless window to whatever is showing.
function fitPopup() {
  requestAnimationFrame(() => {
    const root = viewEl.firstElementChild;
    if (!root) return;
    const r = root.getBoundingClientRect();
    window.rb.popupFit(Math.max(r.right, 200) + 2, r.bottom + 2);
  });
}

// ---- Offer to save a page built in the client ----
// The champion it would be saved for: the one you're picking, else the one open on screen.
function offerChampion() {
  if (state.lcu.inChampSelect && state.lcu.championKey) return champByKey(state.lcu.championKey);
  if (!POPUP && (state.view === 'champion' || state.view === 'editor') && state.champ) return state.champ;
  return null;
}
function renderOffer() {
  const el = $('#offer');
  const o = POPUP ? null : state.offer; // the pick window shows its own offer panel
  if (!o) { el.classList.add('hidden'); el.replaceChildren(); return; }
  const c = offerChampion();
  const edit = o.editOf && state.pages.some((p) => p.id === o.editOf);
  el.style.cssText = `--tree:${treeColor(o.primaryStyleId)};--sub:${treeColor(o.subStyleId)}`;
  el.replaceChildren(
    h('div', { class: 'offer-runes' },
      perkImg(o.selectedPerkIds[0], 'oks'),
      o.selectedPerkIds.slice(1, 4).map((id) => perkImg(id, 'omin')),
      o.selectedPerkIds.slice(4, 6).map((id) => perkImg(id, 'osec'))
    ),
    h('div', { class: 'offer-text' },
      h('b', {}, edit ? 'You changed this page in the client' : 'New page in the client'),
      h('span', {}, edit ? 'Keep the change in RuneBook?' : c ? 'Not saved in RuneBook yet' : 'Open a champion to save it')
    ),
    edit ? h('button', { class: 'save-btn', onclick: async () => {
      if (await window.rb.saveClientOffer(c ? c.key : 0, 'update')) toast('Changes saved');
    } }, 'Save changes') : '',
    c ? h('button', { class: edit ? 'ghost-btn' : 'save-btn', onclick: async () => {
      const saved = await window.rb.saveClientOffer(c.key, 'new');
      if (saved) toast(`Saved for ${c.name}`);
    } }, edit ? 'Save as new' : `Save for ${c.name}`) : '',
    h('button', { class: 'ghost-btn', title: 'Don\'t save', onclick: () => window.rb.dismissClientOffer() }, '✕')
  );
  el.classList.remove('hidden');
}

// ---- Status bar + champ select ----
function renderStatus() {
  const el = $('#conn');
  const s = state.lcu;
  el.className = 'conn' + (s.inChampSelect ? ' select' : s.connected ? ' on' : '');
  if (!s.connected) el.textContent = '● Waiting for League client…';
  else if (s.inChampSelect) {
    const c = s.championKey ? champByKey(s.championKey) : null;
    el.textContent = `● Champ select${c ? `: ${c.name}${s.locked ? ' (locked)' : ''}` : ''}`;
  } else el.textContent = '● Connected to League client';
}

function onLcuState(s) {
  const prev = state.lcu;
  state.lcu = s;
  renderStatus();
  if (!state.data) return;
  if (POPUP) {
    // Follow the champion you hover in the client, unless you're editing.
    if (s.championKey && s.championKey !== prev.championKey && state.view !== 'editor') {
      state.champ = champByKey(s.championKey);
      state.view = 'champion';
    }
    return render();
  }
  // Jump to the champion you're picking, unless you're in the middle of editing.
  if (s.inChampSelect && s.championKey && s.championKey !== prev.championKey && state.view !== 'editor') {
    const c = champByKey(s.championKey);
    if (c) return go('champion', { champ: c });
  }
  if (state.view !== 'editor') render();
}

// ---- Boot ----
let editPage = null;
let pendingEditId = null; // page the picker asked to edit before this window had loaded
async function init() {
  if (location.hash === '#button') {
    document.body.classList.add('popup', 'btnwin');
    renderButton(await window.rb.getButtonState());
    window.rb.onButtonState(renderButton);
    // Once, or again every 3 seconds until the game starts or the picker opens.
    let warnLoop = null;
    const stopWarn = () => { clearInterval(warnLoop); warnLoop = null; };
    window.rb.onButtonWarn(({ volume, repeat } = {}) => {
      stopWarn();
      playWarning(volume ?? 0.7);
      if (repeat) warnLoop = setInterval(() => playWarning(volume ?? 0.7), 3000);
    });
    window.rb.onButtonWarnStop(stopWarn);
    return;
  }
  if (POPUP) document.body.classList.add('popup');
  viewEl.replaceChildren(h('div', { class: 'empty' }, 'Loading champions and runes…'));
  try {
    state.data = await window.rb.loadStatic();
  } catch (err) {
    viewEl.replaceChildren(h('div', { class: 'empty' }, String(err.message || err)));
    return;
  }
  indexData();
  $('#patch').textContent = `Patch ${state.data.version}`;
  await refreshPages();
  $('#settingsBtn').addEventListener('click', openSettings);
  state.editorStyle = (await window.rb.getSettings()).editorStyle || 'guided';
  window.rb.onSettingsChanged((st) => {
    const changed = st.editorStyle !== state.editorStyle;
    state.editorStyle = st.editorStyle || 'guided';
    if (changed && state.view === 'editor') renderEditor();
  });
  $('#search').addEventListener('input', () => go('grid'));
  $('#homeBtn').addEventListener('click', () => go('grid'));
  window.rb.onToast(toast);
  state.recSeen = (await window.rb.getAllRecommended()) || {};
  window.rb.onPagesChanged(async () => {
    await refreshPages();
    if (state.view !== 'editor') render();
  });
  window.rb.onRecProgress(({ done, total }) => {
    $('#patch').textContent = done < total ? `Downloading recommended pages ${done}/${total}` : `Patch ${state.data.version}`;
  });
  window.rb.onStaticUpdated(async () => {
    try { state.data = await window.rb.loadStatic(); } catch { return; }
    indexData();
    $('#patch').textContent = `Patch ${state.data.version}`;
    await refreshPages();
  });
  window.rb.onRecUpdated((all) => {
    state.recSeen = all || {};
    $('#patch').textContent = `Patch ${state.data.version}`;
    if (state.view !== 'editor') render();
  });
  window.rb.onLcuState(onLcuState);
  state.offer = await window.rb.getClientOffer();
  window.rb.onClientOffer((offer) => { state.offer = offer; if (POPUP) render(); else renderOffer(); });
  window.rb.onPageApplied((id) => { popupApplied = id; if (POPUP) render(); });
  if (POPUP) {
    popupApplied = await window.rb.getCurrentPageId();
    const st = await window.rb.getLcuState();
    state.lcu = st;
    state.champ = st.championKey ? champByKey(st.championKey) : null;
    state.view = state.champ ? 'champion' : 'grid';
  }
  else {
    editPage = (id) => {
      const p = state.pages.find((x) => x.id === id);
      if (!p) return;
      state.champ = champByKey(p.championKey);
      openEditor(draftFromPage(p));
    };
    window.rb.onEditPage(editPage);
    pendingEditId = await window.rb.getPendingEdit();
  }
  render();
  onLcuState(await window.rb.getLcuState());
  if (pendingEditId) editPage(pendingEditId);
}

init();

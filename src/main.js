const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, session, shell, clipboard } = require('electron');
const os = require('os');
const log = require('./log');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadStaticData } = require('./staticData');
const { Lcu, myChampion, PAGE_PREFIX } = require('./lcu');
const { watchClientWindow } = require('./clientWindow');

// Two ways to run, one process:
//  - "RuneBook.exe --background": starts with Windows, no window, only a tray icon.
//    It waits for League and shows the small pick window in champ select.
//  - "RuneBook.exe": opens the editor. If the background one is already running,
//    it just asks that one to open the editor, so pages are never written by two processes.
const BACKGROUND = process.argv.includes('--background');
// The warning sound plays without a click, so allow audio without a user gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null; // the editor window, only while open
let popup = null; // small always-on-top window shown during champ select
let tray = null;
const lcu = new Lcu();

// IPC only answers RuneBook's own pages (loaded from disk), never anything else that ends up in a window.
const fromApp = (e) => {
  try { return new URL(e.senderFrame.url).protocol === 'file:'; } catch { return false; }
};
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromApp(e)) throw new Error('Not allowed');
    return fn(e, ...args);
  });
}

// ---- Local storage: saved pages + settings in one JSON file ----
const storeFile = () => path.join(app.getPath('userData'), 'runebook.json');
let store = { pages: [], seeded: [], settings: { autoApply: true, autoApplyMode: 'hover', editorStyle: 'guided', startWithWindows: true, warnSound: true, warnVolume: 0.7, warnSeconds: 15, warnRepeat: 'once' } };

// Saves go to a temp file first and then replace the real one, so a crash or power cut mid-write
// can't leave half a file. The previous good version is kept as runebook.json.bak.
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function loadStore() {
  const file = storeFile();
  let raw = null;
  try { raw = readJson(file); } catch (err) {
    if (fs.existsSync(file)) {
      // Unreadable: keep a copy aside so the next save doesn't overwrite it, then fall back to the backup.
      try { fs.copyFileSync(file, `${file}.broken-${Date.now()}`); } catch {}
      try { raw = readJson(`${file}.bak`); } catch {}
    }
  }
  if (raw) store = { pages: Array.isArray(raw.pages) ? raw.pages : [], seeded: raw.seeded || [], settings: { ...store.settings, ...(raw.settings || {}) } };
}
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  if (fs.existsSync(file)) { try { fs.copyFileSync(file, `${file}.bak`); } catch {} }
  fs.renameSync(tmp, file);
}
function saveStore() {
  try { writeAtomic(storeFile(), JSON.stringify(store, null, 2)); } catch (err) {
    console.error('Saving failed:', err.message);
    send('toast', `Couldn't save: ${err.message}`);
  }
}

// ---- Riot's recommended pages for every champion, cached on disk ----
const recFile = () => path.join(app.getPath('userData'), 'recommended.json');
let staticData = null;
let rec = { patch: null, fetchedAt: 0, pages: {} };
let recLoading = false;

function loadRecCache() {
  try {
    rec = JSON.parse(fs.readFileSync(recFile(), 'utf8'));
  } catch {}
}

const POSITION_NAMES = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', UTILITY: 'Support' };

async function preloadRecommended() {
  if (recLoading || !lcu.connected || !staticData) return;
  const fresh = rec.patch === staticData.version && Date.now() - rec.fetchedAt < 24 * 3600 * 1000
    && Object.keys(rec.pages).length >= staticData.champions.length * 0.9;
  if (fresh) return;
  recLoading = true;
  try {
    const keys = staticData.champions.map((c) => c.key);
    const pages = await lcu.getAllRecommended(keys, (done, total) => send('rec:progress', { done, total }));
    const found = Object.values(pages).filter((l) => l.length).length;
    if (found > 0) {
      rec = { patch: staticData.version, fetchedAt: Date.now(), pages };
      writeAtomic(recFile(), JSON.stringify(rec));
    }
    seedFromRecommended();
    send('rec:updated', rec.pages);
  } catch (err) {
    console.error('Preloading recommended pages failed:', err.message);
  } finally {
    recLoading = false;
  }
}

// Every champion starts with Riot's recommended pages as its own pages.
// Each champion is seeded once, so pages you edit or delete later stay that way.
function seedFromRecommended() {
  if (!staticData) return;
  const keystoneName = new Map();
  for (const style of staticData.styles) for (const r of style.slots[0].runes) keystoneName.set(r.id, r.name);
  const styleName = new Map(staticData.styles.map((st) => [st.id, st.name]));
  const seeded = new Set(store.seeded);
  let changed = false;
  // Older versions named Riot pages after the role ("Mid · Electrocute"); rename them after their runes.
  for (const p of store.pages) {
    if (p.source === 'riot' && !p.nameAuto && /^(Top|Jungle|Mid|Bot|Support|Riot)\b/.test(p.name || '')) {
      p.name = `${keystoneName.get(p.selectedPerkIds[0]) || 'Recommended'} · ${styleName.get(p.subStyleId) || ''}`;
      p.nameAuto = true;
      changed = true;
    }
  }
  for (const c of staticData.champions) {
    const list = rec.pages[c.key];
    if (!list || !list.length || seeded.has(c.key)) continue;
    seeded.add(c.key);
    changed = true;
    if (store.pages.some((p) => p.championKey === c.key)) continue; // already has your own pages
    const defaultIdx = Math.max(0, list.findIndex((r) => r.isDefaultPosition));
    list.forEach((r, i) => {
      store.pages.push({
        id: crypto.randomUUID(),
        championKey: c.key,
        championId: c.id,
        name: `${keystoneName.get(r.selectedPerkIds[0]) || 'Recommended'} · ${styleName.get(r.subStyleId) || ''}`,
        nameAuto: true,
        isDefault: i === defaultIdx,
        primaryStyleId: r.primaryStyleId,
        subStyleId: r.subStyleId,
        selectedPerkIds: r.selectedPerkIds,
        position: r.position,
        source: 'riot',
        patch: staticData.version,
        updatedAt: new Date().toISOString(),
      });
    });
  }
  if (changed) {
    store.seeded = [...seeded];
    saveStore();
    send('pages:changed');
  }
}

// The recommended page to use for a champion: your assigned role first, then Riot's default role.
function recommendedFor(championKey, position) {
  const list = rec.pages[championKey] || [];
  return list.find((p) => position && p.position === position) || list.find((p) => p.isDefaultPosition) || list[0];
}

// ---- Champ select state ----
let champState = { connected: false, inChampSelect: false, championKey: 0, locked: false };
let lastAutoApplied = null; // championKey we already auto-applied for this champ select

function send(channel, payload) {
  for (const w of [win, popup, button]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

// ---- In-client button + pages panel ----
// During champ select a small round RuneBook button sits in the League client's bottom bar,
// between the chat box and the emote buttons. It stays greyed out until you hover a champion;
// clicking it opens that champion's pages just above it. If you lock in without having opened it,
// it glows to remind you. League scales its whole UI with the window, so the spot is a fixed
// fraction of the client window.
const BUTTON_SPOT = { fx: 0.2905, fy: 0.945 }; // centre of the gap, as a fraction of the client window
const BUTTON_SIZE = 24; // at a 1600px wide client, the size of the client's own round buttons next to it
const BUTTON_PAD = 26; // room around it for the warning ripples (clicks there pass through to the client)
let button = null;
let clientRect = null; // League client window, in screen DIPs
let clientMinimized = false;
let stopWatching = null;
let panelUsed = false; // opened the panel during this champ select

function buttonGeometry() {
  let cx, cy, scale = 1;
  if (clientRect) {
    scale = clientRect.width / 1600;
    cx = clientRect.x + clientRect.width * BUTTON_SPOT.fx;
    cy = clientRect.y + clientRect.height * BUTTON_SPOT.fy;
  } else {
    const area = screen.getPrimaryDisplay().workArea;
    cx = area.x + 60;
    cy = area.y + area.height - 60;
  }
  const size = Math.round(BUTTON_SIZE * Math.max(0.6, Math.min(scale, 1.6)));
  return { cx, cy, size, scale };
}

function placeButton() {
  if (!button || button.isDestroyed()) return;
  const { cx, cy, size } = buttonGeometry();
  const full = size + BUTTON_PAD * 2;
  button.setBounds({ x: Math.round(cx - full / 2), y: Math.round(cy - full / 2), width: full, height: full });
}

// The page picker covers the middle of the client, like the client's own rune recommender.
const PANEL_SPOT = { fx: 0.089, fy: 0.112, fw: 0.826, fh: 0.86 };
function placePanel() {
  if (!popup || popup.isDestroyed()) return;
  let b, zoom = 1;
  if (clientRect) {
    b = {
      x: clientRect.x + clientRect.width * PANEL_SPOT.fx, y: clientRect.y + clientRect.height * PANEL_SPOT.fy,
      width: clientRect.width * PANEL_SPOT.fw, height: clientRect.height * PANEL_SPOT.fh,
    };
    zoom = Math.max(0.6, Math.min(clientRect.width / 1600, 1.6));
  } else {
    const a = screen.getPrimaryDisplay().workArea;
    b = { x: a.x + (a.width - 1320) / 2, y: a.y + (a.height - 780) / 2, width: 1320, height: 780 };
  }
  popup.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
  popup.webContents.setZoomFactor(zoom);
}

function buttonState() {
  const enabled = champState.inChampSelect;
  return {
    enabled,
    champ: champState.championKey > 0,
    open: !!(popup && !popup.isDestroyed()),
    highlight: enabled && champState.championKey > 0 && champState.locked && !panelUsed,
  };
}
function sendButtonState() {
  if (button && !button.isDestroyed()) button.webContents.send('button:state', buttonState());
}

function onClientRect(r) {
  if (!r) { clientRect = null; return; }
  clientRect = process.platform === 'win32'
    ? screen.screenToDipRect(null, { x: r.x, y: r.y, width: r.width, height: r.height })
    : r;
  clientMinimized = r.minimized;
  for (const w of [button, popup]) {
    if (!w || w.isDestroyed()) continue;
    if (clientMinimized) w.hide();
    else if (!w.isVisible() && w.rbReady) w.showInactive();
  }
  placeButton();
  placePanel();
}

function overlayWindow(hash, width, height) {
  const w = new BrowserWindow({
    width, height, x: 0, y: 0,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    alwaysOnTop: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, title: 'RuneBook', show: false, focusable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.setAlwaysOnTop(true, 'floating');
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'), { hash });
  return w;
}

function openButton() {
  if (button && !button.isDestroyed()) return;
  button = overlayWindow('button', 88, 88);
  button.setIgnoreMouseEvents(true, { forward: true });
  placeButton();
  button.once('ready-to-show', () => {
    if (!button) return;
    button.rbReady = true;
    placeButton();
    if (!clientMinimized) button.showInactive();
    sendButtonState();
  });
  button.on('closed', () => { button = null; });
  if (!stopWatching) stopWatching = watchClientWindow(onClientRect, app.getPath('userData'));
}

function openPopup() {
  if (popup && !popup.isDestroyed()) return;
  panelUsed = true;
  if (button && !button.isDestroyed()) button.webContents.send('button:warnstop');
  popup = overlayWindow('popup', 1320, 780);
  placePanel();
  popup.once('ready-to-show', () => {
    if (!popup) return;
    popup.rbReady = true;
    placePanel();
    if (!clientMinimized) popup.show();
  });
  popup.on('blur', () => setTimeout(() => { if (popup && !popup.isDestroyed() && !popup.isFocused() && !keepPanel && !popupSticky) closePopup(); }, 150));
  popup.on('closed', () => { popup = null; popupSticky = false; sendButtonState(); });
  sendButtonState();
}
let popupSticky = false; // the picker is showing the editor or the champion search
let keepPanel = false; // true while an offer to save needs an answer
function closePopup() {
  if (popup && !popup.isDestroyed()) popup.close();
  popup = null;
  sendButtonState();
}

function setChampState(patch) {
  const wasIn = champState.inChampSelect;
  champState = { ...champState, ...patch };
  send('lcu:state', champState);

  if (champState.inChampSelect && !wasIn) {
    panelUsed = false;
    openButton();
  }
  if (!champState.inChampSelect && wasIn) {
    closePopup();
    if (button && !button.isDestroyed()) button.close();
    button = null;
    if (stopWatching) { stopWatching(); stopWatching = null; }
    lastAutoApplied = null;
  }
  sendButtonState();
}

// As soon as you pick (or hover) a champion, its default page goes into the client.
// Waits a moment so quickly hovering through champions doesn't send a page for each one.
let autoApplyTimer = null;
function maybeAutoApply() {
  clearTimeout(autoApplyTimer);
  autoApplyTimer = setTimeout(autoApplyNow, 700);
}

// A saved page can stop being valid after a patch (a rune removed or moved). Such a page isn't sent
// to the client; the app marks it and asks you to fix it in the editor.
function pageProblem(p) {
  if (!staticData) return null;
  const ids = p.selectedPerkIds;
  if (!Array.isArray(ids) || ids.length !== 9 || !ids.every(Number.isInteger)) return 'incomplete';
  const pri = staticData.styles.find((s) => s.id === p.primaryStyleId);
  const sub = staticData.styles.find((s) => s.id === p.subStyleId);
  if (!pri || !sub || pri === sub) return 'tree';
  const rowOf = (style, id) => style.slots.findIndex((slot) => slot.runes.some((r) => r.id === id));
  for (let r = 0; r < 4; r++) if (rowOf(pri, ids[r]) !== r) return 'rune';
  const a = rowOf(sub, ids[4]), b = rowOf(sub, ids[5]);
  if (a < 1 || b < 1 || a === b) return 'rune';
  for (let r = 0; r < 3; r++) if (!(staticData.shards[r] || []).some((s) => s.id === ids[6 + r])) return 'rune';
  return null;
}

async function autoApplyNow() {
  const { championKey, inChampSelect } = champState;
  // When: 'hover' (as soon as you hover), 'lock' (when you lock in) or 'off'.
  const mode = store.settings.autoApplyMode || (store.settings.autoApply === false ? 'off' : 'hover');
  if (mode === 'off' || (mode === 'lock' && !champState.locked)) return;
  if (!inChampSelect || !championKey || lastAutoApplied === championKey) return;
  const own = store.pages.filter((p) => p.championKey === championKey && !pageProblem(p));
  let page = own.find((p) => p.isDefault) || own[0];
  if (!page) {
    // No page of your own yet: fall back to Riot's recommendation for your role.
    const r = recommendedFor(championKey, champState.position);
    if (r) page = { ...r, name: `Riot ${POSITION_NAMES[r.position] || 'recommended'}` };
  }
  if (!page) return;
  lastAutoApplied = championKey;
  try {
    const result = await lcu.applyPage(page);
    if (result.ok) {
      send('toast', `Auto-applied "${page.name}"`);
      lastAppliedId = page.id || null;
      send('page:applied', page.id || null);
    } else send('toast', `Couldn't auto-apply "${page.name}".`);
  } catch (err) {
    lastAutoApplied = null; // try again on the next champ select update
    send('toast', `Auto-apply failed: ${err.message}`);
  }
}

// ---- Offer to save pages you build in the client ----
// When the client's active page is one you made there and RuneBook has no copy of it,
// the UI shows an offer to save it for the champion you're on.
let clientOffer = null; // { primaryStyleId, subStyleId, selectedPerkIds, clientName }
const dismissedOffers = new Set(); // page signatures you said no to (this run only)
const pageSig = (p) => [p.primaryStyleId, p.subStyleId, ...p.selectedPerkIds].join(',');

function setOffer(offer) {
  clientOffer = offer;
  keepPanel = !!offer;
  // In champ select the offer lives in the pages panel, so open it.
  if (offer && champState.inChampSelect && champState.championKey) openPopup();
  send('offer:changed', clientOffer);
}

function autoNameFor(p) {
  if (!staticData) return 'Client page';
  let ks = null;
  for (const st of staticData.styles) for (const r of st.slots[0].runes) if (r.id === p.selectedPerkIds[0]) ks = r.name;
  const sub = staticData.styles.find((st) => st.id === p.subStyleId);
  return `${ks || 'Client page'} · ${sub ? sub.name : ''}`;
}

let lastAppliedId = null; // saved page RuneBook last put in the client
let lastAppliedSig = null; // exactly what we put there (a page with alternatives can differ from its saved runes)
let pendingEdit = null; // page to open in the editor once its window has loaded

lcu.on('currentPage', (page) => {
  const ids = Array.isArray(page.selectedPerkIds) ? page.selectedPerkIds : [];
  if (!page.isDeletable || ids.length !== 9 || ids.some((id) => !id) || !page.primaryStyleId || !page.subStyleId) return;
  // RuneBook's own client page that you edited there: offer to save the edit over the page it came from.
  const ours = typeof page.name === 'string' && page.name.startsWith(PAGE_PREFIX);
  const source = ours && lastAppliedId ? store.pages.find((s) => s.id === lastAppliedId) : null;
  const p = {
    primaryStyleId: page.primaryStyleId, subStyleId: page.subStyleId, selectedPerkIds: ids,
    clientName: page.name || '', editOf: source ? source.id : null,
  };
  const sig = pageSig(p);
  if (dismissedOffers.has(sig) || sig === lastAppliedSig || store.pages.some((s) => pageSig(s) === sig)) {
    if (clientOffer && pageSig(clientOffer) !== sig) setOffer(null);
    return;
  }
  setOffer(p);
});

lcu.on('connection', (connected) => {
  log.info(connected ? 'League client connected' : 'League client disconnected');
  setChampState({ connected });
  if (connected) preloadRecommended();
});
// 15 seconds before the game starts, if you still haven't opened the button, play a warning sound.
let warnTimer = null;
let warned = false;
function scheduleWarning(session) {
  clearTimeout(warnTimer);
  const t = session && session.timer;
  if (!t || t.phase !== 'FINALIZATION' || warned || panelUsed) return;
  const left = Number(t.adjustedTimeLeftInPhase) || 0;
  const before = (Number(store.settings.warnSeconds) || 15) * 1000;
  const fire = () => {
    if (warned || panelUsed || !champState.inChampSelect || !store.settings.warnSound) return;
    warned = true;
    if (button && !button.isDestroyed()) {
      button.webContents.send('button:warn', {
        volume: store.settings.warnVolume ?? 0.7,
        repeat: store.settings.warnRepeat === 'repeat',
      });
    }
  };
  if (left <= before) fire();
  else warnTimer = setTimeout(fire, left - before);
}

// Modes without rune pages (Arena, Swarm, TFT): RuneBook stays out of champ select there.
const NO_RUNE_MODES = new Set(['CHERRY', 'STRAWBERRY', 'TFT']);
let modeCheck = { gameId: null, promise: null };
function runesInThisGame(session) {
  const gameId = session.gameId || 0;
  if (modeCheck.gameId !== gameId || !modeCheck.promise) {
    modeCheck = {
      gameId,
      promise: lcu.request('GET', '/lol-gameflow/v1/session')
        .then((gf) => {
          const mode = gf && gf.gameData && gf.gameData.queue && gf.gameData.queue.gameMode;
          log.info(`Champ select, game mode ${mode || 'unknown'}`);
          return !NO_RUNE_MODES.has(mode);
        })
        .catch(() => true),
    };
  }
  return modeCheck.promise;
}

let lastSession = null;
lcu.on('champSelect', async (session) => {
  lastSession = session;
  if (session && !(await runesInThisGame(session))) session = null;
  else if (session && lastSession !== session) return; // a newer update arrived while we waited
  if (session) refreshStaticIfStale();
  const mine = myChampion(session);
  if (!session || !mine) {
    clearTimeout(warnTimer);
    warned = false;
    setChampState({ inChampSelect: false, championKey: 0, locked: false });
    return;
  }
  scheduleWarning(session);
  setChampState({ inChampSelect: true, championKey: mine.championKey, locked: mine.locked, position: mine.position });
  maybeAutoApply();
});

// ---- IPC handlers used by the UI ----
function registerIpc() {
  handle('static:load', async () => {
    if (!staticData) await loadStaticInMain();
    if (!staticData) throw new Error('Could not load champion data. Check your internet connection and reopen RuneBook.');
    return staticData;
  });
  handle('rec:all', () => rec.pages);

  handle('pages:list', () => store.pages);
  handle('pages:save', (_e, page) => {
    const now = new Date().toISOString();
    const saved = { ...page, id: page.id || crypto.randomUUID(), updatedAt: now };
    if (saved.isDefault) {
      // Only one default page per champion.
      store.pages.forEach((p) => {
        if (p.championKey === saved.championKey && p.id !== saved.id) p.isDefault = false;
      });
    }
    const i = store.pages.findIndex((p) => p.id === saved.id);
    if (i >= 0) store.pages[i] = saved;
    else store.pages.push(saved);
    saveStore();
    send('pages:changed');
    if (clientOffer && pageSig(clientOffer) === pageSig(saved)) setOffer(null);
    return saved;
  });
  handle('pages:delete', (_e, id) => {
    store.pages = store.pages.filter((p) => p.id !== id);
    saveStore();
    send('pages:changed');
    return true;
  });

  handle('settings:get', () => store.settings);
  handle('settings:set', (_e, patch) => {
    store.settings = { ...store.settings, ...patch };
    saveStore();
    if ('startWithWindows' in patch) { applyStartWithWindows(); if (rebuildTrayMenu) rebuildTrayMenu(); }
    send('settings:changed', store.settings);
    return store.settings;
  });

  // ---- Bug reports ----
  // Errors from a window go to the log file.
  handle('log:error', (_e, text) => { log.error('[window]', String(text).slice(0, 2000)); });
  // Builds a report (what you wrote + versions + the end of the log), saves it next to the log and
  // opens a new GitHub issue with it, or, without a GitHub page, copies it and shows the file.
  handle('bug:report', (_e, description) => {
    const s = store.settings;
    const report = [
      String(description || '').slice(0, 4000),
      '',
      '---',
      `RuneBook ${app.getVersion()} (build ${BUILD_ID}), Electron ${process.versions.electron}, Windows ${os.release()}`,
      `League client: ${champState.connected ? 'connected' : 'not connected'}${champState.inChampSelect ? ', in champ select' : ''}`,
      `Patch data: ${staticData ? staticData.version : 'not loaded'}, saved pages: ${store.pages.length}`,
      `Settings: ${JSON.stringify({ autoApplyMode: s.autoApplyMode, editorStyle: s.editorStyle, warnSound: s.warnSound, warnSeconds: s.warnSeconds, warnRepeat: s.warnRepeat })}`,
      '',
      'Log:',
      log.tail(150),
    ].join('\n');
    const file = path.join(app.getPath('userData'), `bug-report-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    try { fs.writeFileSync(file, report); } catch {}
    log.info('Bug report saved:', file);
    let issues = '';
    try { issues = (JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).bugs || {}).url || ''; } catch {}
    if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/?$/.test(issues)) {
      // A URL has a size limit, so the issue gets the description and the short facts; the full log stays in the file.
      const title = String(description || 'Bug report').split('\n')[0].slice(0, 80);
      const body = report.split('\nLog:')[0] + '\n\n(The full report with the log is in ' + path.basename(file) + '; you can attach it here.)';
      shell.openExternal(`${issues.replace(/\/$/, '')}/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`);
      shell.showItemInFolder(file);
      return { via: 'github', file };
    }
    clipboard.writeText(report);
    shell.showItemInFolder(file);
    return { via: 'file', file };
  });

  handle('popup:fit', () => {}); // the picker has a fixed size now
  handle('popup:hide', () => closePopup());
  handle('popup:sticky', (_e, v) => { popupSticky = !!v; });
  handle('button:get', () => buttonState());
  // The button window is bigger than the button (room for the ripples); only the button itself takes clicks.
  handle('button:hover', (_e, over) => {
    if (button && !button.isDestroyed()) button.setIgnoreMouseEvents(!over, { forward: true });
  });
  // The picker is a fresh window each time, so it asks which page is in the client.
  handle('page:current', () => lastAppliedId);
  // Edit a page from the picker: open the editor window on it.
  handle('editor:open', (_e, pageId) => {
    closePopup();
    if (win && !win.isDestroyed()) {
      createWindow(); // shows and focuses it
      win.webContents.send('editor:edit', pageId);
    } else {
      pendingEdit = pageId;
      createWindow();
    }
  });
  handle('editor:pending', () => { const id = pendingEdit; pendingEdit = null; return id; });
  handle('button:click', () => {
    if (!buttonState().enabled) return;
    if (popup && !popup.isDestroyed()) closePopup();
    else openPopup();
  });

  handle('offer:get', () => clientOffer);
  handle('offer:dismiss', () => {
    if (clientOffer) dismissedOffers.add(pageSig(clientOffer));
    setOffer(null);
    return true;
  });
  // mode 'update' writes the client's runes over the page it was applied from; 'new' adds a page.
  handle('offer:save', (_e, championKey, mode) => {
    if (!clientOffer || !staticData) return null;
    const runes = {
      primaryStyleId: clientOffer.primaryStyleId, subStyleId: clientOffer.subStyleId,
      selectedPerkIds: clientOffer.selectedPerkIds, patch: staticData.version, updatedAt: new Date().toISOString(),
    };
    const target = mode === 'update' && clientOffer.editOf ? store.pages.find((p) => p.id === clientOffer.editOf) : null;
    let saved;
    if (target) {
      Object.assign(target, runes);
      if (target.nameAuto) target.name = autoNameFor(target);
      saved = target;
    } else {
      const c = staticData.champions.find((x) => x.key === championKey);
      if (!c) return null;
      const hasDefault = store.pages.some((p) => p.championKey === c.key && p.isDefault);
      saved = {
        id: crypto.randomUUID(), championKey: c.key, championId: c.id,
        name: autoNameFor(clientOffer), nameAuto: true, isDefault: !hasDefault, source: 'client', ...runes,
      };
      store.pages.push(saved);
    }
    lastAppliedId = saved.id; // it's the page in the client now
    saveStore();
    setOffer(null);
    send('pages:changed');
    send('page:applied', saved.id);
    return saved;
  });

  handle('lcu:state', () => champState);
  // perkIds: the runes you chose for a page with alternatives (optional).
  handle('lcu:apply', async (_e, pageId, replaceId, perkIds) => {
    const saved = store.pages.find((p) => p.id === pageId);
    if (!saved) return { error: 'Page not found' };
    const page = Array.isArray(perkIds) && perkIds.length === 9 ? { ...saved, selectedPerkIds: perkIds } : saved;
    if (pageProblem(page)) return { error: 'This page has runes that changed in a patch. Edit it first.' };
    try {
      const res = await lcu.applyPage(page, replaceId);
      if (res.ok) { lastAppliedId = saved.id; lastAppliedSig = pageSig(page); send('page:applied', saved.id); }
      return res;
    } catch (err) {
      return { error: err.message };
    }
  });
  handle('lcu:applyRaw', async (_e, page, replaceId) => {
    if (!page || pageProblem(page)) return { error: 'This page has runes that changed in a patch.' };
    try {
      return await lcu.applyPage(page, replaceId);
    } catch (err) {
      return { error: err.message };
    }
  });
  handle('lcu:recommended', async (_e, championKey) => {
    try {
      return await lcu.getRecommendedPages(championKey);
    } catch (err) {
      return { error: err.message };
    }
  });
  handle('lcu:currentPage', async () => {
    try {
      return await lcu.getCurrentPage();
    } catch (err) {
      return { error: err.message };
    }
  });
}

function createWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: '#0a0e13',
    title: 'RuneBook',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

// Start silently in the background when Windows starts.
function applyStartWithWindows() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: !!store.settings.startWithWindows,
    path: process.execPath,
    args: ['--background'],
  });
}

let rebuildTrayMenu = null;
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
  tray.setToolTip('RuneBook');
  const rebuild = rebuildTrayMenu = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open RuneBook', click: createWindow },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: !!store.settings.startWithWindows, click: (item) => {
      store.settings.startWithWindows = item.checked;
      saveStore();
      applyStartWithWindows();
    } },
    { label: 'Quit RuneBook', click: () => app.exit(0) },
  ]));
  rebuild();
  tray.on('click', createWindow);
}

// Champion and rune data, loaded once in the main process and shared with every window.
let staticPromise = null;
// RuneBook usually runs for days from the tray, so look for a new patch again when champ select starts.
let staticCheckedAt = Date.now();
function refreshStaticIfStale() {
  if (!staticData || Date.now() - staticCheckedAt < 3 * 3600 * 1000) return;
  staticCheckedAt = Date.now();
  loadStaticData(path.join(app.getPath('userData'), 'cache'))
    .then((data) => {
      if (data.version === staticData.version) return;
      log.info(`New patch data: ${data.version}`);
      staticData = data;
      preloadRecommended();
      send('static:updated');
    })
    .catch((err) => console.error('Refreshing static data failed:', err.message));
}

function loadStaticInMain() {
  if (!staticPromise) {
    staticPromise = loadStaticData(path.join(app.getPath('userData'), 'cache'))
      .then((data) => {
        staticData = data;
        seedFromRecommended();
        preloadRecommended();
      })
      .catch((err) => {
        console.error('Loading static data failed:', err.message);
        staticPromise = null; // try again next time a window asks
      });
  }
  return staticPromise;
}

// Identifies this build, so a newer RuneBook.exe can take over from an older one running in the background.
let BUILD_ID = app.getVersion();
try { BUILD_ID = JSON.parse(fs.readFileSync(path.join(__dirname, 'build.json'), 'utf8')).id || BUILD_ID; } catch {}

const lockData = { build: BUILD_ID, execPath: process.execPath };
const TAKEOVER = process.argv.includes('--takeover');

// Normally a second RuneBook.exe just hands its request to the running one and quits.
// After a takeover the old one may still be closing, so keep trying for a few seconds.
function getLock(triesLeft) {
  if (app.requestSingleInstanceLock(lockData)) return start();
  if (TAKEOVER && triesLeft > 0) return setTimeout(() => getLock(triesLeft - 1), 300);
  app.quit();
}
getLock(15);

function start() {
  app.on('second-instance', (_e, argv, _cwd, data) => {
    // A different RuneBook.exe (a new version, or a copy in another folder): hand over to it.
    if (data && data.execPath && (data.build !== BUILD_ID || data.execPath !== process.execPath)) {
      app.relaunch({ execPath: data.execPath, args: [...argv.slice(1).filter((x) => x !== '--takeover'), '--takeover'] });
      app.exit(0);
      return;
    }
    // Opening RuneBook.exe again while it runs in the background opens the editor.
    if (!argv.includes('--background')) createWindow();
  });

  // No window may open other windows, go to a website or ask for permissions.
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) e.preventDefault(); });
    wc.on('will-attach-webview', (e) => e.preventDefault());
  });
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    log.init(app.getPath('userData'));
    log.info(`RuneBook ${app.getVersion()} (build ${BUILD_ID}) started${BACKGROUND ? ' in the background' : ''} on Windows ${os.release()}`);
    loadStore();
    loadRecCache();
    registerIpc();
    applyStartWithWindows();
    createTray();
    if (!BACKGROUND) createWindow();
    loadStaticInMain();
    lcu.start();
  });

  // Closing the editor keeps RuneBook in the tray so the pick window still works.
  app.on('window-all-closed', () => {});
}

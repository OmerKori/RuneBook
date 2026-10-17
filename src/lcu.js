// Talks to the running League client (the local "LCU" API).
// league-connect finds the client process, reads its port + password and
// trusts Riot's self-signed certificate for us.
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { authenticate, createHttp1Request, createWebSocketConnection } = require('league-connect');

const PAGE_PREFIX = 'RuneBook';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function leagueRunning() {
  if (process.platform !== 'win32') return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq LeagueClientUx.exe', '/NH', '/FO', 'CSV'], { windowsHide: true },
      (err, out) => resolve(!err && /LeagueClientUx\.exe/i.test(out)));
  });
}

class Lcu extends EventEmitter {
  constructor() {
    super();
    this.credentials = null;
    this.ws = null;
    this.connected = false;
  }

  start() {
    this.connectLoop();
  }

  async connectLoop() {
    // league-connect looks for the client by starting PowerShell every few seconds. That's heavy for something
    // that waits in the tray all day, so first wait for the client with a cheap process check.
    while (!(await leagueRunning())) await sleep(5000);
    try {
      this.credentials = await authenticate({ awaitConnection: true, pollInterval: 3000 });
      this.ws = await createWebSocketConnection({
        authenticationOptions: { awaitConnection: true, pollInterval: 3000 },
        pollInterval: 2000,
        maxRetries: -1,
      });
    } catch (err) {
      console.error('LCU connect failed:', err && err.message);
      setTimeout(() => this.connectLoop(), 5000);
      return;
    }

    this.connected = true;
    this.emit('connection', true);

    this.ws.subscribe('/lol-champ-select/v1/session', (data, event) => {
      if (event && event.eventType === 'Delete') this.emit('champSelect', null);
      else this.emit('champSelect', data);
    });

    // The page the client is showing; fires when you create, edit or switch pages there.
    this.ws.subscribe('/lol-perks/v1/currentpage', (data, event) => {
      if (event && event.eventType !== 'Delete' && data) this.emit('currentPage', data);
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.ws = null;
      this.emit('connection', false);
      this.emit('champSelect', null);
      setTimeout(() => this.connectLoop(), 3000);
    });

    // If we connect while already in champ select, pick up the current state.
    try {
      const session = await this.request('GET', '/lol-champ-select/v1/session');
      this.emit('champSelect', session);
    } catch {}
  }

  async request(method, url, body) {
    if (!this.credentials) throw new Error('League client is not running.');
    const res = await createHttp1Request({ method, url, body }, this.credentials);
    const text = res.text();
    const json = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = (json && json.message) || text || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  // Riot's own recommended pages (the ones the client suggests in champ select).
  async getRecommendedPages(championKey, positions) {
    const list = positions && positions.length ? positions : ['NONE'];
    const lists = await Promise.all(
      list.map((pos) =>
        this.request('GET', `/lol-perks/v1/recommended-pages/champion/${championKey}/position/${pos}/map/11`)
          .catch(() => [])
      )
    );
    const seen = new Set();
    const pages = [];
    for (const l of lists) {
      for (const raw of Array.isArray(l) ? l : []) {
        const page = normalizeRecommended(raw);
        if (!page) continue;
        const sig = page.selectedPerkIds.join(',');
        if (seen.has(sig)) continue;
        seen.add(sig);
        pages.push(page);
      }
    }
    return pages;
  }

  // Recommended pages for every champion, a few requests at a time.
  // Returns { [championKey]: pages[] }.
  async getAllRecommended(championKeys, onProgress) {
    let positionsMap = {};
    try {
      positionsMap = (await this.request('GET', '/lol-perks/v1/recommended-champion-positions')) || {};
    } catch {}
    const result = {};
    let done = 0;
    const queue = [...championKeys];
    const worker = async () => {
      while (queue.length) {
        const key = queue.shift();
        const entry = positionsMap[key] || positionsMap[String(key)];
        const positions = entry && Array.isArray(entry.recommendedPositions) ? entry.recommendedPositions : [];
        try {
          result[key] = await this.getRecommendedPages(key, positions);
        } catch {
          result[key] = [];
        }
        done++;
        if (onProgress) onProgress(done, championKeys.length);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return result;
  }

  async getCurrentPage() {
    return this.request('GET', '/lol-perks/v1/currentpage');
  }

  // Writes a saved page into the client and makes it active.
  // RuneBook owns one client page (name starts with "RuneBook") and replaces it.
  // If there is no such page and no free slot, returns { needsReplace: [...] }
  // so the user can choose which of their pages to replace.
  async applyPage(page, replaceId) {
    const pages = await this.request('GET', '/lol-perks/v1/pages');
    const body = {
      name: `${PAGE_PREFIX}: ${page.name}`.slice(0, 40),
      primaryStyleId: page.primaryStyleId,
      subStyleId: page.subStyleId,
      selectedPerkIds: page.selectedPerkIds,
      current: true,
    };

    const ours = pages.find((p) => p.isDeletable && typeof p.name === 'string' && p.name.startsWith(PAGE_PREFIX));
    const toDelete = ours ? ours.id : replaceId;
    if (toDelete) {
      await this.request('DELETE', `/lol-perks/v1/pages/${toDelete}`);
      await this.request('POST', '/lol-perks/v1/pages', body);
      return { ok: true };
    }

    try {
      await this.request('POST', '/lol-perks/v1/pages', body);
      return { ok: true };
    } catch (err) {
      // No free slot: take over the page that is active now (or any editable one).
      // From then on it is named "RuneBook: ..." and reused, so this happens once.
      const deletable = pages.filter((p) => p.isDeletable);
      const target = deletable.find((p) => p.current) || deletable[0];
      if (!target) throw err;
      await this.request('DELETE', `/lol-perks/v1/pages/${target.id}`);
      await this.request('POST', '/lol-perks/v1/pages', body);
      return { ok: true };
    }
  }
}

const DEFAULT_SHARDS = [5008, 5008, 5011];

function normalizeRecommended(r) {
  if (!r) return null;
  let ids = (r.perks || r.selectedPerkIds || []).map((p) => (p && typeof p === 'object' ? p.id : p));
  ids = ids.filter((id) => typeof id === 'number');
  if (r.keystone && r.keystone.id && ids[0] !== r.keystone.id && !ids.includes(r.keystone.id)) ids.unshift(r.keystone.id);
  if (ids.length === 6) ids = [...ids, ...DEFAULT_SHARDS];
  const primaryStyleId = r.primaryPerkStyleId || r.primaryStyleId;
  const subStyleId = r.secondaryPerkStyleId || r.subStyleId;
  if (ids.length !== 9 || !primaryStyleId || !subStyleId) return null;
  return {
    position: r.position || '',
    isDefaultPosition: !!r.isDefaultPosition,
    primaryStyleId,
    subStyleId,
    selectedPerkIds: ids,
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// From a champ select session, returns { championKey, locked } for this player.
function myChampion(session) {
  if (!session || !Array.isArray(session.myTeam)) return null;
  const me = session.myTeam.find((p) => p.cellId === session.localPlayerCellId);
  if (!me) return null;
  const key = me.championId || me.championPickIntent || 0;
  // In draft modes championId is also set while hovering during your turn,
  // so "locked" means your pick action is completed.
  const actions = Array.isArray(session.actions) ? session.actions.flat() : [];
  const myPicks = actions.filter((a) => a.actorCellId === me.cellId && a.type === 'pick');
  const locked = myPicks.length ? myPicks.some((a) => a.completed) : me.championId > 0;
  return { championKey: key, locked, position: (me.assignedPosition || '').toUpperCase() };
}

module.exports = { Lcu, myChampion, PAGE_PREFIX };

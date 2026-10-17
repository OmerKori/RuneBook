// Downloads champion and rune data from Riot's Data Dragon once per patch
// and caches it in the app's user-data folder so later starts work offline.
const fs = require('fs');
const path = require('path');

const DDRAGON = 'https://ddragon.leagueoflegends.com';
const LOCALE = 'en_US';

// Stat shards are not part of Data Dragon's runesReforged.json.
// Rows as of the 2024+ shard layout (offense / flex / defense).
// Riot's file names for the two health shards are swapped: flat Health uses ...ScalingIcon and
// Health Scaling uses ...PlusIcon (that's how the client shows them).
const SHARD_INFO = {
  5008: { name: 'Adaptive Force', desc: '+9 Adaptive Force', icon: 'StatModsAdaptiveForceIcon', label: 'AF' },
  5005: { name: 'Attack Speed', desc: '+10% Attack Speed', icon: 'StatModsAttackSpeedIcon', label: 'AS' },
  5007: { name: 'Ability Haste', desc: '+8 Ability Haste', icon: 'StatModsCDRScalingIcon', label: 'AH' },
  5010: { name: 'Move Speed', desc: '+2% Move Speed', icon: 'StatModsMovementSpeedIcon', label: 'MS' },
  5001: { name: 'Health Scaling', desc: '+10-180 Health (based on level)', icon: 'StatModsHealthPlusIcon', label: 'HP+' },
  5011: { name: 'Health', desc: '+65 Health', icon: 'StatModsHealthScalingIcon', label: 'HP' },
  5013: { name: 'Tenacity and Slow Resist', desc: '+10% Tenacity and Slow Resist', icon: 'StatModsTenacityIcon', label: 'TEN' },
};
const SHARD_ROWS = [
  [5008, 5005, 5007],
  [5008, 5010, 5001],
  [5011, 5013, 5001],
];

function buildShards() {
  return SHARD_ROWS.map((row) =>
    row.map((id) => ({
      id,
      ...SHARD_INFO[id],
      icon: `${DDRAGON}/cdn/img/perk-images/StatMods/${SHARD_INFO[id].icon}.png`,
    }))
  );
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

async function download() {
  const versions = await getJson(`${DDRAGON}/api/versions.json`);
  const version = versions[0];
  const [champJson, styles] = await Promise.all([
    getJson(`${DDRAGON}/cdn/${version}/data/${LOCALE}/champion.json`),
    getJson(`${DDRAGON}/cdn/${version}/data/${LOCALE}/runesReforged.json`),
  ]);
  const champions = Object.values(champJson.data)
    .map((c) => ({
      id: c.id, // "MonkeyKing"
      key: Number(c.key), // numeric id the client uses, e.g. 62
      name: c.name, // "Wukong"
      tags: c.tags,
      image: `${DDRAGON}/cdn/${version}/img/champion/${c.image.full}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { version, champions, styles };
}

async function loadStaticData(cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, 'static-cache.json');
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {}

  let data = cached;
  try {
    const versions = await getJson(`${DDRAGON}/api/versions.json`);
    if (!cached || cached.version !== versions[0]) {
      data = await download();
      fs.writeFileSync(cacheFile, JSON.stringify(data));
    }
  } catch (err) {
    if (!cached) throw new Error(`Could not download rune data (${err.message}). Check your internet connection.`);
  }
  return { ...data, cdn: DDRAGON, shards: buildShards() };
}

module.exports = { loadStaticData };

// League of Legends: Riot Games API istemcisi ve maç zaman çizelgesinden öldürme olaylarını çıkarma.
// Riot ID (Ad#TAG) -> puuid (account-v1) -> maç listesi (match-v5) -> maç + zaman çizelgesi.
// Anahtar: RIOT_API_KEY (https://developer.riotgames.com). Testlerde RIOT_API_BASE ile sahte sunucu verilebilir.

const CLUSTERS = ['europe', 'americas', 'asia', 'sea'];

// Maç numarasının başındaki sunucu (TR1_123...) -> bölgesel küme
const PLATFORM_CLUSTER = {
  TR1: 'europe', EUW1: 'europe', EUN1: 'europe', RU: 'europe', ME1: 'europe',
  NA1: 'americas', BR1: 'americas', LA1: 'americas', LA2: 'americas',
  KR: 'asia', JP1: 'asia',
  OC1: 'sea', PH2: 'sea', SG2: 'sea', TH2: 'sea', TW2: 'sea', VN2: 'sea',
};
// Riot ID etiketinden tahmini küme (oyuncunun maçları hangi kümede aranacak)
const TAG_CLUSTER = {
  TR1: 'europe', TR: 'europe', EUW: 'europe', EUW1: 'europe', EUNE: 'europe', EUN1: 'europe', RU: 'europe', RU1: 'europe', ME1: 'europe',
  NA: 'americas', NA1: 'americas', BR: 'americas', BR1: 'americas', LAN: 'americas', LAS: 'americas', LA1: 'americas', LA2: 'americas',
  KR: 'asia', KR1: 'asia', JP: 'asia', JP1: 'asia',
  OCE: 'sea', OC1: 'sea', SG: 'sea', SG2: 'sea', PH: 'sea', PH2: 'sea', TH: 'sea', TH2: 'sea', TW: 'sea', TW2: 'sea', VN: 'sea', VN2: 'sea',
};
const QUEUES = {
  400: 'Normal (Seçmeli)', 420: 'Dereceli Tek/Çift', 430: 'Normal (Kapalı)', 440: 'Dereceli Esnek', 450: 'ARAM',
  480: 'Hızlı Oyun', 490: 'Hızlı Oyun', 700: 'Clash', 720: 'ARAM Clash', 830: 'Yapay Zekâya Karşı', 840: 'Yapay Zekâya Karşı',
  850: 'Yapay Zekâya Karşı', 900: 'ARURF', 1020: 'Hepsi Bir', 1300: 'Nexus Kuşatması', 1700: 'Arena', 1710: 'Arena', 1900: 'URF',
  2300: 'Brawl', 2400: 'ARAM: Kargaşa',
};

const DEFAULT_TAG = 'TR1';

// "Ad#TAG" -> { gameName, tagLine }; etiket yazılmamışsa TR1 varsayılır
function parseRiotId(input, defaultTag = DEFAULT_TAG) {
  const s = String(input || '').trim();
  const i = s.lastIndexOf('#');
  const gameName = (i >= 0 ? s.slice(0, i) : s).trim();
  const tagLine = (i >= 0 ? s.slice(i + 1) : defaultTag).trim() || defaultTag;
  return { gameName, tagLine };
}
const riotIdOf = (p) => `${p.riotIdGameName || p.gameName || '?'}#${p.riotIdTagline || p.tagLine || ''}`.replace(/#$/, '');

// Kick yayın diline göre tahmini Riot ID etiketleri (otomatik bulma için)
const LANG_TAGS = [
  ['Turkish', ['TR1']], ['Portuguese', ['BR1']], ['Spanish', ['LAN', 'LAS', 'EUW']], ['Polish', ['EUNE']],
  ['English', ['EUW', 'NA1']], ['German', ['EUW']], ['French', ['EUW']], ['Italian', ['EUW']], ['Russian', ['RU1']],
  ['Korean', ['KR1']], ['Japanese', ['JP1']], ['Arabic', ['ME1', 'EUW']], ['Greek', ['EUNE']], ['Czech', ['EUNE']],
];
function candidateRiotIds(username, slug, language) {
  const tags = (LANG_TAGS.find(([l]) => String(language || '').startsWith(l)) || [null, ['EUW', 'TR1']])[1];
  const bases = [];
  for (const b of [username, slug && slug.replace(/-/g, '_')]) if (b && b.length >= 3 && b.length <= 16 && !bases.some((x) => x.toLowerCase() === b.toLowerCase())) bases.push(b);
  return bases.flatMap((b) => tags.map((t) => `${b}#${t}`));
}

function extractLolEvents(match, timeline, puuid) {
  const parts = match.info.participants || [];
  const byId = new Map(parts.map((p) => [p.participantId, p]));
  // zaman çizelgesindeki katılımcı numaraları maçtakiyle aynı; yine de puuid üzerinden eşleştir
  for (const tp of timeline?.info?.participants || []) {
    const p = parts.find((x) => x.puuid === tp.puuid);
    if (p) byId.set(tp.participantId, p);
  }
  const me = [...byId.entries()].find(([, p]) => p.puuid === puuid)?.[0];
  if (me == null) return [];
  const start = match.info.gameStartTimestamp;
  const events = [];
  for (const frame of timeline?.info?.frames || []) {
    for (const e of frame.events || []) {
      if (e.type !== 'CHAMPION_KILL') continue;
      const killer = byId.get(e.killerId);
      const victim = byId.get(e.victimId);
      const time = new Date(start + e.timestamp).toISOString();
      const weapon = `${killer?.championName || 'Kule / minyon'} → ${victim?.championName || '?'}`;
      if (e.killerId === me && e.victimId !== me) {
        events.push({ type: 'kill', time, other: riotIdOf(victim || {}), otherPuuid: victim?.puuid || null, weapon });
      } else if (e.victimId === me) {
        events.push({ type: 'death', time, other: killer ? riotIdOf(killer) : 'Kule / minyon', otherPuuid: killer?.puuid || null, weapon });
      }
    }
  }
  return events.sort((a, b) => a.time.localeCompare(b.time));
}

function createLol({ apiKey, base, cached, httpError }) {
  const callLog = []; // dakikalık Riot çağrı sayısı (otomatik bulma kullanıcılara pay bırakmak için izler)
  const clusterOfPuuid = new Map();

  function callsLastMinute() {
    const t = Date.now() - 60_000;
    while (callLog.length && callLog[0] < t) callLog.shift();
    return callLog.length;
  }

  async function riot(cluster, path) {
    if (!apiKey) throw httpError(503, 'LoL için RIOT_API_KEY tanımlı değil.');
    callLog.push(Date.now());
    const url = base ? `${base}/${cluster}${path}` : `https://${cluster}.api.riotgames.com${path}`;
    const res = await fetch(url, { headers: { 'X-Riot-Token': apiKey, Accept: 'application/json' } });
    if (res.status === 404) throw httpError(404, 'Riot: bulunamadı.');
    if (res.status === 429) throw httpError(429, 'Riot istek limiti aşıldı. Biraz bekleyin.');
    if (res.status === 401 || res.status === 403) throw httpError(502, 'Riot API anahtarı geçersiz ya da süresi dolmuş.');
    if (res.status === 400) throw httpError(400, 'Riot: geçersiz istek.');
    if (!res.ok) throw httpError(502, `Riot API hatası: ${res.status}`);
    return res.json();
  }

  // Riot ID -> hesap (büyük/küçük harf duyarsız)
  async function account(riotId) {
    const { gameName, tagLine } = parseRiotId(riotId);
    if (!gameName) throw httpError(400, 'Riot ID gerekli (ör. Ad#TR1).');
    return cached(`lol:acc:${gameName.toLowerCase()}#${tagLine.toLowerCase()}`, 10 * 60_000, () =>
      riot('europe', `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`));
  }

  // Oyuncunun maçları: kümesi bilinmiyorsa etiketten tahmin edilenden başlayıp sırayla dene
  async function matchIds(puuid, tagLine, { startTime, count = 20 } = {}) {
    const known = clusterOfPuuid.get(puuid);
    const guess = TAG_CLUSTER[String(tagLine || '').toUpperCase()];
    const order = known ? [known] : [...new Set([guess, ...CLUSTERS].filter(Boolean))];
    const q = `?start=0&count=${count}` + (startTime ? `&startTime=${Math.floor(startTime / 1000)}` : '');
    for (const cluster of order) {
      const ids = await cached(`lol:ids:${cluster}:${puuid}:${q}`, 60_000, () => riot(cluster, `/lol/match/v5/matches/by-puuid/${puuid}/ids${q}`));
      if (ids.length) { clusterOfPuuid.set(puuid, cluster); return ids; }
    }
    return [];
  }

  const clusterOfMatch = (id) => PLATFORM_CLUSTER[String(id).split('_')[0].toUpperCase()] || 'europe';
  const match = (id) => cached(`lol:m:${id}`, 24 * 3600_000, () => riot(clusterOfMatch(id), `/lol/match/v5/matches/${id}`));
  const timeline = (id) => cached(`lol:t:${id}`, 3600_000, () => riot(clusterOfMatch(id), `/lol/match/v5/matches/${id}/timeline`));

  return { account, matchIds, match, timeline, callsLastMinute };
}

function lolSummary(id, m) {
  const a = m.info;
  return {
    id, createdAt: new Date(a.gameStartTimestamp || a.gameCreation).toISOString(), duration: a.gameDuration,
    map: QUEUES[a.queueId] || a.gameMode || 'LoL', mode: a.gameMode === 'CLASSIC' ? 'Sihirdar Vadisi' : (a.gameMode || ''),
  };
}

module.exports = { createLol, extractLolEvents, lolSummary, parseRiotId, riotIdOf, candidateRiotIds, TAG_CLUSTER };

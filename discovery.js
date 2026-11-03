// Otomatik yayıncı bulma
// 1. Kick'te şu an PUBG kategorisinde yayın yapan kanalları düzenli tara (aday kanallar).
// 2. Her aday için Kick kullanıcı adını / kanal adını PUBG'de ara (tek istekte 10 isim).
// 3. Aynı adlı PUBG hesabının yayın başladıktan sonra oynanmış bir maçı varsa eşleşme doğrulanmış sayılır
//    ve yayıncı kaydına "auto" olarak eklenir.
// PUBG oyuncu araması dakikada sınırlı olduğu için kullanıcı aramalarına her zaman pay bırakılır.

const VALID_NAME = /^[A-Za-z0-9_-]{3,16}$/;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Kick "2026-11-02 21:28:33" biçiminde UTC verir
const kickTime = (s) => new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z')).getTime();

function candidateNames(username, slug) {
  const out = [];
  for (const n of [username, slug, slug && slug.replace(/-/g, '_')]) if (n && VALID_NAME.test(n) && !out.includes(n)) out.push(n);
  return out;
}

function createDiscovery(opts) {
  const o = {
    kickBase: 'https://kick.com',
    category: 'pubg-battlegrounds',
    maxPages: 10,            // sayfa başına 24 yayın
    scanEveryMs: 10 * MINUTE,
    tickEveryMs: MINUTE,
    rpm: 10,                 // PUBG anahtarının dakikalık oyuncu araması limiti
    reserve: 4,              // bu kadarı kullanıcı aramalarına bırakılır
    recheckMs: 10 * MINUTE,  // eşleşme henüz doğrulanamadıysa tekrar bakma aralığı
    giveUpAfterLiveMs: 2 * HOUR, // yayın bu kadar sürdüğü halde maç yoksa vazgeç
    retryNotFoundMs: 7 * DAY,
    retryNoMatchMs: 3 * DAY,
    log: (...a) => console.log('[keşif]', ...a),
    ...opts,
  };
  // Gerekli: o.store ({get,set}), o.pubgPlayers(names) -> [{name, id, matchIds}], o.matchCreatedAt(id) -> ms,
  //          o.isMapped(slug), o.addStreamer(entry) (async olabilir), o.lookupsLastMinute()
  // İsteğe bağlı: o.liveTtlMs — son taramadan bu kadar süre sonra "canlı" bilgisi bayat sayılır

  let state = { candidates: {}, live: {}, lastScan: 0, lastError: null };
  let live = new Map(); // slug -> { start, viewers } (son taramada canlı olanlar)
  let loadedAt = 0;
  let running = false;
  let timer = null;
  let pauseUntil = 0;

  // Durum kalıcı depoda tutulur; sunucusuz ortamda her istek ayrı örnekte çalışabileceği için
  // "şu an canlı" bilgisi de kaydedilir.
  async function load() {
    const s = await o.store.get('discovery', null);
    state = { candidates: s?.candidates || {}, live: s?.live || {}, lastScan: s?.lastScan || 0, lastScanCount: s?.lastScanCount || 0, lastError: s?.lastError || null };
    const fresh = Date.now() - state.lastScan < (o.liveTtlMs || 2 * o.scanEveryMs);
    live = new Map(fresh ? Object.entries(state.live) : []);
    loadedAt = Date.now();
  }
  async function ensureLoaded(maxAgeMs = Infinity) {
    if (!loadedAt || Date.now() - loadedAt > maxAgeMs) await load();
  }
  async function save() {
    state.live = Object.fromEntries([...live].map(([slug, l]) => [slug, { start: l.start, viewers: l.viewers }]));
    await o.store.set('discovery', state);
  }

  // --- 1. Kick taraması ---
  async function scan() {
    const seen = new Map();
    for (let page = 1; page <= o.maxPages; page++) {
      const url = `${o.kickBase}/stream/livestreams/all?page=${page}&limit=24&subcategory=${o.category}&sort=desc`;
      const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (KickReport)' } });
      if (!res.ok) throw new Error(`Kick listesi alınamadı (${res.status})`);
      const body = await res.json();
      for (const s of body.data || []) {
        const slug = s.channel?.slug;
        if (!slug || s.is_live === false) continue;
        seen.set(slug, {
          start: kickTime(s.start_time || s.created_at), viewers: s.viewer_count ?? s.viewers ?? 0,
          title: s.session_title || '', language: s.language || '',
          username: s.channel?.user?.username || slug, avatar: s.channel?.user?.profilepic || null,
        });
      }
      if (!body.next_page_url || !(body.data || []).length) break;
    }
    live = seen;
    const now = Date.now();
    for (const [slug, l] of seen) {
      let c = state.candidates[slug];
      if (!c) c = state.candidates[slug] = { slug, firstSeen: now, status: 'pending', tried: [] };
      c.username = l.username;
      c.avatar = l.avatar;
      c.language = l.language;
      c.lastSeen = now;
      c.lastStart = l.start;
      c.names = candidateNames(l.username, slug);
    }
    state.lastScan = now;
    state.lastScanCount = seen.size;
  }

  // --- 2-3. PUBG eşleştirme ---
  function due(c, now) {
    if (!live.has(c.slug)) return false;
    if (o.isMapped(c.slug)) { if (c.status !== 'linked') c.status = 'linked'; return false; }
    if (c.status === 'rejected' || c.status === 'linked') return false;
    if ((c.status === 'notfound' || c.status === 'nomatch') && (c.retryAt || 0) <= now) {
      c.status = 'pending'; c.tried = []; delete c.pubgName;
    }
    return c.status === 'pending' && (c.nextCheck || 0) <= now;
  }

  // Bir aday için bu turda sorulacak isim: doğrulanmayı bekleyen PUBG adı ya da henüz denenmemiş ilk isim
  function nextName(c) {
    if (c.pubgName) return c.pubgName;
    return (c.names || []).find((n) => !c.tried.includes(n)) || null;
  }

  async function verify(c, player, now) {
    const start = live.get(c.slug)?.start ?? c.lastStart;
    for (const id of (player.matchIds || []).slice(0, 5)) {
      let t;
      try { t = await o.matchCreatedAt(id); } catch { continue; }
      if (t >= start - 2 * MINUTE && t <= now + MINUTE) {
        c.status = 'linked';
        c.pubgName = player.name;
        c.linkedAt = now;
        await o.addStreamer({ pubgName: player.name, shard: 'steam', kick: c.slug, source: 'auto', avatar: c.avatar || null, verifiedAt: new Date(now).toISOString() });
        o.log(`eşleşti: kick.com/${c.slug} -> ${player.name}`);
        return;
      }
    }
    // Yayın sırasında maç yok: yayın yeni başladıysa sonra tekrar bak, uzun süredir sürüyorsa vazgeç
    c.pubgName = player.name;
    if (now - start > o.giveUpAfterLiveMs) {
      c.status = 'nomatch';
      c.retryAt = now + o.retryNoMatchMs;
    } else {
      c.nextCheck = now + o.recheckMs;
    }
  }

  async function lookups() {
    const now = Date.now();
    if (now < pauseUntil) return;
    const pending = Object.values(state.candidates).filter((c) => due(c, now));
    // çok izlenen yayınlar önce
    pending.sort((a, b) => (live.get(b.slug)?.viewers || 0) - (live.get(a.slug)?.viewers || 0));

    while (pending.length) {
      const budget = o.rpm - o.reserve - o.lookupsLastMinute();
      if (budget <= 0) return;
      // 10 isimlik bir paket hazırla (her adaydan bir isim)
      const batch = [];
      while (pending.length && batch.length < 10) {
        const c = pending.shift();
        const name = nextName(c);
        if (!name) { c.status = 'notfound'; c.retryAt = now + o.retryNotFoundMs; continue; }
        if (!batch.some((b) => b.name === name)) batch.push({ c, name });
      }
      if (!batch.length) return;

      let players;
      try {
        players = await o.pubgPlayers(batch.map((b) => b.name));
      } catch (e) {
        if (e.status === 429) { pauseUntil = Date.now() + MINUTE; o.log('PUBG limiti doldu, 1 dk bekleniyor'); }
        else if (e.status === 400) batch.forEach((b) => { b.c.tried.push(b.name); }); // geçersiz isim içeren paket
        else { state.lastError = e.message; o.log('PUBG hatası:', e.message); }
        return;
      }
      const byName = new Map(players.map((p) => [p.name, p]));
      for (const { c, name } of batch) {
        const p = byName.get(name);
        if (!p) {
          if (c.pubgName === name) delete c.pubgName; // ad değişmiş olabilir
          c.tried.push(name);
          if (!nextName(c)) { c.status = 'notfound'; c.retryAt = now + o.retryNotFoundMs; }
          else pending.push(c); // sıradaki isimle tekrar dene
          continue;
        }
        await verify(c, p, Date.now());
      }
    }
  }

  // reload: true -> durumu depodan yeniden oku (sunucusuz ortamda başka örnek yazmış olabilir)
  async function tick({ reload = false } = {}) {
    if (running) return;
    running = true;
    try {
      await ensureLoaded(reload ? 0 : Infinity);
      if (Date.now() - state.lastScan >= o.scanEveryMs || !live.size) {
        try { await scan(); state.lastError = null; } catch (e) { state.lastError = e.message; o.log(e.message); }
      }
      await lookups();
    } catch (e) {
      state.lastError = e.message;
      o.log('hata:', e.message);
    } finally {
      running = false;
      try { await save(); } catch (e) { o.log('kaydedilemedi:', e.message); }
    }
  }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, o.tickEveryMs);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }

  // Kullanıcı otomatik bir eşleşmeyi silerse tekrar eklenmesin
  async function reject(slug) {
    await ensureLoaded(0);
    const c = state.candidates[slug];
    if (c) { c.status = 'rejected'; await save(); }
  }

  async function status(maxAgeMs = Infinity) {
    await ensureLoaded(maxAgeMs);
    const list = Object.values(state.candidates);
    const count = (s) => list.filter((c) => c.status === s).length;
    return {
      lastScan: state.lastScan ? new Date(state.lastScan).toISOString() : null,
      liveNow: live.size,
      lastError: state.lastError,
      totals: { candidates: list.length, linked: count('linked'), pending: count('pending'), notfound: count('notfound'), nomatch: count('nomatch') },
      // elle eşleştirme için: PUBG adı bulunamayan kanallar
      unmatched: list
        .filter((c) => c.status === 'notfound' || c.status === 'nomatch')
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
        .slice(0, 50)
        .map((c) => ({ slug: c.slug, username: c.username, avatar: c.avatar, status: c.status, tried: c.tried, pubgName: c.pubgName || null, live: live.has(c.slug) })),
    };
  }

  return { start, stop, tick, scan, lookups, reject, status, ensureLoaded, isLive: (slug) => live.has(slug), _state: () => state };
}

module.exports = { createDiscovery, candidateNames };

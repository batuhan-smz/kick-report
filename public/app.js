// Kick Report — istemci (tek sayfalık uygulama)
// Sayfalar:  /                       PUBG ana sayfa      /lol                  LoL ana sayfa
//            /players/steam/:ad      PUBG oyuncusu       /lol/players/:riotId  LoL oyuncusu (Ad#TAG)
//            /streamers              yayıncı kaydı (yönetici, menüde yok)
// Akış: oyuncunun maçları (sunucu) -> her maçta oynayan kayıtlı yayıncılar (sunucu)
//       -> o yayıncıların Kick VOD listeleri (doğrudan tarayıcı) -> maçı VOD ile zaman üzerinden eşleştir
//       -> eşleşen maçların öldürme olaylarını çek -> her (olay × yayın) bir video kartı.
// Oyuna özel her şey aşağıdaki GAMES yapılandırmasında; geri kalan kod iki oyunda ortak.

const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
const DEMO = query.has('demo');
const SUFFIX = DEMO ? '?demo=1' : '';

const LABELS = { kill: 'Öldürme', knock: 'Düşürme', death: 'Ölüm', knocked: 'Düştü', start: 'Maç başı' };
const ROLE_LABEL = { own: 'Kendi yayını', enemy: 'Rakip tepkisi', other: 'Aynı maç' };
const MATCH_GRACE_MS = 60_000; // VOD sınırlarında küçük tolerans

let hls = null;
let currentSrc = null;
let modalList = [];   // modalda gezinilebilen kartlar
let modalIndex = -1;
let runId = 0;        // eski aramaların sonuçları yeni sayfayı ezmesin
const vodCache = new Map();     // kick kanalı -> Promise<vod[]>
const channelCache = new Map(); // kick kanalı -> Promise<{avatar, live}>
const clipCache = new Map();    // kick kanalı -> { clips, cursor, done, oldest, pages, chain }
const CLIP_MAX_PAGES = 15;      // kanal başına en fazla 15 × 20 klip taranır
const streamersByGame = { pubg: [], lol: [] };

// ---------- yardımcılar ----------
const fmtClock = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(s).padStart(2, '0');
};
const fmtDate = (d) => d.toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const rtf = new Intl.RelativeTimeFormat('tr', { numeric: 'auto' });
function timeAgo(d) {
  const s = (d - Date.now()) / 1000;
  for (const [unit, n] of [['day', 86400], ['hour', 3600], ['minute', 60]]) if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), unit);
  return 'az önce';
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const initial = (s) => esc((s || '?').trim().charAt(0).toUpperCase());
// Kick "2026-11-02 21:28:33" biçiminde UTC verir
const kickTime = (s) => new Date(s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z'));
const lolId = (s) => { s = String(s || '').trim(); return s.includes('#') ? s : `${s}#TR1`; }; // etiket yoksa TR1

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `İstek başarısız (${res.status})`), { status: res.status });
  return body;
}

// Aynı anda en fazla n istek
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k).catch((e) => ({ error: e.message })); }
  }));
  return out;
}

function memo(map, key, fn) {
  if (!map.has(key)) {
    const p = fn();
    p.catch(() => map.delete(key)); // hata olursa sonra tekrar dene
    map.set(key, p);
  }
  return map.get(key);
}

// ---------- oyunlar ----------
const GAMES = {
  pubg: {
    id: 'pubg', label: 'PUBG', home: '/',
    clips: true, // abonelere özel kayıtlarda o anı kapsayan klipler aranır
    heroTitle: 'Seni öldüren yayıncı <span>o an</span> ne dedi?',
    heroText: 'PUBG oyuncu adını yaz. Son iki haftada maçlarında karşılaştığın Kick yayıncılarının kayıtları tam o saniyeden açılsın.',
    placeholder: 'PUBG oyuncu adı, ör. F1ZYY_T (büyük/küçük harf önemli)',
    topPlaceholder: 'PUBG oyuncusu ara…',
    recentKey: 'kr_recent',
    streamersApi: '/api/streamers',
    discoveryApi: '/api/discovery',
    accountLabel: 'PUBG adı', accountPlaceholder: 'örn. chocoTaco',
    playerPath: (name) => `/players/steam/${encodeURIComponent(name)}`,
    normalize: (name) => name.trim(),
    streamerName: (s) => s.pubgName,
    streamerKey: (s) => s.pubgName.toLowerCase(),
    deleteUrl: (s) => `/api/streamers/${encodeURIComponent(s.pubgName)}`,
    addBody: (account, kick) => ({ pubgName: account, shard: 'steam', kick }),
    fetchPlayer: async (name) => {
      const p = await getJSON(`/api/pubg/steam/player/${encodeURIComponent(name)}`);
      return { name: p.name, key: p.name.toLowerCase(), matchIds: p.matchIds };
    },
    fetchMatch: (id) => getJSON(`/api/pubg/steam/match/${id}`),
    fetchEvents: async (m, player) => {
      const full = await getJSON(`/api/pubg/steam/match/${m.id}/events?player=${encodeURIComponent(player.name)}`);
      m.events = full.events;
      m.placement = full.placement;
    },
    otherKey: (ev) => String(ev.other || '').toLowerCase(),
    matchBadge: (m) => (m.placement ? `<span class="place ${m.placement === 1 ? 'win' : ''}">#${m.placement}</span>` : ''),
    filters: { all: 'Tümü', kill: 'Öldürmeler', knock: 'Düşürmeler', death: 'Ölümler' },
    loadingMatches: 'PUBG maçları alınıyor…',
    loadingEvents: 'Telemetri işleniyor…',
    noMatches: 'Son 14 günde maç bulunamadı.',
    noEvents: 'Bu maçta öldürme/düşürme yok.',
    emptyStreamers: 'Henüz yayıncı yok. Otomatik bulma, Kick\'te PUBG yayını yapan kanalları birkaç dakika içinde eklemeye başlar.',
  },
  lol: {
    id: 'lol', label: 'LoL', home: '/lol',
    heroTitle: 'Seni öldüren yayıncı <span>o an</span> ne dedi?',
    heroText: 'Riot ID\'ni yaz (Ad#TR1). Son maçlarında karşılaştığın Kick yayıncılarının kayıtları tam o saniyeden açılsın.',
    placeholder: 'Riot ID, örn. Ad#TR1 (etiket yoksa TR1 sayılır)',
    topPlaceholder: 'Riot ID ara (Ad#TR1)…',
    recentKey: 'kr_recent_lol',
    streamersApi: '/api/lol/streamers',
    discoveryApi: '/api/lol/discovery',
    accountLabel: 'Riot ID', accountPlaceholder: 'örn. Ad#TR1',
    playerPath: (name) => `/lol/players/${encodeURIComponent(name)}`,
    normalize: lolId,
    streamerName: (s) => s.riotId,
    streamerKey: (s) => s.puuid,
    deleteUrl: (s) => `/api/lol/streamers/${encodeURIComponent(s.puuid)}`,
    addBody: (account, kick) => ({ riotId: lolId(account), kick }),
    fetchPlayer: async (name) => {
      const p = await getJSON(`/api/lol/player/${encodeURIComponent(name)}`);
      return { name: p.name, key: p.puuid, puuid: p.puuid, matchIds: p.matchIds };
    },
    fetchMatch: (id) => getJSON(`/api/lol/match/${encodeURIComponent(id)}`),
    fetchEvents: async (m, player) => {
      const full = await getJSON(`/api/lol/match/${encodeURIComponent(m.id)}/events?puuid=${encodeURIComponent(player.puuid)}`);
      m.events = full.events;
      m.result = full.result;
      if (full.champion) m.mode = `${full.champion} · ${full.kda}`;
    },
    otherKey: (ev) => ev.otherPuuid,
    matchBadge: (m) => (m.result ? `<span class="place ${m.result === 'win' ? 'win' : 'loss'}">${m.result === 'win' ? 'Zafer' : 'Yenilgi'}</span>` : ''),
    filters: { all: 'Tümü', kill: 'Öldürmeler', death: 'Ölümler' },
    loadingMatches: 'LoL maçları alınıyor…',
    loadingEvents: 'Maç zaman çizelgeleri işleniyor…',
    noMatches: 'Son maç bulunamadı.',
    noEvents: 'Bu maçta öldürme/ölüm yok.',
    emptyStreamers: 'Henüz LoL yayıncısı yok. Otomatik bulma, Kick\'te LoL yayını yapan kanalları zamanla ekler; yönetici sayfasından elle de eklenebilir.',
  },
};
const gameOfPath = () => (location.pathname === '/lol' || location.pathname.startsWith('/lol/') ? GAMES.lol : GAMES.pubg);

// ---------- veri kaynakları ----------
function getKickVods(slug) {
  return memo(vodCache, slug, async () => {
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/videos`);
    if (res.status === 404) throw new Error(`Kick kanalı bulunamadı: ${slug}`);
    if (!res.ok) throw new Error(`Kick videoları alınamadı: ${slug} (${res.status})`);
    const list = await res.json();
    // Abonelere özel kayıtlar (video.status = "subscriber_only") listede adressiz gelir. Atlanmaz,
    // "kilitli" olarak tutulur: o kayıttaki anlar için aynı yayından alınmış klipler aranır.
    return list
      .filter((v) => v.start_time && (v.source || v.video?.status === 'subscriber_only' || v.video?.is_private))
      .map((v) => {
        const start = kickTime(v.start_time);
        const end = v.is_live || !v.duration ? new Date() : new Date(start.getTime() + v.duration);
        const thumb = v.thumbnail?.src || v.thumbnail?.url || v.video?.thumb || null;
        return { id: String(v.id ?? v.video?.live_stream_id ?? ''), start, end, src: v.source || null, locked: !v.source,
          title: v.session_title, uuid: v.video?.uuid, live: v.is_live, thumb };
      });
  });
}

// Yayıncı profil resmi ve canlı durumu (olmazsa sorun değil)
function getKickChannel(slug) {
  return memo(channelCache, slug, async () => {
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error('kanal bilgisi yok');
    const c = await res.json();
    return { avatar: c.user?.profile_pic || null, live: !!c.livestream, viewers: c.livestream?.viewer_count ?? null };
  });
}

function findVod(vods, date) {
  const t = date.getTime();
  const hits = vods.filter((v) => t >= v.start.getTime() - MATCH_GRACE_MS && t <= v.end.getTime() + MATCH_GRACE_MS);
  return hits.find((v) => !v.locked) || hits[0] || null;
}

// Kanalın klipleri, en yeniden eskiye. sinceMs'den önce oluşturulan kliplere ulaşana kadar sayfa çekilir;
// daha sonra daha eski bir an gerekirse kalan sayfalardan devam edilir.
function getKickClips(slug, sinceMs) {
  let e = clipCache.get(slug);
  if (!e) clipCache.set(slug, (e = { clips: [], cursor: null, done: false, oldest: Infinity, pages: 0, chain: Promise.resolve() }));
  e.chain = e.chain.then(async () => {
    while (!e.done && e.oldest > sinceMs && e.pages < CLIP_MAX_PAGES) {
      const q = new URLSearchParams({ sort: 'date', time: 'all' });
      if (e.cursor) q.set('cursor', e.cursor);
      const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/clips?${q}`);
      if (!res.ok) throw new Error(`Kick klipleri alınamadı: ${slug} (${res.status})`);
      const j = await res.json();
      e.pages++;
      for (const c of j.clips || []) {
        const created = Date.parse(c.created_at);
        e.oldest = Math.min(e.oldest, created);
        const src = c.video_url || c.clip_url;
        if (!src) continue;
        e.clips.push({ id: c.id, livestreamId: String(c.livestream_id ?? ''), created, duration: c.duration || 0,
          src, thumb: c.thumbnail_url || null, title: c.title || '' });
      }
      e.cursor = j.nextCursor || null;
      if (!e.cursor || !(j.clips || []).length) e.done = true;
    }
    return e.clips;
  }).catch(() => e.clips); // hata sonraki çağrıları kilitlemesin; elde olanla devam
  return e.chain;
}

// Klibin kapsadığı gerçek saat aralığı: klip listesindeki segment saatlerinden (#EXT-X-PROGRAM-DATE-TIME)
async function clipRange(clip) {
  const segs = await getTimeline({ src: clip.src });
  if (!segs.length || segs[0].pdt == null) return null;
  const last = segs[segs.length - 1];
  return { start: segs[0].pdt, end: last.pdt + last.dur * 1000 };
}

// Abonelere özel kayıtta kalan birebir anlar için aynı yayından alınmış, o anı kapsayan klibi bul.
// Bulunan klip m.clips'e "kanal|olay sırası" anahtarıyla yazılır; kartlar oradan oluşur.
async function attachClips(G, matches, player) {
  const need = [];
  for (const m of matches) {
    m.clips = new Map();
    (m.events || []).forEach((ev, i) => {
      for (const st of m.streams || []) {
        if (st.vod.locked && roleOf(G, st, player, ev) !== 'other') need.push({ m, st, ev, i, t: Date.parse(ev.time) });
      }
    });
  }
  if (!G.clips || !need.length) return;
  const since = new Map();
  for (const n of need) since.set(n.st.streamer.kick, Math.min(since.get(n.st.streamer.kick) ?? Infinity, n.t - 60_000));
  const bySlug = new Map();
  await pool([...since], 3, async ([slug, t]) => bySlug.set(slug, await getKickClips(slug, t)));
  const ranges = new Map(); // klip id -> Promise<aralık>
  const rangeOf = (c) => memo(ranges, c.id, () => clipRange(c));
  await pool(need, 4, async (n) => {
    // Klip ancak o an yaşandıktan sonra oluşturulabilir ve aynı yayından olmalı
    const cands = (bySlug.get(n.st.streamer.kick) || []).filter((c) => c.livestreamId === n.st.vod.id && c.created >= n.t - 5000);
    let best = null;
    for (const c of cands) {
      const r = await rangeOf(c).catch(() => null);
      // olay klibin içinde olmalı (2 sn tolerans); birden fazla varsa olaydan önce en çok görüntü veren
      if (r && n.t >= r.start - 2000 && n.t <= r.end && (!best || r.start < best.range.start)) best = { c, range: r };
    }
    if (best) {
      n.m.clips.set(`${n.st.streamer.kick}|${n.i}`, {
        id: n.st.vod.id, src: best.c.src, thumb: best.c.thumb || n.st.vod.thumb, start: new Date(best.range.start),
        end: new Date(best.range.end), clip: true, clipId: best.c.id, title: best.c.title, live: false,
      });
    }
  });
}

async function loadStreamers(G) {
  try { streamersByGame[G.id] = await getJSON(G.streamersApi); } catch { streamersByGame[G.id] = []; }
  return streamersByGame[G.id];
}

// Demo (sadece PUBG): ilk kayıtlı yayıncının gerçek Kick VOD'u, sahte maçlar
function demoMatches(vods, streamer) {
  const open = vods.filter((x) => !x.locked);
  const v = open.find((x) => !x.live && x.end - x.start > 3 * 3600_000) || open[0];
  if (!v) return [];
  const names = ['ShroudFan', 'xX_Sniper_Xx', 'kebapci42', 'TurkishPan', 'LootGoblin', 'Ryuuu'];
  const weapons = ['M416', 'Kar98k', 'Beryl M762', 'Mini14', 'UMP45', 'Pan'];
  return [40, 75, 120].map((min, mi) => {
    const created = new Date(v.start.getTime() + min * 60_000);
    const types = mi === 2 ? ['knock', 'kill', 'knocked', 'death'] : ['knock', 'kill', 'kill', 'knock', 'kill'];
    return {
      id: 'demo-' + mi, createdAt: created.toISOString(), duration: 1700, placement: [3, 1, 12][mi],
      map: ['Erangel', 'Miramar', 'Taego'][mi], mode: 'squad-fpp',
      streams: [{ streamer, vod: v }],
      events: types.map((type, i) => ({
        type, other: names[(i + mi) % names.length], weapon: weapons[(i * 2 + mi) % weapons.length],
        distance: 20 + ((i * 97 + mi * 41) % 280),
        time: new Date(created.getTime() + (180 + i * 190) * 1000).toISOString(),
      })),
    };
  });
}

// ---------- yönlendirme ----------
function navigate(path) {
  history.pushState(null, '', path + SUFFIX);
  route();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', route);

function route() {
  closeModal();
  runId++;
  const parts = location.pathname.split('/').filter(Boolean);
  const admin = parts[0] === 'streamers';
  const G = gameOfPath();
  // menü: hangi oyundayız
  document.querySelectorAll('.game-nav a').forEach((a) => a.classList.toggle('on', !admin && a.dataset.game === G.id));
  const isHome = !parts.length || (parts.length === 1 && parts[0] === 'lol');
  $('topSearch').hidden = isHome || admin;
  $('topSearch').elements.name.placeholder = G.topPlaceholder;
  bindSearch($('topSearch'), G);
  window.scrollTo(0, 0);
  if (parts[0] === 'players' && parts[2]) return playerPage(GAMES.pubg, decodeURIComponent(parts[2]));
  if (parts[0] === 'lol' && parts[1] === 'players' && parts[2]) return playerPage(GAMES.lol, decodeURIComponent(parts[2]));
  if (admin) return streamersPage();
  return homePage(G);
}

function bindSearch(form, G) {
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = G.normalize(form.elements.name.value);
    if (name && name !== '#TR1') navigate(G.playerPath(name));
  };
}

// ---------- yayıncı kartları ----------
function avatarHTML(s) {
  // otomatik bulunan yayıncıların profil resmi ve canlı durumu sunucudan gelir
  if (s.avatar) return `<span class="avatar${s.live ? ' live' : ''}"><img src="${esc(s.avatar)}" alt="" loading="lazy"></span>`;
  return `<span class="avatar${s.live ? ' live' : ''}" data-avatar="${esc(s.kick)}">${initial(s.kick)}</span>`;
}
// Profil resmi bilinmeyen (elle eklenen) yayıncılar için Kick'ten sonradan doldur
function hydrateAvatars(root) {
  const slugs = [...new Set([...root.querySelectorAll('[data-avatar]')].map((el) => el.dataset.avatar))].slice(0, 30);
  for (const slug of slugs) {
    getKickChannel(slug).then((c) => {
      root.querySelectorAll(`[data-avatar="${CSS.escape(slug)}"]`).forEach((el) => {
        if (c.avatar) el.innerHTML = `<img src="${esc(c.avatar)}" alt="" loading="lazy">`;
        el.classList.toggle('live', c.live);
      });
      root.querySelectorAll(`[data-live="${CSS.escape(slug)}"]`).forEach((el) => {
        el.hidden = !c.live;
        if (c.live && c.viewers != null) el.textContent = `CANLI · ${c.viewers}`;
      });
    }).catch(() => {});
  }
}

function streamerCard(s, G) {
  return `<a class="streamer-card" href="${G.playerPath(G.streamerName(s))}" data-link>
    ${avatarHTML(s)}
    <span class="sc-text"><b>${esc(s.kick)}</b><small>${esc(G.streamerName(s))}</small></span>
    <span class="live-pill" data-live="${esc(s.kick)}" ${s.live ? '' : 'hidden'}>${s.live && s.viewers != null ? `CANLI · ${s.viewers}` : 'CANLI'}</span>
  </a>`;
}

const sourceBadge = (s, G) => s.source === 'auto'
  ? `<span class="src auto" title="Kick'te ${G.label} yayını sırasında oynanan maçla doğrulandı">otomatik</span>`
  : '<span class="src manual">elle</span>';

function discoveryText(d, G) {
  if (!d.enabled) return G.id === 'lol' ? 'LoL otomatik bulma kapalı (RIOT_API_KEY tanımlı değil).' : 'Otomatik bulma kapalı.';
  const t = d.totals;
  const when = d.lastScan ? timeAgo(new Date(d.lastScan)) : 'henüz yapılmadı';
  return `Kick'te şu an <b>${d.liveNow}</b> canlı ${G.label} yayını var. Son tarama: ${when}. ` +
    `Bugüne kadar <b>${t.candidates}</b> kanal görüldü: <b>${t.linked}</b> eşleşti, ${t.pending} kontrol bekliyor, ` +
    `${t.notfound + t.nomatch} kanalın ${G.accountLabel} bulunamadı.` + (d.lastError ? ` <span class="err">Son hata: ${esc(d.lastError)}</span>` : '');
}

// ---------- son görüntülenenler ----------
// Her ziyaretçinin kendi tarayıcısında tutulur (localStorage), her oyun için ayrı; erişilemezse sessizce boş kalır.
const RECENT_MAX = 8;
function getRecent(G) {
  try { const list = JSON.parse(localStorage.getItem(G.recentKey) || '[]'); return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
function setRecent(G, list) {
  try { localStorage.setItem(G.recentKey, JSON.stringify(list.slice(0, RECENT_MAX))); } catch { /* gizli pencere vb. */ }
}
function addRecent(G, name) {
  setRecent(G, [name, ...getRecent(G).filter((x) => !same(x, name))]);
}
function drawRecent(G) {
  const box = $('recent');
  if (!box) return;
  const list = getRecent(G);
  box.hidden = !list.length;
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="recent-head"><span>Son görüntülenenler</span><button type="button" class="link-btn" data-clear>Temizle</button></div>
    <div class="recent-list">${list.map((n) => `<span class="recent-chip"><a href="${G.playerPath(n)}" data-link>${esc(n)}</a><button type="button" aria-label="${esc(n)} listeden kaldır" data-remove="${esc(n)}">✕</button></span>`).join('')}</div>`;
  box.onclick = (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) { setRecent(G, getRecent(G).filter((x) => x !== rm.dataset.remove)); drawRecent(G); }
    if (e.target.closest('[data-clear]')) { setRecent(G, []); drawRecent(G); }
  };
}

// ---------- ana sayfa ----------
async function homePage(G) {
  document.title = G.id === 'lol' ? 'LoL · Kick Report' : 'Kick Report | PUBG ve LoL anlarını Kick yayınından izle';
  const app = $('app');
  app.innerHTML = `
    <section class="hero">
      <h1>${G.heroTitle}</h1>
      <p>${G.heroText}</p>
      <form id="heroSearch" class="search big">
        <input name="name" placeholder="${esc(G.placeholder)}" autocomplete="off" required>
        <button type="submit">Anları bul</button>
      </form>
      <p class="hero-meta">Ücretsiz · Hesap gerekmez<span id="heroCount"></span></p>
      <div id="recent" class="recent" hidden></div>
      ${DEMO && G.id === 'pubg' ? '<p class="note">Demo modu: PUBG verisi sahte, video ilk kayıtlı yayıncının gerçek Kick yayınından.</p>' : ''}
    </section>
    <section>
      <div class="section-head"><h2>${G.label} yayıncıları <span id="streamerTotal" class="muted"></span></h2></div>
      <div id="homeStreamers" class="streamer-grid"><div class="muted">Yükleniyor…</div></div>
    </section>`;
  bindSearch($('heroSearch'), G);
  $('heroSearch').elements.name.focus();
  drawRecent(G);
  const my = runId;
  const list = await loadStreamers(G);
  if (my !== runId) return;
  const grid = $('homeStreamers');
  // önce şu an canlı olanlar (çok izleyicisi olan önde), sonra en son doğrulananlar
  const byLive = (a, b) => (!!b.live - !!a.live) || ((b.viewers ?? -1) - (a.viewers ?? -1)) ||
    String(b.verifiedAt || '').localeCompare(String(a.verifiedAt || ''));
  const shown = [...list].sort(byLive).slice(0, 24);
  $('streamerTotal').textContent = list.length ? `(${list.length})` : '';
  $('heroCount').textContent = list.length ? ` · ${list.length} yayıncı listede` : '';
  const draw = () => {
    grid.innerHTML = shown.length ? shown.map((s) => streamerCard(s, G)).join('') : `<div class="empty-box">${G.emptyStreamers}</div>`;
    hydrateAvatars(grid);
  };
  draw();
  if (!shown.length) return;
  // Sunucunun canlı bilgisi son taramaya dayanır; Kick'ten anlık durumu alıp
  // canlı olanları en üste taşı (sıra değiştiyse listeyi yeniden çiz)
  await Promise.allSettled(shown.map((s) => getKickChannel(s.kick).then((c) => {
    s.live = c.live;
    s.viewers = c.live ? c.viewers : null;
    if (!s.avatar && c.avatar) s.avatar = c.avatar;
  })));
  if (my !== runId || !document.body.contains(grid)) return;
  const before = shown.map((s) => s.kick).join();
  shown.sort(byLive);
  if (before !== shown.map((s) => s.kick).join() || shown.some((s) => s.live)) draw();
}

// ---------- yayıncılar sayfası (yönetici) ----------
// Menüde bağlantısı yok; sadece /streamers adresi yazılarak açılır ve şifre ister.
async function streamersPage() {
  const my = runId;
  const me = await getJSON('/api/admin/me').catch(() => ({ admin: false }));
  if (my !== runId) return;
  if (me.admin) return adminStreamersPage(GAMES.pubg);
  document.title = 'Yönetici girişi · Kick Report';
  $('app').innerHTML = `
    <section class="login">
      <form id="loginForm" class="panel login-box">
        <h1>Yönetici girişi</h1>
        <label>Şifre<input name="password" type="password" required autocomplete="current-password" autofocus></label>
        <button type="submit">Giriş yap</button>
        <div id="loginStatus" class="status"></div>
      </form>
    </section>`;
  const form = $('loginForm');
  form.elements.password.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await getJSON('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: form.elements.password.value }) });
      adminStreamersPage(GAMES.pubg);
    } catch (err) {
      setStatus($('loginStatus'), err.message, true);
      form.elements.password.select();
    } finally {
      btn.disabled = false;
    }
  };
}

async function adminStreamersPage(G) {
  document.title = 'Yayıncılar · Kick Report';
  const app = $('app');
  app.innerHTML = `
    <section class="page-head">
      <button id="logoutBtn" class="ghost logout">Çıkış yap</button>
      <h1>Yayıncılar</h1>
      <div class="tabs admin-tabs" id="adminTabs">${Object.values(GAMES).map((g) => `<button data-game="${g.id}" class="${g.id === G.id ? 'on' : ''}">${g.label}</button>`).join('')}</div>
      <p class="muted">Kick'te ${G.label} yayını yapan kanallar otomatik bulunur: kanal adıyla aynı ${G.accountLabel} hesabının yayın sırasında maç oynadığı görülünce eşleşme eklenir. Oyunda farklı ad kullananları aşağıdan elle ekleyebilirsin.</p>
    </section>
    <div id="discoveryBox" class="panel discovery"><span class="muted">Otomatik bulma durumu yükleniyor…</span></div>
    <div id="addStatus" class="status"></div>
    <div class="list-head">
      <h2>Eşleşen ${G.label} yayıncıları <span id="matchedCount" class="muted"></span></h2>
      <input id="streamerFilter" type="search" placeholder="Kanal ya da ${esc(G.accountLabel)} ara…" autocomplete="off">
    </div>
    <div id="streamerTable" class="streamer-list"></div>
    <div id="moreRows"></div>
    <section id="unmatchedBox" hidden>
      <h2>${G.accountLabel} bulunamayanlar</h2>
      <p class="muted small">Bu kanallar Kick'te ${G.label} oynuyor ama oyunda farklı bir ad kullanıyor olabilir. ${G.accountLabel} biliyorsan yaz, eşleştir.</p>
      <div id="unmatchedList" class="streamer-list"></div>
    </section>
    <details class="panel manual-add">
      <summary>Elle ${G.label} yayıncısı ekle</summary>
      <form id="addStreamer" class="add-form">
        <label>${G.accountLabel}<input name="account" required placeholder="${esc(G.accountPlaceholder)}" autocomplete="off"></label>
        <label>Kick kanalı<input name="kick" required placeholder="örn. kanaladi" autocomplete="off"></label>
        <button type="submit">Ekle</button>
      </form>
    </details>`;

  $('adminTabs').onclick = (e) => {
    const b = e.target.closest('button[data-game]');
    if (b && b.dataset.game !== G.id) adminStreamersPage(GAMES[b.dataset.game]);
  };

  async function add(account, kick, btn) {
    btn.disabled = true;
    try {
      const s = await getJSON(G.streamersApi, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(G.addBody(account, kick)) });
      setStatus($('addStatus'), `${G.streamerName(s)} → kick.com/${s.kick} eklendi.`);
      draw();
      return true;
    } catch (err) {
      if (err.status === 401) { streamersPage(); return false; } // oturum süresi doldu
      setStatus($('addStatus'), err.message, true);
      return false;
    } finally {
      btn.disabled = false;
    }
  }

  $('logoutBtn').onclick = async () => {
    await getJSON('/api/admin/logout', { method: 'POST' }).catch(() => {});
    navigate('/');
  };

  const form = $('addStreamer');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const ok = await add(form.elements.account.value.trim(), form.elements.kick.value.trim(), form.querySelector('button'));
    if (ok) form.reset();
  };

  const PAGE = 60;
  let limit = PAGE;
  $('streamerFilter').oninput = () => { limit = PAGE; drawRows(); };

  function drawRows() {
    const box = $('streamerTable');
    if (!box) return;
    const all0 = streamersByGame[G.id];
    const q = $('streamerFilter').value.trim().toLowerCase();
    const all = [...all0]
      .filter((s) => !q || s.kick.includes(q) || G.streamerName(s).toLowerCase().includes(q))
      .sort((a, b) => (b.live - a.live) || a.kick.localeCompare(b.kick));
    $('matchedCount').textContent = `(${all0.length})`;
    box.innerHTML = all.length ? '' : `<div class="empty-box">${q ? 'Aramaya uyan yayıncı yok.' : 'Henüz eşleşen yayıncı yok. Otomatik bulma zamanla ekler; aşağıdan elle de ekleyebilirsin.'}</div>`;
    for (const s of all.slice(0, limit)) {
      const row = document.createElement('div');
      row.className = 'streamer-row';
      row.innerHTML = `${avatarHTML(s)}
        <span class="sc-text"><b>${esc(s.kick)}</b><small>${esc(G.streamerName(s))}</small></span>
        <span class="live-pill" data-live="${esc(s.kick)}" ${s.live ? '' : 'hidden'}>CANLI</span>
        ${sourceBadge(s, G)}
        <a href="${G.playerPath(G.streamerName(s))}" data-link class="ghost-link">Anları</a>
        <a href="https://kick.com/${encodeURIComponent(s.kick)}" target="_blank" rel="noopener" class="ghost-link">Kick ↗</a>`;
      const del = document.createElement('button');
      del.className = 'ghost';
      del.textContent = 'Sil';
      del.title = s.source === 'auto' ? 'Yanlış eşleşmeyse sil, tekrar otomatik eklenmez' : '';
      del.onclick = async () => {
        if (!confirm(`${s.kick} silinsin mi?`)) return;
        await getJSON(G.deleteUrl(s), { method: 'DELETE' }).catch((err) => setStatus($('addStatus'), err.message, true));
        draw();
      };
      row.appendChild(del);
      box.appendChild(row);
    }
    const more = $('moreRows');
    more.innerHTML = '';
    if (all.length > limit) {
      const b = document.createElement('button');
      b.className = 'ghost more';
      b.textContent = `Daha fazla göster (${all.length - limit})`;
      b.onclick = () => { limit += PAGE; drawRows(); };
      more.appendChild(b);
    }
    hydrateAvatars(box);
  }

  function drawUnmatched(d) {
    const list = d?.unmatched || [];
    $('unmatchedBox').hidden = !list.length;
    const box = $('unmatchedList');
    box.innerHTML = '';
    for (const c of list) {
      const row = document.createElement('form');
      row.className = 'streamer-row unmatched';
      const why = c.status === 'nomatch'
        ? `"${esc(c.pubgName)}" adlı hesap var ama yayın sırasında maçı yok`
        : c.tried.length ? `Denenen: ${c.tried.map(esc).join(', ')}` : `Kanal adı geçerli bir ${esc(G.accountLabel)} değil`;
      row.innerHTML = `${avatarHTML({ kick: c.slug, avatar: c.avatar, live: c.live })}
        <span class="sc-text"><b>${esc(c.slug)}</b><small>${why}</small></span>
        <input name="account" placeholder="${esc(G.accountLabel)}" required autocomplete="off">
        <button type="submit" class="ghost">Eşleştir</button>`;
      row.onsubmit = (e) => { e.preventDefault(); add(row.elements.account.value.trim(), c.slug, row.querySelector('button')); };
      box.appendChild(row);
    }
  }

  async function draw() {
    let expired = false;
    const [, d] = await Promise.all([loadStreamers(G), getJSON(G.discoveryApi).catch((e) => { expired = e.status === 401; return null; })]);
    if (expired) return streamersPage(); // oturum süresi doldu: giriş formuna dön
    if (!$('streamerTable')) return;
    $('discoveryBox').innerHTML = d ? discoveryText(d, G) : 'Otomatik bulma durumu alınamadı.';
    drawRows();
    drawUnmatched(d);
  }
  draw();
}

function setStatus(el, msg, isError = false) {
  if (!el) return;
  el.textContent = msg;
  el.className = 'status' + (isError ? ' error' : '');
}

// ---------- oyuncu sayfası ----------
async function playerPage(G, name) {
  const my = runId;
  const app = $('app');
  $('topSearch').elements.name.value = name;
  document.title = `${name} · ${G.label} · Kick Report`;
  app.innerHTML = `
    <section class="player-head">
      <div class="ph-avatar ${G.id}">${initial(name)}</div>
      <div><div class="ph-game">${G.label}</div><h1 id="playerName">${esc(name)}</h1></div>
      <div id="stats" class="stats"></div>
    </section>
    <div id="progress" class="progress"><div class="bar"></div><span id="progressText">Hazırlanıyor…</span></div>
    <div id="pageStatus" class="status"></div>
    <div id="filters" class="filters" hidden></div>
    <div id="matches"></div>`;

  const progress = (text, pct) => {
    if (my !== runId) return;
    $('progressText').textContent = text;
    if (pct != null) app.querySelector('.progress .bar').style.width = pct + '%';
  };
  try {
    let matches, player = { name, key: name.toLowerCase() }, checked = 0;
    const streamers = await loadStreamers(G);
    if (DEMO && G.id === 'pubg') {
      const s = streamers[0];
      if (!s) throw new Error('Demo için önce en az bir yayıncı kaydet.');
      progress('Kick yayınları alınıyor…', 50);
      matches = demoMatches(await getKickVods(s.kick), s);
      checked = matches.length;
    } else {
      if (!streamers.length) throw new Error(`Henüz kayıtlı ${G.label} yayıncısı yok. Yayıncılar eklendikçe arama sonuç vermeye başlar.`);
      progress(G.loadingMatches, 5);
      player = await G.fetchPlayer(name);
      if (my !== runId) return;
      addRecent(G, player.name); // sadece gerçekten bulunan oyuncular, oyundaki doğru yazımıyla
      $('playerName').textContent = player.name;
      const ids = player.matchIds.slice(0, 20);
      if (!ids.length) throw new Error(G.noMatches);

      let done = 0;
      const summaries = (await pool(ids, 4, async (id) => {
        const m = await G.fetchMatch(id);
        progress(`Maçlar kontrol ediliyor… ${++done}/${ids.length}`, 5 + (done / ids.length) * 35);
        return m;
      })).filter((m) => m && !m.error);
      checked = summaries.length;
      if (my !== runId) return;

      // Bu maçlarda oynayan bütün kayıtlı yayıncıların VOD'larını çek
      const slugs = [...new Set(summaries.flatMap((m) => (m.streamers || []).map((s) => s.kick)))];
      const failed = [];
      if (slugs.length) {
        progress(`${slugs.length} yayıncının Kick yayınları alınıyor…`, 45);
        await pool(slugs, 3, (slug) => getKickVods(slug).catch((err) => { failed.push(slug); throw err; }));
      }
      for (const m of summaries) {
        m.streams = [];
        for (const s of m.streamers || []) {
          const vod = findVod(await getKickVods(s.kick).catch(() => []), new Date(m.createdAt));
          if (vod) m.streams.push({ streamer: s, vod });
        }
      }

      // Sadece yayında görünen maçların olaylarını çek; oyuncunun kendisi yayıncı değilse
      // ve maçtaki yayıncılar oyuncuyla hiç karşılaşmadıysa kart çıkmaz (birebir etkileşim)
      const hits = summaries.filter((m) => m.streams.length);
      done = 0;
      await pool(hits, 2, async (m) => {
        await G.fetchEvents(m, player);
        progress(`${G.loadingEvents} ${++done}/${hits.length}`, 55 + (done / Math.max(1, hits.length)) * 40);
      });
      if (G.clips && hits.some((m) => m.streams.some((st) => st.vod.locked))) {
        progress('Abonelere özel yayınlar için klipler aranıyor…', 96);
        await attachClips(G, hits, player);
      }
      matches = summaries;
      if (failed.length) setStatus($('pageStatus'), `Yayınları alınamayan kanallar: ${failed.join(', ')}`, true);
    }
    if (my !== runId) return;
    $('progress').remove();
    renderPlayer(G, matches, player, checked);
  } catch (err) {
    if (my !== runId) return;
    $('progress')?.remove();
    setStatus($('pageStatus'), err.message, true);
  }
}

// Bir olay için yayın rolü: kendi yayını, rakibin yayını, maçtaki diğer yayıncılar
function roleOf(G, st, player, ev) {
  const key = G.streamerKey(st.streamer);
  if (key && key === player.key) return 'own';
  if (ev && key && key === G.otherKey(ev)) return 'enemy';
  return 'other';
}
const ROLE_ORDER = ['own', 'enemy', 'other'];

// Sadece yayıncının birebir dahil olduğu anlar: oyuncunun kendi yayını ya da
// oyuncunun öldürdüğü / oyuncuyu öldüren yayıncının yayını. Maçtaki diğer yayıncılar gösterilmez.
// Abonelere özel kayıtlarda sadece o anı kapsayan bir klip varsa kart çıkar; yoksa an m.lockedMissed'e sayılır.
function buildCards(G, m, player) {
  const cards = [];
  m.lockedMissed = 0;
  (m.events || []).forEach((ev, i) => {
    const outgoing = ev.type === 'kill' || ev.type === 'knock';
    for (const st of m.streams) {
      const role = roleOf(G, st, player, ev);
      if (role === 'other') continue;
      let vod = st.vod;
      if (vod.locked) {
        vod = m.clips?.get(`${st.streamer.kick}|${i}`);
        if (!vod) { m.lockedMissed++; continue; }
      }
      cards.push({
        match: m, ev, role, streamer: st.streamer, vod,
        at: (new Date(ev.time) - vod.start) / 1000,
        from: outgoing ? player.name : ev.other, to: outgoing ? ev.other : player.name,
      });
    }
  });
  return cards.sort((a, b) => a.ev.time.localeCompare(b.ev.time) || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
}

const ROLE_FILTER = { all: 'Bütün yayınlar', own: 'Kendi yayını', enemy: 'Rakip tepkileri' };
const matchesFilter = (c, f) =>
  (f.type === 'all' || c.ev.type === f.type || (f.type === 'death' && c.ev.type === 'knocked')) &&
  (f.role === 'all' || c.role === f.role);

function renderPlayer(G, matches, player, checked) {
  matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  matches.forEach((m) => { m.cards = m.streams?.length ? buildCards(G, m, player) : []; });
  // sadece yayıncıyla birebir etkileşim olan maçlar
  const inStream = matches.filter((m) => m.cards.length);
  const evs = [...new Set(inStream.flatMap((m) => m.cards.map((c) => c.ev)))];
  const channels = new Set(inStream.flatMap((m) => m.cards.map((c) => c.streamer.kick)));
  $('stats').innerHTML = [
    ['Maç', checked], ['Etkileşimli maç', inStream.length], ['Yayıncı', channels.size],
    ['Öldürme', evs.filter((e) => e.type === 'kill').length], ['Ölüm', evs.filter((e) => e.type === 'death').length],
  ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');

  if (!inStream.length) {
    const sameMatch = matches.filter((m) => m.streams?.length).length;
    $('matches').innerHTML = `<div class="empty-box">Son ${checked} maçta bu oyuncunun bir yayıncıyla birebir karşılaşması yok.
      ${sameMatch ? `<br>${sameMatch} maçta yayıncılar vardı ama oyuncuyla doğrudan çatışmadılar.` : ''}
      ${matches.some((m) => m.lockedMissed) ? `<br>${matches.reduce((n, m) => n + (m.lockedMissed || 0), 0)} an abonelere özel bir yayında kaldı ve o anı kapsayan bir klip yok.` : ''}
      <br>Başka bir oyuncu ara.</div>`;
    return;
  }

  const f = { type: 'all', role: 'all' };
  const filters = $('filters');
  filters.hidden = false;
  filters.innerHTML = Object.entries({ type: G.filters, role: ROLE_FILTER }).map(([key, opts]) =>
    `<div class="tabs" data-key="${key}">${Object.entries(opts).map(([v, l]) => `<button data-v="${v}" class="${v === 'all' ? 'on' : ''}">${l}</button>`).join('')}</div>`).join('');
  filters.onclick = (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    const group = b.parentElement;
    f[group.dataset.key] = b.dataset.v;
    group.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    draw();
  };

  function draw() {
    const root = $('matches');
    root.innerHTML = '';
    const visible = [];
    for (const m of inStream) {
      const cards = m.cards.filter((c) => matchesFilter(c, f));
      const created = new Date(m.createdAt);
      const sec = document.createElement('section');
      sec.className = 'match';
      sec.innerHTML = `
        <div class="match-head">
          ${G.matchBadge(m)}
          <div class="mh-main"><b>${esc(m.map)}</b> <span class="muted">${esc(m.mode)}</span></div>
          <div class="mh-meta">${fmtDate(created)} · ${timeAgo(created)} · ${Math.round((m.duration || 0) / 60)} dk</div>
          <div class="mh-streams">${m.streams.filter((st) => !st.vod.locked && m.cards.some((c) => c.streamer.kick === st.streamer.kick)).map((st) => `<button class="chip" data-start="${esc(st.streamer.kick)}" title="Maçın başından izle">${avatarHTML(st.streamer)}${esc(st.streamer.kick)} ▶</button>`).join('')}</div>
        </div>`;
      sec.querySelectorAll('[data-start]').forEach((b) => {
        const st = m.streams.find((x) => x.streamer.kick === b.dataset.start);
        b.onclick = () => openModal([{ match: m, ev: { type: 'start', other: m.map, weapon: m.mode, time: m.createdAt }, role: roleOf(G, st, player, null),
          streamer: st.streamer, vod: st.vod, at: (created - st.vod.start) / 1000, from: m.map, to: m.mode }], 0);
      });
      const grid = document.createElement('div');
      grid.className = 'card-grid';
      if (!cards.length) grid.innerHTML = `<div class="muted small">${m.events?.length ? 'Bu filtreye uyan an yok.' : G.noEvents}</div>`;
      for (const c of cards) {
        const idx = visible.push(c) - 1;
        grid.appendChild(cardEl(c, () => openModal(visible, idx)));
      }
      sec.appendChild(grid);
      root.appendChild(sec);
    }
    const off = matches.length - inStream.length;
    if (off) root.insertAdjacentHTML('beforeend', `<div class="muted small offline">${off} maçta bir yayıncıyla birebir etkileşim yok.</div>`);
    const missed = matches.reduce((n, m) => n + (m.lockedMissed || 0), 0);
    if (missed) root.insertAdjacentHTML('beforeend', `<div class="muted small offline">${missed} an abonelere özel bir yayında kaldı ve o anı kapsayan bir klip bulunamadı.</div>`);
    hydrateAvatars(root);
  }
  draw();
}

function cardEl(c, onClick) {
  const b = document.createElement('button');
  b.className = `card ${c.role}`;
  const thumb = c.vod.thumb ? `style="background-image:url('${esc(c.vod.thumb)}')"` : '';
  const dist = c.ev.distance ? ` · ${c.ev.distance} m` : '';
  b.innerHTML = `
    <div class="thumb" ${thumb}>
      <span class="role-badge ${c.role}">${ROLE_LABEL[c.role]}</span>
      ${c.vod.clip ? '<span class="clip-badge" title="Yayın kaydı abonelere özel; bu an bir klipten">Klip</span>' : ''}
      <span class="ts">${fmtClock(c.at)}</span>
      <span class="play">▶</span>
    </div>
    <div class="card-body">
      <div class="kill-line"><span class="tag ${c.ev.type}">${LABELS[c.ev.type]}</span></div>
      <div class="vs"><b>${esc(c.from)}</b><span class="arrow">→</span><b>${esc(c.to)}</b></div>
      <div class="sub">${esc(c.ev.weapon)}${dist}</div>
      <div class="by">${avatarHTML(c.streamer)}<span>${esc(c.streamer.kick)}</span><span class="muted">· ${timeAgo(new Date(c.ev.time))}</span></div>
    </div>`;
  b.onclick = onClick;
  return b;
}

// ---------- video penceresi ----------
function openModal(list, index) {
  modalList = list;
  modalIndex = index;
  $('modal').hidden = false;
  document.body.classList.add('noscroll');
  playCurrent();
}

function closeModal() {
  if ($('modal').hidden) return;
  $('modal').hidden = true;
  document.body.classList.remove('noscroll');
  $('video').pause();
}

function step(d) {
  const n = modalIndex + d;
  if (n < 0 || n >= modalList.length) return;
  modalIndex = n;
  playCurrent();
}

// ---------- kayıt zaman çizelgesi ----------
// Kick kayıtları her segmentin gerçek saatini (#EXT-X-PROGRAM-DATE-TIME) içerir. Kayıt, Kick'in bildirdiği
// başlangıçtan birkaç saniye önce başlayabilir ve yayın koptuğunda arada video olmaz. Bu yüzden videodaki
// konum "olay saati − yayın başlangıcı" ile değil, segment saatlerinden hesaplanır.
const timelineCache = new Map(); // vod.src -> { at, segs: [{ pdt, start, dur }] }

async function getTimeline(vod) {
  const hit = timelineCache.get(vod.src);
  if (hit && (!vod.live || Date.now() - hit.at < 60_000)) return hit.segs;
  let url = vod.src;
  let text = await (await fetch(url)).text();
  if (text.includes('#EXT-X-STREAM-INF')) {
    // ana liste: en düşük kalite (en son satır) en küçük dosya; saatler bütün kalitelerde aynı
    const uris = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    url = new URL(uris[uris.length - 1], vod.src).href;
    text = await (await fetch(url)).text();
  }
  const segs = [];
  let pos = 0, pdt = null, dur = null;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(l.slice(25));
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (l && !l.startsWith('#') && dur != null) {
      segs.push({ pdt, start: pos, dur });
      pos += dur;
      pdt = pdt == null ? null : pdt + dur * 1000; // etiketsiz segment: bir öncekinden devam
      dur = null;
    }
  }
  timelineCache.set(vod.src, { at: Date.now(), segs });
  return segs;
}

// Gerçek saat (ms) -> videodaki saniye. Saat bir kopmaya denk gelirse kopmadan sonraki ilk ana gider.
function wallToPosition(segs, ms) {
  if (!segs.length || segs[0].pdt == null) return null;
  if (ms <= segs[0].pdt) return 0;
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid].pdt <= ms) lo = mid; else hi = mid - 1; }
  const s = segs[lo];
  const off = (ms - s.pdt) / 1000;
  if (off <= s.dur) return s.start + off;
  return segs[lo + 1] ? segs[lo + 1].start : s.start + s.dur;
}

let playToken = 0;
async function playCurrent() {
  const c = modalList[modalIndex];
  if (!c) return;
  const token = ++playToken;
  const lead = c.ev.type === 'start' ? 0 : Number($('lead').value) || 0;
  const fix = Number($('syncFix').value) || 0;
  // Tahmini konum (yedek): olay saati − Kick'in bildirdiği yayın başlangıcı
  let t = Math.max(0, c.at - lead + fix);
  try {
    const exact = wallToPosition(await getTimeline(c.vod), new Date(c.ev.time).getTime() + (fix - lead) * 1000);
    if (exact != null) t = exact;
  } catch { /* liste okunamadı: tahmini konumla devam */ }
  if (token !== playToken) return; // bu arada başka bir karta geçildi
  const slug = c.streamer.kick;
  $('modalTitle').innerHTML = c.ev.type === 'start'
    ? `<b>${esc(slug)}</b> · ${esc(c.match.map)} maç başı`
    : `<span class="tag ${c.ev.type}">${LABELS[c.ev.type]}</span> <b>${esc(c.from)}</b> → <b>${esc(c.to)}</b>`;
  $('modalInfo').innerHTML = `<span class="role-badge ${c.role}">${ROLE_LABEL[c.role]}</span>${c.vod.clip ? ' <span class="clip-badge">Klip</span>' : ''} ${esc(slug)} · ${esc(c.ev.weapon)}${c.ev.distance ? ' · ' + c.ev.distance + ' m' : ''} · ${fmtClock(t)}
    <span class="muted">(${modalIndex + 1}/${modalList.length})</span>`;
  $('prevBtn').disabled = modalIndex <= 0;
  $('nextBtn').disabled = modalIndex >= modalList.length - 1;
  $('kickLink').href = c.vod.clip ? `https://kick.com/${encodeURIComponent(slug)}/clips/${encodeURIComponent(c.vod.clipId)}` : c.vod.uuid ? `https://kick.com/${encodeURIComponent(slug)}/videos/${c.vod.uuid}` : `https://kick.com/${encodeURIComponent(slug)}`;

  const video = $('video');
  if (currentSrc === c.vod.src) {
    video.currentTime = t;
    video.play().catch(() => {});
    return;
  }
  currentSrc = c.vod.src;
  if (hls) { hls.destroy(); hls = null; }
  if (!(canPlayH264() && window.Hls && Hls.isSupported())) {
    // hls.js kullanılamıyor: tarayıcı HLS'yi kendisi oynatabiliyorsa (Safari, iPhone) onu dene
    if (!video.canPlayType('application/vnd.apple.mpegurl')) { currentSrc = null; return showPlayError(CODEC_HELP); }
    video.removeAttribute('src');
    video.src = c.vod.src;
    video.addEventListener('loadedmetadata', () => { video.currentTime = t; video.play().catch(() => {}); }, { once: true });
    video.addEventListener('error', () => {
      currentSrc = null;
      showPlayError(video.error?.code === 4 ? CODEC_HELP : 'Video oynatılamadı. "Kick\'te aç" ile deneyebilirsin.');
    }, { once: true });
  } else {
    hls = new Hls({ startPosition: t });
    hls.loadSource(c.vod.src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      currentSrc = null;
      showPlayError(d.details === 'manifestIncompatibleCodecsError' ? CODEC_HELP : `Video oynatılamadı (${esc(d.details)}). "Kick'te aç" ile deneyebilirsin.`);
    });
  }
}

// Kick VOD'ları H.264 + AAC. Bazı tarayıcılarda (VS Code içindeki tarayıcı, Windows N sürümleri) bu kodekler yok.
function canPlayH264() {
  const MS = window.ManagedMediaSource || window.MediaSource;
  return !!MS && MS.isTypeSupported('video/mp4; codecs="avc1.4D401F,mp4a.40.2"');
}
const CODEC_HELP = 'Bu tarayıcı Kick videolarındaki H.264 formatını oynatamıyor. VS Code içindeki tarayıcıyı kullanıyorsan sayfayı Chrome, Edge ya da Firefox\'ta aç. Ya da "Kick\'te aç" bağlantısını kullan.';
function showPlayError(msg) {
  $('modalInfo').insertAdjacentHTML('beforeend', `<div class="play-error">${msg}</div>`);
}

$('modalClose').onclick = closeModal;
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
$('prevBtn').onclick = () => step(-1);
$('nextBtn').onclick = () => step(1);
['lead', 'syncFix'].forEach((id) => $(id).addEventListener('change', playCurrent));
document.addEventListener('keydown', (e) => {
  if ($('modal').hidden || e.target.matches('input, select')) return;
  if (e.key === 'Escape') closeModal();
  if (e.key === 'ArrowLeft' && e.shiftKey) step(-1);
  if (e.key === 'ArrowRight' && e.shiftKey) step(1);
});

// ---------- başlangıç ----------
// Eski ?name=..&shard=.. bağlantılarını yeni adrese çevir
if (query.get('name')) history.replaceState(null, '', GAMES.pubg.playerPath(query.get('name')) + SUFFIX);
route();

// Footer telif yılı
if ($('year')) $('year').textContent = new Date().getFullYear();

// PWA / Android uygulaması: bağlantı yokken de açılabilmek için service worker
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

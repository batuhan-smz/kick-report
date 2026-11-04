// Kick Report — istemci (tek sayfalık uygulama)
// Sayfalar:  /                         ana sayfa: arama + kayıtlı yayıncılar
//            /players/:shard/:name     oyuncunun yayınlarda görünen anları
//            /streamers                yayıncı kaydı
// Akış: oyuncunun PUBG maçları (sunucu) -> her maçta oynayan kayıtlı yayıncılar (sunucu)
//       -> o yayıncıların Kick VOD listeleri (doğrudan tarayıcı) -> maçı VOD ile zaman üzerinden eşleştir
//       -> eşleşen maçların telemetri olaylarını çek -> her (olay × yayın) bir video kartı.

const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
const DEMO = query.has('demo');
const SUFFIX = DEMO ? '?demo=1' : '';

const LABELS = { kill: 'Öldürme', knock: 'Düşürme', death: 'Ölüm', knocked: 'Düştü', start: 'Maç başı' };
const ROLE_LABEL = { own: 'Kendi yayını', enemy: 'Rakip tepkisi', other: 'Aynı maç' };
const MATCH_GRACE_MS = 60_000; // VOD sınırlarında küçük tolerans

let hls = null;
let currentSrc = null;
let streamers = [];
let modalList = [];   // modalda gezinilebilen kartlar
let modalIndex = -1;
let runId = 0;        // eski aramaların sonuçları yeni sayfayı ezmesin
const vodCache = new Map();     // kick kanalı -> Promise<vod[]>
const channelCache = new Map(); // kick kanalı -> Promise<{avatar, live}>

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
const playerPath = (shard, name) => `/players/${shard}/${encodeURIComponent(name)}`;

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

// ---------- veri kaynakları ----------
function getKickVods(slug) {
  return memo(vodCache, slug, async () => {
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/videos`);
    if (res.status === 404) throw new Error(`Kick kanalı bulunamadı: ${slug}`);
    if (!res.ok) throw new Error(`Kick videoları alınamadı: ${slug} (${res.status})`);
    const list = await res.json();
    return list
      .filter((v) => v.source && v.start_time)
      .map((v) => {
        const start = kickTime(v.start_time);
        const end = v.is_live || !v.duration ? new Date() : new Date(start.getTime() + v.duration);
        const thumb = v.thumbnail?.src || v.thumbnail?.url || v.video?.thumb || null;
        return { start, end, src: v.source, title: v.session_title, uuid: v.video?.uuid, live: v.is_live, thumb };
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
  return vods.find((v) => t >= v.start.getTime() - MATCH_GRACE_MS && t <= v.end.getTime() + MATCH_GRACE_MS) || null;
}

async function loadStreamers() {
  try { streamers = await getJSON('/api/streamers'); } catch { streamers = []; }
  return streamers;
}

// Demo: ilk kayıtlı yayıncının gerçek Kick VOD'u, sahte PUBG maçları
function demoMatches(vods, streamer) {
  const v = vods.find((x) => !x.live && x.end - x.start > 3 * 3600_000) || vods[0];
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
  $('topSearch').hidden = !parts.length;
  window.scrollTo(0, 0);
  if (parts[0] === 'players' && parts[1] && parts[2]) return playerPage(parts[1], decodeURIComponent(parts[2]));
  if (parts[0] === 'streamers') return streamersPage();
  return homePage();
}

function bindSearch(form) {
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    if (name) navigate(playerPath('steam', name));
  };
}
bindSearch($('topSearch'));

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

function streamerCard(s) {
  return `<a class="streamer-card" href="${playerPath(s.shard, s.pubgName)}" data-link>
    ${avatarHTML(s)}
    <span class="sc-text"><b>${esc(s.kick)}</b><small>${esc(s.pubgName)}</small></span>
    <span class="live-pill" data-live="${esc(s.kick)}" ${s.live ? '' : 'hidden'}>CANLI</span>
  </a>`;
}

const sourceBadge = (s) => s.source === 'auto'
  ? '<span class="src auto" title="Kick\'te PUBG yayını sırasında oynanan maçla doğrulandı">otomatik</span>'
  : '<span class="src manual">elle</span>';

function discoveryText(d) {
  if (!d.enabled) return 'Otomatik bulma kapalı.';
  const t = d.totals;
  const when = d.lastScan ? timeAgo(new Date(d.lastScan)) : 'henüz yapılmadı';
  return `Kick'te şu an <b>${d.liveNow}</b> canlı PUBG yayını var. Son tarama: ${when}. ` +
    `Bugüne kadar <b>${t.candidates}</b> kanal görüldü: <b>${t.linked}</b> eşleşti, ${t.pending} kontrol bekliyor, ` +
    `${t.notfound + t.nomatch} kanalın PUBG adı bulunamadı.` + (d.lastError ? ` <span class="err">Son hata: ${esc(d.lastError)}</span>` : '');
}

// ---------- son görüntülenenler ----------
// Her ziyaretçinin kendi tarayıcısında tutulur (localStorage); erişilemezse sessizce boş kalır.
const RECENT_KEY = 'kr_recent';
const RECENT_MAX = 8;
function getRecent() {
  try { const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
function setRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch { /* gizli pencere vb. */ }
}
function addRecent(name) {
  setRecent([name, ...getRecent().filter((x) => !same(x, name))]);
}
function drawRecent() {
  const box = $('recent');
  if (!box) return;
  const list = getRecent();
  box.hidden = !list.length;
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="recent-head"><span>Son görüntülenenler</span><button type="button" class="link-btn" data-clear>Temizle</button></div>
    <div class="recent-list">${list.map((n) => `<span class="recent-chip"><a href="${playerPath('steam', n)}" data-link>${esc(n)}</a><button type="button" aria-label="${esc(n)} listeden kaldır" data-remove="${esc(n)}">✕</button></span>`).join('')}</div>`;
  box.onclick = (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) { setRecent(getRecent().filter((x) => x !== rm.dataset.remove)); drawRecent(); }
    if (e.target.closest('[data-clear]')) { setRecent([]); drawRecent(); }
  };
}

// ---------- ana sayfa ----------
async function homePage() {
  const app = $('app');
  app.innerHTML = `
    <section class="hero">
      <h1>PUBG anlarını <span>Kick</span> yayınlarında izle</h1>
      <p>Bir oyuncu adı yaz. Bir yayıncıyı vurduğu ya da bir yayıncı tarafından vurulduğu anları, o yayıncının kendi yayınından görürsün: birebir tepkiler.</p>
      <form id="heroSearch" class="search big">
        <input name="name" placeholder="PUBG oyuncu adı (büyük/küçük harf önemli)" autocomplete="off" required>
        <button type="submit">Ara</button>
      </form>
      <div id="recent" class="recent" hidden></div>
      ${DEMO ? '<p class="note">Demo modu: PUBG verisi sahte, video ilk kayıtlı yayıncının gerçek Kick yayınından.</p>' : ''}
    </section>
    <section>
      <div class="section-head"><h2>Yayıncılar <span id="streamerTotal" class="muted"></span></h2></div>
      <div id="homeStreamers" class="streamer-grid"><div class="muted">Yükleniyor…</div></div>
    </section>`;
  bindSearch($('heroSearch'));
  $('heroSearch').elements.name.focus();
  drawRecent();
  const my = runId;
  await loadStreamers();
  if (my !== runId) return;
  const grid = $('homeStreamers');
  // önce şu an canlı olanlar, sonra en son doğrulananlar
  const shown = [...streamers]
    .sort((a, b) => (b.live - a.live) || String(b.verifiedAt || '').localeCompare(String(a.verifiedAt || '')))
    .slice(0, 24);
  $('streamerTotal').textContent = streamers.length ? `(${streamers.length})` : '';
  grid.innerHTML = shown.length
    ? shown.map(streamerCard).join('')
    : '<div class="empty-box">Henüz yayıncı yok. Otomatik bulma, Kick\'te PUBG yayını yapan kanalları birkaç dakika içinde eklemeye başlar.</div>';
  hydrateAvatars(grid);
}

// ---------- yayıncılar sayfası (yönetici) ----------
// Menüde bağlantısı yok; sadece /streamers adresi yazılarak açılır ve şifre ister.
async function streamersPage() {
  const my = runId;
  const me = await getJSON('/api/admin/me').catch(() => ({ admin: false }));
  if (my !== runId) return;
  if (me.admin) return adminStreamersPage();
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
      adminStreamersPage();
    } catch (err) {
      setStatus($('loginStatus'), err.message, true);
      form.elements.password.select();
    } finally {
      btn.disabled = false;
    }
  };
}

async function adminStreamersPage() {
  document.title = 'Yayıncılar · Kick Report';
  const app = $('app');
  app.innerHTML = `
    <section class="page-head">
      <button id="logoutBtn" class="ghost logout">Çıkış yap</button>
      <h1>Yayıncılar</h1>
      <p class="muted">Kick'te PUBG yayını yapan kanallar otomatik bulunur: kanal adıyla aynı adlı PUBG hesabının yayın sırasında maç oynadığı görülünce eşleşme eklenir. Oyunda farklı ad kullananları aşağıdan elle ekleyebilirsin.</p>
    </section>
    <div id="discoveryBox" class="panel discovery"><span class="muted">Otomatik bulma durumu yükleniyor…</span></div>
    <div id="addStatus" class="status"></div>
    <div class="list-head">
      <h2>Eşleşen yayıncılar <span id="matchedCount" class="muted"></span></h2>
      <input id="streamerFilter" type="search" placeholder="Kanal ya da PUBG adı ara…" autocomplete="off">
    </div>
    <div id="streamerTable" class="streamer-list"></div>
    <div id="moreRows"></div>
    <section id="unmatchedBox" hidden>
      <h2>PUBG adı bulunamayanlar</h2>
      <p class="muted small">Bu kanallar Kick'te PUBG oynuyor ama oyunda farklı bir ad kullanıyor olabilir. PUBG adını biliyorsan yaz, eşleştir.</p>
      <div id="unmatchedList" class="streamer-list"></div>
    </section>
    <details class="panel manual-add">
      <summary>Elle yayıncı ekle</summary>
      <form id="addStreamer" class="add-form">
        <label>PUBG adı<input name="pubgName" required placeholder="örn. chocoTaco" autocomplete="off"></label>
        <label>Kick kanalı<input name="kick" required placeholder="örn. kanaladi" autocomplete="off"></label>
        <button type="submit">Ekle</button>
      </form>
    </details>`;

  async function add(body, btn) {
    btn.disabled = true;
    try {
      const s = await getJSON('/api/streamers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      setStatus($('addStatus'), `${s.pubgName} → kick.com/${s.kick} eklendi.`);
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
    const ok = await add({ pubgName: form.elements.pubgName.value.trim(), shard: 'steam', kick: form.elements.kick.value.trim() }, form.querySelector('button'));
    if (ok) form.reset();
  };

  const PAGE = 60;
  let limit = PAGE;
  $('streamerFilter').oninput = () => { limit = PAGE; drawRows(); };

  function drawRows() {
    const box = $('streamerTable');
    if (!box) return;
    const q = $('streamerFilter').value.trim().toLowerCase();
    const all = [...streamers]
      .filter((s) => !q || s.kick.includes(q) || s.pubgName.toLowerCase().includes(q))
      .sort((a, b) => (b.live - a.live) || a.kick.localeCompare(b.kick));
    $('matchedCount').textContent = `(${streamers.length})`;
    box.innerHTML = all.length ? '' : `<div class="empty-box">${q ? 'Aramaya uyan yayıncı yok.' : 'Henüz eşleşen yayıncı yok. Otomatik bulma birkaç dakika içinde eklemeye başlar.'}</div>`;
    for (const s of all.slice(0, limit)) {
      const row = document.createElement('div');
      row.className = 'streamer-row';
      row.innerHTML = `${avatarHTML(s)}
        <span class="sc-text"><b>${esc(s.kick)}</b><small>${esc(s.pubgName)}</small></span>
        <span class="live-pill" data-live="${esc(s.kick)}" ${s.live ? '' : 'hidden'}>CANLI</span>
        ${sourceBadge(s)}
        <a href="${playerPath(s.shard, s.pubgName)}" data-link class="ghost-link">Anları</a>
        <a href="https://kick.com/${encodeURIComponent(s.kick)}" target="_blank" rel="noopener" class="ghost-link">Kick ↗</a>`;
      const del = document.createElement('button');
      del.className = 'ghost';
      del.textContent = 'Sil';
      del.title = s.source === 'auto' ? 'Yanlış eşleşmeyse sil, tekrar otomatik eklenmez' : '';
      del.onclick = async () => {
        if (!confirm(`${s.kick} silinsin mi?`)) return;
        await getJSON(`/api/streamers/${encodeURIComponent(s.pubgName)}`, { method: 'DELETE' }).catch((err) => setStatus($('addStatus'), err.message, true));
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
        : c.tried.length ? `Denenen: ${c.tried.map(esc).join(', ')}` : 'Kanal adı geçerli bir PUBG adı değil';
      row.innerHTML = `${avatarHTML({ kick: c.slug, avatar: c.avatar, live: c.live })}
        <span class="sc-text"><b>${esc(c.slug)}</b><small>${why}</small></span>
        <input name="pubgName" placeholder="PUBG adı" required autocomplete="off">
        <button type="submit" class="ghost">Eşleştir</button>`;
      row.onsubmit = (e) => { e.preventDefault(); add({ pubgName: row.elements.pubgName.value.trim(), shard: 'steam', kick: c.slug }, row.querySelector('button')); };
      box.appendChild(row);
    }
  }

  async function draw() {
    let expired = false;
    const [, d] = await Promise.all([loadStreamers(), getJSON('/api/discovery').catch((e) => { expired = e.status === 401; return null; })]);
    if (expired) return streamersPage(); // oturum süresi doldu: giriş formuna dön
    if (!$('streamerTable')) return;
    $('discoveryBox').innerHTML = d ? discoveryText(d) : 'Otomatik bulma durumu alınamadı.';
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
async function playerPage(shard, name) {
  const my = runId;
  const app = $('app');
  $('topSearch').elements.name.value = name;
  document.title = `${name} · Kick Report`;
  app.innerHTML = `
    <section class="player-head">
      <div class="ph-avatar">${initial(name)}</div>
      <div><h1 id="playerName">${esc(name)}</h1></div>
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
    let matches, playerName = name, checked = 0;
    await loadStreamers();
    if (DEMO) {
      const s = streamers[0];
      if (!s) throw new Error('Demo için önce en az bir yayıncı kaydet.');
      progress('Kick yayınları alınıyor…', 50);
      matches = demoMatches(await getKickVods(s.kick), s);
      checked = matches.length;
    } else {
      if (!streamers.length) throw new Error('Henüz kayıtlı yayıncı yok. Yayıncılar otomatik bulundukça arama sonuç vermeye başlar.');
      progress('PUBG maçları alınıyor…', 5);
      const player = await getJSON(`/api/pubg/${shard}/player/${encodeURIComponent(name)}`);
      if (my !== runId) return;
      playerName = player.name;
      addRecent(player.name); // sadece gerçekten bulunan oyuncular, PUBG'deki doğru yazımıyla
      $('playerName').textContent = player.name;
      const ids = player.matchIds.slice(0, 20);
      if (!ids.length) throw new Error('Son 14 günde maç bulunamadı.');

      let done = 0;
      const summaries = (await pool(ids, 4, async (id) => {
        const m = await getJSON(`/api/pubg/${shard}/match/${id}`);
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

      const hits = summaries.filter((m) => m.streams.length);
      done = 0;
      await pool(hits, 2, async (m) => {
        const full = await getJSON(`/api/pubg/${shard}/match/${m.id}/events?player=${encodeURIComponent(playerName)}`);
        m.events = full.events;
        m.placement = full.placement;
        progress(`Telemetri işleniyor… ${++done}/${hits.length}`, 55 + (done / Math.max(1, hits.length)) * 45);
      });
      matches = summaries;
      if (failed.length) setStatus($('pageStatus'), `Yayınları alınamayan kanallar: ${failed.join(', ')}`, true);
    }
    if (my !== runId) return;
    $('progress').remove();
    renderPlayer(matches, playerName, checked);
  } catch (err) {
    if (my !== runId) return;
    $('progress')?.remove();
    setStatus($('pageStatus'), err.message, true);
  }
}

// Bir olay için yayın rolü: kendi yayını, rakibin yayını, maçtaki diğer yayıncılar
function roleOf(st, playerName, ev) {
  if (same(st.streamer.pubgName, playerName)) return 'own';
  if (ev && same(st.streamer.pubgName, ev.other)) return 'enemy';
  return 'other';
}
const ROLE_ORDER = ['own', 'enemy', 'other'];

// Sadece yayıncının birebir dahil olduğu anlar: oyuncunun kendi yayını ya da
// oyuncunun vurduğu / oyuncuyu vuran yayıncının yayını. Maçtaki diğer yayıncılar gösterilmez.
function buildCards(m, playerName) {
  const cards = [];
  for (const ev of m.events || []) {
    const outgoing = ev.type === 'kill' || ev.type === 'knock';
    for (const st of m.streams) {
      const role = roleOf(st, playerName, ev);
      if (role === 'other') continue;
      cards.push({
        match: m, ev, role, streamer: st.streamer, vod: st.vod,
        at: (new Date(ev.time) - st.vod.start) / 1000,
        from: outgoing ? playerName : ev.other, to: outgoing ? ev.other : playerName,
      });
    }
  }
  return cards.sort((a, b) => a.ev.time.localeCompare(b.ev.time) || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
}

const FILTERS = {
  type: { all: 'Tümü', kill: 'Öldürmeler', knock: 'Düşürmeler', death: 'Ölümler' },
  role: { all: 'Bütün yayınlar', own: 'Kendi yayını', enemy: 'Rakip tepkileri' },
};
const matchesFilter = (c, f) =>
  (f.type === 'all' || c.ev.type === f.type || (f.type === 'death' && c.ev.type === 'knocked')) &&
  (f.role === 'all' || c.role === f.role);

function renderPlayer(matches, playerName, checked) {
  matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  matches.forEach((m) => { m.cards = m.streams?.length ? buildCards(m, playerName) : []; });
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
      <br>Başka bir oyuncu ara.</div>`;
    return;
  }

  const f = { type: 'all', role: 'all' };
  const filters = $('filters');
  filters.hidden = false;
  filters.innerHTML = Object.entries(FILTERS).map(([key, opts]) =>
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
      const place = m.placement ? `<span class="place ${m.placement === 1 ? 'win' : ''}">#${m.placement}</span>` : '';
      sec.innerHTML = `
        <div class="match-head">
          ${place}
          <div class="mh-main"><b>${esc(m.map)}</b> <span class="muted">${esc(m.mode)}</span></div>
          <div class="mh-meta">${fmtDate(created)} · ${timeAgo(created)} · ${Math.round((m.duration || 0) / 60)} dk</div>
          <div class="mh-streams">${m.streams.filter((st) => m.cards.some((c) => c.streamer.kick === st.streamer.kick)).map((st) => `<button class="chip" data-start="${esc(st.streamer.kick)}" title="Maçın başından izle">${avatarHTML(st.streamer)}${esc(st.streamer.kick)} ▶</button>`).join('')}</div>
        </div>`;
      sec.querySelectorAll('[data-start]').forEach((b) => {
        const st = m.streams.find((x) => x.streamer.kick === b.dataset.start);
        b.onclick = () => openModal([{ match: m, ev: { type: 'start', other: m.map, weapon: m.mode, time: m.createdAt }, role: roleOf(st, playerName, null),
          streamer: st.streamer, vod: st.vod, at: (created - st.vod.start) / 1000, from: m.map, to: m.mode }], 0);
      });
      const grid = document.createElement('div');
      grid.className = 'card-grid';
      if (!cards.length) grid.innerHTML = `<div class="muted small">${m.events?.length ? 'Bu filtreye uyan an yok.' : 'Bu maçta öldürme/düşürme yok.'}</div>`;
      for (const c of cards) {
        const idx = visible.push(c) - 1;
        grid.appendChild(cardEl(c, () => openModal(visible, idx)));
      }
      sec.appendChild(grid);
      root.appendChild(sec);
    }
    const off = matches.length - inStream.length;
    if (off) root.insertAdjacentHTML('beforeend', `<div class="muted small offline">${off} maçta bir yayıncıyla birebir etkileşim yok.</div>`);
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
  $('modalInfo').innerHTML = `<span class="role-badge ${c.role}">${ROLE_LABEL[c.role]}</span> ${esc(slug)} · ${esc(c.ev.weapon)}${c.ev.distance ? ' · ' + c.ev.distance + ' m' : ''} · ${fmtClock(t)}
    <span class="muted">(${modalIndex + 1}/${modalList.length})</span>`;
  $('prevBtn').disabled = modalIndex <= 0;
  $('nextBtn').disabled = modalIndex >= modalList.length - 1;
  $('kickLink').href = c.vod.uuid ? `https://kick.com/${encodeURIComponent(slug)}/videos/${c.vod.uuid}` : `https://kick.com/${encodeURIComponent(slug)}`;

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
if (query.get('name')) history.replaceState(null, '', playerPath(query.get('shard') || 'steam', query.get('name')) + SUFFIX);
route();

// Footer telif yılı
if ($('year')) $('year').textContent = new Date().getFullYear();

// PWA / Android uygulaması: bağlantı yokken de açılabilmek için service worker
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

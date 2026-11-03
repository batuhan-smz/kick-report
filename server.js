// Kick Report — sunucu
// Yerelde:  npm start  (ayarlar .env dosyasından ya da ortam değişkenlerinden okunur)
// Vercel'de: api/index.js bu dosyadaki handler'ı sunucusuz fonksiyon olarak çalıştırır.
// PUBG anahtarı tarayıcıya hiç gönderilmez; PUBG çağrıları bu sunucu üzerinden yapılır.
// Kick VOD'ları tarayıcıdan çekilir. Sunucu sadece otomatik yayıncı bulma için Kick'in canlı yayın listesini okur.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { createDiscovery } = require('./discovery');
const { createStore } = require('./store');

// .env dosyası (yerel geliştirme): ANAHTAR=değer satırları; zaten tanımlı ortam değişkenlerini ezmez
(function loadDotEnv() {
  let text;
  try { text = fs.readFileSync(path.join(__dirname, '.env'), 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
})();

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.PUBG_API_KEY || '';
const PUBG_BASE = process.env.PUBG_API_BASE || 'https://api.pubg.com';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SHARDS = new Set(['steam', 'kakao', 'console', 'psn', 'xbox', 'stadia']);
const STREAMERS_FILE = process.env.STREAMERS_FILE || path.join(__dirname, 'data', 'streamers.json');
const DISCOVERY_FILE = process.env.DISCOVERY_FILE || path.join(__dirname, 'data', 'discovery.json');
const PUBG_RPM = Number(process.env.PUBG_RPM || 10); // PUBG anahtarının dakikalık oyuncu araması limiti
const ADMIN_PASSWORD_FILE = process.env.ADMIN_PASSWORD_FILE || path.join(__dirname, 'data', 'admin-password.txt');

// --- yönetici girişi ---
// Şifre ADMIN_PASSWORD ortam değişkeninden gelir. Yoksa bir kez rastgele üretilip data/admin-password.txt'ye yazılır.
// Girişte tarayıcıya imzalı, HttpOnly bir çerez verilir; sunucu yeniden başlasa da geçerli kalır, şifre değişince geçersizleşir.
const ADMIN_PASSWORD = loadAdminPassword();
const ADMIN_SECRET = crypto.createHash('sha256').update('kick-report-admin:' + ADMIN_PASSWORD).digest();
const SESSION_MS = 7 * 24 * 3600_000;
const COOKIE = 'kr_admin';

function loadAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  try {
    const saved = fs.readFileSync(ADMIN_PASSWORD_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch { /* yok, üretilecek */ }
  const generated = crypto.randomBytes(12).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(ADMIN_PASSWORD_FILE), { recursive: true });
    fs.writeFileSync(ADMIN_PASSWORD_FILE, generated + '\n', { mode: 0o600 });
  } catch {
    // Salt okunur dosya sistemi (ör. Vercel): ADMIN_PASSWORD verilmeli, yoksa yönetici girişi kullanılamaz
    console.warn('UYARI: ADMIN_PASSWORD tanımlı değil ve şifre dosyası yazılamadı; yönetici girişi kapalı.');
  }
  return generated;
}

const sign = (data) => crypto.createHmac('sha256', ADMIN_SECRET).update(data).digest('base64url');
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function makeSession() {
  const exp = String(Date.now() + SESSION_MS);
  return `${exp}.${sign(exp)}`;
}
function isAdmin(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return !!exp && !!sig && Number(exp) > Date.now() && safeEqual(sig, sign(exp));
}
function sessionCookie(req, value, maxAgeSec) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}
function requireAdmin(req) {
  if (!isAdmin(req)) throw httpError(401, 'Bu işlem için yönetici girişi gerekli.');
}

// Şifre denemesi sınırı: bir IP 15 dakikada en fazla 10 yanlış deneme yapabilir
const loginFails = new Map(); // ip -> [zamanlar]
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}
function recentFails(ip) {
  const t = Date.now() - 15 * 60_000;
  const list = (loginFails.get(ip) || []).filter((x) => x > t);
  loginFails.set(ip, list);
  return list;
}

// --- kalıcı depolama: yerelde data/ klasörü, Vercel'de özel Blob deposu ---
const store = createStore({ streamers: STREAMERS_FILE, discovery: DISCOVERY_FILE });
// Sunucusuz ortamda birden çok örnek aynı veriyi yazabilir: kısa aralıklarla depodan tazele,
// yazmadan hemen önce son hâli oku. Yerelde tek yazan bu süreç olduğu için bellek yeterli.
const SERVERLESS = store.kind === 'blob';
const READ_TTL = SERVERLESS ? 15_000 : Infinity;
const FRESH = SERVERLESS ? 0 : Infinity;

// --- yayıncı kaydı: PUBG adı -> Kick kanalı ---
// source: 'manual' (elle eklenen) ya da 'auto' (otomatik bulunan)
let streamers = [];
let streamersLoadedAt = 0;
async function loadStreamers(maxAgeMs = READ_TTL) {
  if (streamersLoadedAt && Date.now() - streamersLoadedAt < maxAgeMs) return;
  const list = await store.get('streamers', []);
  streamers = Array.isArray(list) ? list : [];
  streamersLoadedAt = Date.now();
}
async function saveStreamers() {
  await store.set('streamers', streamers);
}
async function upsertStreamer(entry) {
  await loadStreamers(FRESH);
  const key = entry.pubgName.toLowerCase();
  // Elle eklenen kayıt, aynı kanal için otomatik bulunanın yerine geçer
  streamers = streamers.filter((s) => s.pubgName.toLowerCase() !== key && !(entry.source === 'manual' && s.source === 'auto' && s.kick === entry.kick));
  streamers.push(entry);
  await saveStreamers();
}
function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > limit) { reject(httpError(413, 'İstek çok büyük')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(httpError(400, 'Geçersiz JSON')); } });
    req.on('error', reject);
  });
}

// Maç katılımcıları arasındaki kayıtlı yayıncılar (steam ve kakao aynı maçta olabildiği için platforma bakılmaz)
function streamersIn(match) {
  const names = new Set((match.included || [])
    .filter((x) => x.type === 'participant')
    .map((x) => (x.attributes?.stats?.name || '').toLowerCase()));
  return streamers.filter((s) => names.has(s.pubgName.toLowerCase()));
}

// --- basit bellek içi önbellek (maç ve telemetri verisi değişmez) ---
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { val, exp: Date.now() + ttlMs });
  return val;
}

// Oyuncu aramaları dakikalık limite sayılır; otomatik bulma kullanıcılara pay bırakmak için bunu izler
const lookupLog = [];
function lookupsLastMinute() {
  const t = Date.now() - 60_000;
  while (lookupLog.length && lookupLog[0] < t) lookupLog.shift();
  return lookupLog.length;
}

async function pubg(pathname) {
  if (!API_KEY) throw httpError(500, 'PUBG_API_KEY tanımlı değil. Sunucuyu PUBG_API_KEY=... ile başlatın.');
  if (pathname.includes('/players')) lookupLog.push(Date.now());
  const res = await fetch(PUBG_BASE + pathname, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/vnd.api+json' },
  });
  if (res.status === 404) throw httpError(404, 'PUBG: bulunamadı (oyuncu adı büyük/küçük harfe duyarlıdır).');
  if (res.status === 429) throw httpError(429, 'PUBG istek limiti aşıldı (varsayılan anahtar: dakikada 10). Biraz bekleyin.');
  if (res.status === 400) throw httpError(400, 'PUBG: geçersiz istek (oyuncu adını kontrol edin).');
  if (!res.ok) throw httpError(502, `PUBG API hatası: ${res.status}`);
  return res.json();
}

async function fetchTelemetry(url) {
  const res = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
  if (!res.ok) throw httpError(502, `Telemetri indirilemedi: ${res.status}`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf); // fetch açmadıysa biz açalım
  return JSON.parse(buf.toString('utf8'));
}

// --- telemetriden oyuncuya ait olayları çıkar ---
const MAPS = {
  Baltic_Main: 'Erangel', Erangel_Main: 'Erangel', Desert_Main: 'Miramar', Savage_Main: 'Sanhok',
  DihorOtok_Main: 'Vikendi', Tiger_Main: 'Taego', Kiki_Main: 'Deston', Neon_Main: 'Rondo',
  Summerland_Main: 'Karakin', Chimera_Main: 'Paramo', Heaven_Main: 'Haven', Range_Main: 'Camp Jackal',
};
const meters = (cm) => (typeof cm === 'number' && cm > 0 ? Math.round(cm / 100) : null); // telemetri mesafesi cm cinsinden
const prettyWeapon = (w) => (w || '').replace(/^Weap/, '').replace(/^Proj/, '').replace(/_C$/, '').replace(/_/g, ' ') || 'Bilinmiyor';

function extractEvents(telemetry, playerName) {
  const me = playerName.toLowerCase();
  const is = (c) => c && c.name && c.name.toLowerCase() === me;
  const events = [];
  for (const e of telemetry) {
    const t = e._T;
    if (t === 'LogPlayerKillV2') {
      const killer = e.finisher || e.killer;
      const info = e.finishDamageInfo || e.killerDamageInfo || {};
      const weapon = prettyWeapon(info.damageCauserName);
      const distance = meters(info.distance);
      if (is(killer) && !is(e.victim)) events.push({ type: 'kill', time: e._D, other: e.victim?.name, weapon, distance });
      else if (is(e.victim)) events.push({ type: 'death', time: e._D, other: killer?.name || 'Çevre / mavi bölge', weapon, distance });
    } else if (t === 'LogPlayerMakeGroggy') {
      const weapon = prettyWeapon(e.damageCauserName);
      const distance = meters(e.distance);
      if (is(e.attacker) && !is(e.victim)) events.push({ type: 'knock', time: e._D, other: e.victim?.name, weapon, distance });
      else if (is(e.victim)) events.push({ type: 'knocked', time: e._D, other: e.attacker?.name || '?', weapon, distance });
    }
  }
  return events.sort((a, b) => a.time.localeCompare(b.time));
}

// --- API uç noktaları ---
async function handleApi(req, url, res) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  await loadStreamers();

  // GET|POST /api/cron/discovery -> otomatik bulmanın bir turu (GitHub Actions her 30 dk çağırır)
  // Authorization: Bearer <CRON_SECRET>
  if (parts[1] === 'cron' && parts[2] === 'discovery') {
    const secret = process.env.CRON_SECRET;
    const auth = String(req.headers.authorization || '');
    if (!secret || !safeEqual(auth, 'Bearer ' + secret)) throw httpError(401, 'Yetkisiz');
    if (!discovery) throw httpError(503, 'Otomatik bulma kapalı (PUBG_API_KEY yok ya da DISCOVERY=0).');
    await loadStreamers(FRESH);
    const started = Date.now();
    await discovery.tick({ reload: true });
    const st = await discovery.status();
    return { ok: true, ms: Date.now() - started, liveNow: st.liveNow, totals: st.totals, lastError: st.lastError };
  }

  // GET  /api/admin/me      -> { admin: true|false }
  // POST /api/admin/login   -> { password } doğruysa yönetici çerezi verir
  // POST /api/admin/logout  -> çerezi siler
  if (parts[1] === 'admin') {
    if (req.method === 'GET' && parts[2] === 'me') return { admin: isAdmin(req) };
    if (req.method === 'POST' && parts[2] === 'login') {
      const ip = clientIp(req);
      if (recentFails(ip).length >= 10) throw httpError(429, 'Çok fazla yanlış deneme. 15 dakika sonra tekrar dene.');
      const b = await readBody(req);
      if (!safeEqual(b.password || '', ADMIN_PASSWORD)) {
        loginFails.get(ip).push(Date.now());
        throw httpError(401, 'Şifre yanlış.');
      }
      loginFails.delete(ip);
      res.setHeader('Set-Cookie', sessionCookie(req, makeSession(), SESSION_MS / 1000));
      return { admin: true };
    }
    if (req.method === 'POST' && parts[2] === 'logout') {
      res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
      return { admin: false };
    }
    // POST /api/admin/import -> { streamers?: [...], discovery?: {...} } başka bir kurulumdan veri aktarımı
    // Yayıncılar birleştirilir (aynı PUBG adında gelen kayıt geçerli olur), discovery verilirse yerine geçer.
    if (req.method === 'POST' && parts[2] === 'import') {
      requireAdmin(req);
      const b = await readBody(req, 5_000_000);
      let added = 0;
      if (Array.isArray(b.streamers)) {
        await loadStreamers(FRESH);
        const valid = b.streamers.filter((s) => s && typeof s.pubgName === 'string' && typeof s.kick === 'string' && SHARDS.has(s.shard || 'steam'));
        const incoming = new Set(valid.map((s) => s.pubgName.toLowerCase()));
        streamers = streamers.filter((s) => !incoming.has(s.pubgName.toLowerCase())).concat(valid);
        added = valid.length;
        await saveStreamers();
      }
      if (b.discovery && typeof b.discovery === 'object' && b.discovery.candidates) {
        await store.set('discovery', b.discovery);
        if (discovery) await discovery.ensureLoaded(0);
      }
      return { ok: true, streamers: streamers.length, imported: added, discovery: !!b.discovery };
    }
    throw httpError(404, 'Bilinmeyen uç nokta');
  }

  // GET    /api/streamers           -> kayıtlı yayıncılar (herkese açık; arama ve ana sayfa kullanır)
  // POST   /api/streamers           -> { pubgName, shard, kick } ekle / güncelle   (yönetici)
  // DELETE /api/streamers/:pubgName -> kaydı sil                                  (yönetici)
  if (parts[1] === 'streamers') {
    // live: şu an Kick'te PUBG yayını açık mı (son taramaya göre)
    if (req.method === 'GET' && !parts[2]) {
      if (discovery) await discovery.ensureLoaded(SERVERLESS ? 60_000 : Infinity).catch(() => {});
      return streamers.map((s) => ({ ...s, live: discovery ? discovery.isLive(s.kick) : false }));
    }
    requireAdmin(req);
    if (req.method === 'POST' && !parts[2]) {
      const b = await readBody(req);
      const shard = String(b.shard || 'steam');
      const kick = String(b.kick || '').trim().toLowerCase();
      const pubgName = String(b.pubgName || '').trim();
      if (!SHARDS.has(shard)) throw httpError(400, 'Geçersiz platform');
      if (!/^[a-z0-9_-]{2,40}$/.test(kick)) throw httpError(400, 'Geçersiz Kick kanal adı');
      if (!pubgName) throw httpError(400, 'PUBG adı gerekli');
      // PUBG'de var mı bak, adın doğru yazımını al
      const data = await cached(`p:${shard}:${pubgName}`, 60_000, () =>
        pubg(`/shards/${shard}/players?filter[playerNames]=${encodeURIComponent(pubgName)}`));
      const p = data.data?.[0];
      if (!p) throw httpError(404, 'PUBG oyuncusu bulunamadı');
      const entry = { pubgName: p.attributes.name, shard, kick, source: 'manual' };
      await upsertStreamer(entry);
      return entry;
    }
    if (req.method === 'DELETE' && parts[2]) {
      const n = decodeURIComponent(parts[2]).toLowerCase();
      await loadStreamers(FRESH);
      const gone = streamers.filter((s) => s.pubgName.toLowerCase() === n);
      streamers = streamers.filter((s) => s.pubgName.toLowerCase() !== n);
      await saveStreamers();
      // silinen otomatik eşleşme bir sonraki taramada geri eklenmesin
      for (const s of gone.filter((x) => x.source === 'auto')) await discovery?.reject(s.kick);
      return { ok: true };
    }
    throw httpError(405, 'Desteklenmeyen istek');
  }

  // GET /api/discovery -> otomatik bulma durumu (yönetici)
  if (parts[1] === 'discovery' && req.method === 'GET') {
    requireAdmin(req);
    if (!discovery) return { enabled: false };
    return { enabled: true, ...(await discovery.status(FRESH)) };
  }

  // GET /api/pubg/:shard/player/:name  -> oyuncu + son maç id'leri
  if (parts[1] === 'pubg' && parts[3] === 'player' && parts[4]) {
    const shard = parts[2];
    if (!SHARDS.has(shard)) throw httpError(400, 'Geçersiz platform');
    const name = decodeURIComponent(parts[4]);
    const data = await cached(`p:${shard}:${name}`, 60_000, () =>
      pubg(`/shards/${shard}/players?filter[playerNames]=${encodeURIComponent(name)}`));
    const p = data.data?.[0];
    if (!p) throw httpError(404, 'Oyuncu bulunamadı');
    return {
      id: p.id,
      name: p.attributes.name,
      matchIds: (p.relationships?.matches?.data || []).map((m) => m.id),
    };
  }

  // GET /api/pubg/:shard/match/:id  -> maç özeti (telemetri yok)
  // GET /api/pubg/:shard/match/:id/events?player=Name -> oyuncunun öldürme/düşürme olayları
  if (parts[1] === 'pubg' && parts[3] === 'match' && parts[4]) {
    const shard = parts[2];
    if (!SHARDS.has(shard)) throw httpError(400, 'Geçersiz platform');
    const id = parts[4].replace(/[^a-zA-Z0-9-]/g, '');
    const match = await cached(`m:${shard}:${id}`, 24 * 3600_000, () => pubg(`/shards/${shard}/matches/${id}`));
    const a = match.data.attributes;
    const summary = {
      id, createdAt: a.createdAt, duration: a.duration, map: MAPS[a.mapName] || a.mapName,
      mode: a.gameMode, matchType: a.matchType,
      streamers: streamersIn(match), // bu maçta oynayan kayıtlı yayıncılar
    };
    if (parts[5] !== 'events') return summary;

    const player = url.searchParams.get('player');
    if (!player) throw httpError(400, 'player parametresi gerekli');
    const asset = (match.included || []).find((x) => x.type === 'asset');
    if (!asset) throw httpError(502, 'Maçın telemetri dosyası yok');
    const telemetry = await cached(`t:${id}`, 3600_000, () => fetchTelemetry(asset.attributes.URL));
    const me = (match.included || []).find((x) => x.type === 'participant' && (x.attributes?.stats?.name || '').toLowerCase() === player.toLowerCase());
    return { ...summary, placement: me?.attributes?.stats?.winPlace ?? null, events: extractEvents(telemetry, player) };
  }

  throw httpError(404, 'Bilinmeyen uç nokta');
}

// --- Android uygulaması (TWA) doğrulaması: /.well-known/assetlinks.json ---
// Android, uygulamayı adres çubuğu olmadan açmadan önce bu dosyada uygulamanın paket adını ve
// imza parmak izini (SHA-256) arar. Parmak izleri TWA_SHA256 (virgülle ayrılmış) ortam değişkeninden
// ya da android/build.ps1'in yazdığı android/keystore/sha256.txt dosyasından okunur.
// Play App Signing kullanılıyorsa Google'ın imza parmak izi de TWA_SHA256'ya eklenmeli.
const TWA_PACKAGE = process.env.TWA_PACKAGE || 'com.kickreport.app';
const TWA_FINGERPRINT_FILE = process.env.TWA_FINGERPRINT_FILE || path.join(__dirname, 'android', 'keystore', 'sha256.txt');
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
function twaFingerprints() {
  let list = (process.env.TWA_SHA256 || '').split(',');
  if (!process.env.TWA_SHA256) {
    try { list = fs.readFileSync(TWA_FINGERPRINT_FILE, 'utf8').split(/\r?\n/); } catch { list = []; }
  }
  return [...new Set(list.map((s) => s.trim().toUpperCase()).filter((s) => FINGERPRINT.test(s)))];
}
function assetLinks() {
  const fingerprints = twaFingerprints();
  if (!fingerprints.length) return null;
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: TWA_PACKAGE, sha256_cert_fingerprints: fingerprints },
  }];
}

// --- statik dosyalar + yönlendirme ---
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};
// Kod dosyaları her açılışta kontrol edilsin (yeni sürüm hemen gelsin); ikonlar bir gün önbellekte kalabilir
const cacheHeader = (ext) => (ext === '.png' || ext === '.ico' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache');
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// İstek işleyici: yerelde http sunucusu, Vercel'de api/index.js aynı fonksiyonu kullanır
async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // Vercel yönlendirmesi asıl yolu ?__path= ile iletir (vercel.json)
  const forced = url.searchParams.get('__path');
  if (forced) { url.pathname = forced; url.searchParams.delete('__path'); }
  if (url.pathname === '/.well-known/assetlinks.json') {
    const links = assetLinks();
    res.writeHead(links ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(links || { error: 'İmza parmak izi yok. android/build.ps1 çalıştırın ya da TWA_SHA256 verin.' }));
  }
  if (url.pathname.startsWith('/api/')) {
    try {
      const body = await handleApi(req, url, res);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch (e) {
      res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      if (!e.status) console.error(e);
    }
    return;
  }
  const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    // /players/steam/Ad, /streamers gibi uzantısız adresler tek sayfalık uygulamaya gider
    if (err && !path.extname(file)) {
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(500); return res.end(); }
        res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
        res.end(html);
      });
    }
    if (err) { res.writeHead(404); return res.end('Bulunamadı'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cacheHeader(ext) });
    res.end(data);
  });
}
const server = http.createServer(handler);

// --- otomatik yayıncı bulma (DISCOVERY=0 ile kapatılır) ---
const discovery = API_KEY && process.env.DISCOVERY !== '0' ? createDiscovery({
  store,
  // Vercel'de tarama 30 dakikada bir yapılıyor; "canlı" bilgisi bir sonraki taramaya kadar geçerli sayılır
  liveTtlMs: SERVERLESS ? 40 * 60_000 : undefined,
  kickBase: process.env.KICK_BASE || 'https://kick.com',
  rpm: PUBG_RPM,
  reserve: Number(process.env.DISCOVERY_RESERVE || 4),
  maxPages: Number(process.env.DISCOVERY_MAX_PAGES || 10),
  lookupsLastMinute,
  isMapped: (slug) => streamers.some((s) => s.kick === slug),
  addStreamer: async (entry) => {
    await loadStreamers(FRESH);
    if (!streamers.some((s) => s.kick === entry.kick)) await upsertStreamer(entry);
  },
  matchCreatedAt: async (id) => {
    const m = await cached(`m:steam:${id}`, 24 * 3600_000, () => pubg(`/shards/steam/matches/${id}`));
    return new Date(m.data.attributes.createdAt).getTime();
  },
  pubgPlayers: async (names) => {
    try {
      const data = await pubg(`/shards/steam/players?filter[playerNames]=${names.map(encodeURIComponent).join(',')}`);
      return (data.data || []).map((p) => ({ name: p.attributes.name, id: p.id, matchIds: (p.relationships?.matches?.data || []).map((m) => m.id) }));
    } catch (e) {
      if (e.status === 404) return []; // paketteki isimlerin hiçbiri yok
      throw e;
    }
  },
}) : null;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Kick Report çalışıyor: http://localhost:${PORT}`);
    console.log(process.env.ADMIN_PASSWORD
      ? `Yönetici sayfası: http://localhost:${PORT}/streamers (şifre: ADMIN_PASSWORD)`
      : `Yönetici sayfası: http://localhost:${PORT}/streamers (şifre ${ADMIN_PASSWORD_FILE} dosyasında)`);
    if (!API_KEY) console.log('Uyarı: PUBG_API_KEY yok. Sadece demo modu çalışır: http://localhost:' + PORT + '/?demo=1');
    if (discovery) {
      console.log('Otomatik yayıncı bulma açık (kapatmak için DISCOVERY=0).');
      loadStreamers().then(() => discovery.start());
    }
  });
}

module.exports = { extractEvents, server, handler, discovery, loadStreamers };

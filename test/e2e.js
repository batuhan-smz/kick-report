// Sahte PUBG API + sahte Kick yanıtı ile uçtan uca test
// Çalıştırma: npm test  (playwright gerekir; PW_CHANNEL=msedge ile sistemdeki Edge kullanılabilir)
const http = require('http'); const zlib = require('zlib'); const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
// server.js daha ilk yüklemede şifreyi okur; ayarlanmazsa projedeki data/ klasörüne şifre dosyası üretirdi
process.env.ADMIN_PASSWORD = 'gizli-sifre';
process.env.DISCOVERY = '0';
const { extractEvents } = require('../server.js');
delete process.env.DISCOVERY;
const P = (n) => ({ name: n, accountId: 'a.' + n });
const tel = [
  { _T: 'LogMatchStart', _D: '2026-11-02T22:00:00Z' },
  { _T: 'LogPlayerMakeGroggy', _D: '2026-11-02T22:05:00.100Z', attacker: P('Me'), victim: P('Bob'), damageCauserName: 'WeapHK416_C', distance: 4520 },
  { _T: 'LogPlayerKillV2', _D: '2026-11-02T22:05:10Z', killer: P('Me'), finisher: P('Me'), victim: P('Bob'), finishDamageInfo: { damageCauserName: 'WeapHK416_C' } },
  { _T: 'LogPlayerKillV2', _D: '2026-11-02T22:06:00Z', killer: P('X'), finisher: P('X'), victim: P('Y') },
  { _T: 'LogPlayerMakeGroggy', _D: '2026-11-02T22:20:00Z', attacker: P('Zed'), victim: P('me'), damageCauserName: 'WeapKar98k_C' },
  { _T: 'LogPlayerKillV2', _D: '2026-11-02T22:20:05Z', killer: null, finisher: null, victim: P('Me') },
];
const ev = extractEvents(tel, 'Me');
assert.deepStrictEqual(ev.map(e => e.type), ['knock', 'kill', 'knocked', 'death']);
assert.strictEqual(ev[0].weapon, 'HK416'); assert.strictEqual(ev[0].distance, 45); assert.strictEqual(ev[3].other, 'Çevre / mavi bölge');
console.log('extractEvents OK');

const participant = (n) => ({ type: 'participant', attributes: { stats: { name: n, winPlace: 3 } } });
const mock = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url);
  if (u.startsWith('/shards/steam/players')) {
    const n = u.split('=').pop();
    return res.end(JSON.stringify({ data: [{ id: 'acc.' + n, attributes: { name: n }, relationships: { matches: { data: [{ id: 'm1' }, { id: 'm2' }] } } }] }));
  }
  if (u === '/shards/steam/matches/m1') return res.end(JSON.stringify({ data: { attributes: { createdAt: '2026-11-02T22:00:00Z', duration: 1800, mapName: 'Baltic_Main', gameMode: 'squad-fpp' } },
    included: [participant('Me'), participant('Bob'), participant('X'), { type: 'asset', attributes: { URL: 'http://127.0.0.1:4100/tel.json' } }] }));
  if (u === '/shards/steam/matches/m2') return res.end(JSON.stringify({ data: { attributes: { createdAt: '2026-10-01T10:00:00Z', duration: 1500, mapName: 'Desert_Main', gameMode: 'solo' } }, included: [participant('Me')] }));
  if (u === '/tel.json') { res.setHeader('Content-Type', 'application/octet-stream'); return res.end(zlib.gzipSync(JSON.stringify(tel))); }
  res.statusCode = 404; res.end('{}');
}).listen(4100);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kick-report-'));
process.env.STREAMERS_FILE = path.join(tmp, 'streamers.json');
process.env.DISCOVERY_FILE = path.join(tmp, 'discovery.json');
process.env.PUBG_API_KEY = 'test'; process.env.PUBG_API_BASE = 'http://127.0.0.1:4100';
process.env.ADMIN_PASSWORD = 'gizli-sifre';
delete require.cache[require.resolve('../server.js')];
const { server } = require('../server.js');
server.listen(4000, async () => {
  let cookie = '';
  const raw = (p, opts = {}) => fetch('http://localhost:4000' + p, { ...opts, headers: { 'Content-Type': 'application/json', cookie, ...(opts.headers || {}) } });
  const api = (p, opts) => raw(p, opts).then(r => r.json());
  const add = (pubgName, kick) => api('/api/streamers', { method: 'POST', body: JSON.stringify({ pubgName, shard: 'steam', kick }) });

  // yönetici koruması: girişsiz ekleme/silme/durum yok, yanlış şifre reddedilir, sahte çerez geçmez
  assert.strictEqual((await raw('/api/streamers', { method: 'POST', body: JSON.stringify({ pubgName: 'Me', kick: 'testkanal' }) })).status, 401);
  assert.strictEqual((await raw('/api/streamers/Me', { method: 'DELETE' })).status, 401);
  assert.strictEqual((await raw('/api/discovery')).status, 401);
  assert.strictEqual((await raw('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'yanlis' }) })).status, 401);
  assert.strictEqual((await raw('/api/streamers', { method: 'POST', headers: { cookie: `kr_admin=${Date.now() + 1e9}.sahte` }, body: '{}' })).status, 401);
  assert.deepStrictEqual(await api('/api/admin/me'), { admin: false });
  const login = await raw('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'gizli-sifre' }) });
  assert.strictEqual(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.ok(/HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), setCookie);
  cookie = setCookie.split(';')[0];
  assert.deepStrictEqual(await api('/api/admin/me'), { admin: true });
  assert.strictEqual((await api('/api/streamers')).length, 0); // liste herkese açık
  console.log('admin API OK');
  // Me'nin kendi kanalı + rakip Bob'un kanalı. Aranan oyuncu kayıtlı olmasa da rakibin yayını bulunmalı.
  assert.strictEqual((await add('Me', 'testkanal')).kick, 'testkanal');
  await add('Bob', 'BobKanal');
  await add('Nobody', 'yok');
  await add('X', 'xkanal'); // aynı maçta ama Me ile etkileşimi yok
  assert.strictEqual((await api('/api/streamers')).length, 4);
  const m1 = await api('/api/pubg/steam/match/m1');
  assert.deepStrictEqual(m1.streamers.map(s => s.kick).sort(), ['bobkanal', 'testkanal', 'xkanal']);
  console.log('streamers API OK');

  const { chromium } = require(process.env.PW_MODULE || 'playwright');
  const b = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  const p = await b.newPage({ viewport: { width: 1280, height: 1000 } });
  p.on('console', m => console.log('console:', m.text())); p.on('pageerror', e => console.log('pageerror', e.message));
  const kickCalls = [];
  await p.route('https://kick.com/api/v2/**', r => { kickCalls.push(r.request().url()); r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify([{ start_time: '2026-11-02 21:28:33', duration: 44840000, is_live: false, source: 'https://stream.kick.com/x/master.m3u8', session_title: 't', video: { uuid: 'u1' } }]) }); });
  // Gerçek Kick kayıtları gibi: kayıt Kick'in bildirdiği başlangıçtan (21:28:33) 3 sn önce başlıyor
  // ve 21:40:00'da yayın 30 sn kopuyor. Segment saatleri #EXT-X-PROGRAM-DATE-TIME ile veriliyor.
  const playlist = (() => {
    const out = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10', '#EXT-X-PLAYLIST-TYPE:EVENT'];
    const seg = (ms, i, disc) => { if (disc) out.push('#EXT-X-DISCONTINUITY'); out.push('#EXT-X-PROGRAM-DATE-TIME:' + new Date(ms).toISOString(), '#EXTINF:10.000,', i + '.ts'); };
    let t = Date.parse('2026-11-02T21:28:30Z'), i = 0;
    for (; t < Date.parse('2026-11-02T21:40:00Z'); t += 10000) seg(t, i++);
    t += 30000; seg(t, i++, true); t += 10000;
    for (let k = 0; k < 720; k++, t += 10000) seg(t, i++);
    return out.concat('#EXT-X-ENDLIST').join('\n');
  })();
  await p.route('https://stream.kick.com/**', r => {
    const u = r.request().url();
    const hdr = { 'access-control-allow-origin': '*', 'content-type': 'application/vnd.apple.mpegurl' };
    if (u.endsWith('master.m3u8')) return r.fulfill({ headers: hdr, body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=230000,CODECS="avc1.4D401F,mp4a.40.2",RESOLUTION=284x160\n160p30/playlist.m3u8' });
    if (u.endsWith('playlist.m3u8')) return r.fulfill({ headers: hdr, body: playlist });
    r.fulfill({ status: 404, body: '' });
  });
  const shot = async (n) => { if (process.env.SHOT_DIR) await p.screenshot({ path: path.join(process.env.SHOT_DIR, n + '.png'), fullPage: true }); };
  // ana sayfa: kayıtlı yayıncılar listelenir, aramadan oyuncu sayfasına gidilir
  await p.goto('http://localhost:4000/');
  await p.waitForSelector('.streamer-card');
  assert.strictEqual(await p.locator('.streamer-card').count(), 4);
  await shot('home');
  await p.fill('#heroSearch input[name=name]', 'Me');
  await p.click('#heroSearch button');
  await p.waitForSelector('.card', { timeout: 15000 });
  assert.strictEqual(new URL(p.url()).pathname, '/players/steam/Me');
  const rows = await p.$$eval('.card', els => els.map(e => e.innerText.replace(/\s+/g, ' ')));
  console.log(rows);
  // sadece maçta olan kanalların videoları sorgulanmalı (Nobody/yok maçta değil)
  const vodCalls = kickCalls.filter(u => u.endsWith('/videos')).map(u => u.split('/')[6]).sort();
  assert.deepStrictEqual(vodCalls, ['bobkanal', 'testkanal', 'xkanal']);
  // Sadece birebir etkileşimler: 4 olay kendi yayınında + Bob'la olan 2 olay Bob'un yayınında = 6 kart.
  // X aynı maçta ama Me ile hiç çatışmadı: kartı ve maç başı butonu olmamalı. 22:05:00.1 - 21:28:33 = 36:27
  assert.strictEqual(rows.length, 6);
  assert.ok(/Kendi yayını 36:27 .*Düşürme Me → Bob HK416 · 45 m T testkanal/i.test(rows[0]), rows[0]);
  assert.ok(/Rakip tepkisi 36:27 .*Me → Bob .* bobkanal/i.test(rows[1]), rows[1]);
  assert.ok(rows.every(r => !r.includes('Aynı maç') && !r.includes('xkanal')));
  assert.ok(rows.filter(r => r.includes('bobkanal')).every(r => r.includes('Bob')));
  const head = await p.textContent('.match-head');
  assert.ok(head.includes('#3') && head.includes('bobkanal') && !head.includes('xkanal'), head);
  await shot('player');
  // filtreler
  await p.click('.tabs[data-key=role] button[data-v=enemy]');
  assert.strictEqual(await p.locator('.card').count(), 2);
  await p.click('.tabs[data-key=type] button[data-v=death]');
  assert.strictEqual(await p.locator('.card').count(), 0);
  await p.click('.tabs[data-key=type] button[data-v=all]');
  // video penceresi + sonraki
  await p.click('.card.enemy >> nth=1'); await p.waitForTimeout(500);
  assert.ok(!(await p.isHidden('#modal')));
  const info = await p.textContent('#modalInfo'); console.log('modal:', info);
  assert.ok(info.includes('bobkanal') && info.includes('2/2'));
  // Açık kart öldürme: 22:05:10, 10 sn önce = 22:05:00. Kayıt 21:28:30'da başladı, arada 30 sn kopma var:
  // 2190 − 30 = 2160 sn = 36:00. Eski hesap (olay − yayın başlangıcı − 10) 36:27 verirdi, yani 27 sn geç.
  assert.ok(info.includes('36:00'), info);
  await p.click('#prevBtn');
  // Düşürme 22:05:00.1 → 22:04:50.1 → 2180.1 − 30 = 2150.1 sn = 35:50
  assert.ok((await p.textContent('#modalInfo')).includes('35:50'));
  await p.click('#nextBtn');
  await p.click('#prevBtn');
  assert.ok((await p.textContent('#modalInfo')).includes('1/2'));
  await shot('modal');
  await p.keyboard.press('Escape');
  assert.ok(await p.isHidden('#modal'));
  // H.264 desteği olmayan tarayıcı (ör. VS Code içindeki tarayıcı): anlaşılır uyarı gösterilmeli
  const p2 = await b.newPage();
  await p2.addInitScript(() => {
    MediaSource.isTypeSupported = () => false;
    const orig = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (t) { return /mpegurl/i.test(t) ? '' : orig.call(this, t); };
  });
  await p2.route('https://kick.com/api/v2/**', r => r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify([{ start_time: '2026-11-02 21:28:33', duration: 44840000, is_live: false, source: 'https://stream.kick.com/x/master.m3u8', session_title: 't', video: { uuid: 'u1' } }]) }));
  await p2.goto('http://localhost:4000/players/steam/Me');
  await p2.click('.card >> nth=0');
  const err = await p2.textContent('.play-error');
  console.log('codec uyarısı:', err);
  assert.ok(err.includes('H.264'));
  await p2.close();
  // yayıncılar sayfası: menüde bağlantısı yok, sadece adresle açılır ve şifre ister
  assert.strictEqual(await p.locator('a[href="/streamers"]').count(), 0);
  await p.goto('http://localhost:4000/streamers');
  await p.waitForSelector('#loginForm');
  assert.strictEqual(await p.locator('.streamer-row').count(), 0);
  await shot('login');
  await p.fill('#loginForm input[name=password]', 'yanlis');
  await p.click('#loginForm button');
  await p.waitForSelector('#loginStatus.error');
  assert.ok((await p.textContent('#loginStatus')).includes('yanlış'));
  await p.fill('#loginForm input[name=password]', 'gizli-sifre');
  await p.click('#loginForm button');
  await p.waitForSelector('.streamer-row');
  assert.strictEqual(await p.locator('.streamer-row').count(), 4);
  await shot('streamers');
  // sayfa yenilenince giriş korunur, çıkışta tekrar şifre ister
  await p.reload();
  await p.waitForSelector('.streamer-row');
  await p.click('#logoutBtn');
  await p.waitForSelector('#heroSearch');
  await p.goto('http://localhost:4000/streamers');
  await p.waitForSelector('#loginForm');
  if (process.env.SHOT_DIR) {
    await p.goto('http://localhost:4000/players/steam/Me'); await p.waitForSelector('.card');
    await p.setViewportSize({ width: 390, height: 844 }); await shot('player-m');
  }
  await b.close(); server.close(); mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); console.log('E2E OK');
});

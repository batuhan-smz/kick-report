// Sahte PUBG API + sahte Riot API + sahte Kick yanıtı ile uçtan uca test
// Çalıştırma: npm test  (playwright gerekir; PW_CHANNEL=msedge ile sistemdeki Edge kullanılabilir)
const http = require('http'); const zlib = require('zlib'); const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
// server.js daha ilk yüklemede şifreyi okur; ayarlanmazsa projedeki data/ klasörüne şifre dosyası üretirdi
process.env.ADMIN_PASSWORD = 'gizli-sifre';
process.env.DISCOVERY = '0';
const { extractEvents } = require('../server.js');
const { extractLolEvents, parseRiotId } = require('../lol.js');
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

// --- LoL: Oyuncu#TR1 (Ahri) maçta yayıncı Rakip#TR1'i (Zed) öldürüyor ve ondan ölüyor;
//     aynı maçtaki yayıncı Seyirci#TR1 (Lux) oyuncuyla hiç karşılaşmıyor; bir ölüm de kuleden.
const LOL_START = Date.parse('2026-11-02T22:00:00Z');
const LOL_ACCOUNTS = {
  'oyuncu#tr1': { puuid: 'p-me', gameName: 'Oyuncu', tagLine: 'TR1' },
  'rakip#tr1': { puuid: 'p-rakip', gameName: 'Rakip', tagLine: 'TR1' },
  'seyirci#tr1': { puuid: 'p-x', gameName: 'Seyirci', tagLine: 'TR1' },
};
const lp = (id, puuid, name, champ, win, k, d, a) => ({ participantId: id, puuid, riotIdGameName: name, riotIdTagline: 'TR1', championName: champ, win, kills: k, deaths: d, assists: a });
const LOL_MATCH = {
  metadata: { matchId: 'TR1_1001', participants: ['p-me', 'p-rakip', 'p-x'] },
  info: { gameStartTimestamp: LOL_START, gameDuration: 1800, queueId: 420, gameMode: 'CLASSIC',
    participants: [lp(1, 'p-me', 'Oyuncu', 'Ahri', true, 5, 2, 7), lp(6, 'p-rakip', 'Rakip', 'Zed', false, 1, 4, 2), lp(7, 'p-x', 'Seyirci', 'Lux', true, 3, 1, 9)] },
};
const LOL_TL = { info: { participants: [{ participantId: 1, puuid: 'p-me' }, { participantId: 6, puuid: 'p-rakip' }, { participantId: 7, puuid: 'p-x' }], frames: [
  { events: [{ type: 'CHAMPION_KILL', timestamp: 300100, killerId: 1, victimId: 6 }, { type: 'WARD_PLACED', timestamp: 310000 }] },
  { events: [{ type: 'CHAMPION_KILL', timestamp: 400000, killerId: 7, victimId: 6 }] },
  { events: [{ type: 'CHAMPION_KILL', timestamp: 900000, killerId: 6, victimId: 1 }, { type: 'CHAMPION_KILL', timestamp: 1000000, killerId: 0, victimId: 1 }] },
] } };
const lev = extractLolEvents(LOL_MATCH, LOL_TL, 'p-me');
assert.deepStrictEqual(lev.map((e) => [e.type, e.other, e.weapon]), [
  ['kill', 'Rakip#TR1', 'Ahri → Zed'], ['death', 'Rakip#TR1', 'Zed → Ahri'], ['death', 'Kule / minyon', 'Kule / minyon → Ahri']]);
assert.strictEqual(lev[0].time, '2026-11-02T22:05:00.100Z');
assert.strictEqual(lev[0].otherPuuid, 'p-rakip');
assert.deepStrictEqual(parseRiotId('Faker'), { gameName: 'Faker', tagLine: 'TR1' });
assert.deepStrictEqual(parseRiotId(' Hide on bush #KR1 '), { gameName: 'Hide on bush', tagLine: 'KR1' });
console.log('extractLolEvents OK');

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
  if (u.startsWith('/riot/')) {
    const [, , cluster, ...rest] = u.split('?')[0].split('/');
    const p = '/' + rest.join('/');
    const acc = p.match(/^\/riot\/account\/v1\/accounts\/by-riot-id\/([^/]+)\/([^/]+)$/);
    if (acc) { const a = LOL_ACCOUNTS[(acc[1] + '#' + acc[2]).toLowerCase()]; if (a) return res.end(JSON.stringify(a)); res.statusCode = 404; return res.end('{}'); }
    const ids = p.match(/^\/lol\/match\/v5\/matches\/by-puuid\/([^/]+)\/ids$/);
    if (ids) return res.end(JSON.stringify(cluster === 'europe' && ids[1] === 'p-me' ? ['TR1_1001'] : []));
    if (p === '/lol/match/v5/matches/TR1_1001') return res.end(JSON.stringify(LOL_MATCH));
    if (p === '/lol/match/v5/matches/TR1_1001/timeline') return res.end(JSON.stringify(LOL_TL));
  }
  if (u === '/tel.json') { res.setHeader('Content-Type', 'application/octet-stream'); return res.end(zlib.gzipSync(JSON.stringify(tel))); }
  res.statusCode = 404; res.end('{}');
}).listen(4100);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kick-report-'));
process.env.STREAMERS_FILE = path.join(tmp, 'streamers.json');
process.env.DISCOVERY_FILE = path.join(tmp, 'discovery.json');
process.env.PUBG_API_KEY = 'test'; process.env.PUBG_API_BASE = 'http://127.0.0.1:4100';
process.env.LOL_STREAMERS_FILE = path.join(tmp, 'lol-streamers.json');
process.env.LOL_DISCOVERY_FILE = path.join(tmp, 'lol-discovery.json');
process.env.RIOT_API_KEY = 'test'; process.env.RIOT_API_BASE = 'http://127.0.0.1:4100/riot';
process.env.DISCOVERY = '0';
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
  // LoL yayıncıları: Riot ID ile eklenir, puuid ile saklanır; etiket yazılmazsa TR1
  assert.strictEqual((await raw('/api/lol/streamers', { method: 'POST', headers: { cookie: '' }, body: JSON.stringify({ riotId: 'Rakip#TR1', kick: 'rakipkanal' }) })).status, 401);
  const rk = await api('/api/lol/streamers', { method: 'POST', body: JSON.stringify({ riotId: 'rakip#tr1', kick: 'RakipKanal' }) });
  assert.deepStrictEqual([rk.riotId, rk.puuid, rk.kick], ['Rakip#TR1', 'p-rakip', 'rakipkanal']);
  await api('/api/lol/streamers', { method: 'POST', body: JSON.stringify({ riotId: 'Seyirci', kick: 'seyircikanal' }) });
  assert.strictEqual((await raw('/api/lol/streamers', { method: 'POST', body: JSON.stringify({ riotId: 'Yok#TR1', kick: 'yokkanal' }) })).status, 404);
  assert.strictEqual((await api('/api/lol/streamers')).length, 2);
  const lm = await api('/api/lol/match/TR1_1001');
  assert.deepStrictEqual(lm.streamers.map((x) => x.kick).sort(), ['rakipkanal', 'seyircikanal']);
  assert.strictEqual(lm.map, 'Dereceli Tek/Çift');
  console.log('LoL API OK');
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
  // platform seçimi ve "Ana sayfa" butonu yok; ilk ziyarette son görüntülenenler boş
  assert.strictEqual(await p.locator('select').count(), 0);
  assert.deepStrictEqual(await p.$$eval('.game-nav a', (els) => els.map((e) => [e.textContent, e.classList.contains('on')])), [['PUBG', true], ['LoL', false]]);
  assert.ok(await p.isHidden('#recent'));
  assert.ok(!(await p.textContent('.streamer-card')).includes('Steam'));
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
  // --- Abonelere özel kayıt: bobkanal'ın kaydı subscriber_only (adres yok). Kartlar aynı yayından (555)
  // alınmış, o anı kapsayan kliplerden çıkmalı. Klipler iki sayfada: ilk sayfadaki klip olayı kapsıyor ama
  // başka bir yayından (999), yok sayılmalı. İkinci sayfadaki clip_ok 22:05:03–22:05:31 aralığında:
  // öldürmeyi (22:05:10) kapsıyor, düşürmeyi (22:05:00.1) kapsamıyor.
  const p3 = await b.newPage({ viewport: { width: 1280, height: 1000 } });
  p3.on('pageerror', e => console.log('pageerror', e.message));
  const clipCalls = [];
  const clip = (id, ls, created) => ({ id, livestream_id: ls, created_at: created, duration: 28, privacy: 'public',
    video_url: `https://clips.kick.com/clips/aa/${id}/playlist.m3u8`, thumbnail_url: null, title: id });
  await p3.route('https://kick.com/api/v2/**', r => {
    const u = new URL(r.request().url());
    const hdr = { 'access-control-allow-origin': '*' };
    if (u.pathname.endsWith('/clips')) {
      clipCalls.push(u.pathname.split('/')[4] + (u.searchParams.get('cursor') ? '+cursor' : ''));
      const page = u.searchParams.get('cursor')
        ? { clips: [clip('clip_ok', 555, '2026-11-02T22:07:00Z'), clip('clip_old', 555, '2026-11-02T21:50:00Z')], nextCursor: null }
        : { clips: [clip('clip_new', 555, '2026-11-03T01:00:00Z'), clip('clip_other', 999, '2026-11-02T22:06:00Z')], nextCursor: '{"view":0,"id":"clip_other"}' };
      return r.fulfill({ contentType: 'application/json', headers: hdr, body: JSON.stringify(page) });
    }
    const locked = u.pathname.includes('/bobkanal/');
    r.fulfill({ contentType: 'application/json', headers: hdr, body: JSON.stringify([locked
      ? { id: 555, start_time: '2026-11-02 21:28:33', duration: 44840000, is_live: false, source: null, session_title: 't', video: { uuid: 'u2', status: 'subscriber_only', is_private: true } }
      : { id: 777, start_time: '2026-11-02 21:28:33', duration: 44840000, is_live: false, source: 'https://stream.kick.com/x/master.m3u8', session_title: 't', video: { uuid: 'u1' } }]) });
  });
  const clipPlaylist = (fromIso, segs) => ['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-TARGETDURATION:2']
    .concat(...Array.from({ length: segs }, (_, i) => ['#EXT-X-PROGRAM-DATE-TIME:' + new Date(Date.parse(fromIso) + i * 2000).toISOString(), '#EXTINF:2.000,', '1.ts']))
    .concat('#EXT-X-ENDLIST').join('\n');
  const CLIP_FROM = { clip_ok: '2026-11-02T22:05:03Z', clip_other: '2026-11-02T22:04:50Z', clip_new: '2026-11-02T23:00:00Z', clip_old: '2026-11-02T21:49:00Z' };
  await p3.route('https://clips.kick.com/**', r => {
    const id = r.request().url().split('/')[5];
    if (!r.request().url().endsWith('playlist.m3u8') || !CLIP_FROM[id]) return r.fulfill({ status: 404, body: '' });
    r.fulfill({ headers: { 'access-control-allow-origin': '*', 'content-type': 'application/vnd.apple.mpegurl' }, body: clipPlaylist(CLIP_FROM[id], 14) });
  });
  await p3.route('https://stream.kick.com/**', r => {
    const u = r.request().url();
    const hdr = { 'access-control-allow-origin': '*', 'content-type': 'application/vnd.apple.mpegurl' };
    if (u.endsWith('master.m3u8')) return r.fulfill({ headers: hdr, body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=230000,CODECS="avc1.4D401F,mp4a.40.2",RESOLUTION=284x160\n160p30/playlist.m3u8' });
    if (u.endsWith('playlist.m3u8')) return r.fulfill({ headers: hdr, body: playlist });
    r.fulfill({ status: 404, body: '' });
  });
  await p3.goto('http://localhost:4000/players/steam/Me');
  await p3.waitForSelector('.card', { timeout: 15000 });
  const rows3 = await p3.$$eval('.card', els => els.map(e => e.innerText.replace(/\s+/g, ' ')));
  console.log('klip kartları:', rows3);
  // klipler sadece kilitli kanal için, iki sayfa (ikincisi cursor ile) çekilmeli
  assert.deepStrictEqual(clipCalls, ['bobkanal', 'bobkanal+cursor']);
  // 4 kendi yayını kartı (testkanal, açık kayıt) + 1 klip kartı (öldürme). Düşürmeyi kapsayan klip yok.
  assert.strictEqual(rows3.length, 5);
  const clipRows = rows3.filter(r => r.includes('bobkanal'));
  assert.strictEqual(clipRows.length, 1);
  // 22:05:10 − klip başlangıcı 22:05:03 = 0:07
  assert.ok(/Rakip tepkisi Klip 0:07 .*Öldürme Me → Bob/iu.test(clipRows[0]), clipRows[0]);
  assert.ok(rows3.filter(r => r.includes('testkanal')).every(r => !r.includes('Klip')));
  assert.ok(!(await p3.textContent('.match-head')).includes('bobkanal')); // kilitli kayıt için "maç başı" düğmesi yok
  assert.ok((await p3.textContent('#matches')).includes('1 an abonelere özel bir yayında kaldı'));
  await p3.click('.card.enemy');
  await p3.waitForTimeout(500);
  const info3 = await p3.textContent('#modalInfo');
  console.log('klip modal:', info3);
  // 10 sn önceden başla → 22:05:00, klip 22:05:03'te başlıyor → klibin başı
  assert.ok(info3.includes('Klip') && info3.includes('bobkanal') && info3.includes('0:00'), info3);
  assert.strictEqual(await p3.getAttribute('#kickLink', 'href'), 'https://kick.com/bobkanal/clips/clip_ok');
  if (process.env.SHOT_DIR) await p3.screenshot({ path: path.join(process.env.SHOT_DIR, 'clips.png'), fullPage: true });
  await p3.close();
  console.log('Klip OK');
  // son görüntülenenler: bulunan oyuncu ana sayfada arama kutusunun altında listelenir
  await p.goto('http://localhost:4000/');
  await p.waitForSelector('#recent .recent-chip');
  assert.deepStrictEqual(await p.$$eval('#recent .recent-chip a', (els) => els.map((e) => e.textContent)), ['Me']);
  await shot('home');
  await p.reload(); // sayfa yenilenince korunur
  await p.waitForSelector('#recent .recent-chip');
  await p.click('#recent .recent-chip a');
  await p.waitForSelector('.card');
  assert.strictEqual(new URL(p.url()).pathname, '/players/steam/Me');
  await p.goto('http://localhost:4000/');
  await p.waitForSelector('#recent .recent-chip');
  await p.click('#recent [data-remove="Me"]');
  assert.ok(await p.isHidden('#recent'));
  // --- LoL: menüden geç, Riot ID ile ara (etiketsiz -> TR1), sadece birebir rakip kartları çıkmalı
  await p.click('.game-nav a[data-game="lol"]');
  await p.waitForSelector('.streamer-card');
  assert.strictEqual(new URL(p.url()).pathname, '/lol');
  assert.deepStrictEqual(await p.$$eval('.game-nav a.on', (els) => els.map((e) => e.textContent)), ['LoL']);
  assert.strictEqual(await p.locator('.streamer-card').count(), 2);
  assert.ok(await p.isHidden('#recent')); // PUBG'deki son görüntülenenler LoL'de görünmez
  await p.fill('#heroSearch input[name=name]', 'Oyuncu');
  await p.click('#heroSearch button');
  await p.waitForSelector('.card', { timeout: 15000 });
  assert.strictEqual(decodeURIComponent(new URL(p.url()).pathname), '/lol/players/Oyuncu#TR1');
  const lrows = await p.$$eval('.card', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
  console.log(lrows);
  assert.strictEqual(lrows.length, 2);
  assert.ok(/Rakip tepkisi .*Öldürme Oyuncu#TR1 → Rakip#TR1 Ahri → Zed .*rakipkanal/i.test(lrows[0]), lrows[0]);
  assert.ok(/Rakip tepkisi .*Ölüm Rakip#TR1 → Oyuncu#TR1 Zed → Ahri .*rakipkanal/i.test(lrows[1]), lrows[1]);
  assert.ok(lrows.every((r) => !r.includes('seyircikanal') && !r.includes('Kule')));
  const lhead = await p.textContent('.match-head');
  assert.ok(lhead.includes('Zafer') && lhead.includes('Dereceli Tek/Çift') && lhead.includes('Ahri · 5/2/7') && !lhead.includes('seyircikanal'), lhead);
  assert.deepStrictEqual(await p.$$eval('.tabs[data-key=type] button', (els) => els.map((e) => e.textContent)), ['Tümü', 'Öldürmeler', 'Ölümler']);
  await shot('lol-player');
  await p.click('.card >> nth=0');
  await p.waitForFunction(() => /\d:\d\d/.test(document.querySelector('#modalInfo')?.textContent || ''));
  // 22:05:00.1 − 10 sn = 22:04:50.1; kayıt 21:28:30'da başlıyor ve 30 sn kopuyor -> 35:50
  const linfo = await p.textContent('#modalInfo');
  assert.ok(linfo.includes('rakipkanal') && linfo.includes('Ahri → Zed') && linfo.includes('35:50'), linfo);
  await p.keyboard.press('Escape');
  await p.click('.brand');
  await p.waitForSelector('#heroSearch');
  // LoL ana sayfasındaki son görüntülenenler, PUBG'den ayrı
  await p.goto('http://localhost:4000/lol');
  await p.waitForSelector('#recent .recent-chip');
  assert.deepStrictEqual(await p.$$eval('#recent .recent-chip a', (els) => els.map((e) => e.textContent)), ['Oyuncu#TR1']);
  await shot('lol-home');
  // bulunamayan Riot ID
  await p.goto('http://localhost:4000/lol/players/' + encodeURIComponent('Yok#TR1'));
  await p.waitForSelector('#pageStatus.error');
  assert.ok((await p.textContent('#pageStatus')).includes('bulunamadı'));
  console.log('LoL UI OK');
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
  await p.click('#adminTabs button[data-game="lol"]');
  await p.waitForFunction(() => document.querySelectorAll('.streamer-row').length === 2);
  assert.ok((await p.textContent('#streamerTable')).includes('Rakip#TR1'));
  await shot('lol-admin');
  await p.click('#adminTabs button[data-game="pubg"]');
  await p.waitForFunction(() => document.querySelectorAll('.streamer-row').length === 4);
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

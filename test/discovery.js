// Otomatik yayıncı bulma testi: sahte Kick canlı yayın listesi + sahte PUBG API
const http = require('http'); const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { candidateNames } = require('../discovery');

assert.deepStrictEqual(candidateNames('F1ZYY_T', 'f1zyy-t'), ['F1ZYY_T', 'f1zyy-t', 'f1zyy_t']);
assert.deepStrictEqual(candidateNames('Bad Name!', 'ok'), []); // geçersizler elenir (ok çok kısa değil ama 2 harf)
console.log('candidateNames OK');

const now = Date.now();
const kickFmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const H = 3600_000;
const stream = (slug, username, startMs, viewers) => ({
  is_live: true, start_time: kickFmt(startMs), viewer_count: viewers, session_title: 'pubg', language: 'Turkish',
  channel: { slug, user: { username, profilepic: `https://img/${slug}.webp` } },
});
const LIVE = [
  stream('wandays', 'Wandays', now - 1 * H, 300),     // yayın sırasında maçı var -> eşleşir
  stream('f1zyy-t', 'F1ZYY_T', now - 3 * H, 200),     // maçları yayından önce, 3 saattir yayında -> vazgeçilir
  stream('newbie', 'Newbie', now - 10 * 60_000, 100), // yayın yeni başladı, maç yok -> beklemede
  stream('ghost-tv', 'GhostTV', now - 1 * H, 50),     // PUBG'de bu isimlerin hiçbiri yok
  stream('manualch', 'Manual', now - 1 * H, 10),      // elle eklenmiş, aranmamalı
];
const PLAYERS = { Wandays: ['w1'], F1ZYY_T: ['f1'], Newbie: ['n1'], ManualPubg: ['m1'] };
const MATCHES = { w1: now - 0.5 * H, f1: now - 5 * H, n1: now - 24 * H, m1: now - H };

const playerRequests = [];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/stream/livestreams/all') {
    assert.strictEqual(u.searchParams.get('subcategory'), 'pubg-battlegrounds');
    return res.end(JSON.stringify({ data: u.searchParams.get('page') === '1' ? LIVE : [], next_page_url: null }));
  }
  if (u.pathname === '/shards/steam/players') {
    const names = u.searchParams.get('filter[playerNames]').split(',');
    playerRequests.push(names);
    assert.ok(names.length <= 10);
    const found = names.filter((n) => PLAYERS[n]).map((n) => ({ id: 'acc.' + n, attributes: { name: n }, relationships: { matches: { data: PLAYERS[n].map((id) => ({ id })) } } }));
    if (!found.length) { res.statusCode = 404; return res.end('{}'); }
    return res.end(JSON.stringify({ data: found }));
  }
  const m = u.pathname.match(/^\/shards\/steam\/matches\/(\w+)$/);
  if (m && MATCHES[m[1]]) return res.end(JSON.stringify({ data: { attributes: { createdAt: new Date(MATCHES[m[1]]).toISOString(), duration: 1800, mapName: 'Baltic_Main', gameMode: 'squad' } }, included: [] }));
  res.statusCode = 404; res.end('{}');
}).listen(4200);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kick-discovery-'));
fs.writeFileSync(path.join(tmp, 'streamers.json'), JSON.stringify([{ pubgName: 'ManualPubg', shard: 'steam', kick: 'manualch', source: 'manual' }]));
Object.assign(process.env, {
  PUBG_API_KEY: 'test', PUBG_API_BASE: 'http://127.0.0.1:4200', KICK_BASE: 'http://127.0.0.1:4200',
  STREAMERS_FILE: path.join(tmp, 'streamers.json'), DISCOVERY_FILE: path.join(tmp, 'discovery.json'),
  ADMIN_PASSWORD_FILE: path.join(tmp, 'admin-password.txt'), // ADMIN_PASSWORD yok: şifre üretilip buraya yazılmalı
});
delete process.env.ADMIN_PASSWORD;
process.env.CRON_SECRET = 'cron-test-anahtari';
const { server, discovery, loadStreamers } = require('../server.js');

server.listen(4001, async () => {
  let cookie = '';
  const api = (p, opts = {}) => fetch('http://localhost:4001' + p, { ...opts, headers: { cookie, 'Content-Type': 'application/json' } }).then((r) => r.json());
  try {
    // üretilen şifreyle giriş
    const password = fs.readFileSync(path.join(tmp, 'admin-password.txt'), 'utf8').trim();
    assert.ok(password.length >= 12, 'üretilen şifre yeterince uzun olmalı');
    const login = await fetch('http://localhost:4001/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
    assert.strictEqual(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    await loadStreamers();

    await discovery.tick();
    const st = discovery._state().candidates;
    console.log(Object.values(st).map((c) => `${c.slug}: ${c.status}${c.pubgName ? ' (' + c.pubgName + ')' : ''} tried=${c.tried.join(',')}`).join('\n'));
    console.log('PUBG istekleri:', JSON.stringify(playerRequests));

    assert.strictEqual(st.wandays.status, 'linked');
    assert.strictEqual(st['f1zyy-t'].status, 'nomatch');
    assert.strictEqual(st.newbie.status, 'pending');
    assert.ok(st.newbie.nextCheck > Date.now());
    assert.strictEqual(st['ghost-tv'].status, 'notfound');
    assert.deepStrictEqual(st['ghost-tv'].tried, ['GhostTV', 'ghost-tv', 'ghost_tv']);
    assert.strictEqual(st.manualch.status, 'linked');
    // elle eklenen kanal hiç sorulmadı; çok izlenen yayın ilk pakette; ilk paket 4 isim
    assert.ok(!playerRequests.flat().includes('Manual'));
    assert.strictEqual(playerRequests[0][0], 'Wandays');
    assert.strictEqual(playerRequests.length, 3); // [4 isim], [ghost-tv], [ghost_tv]
    assert.ok(playerRequests.length <= 10 - 4, 'kullanıcılara pay bırakılmalı');

    const list = await api('/api/streamers');
    const w = list.find((s) => s.kick === 'wandays');
    assert.ok(w && w.pubgName === 'Wandays' && w.source === 'auto' && w.live === true && w.avatar);
    assert.strictEqual(list.length, 2);

    // bütçe dolu: yeni tur PUBG'ye istek atmamalı (son 1 dk'da 3 istek + 4 pay = 7, limit 10 -> 3 hak var,
    // ama newbie nextCheck beklediği için zaten sorulmaz)
    await discovery.tick();
    assert.strictEqual(playerRequests.length, 3);

    const d = await api('/api/discovery');
    assert.strictEqual(d.enabled, true);
    assert.strictEqual(d.liveNow, 5);
    assert.deepStrictEqual(d.totals, { candidates: 5, linked: 2, pending: 1, notfound: 1, nomatch: 1 });
    assert.deepStrictEqual(d.unmatched.map((c) => c.slug).sort(), ['f1zyy-t', 'ghost-tv']);

    // otomatik eşleşme silinirse geri eklenmez
    await api('/api/streamers/Wandays', { method: 'DELETE' });
    await discovery.tick();
    assert.ok(!(await api('/api/streamers')).some((s) => s.kick === 'wandays'));
    assert.strictEqual(discovery._state().candidates.wandays.status, 'rejected');

    // Vercel yolu: rewrite asıl adresi ?__path= ile iletir
    const viaVercel = await fetch('http://localhost:4001/api/index?__path=/api/streamers').then((r) => r.json());
    assert.ok(Array.isArray(viaVercel) && viaVercel.some((x) => x.kick === 'manualch'));
    // GitHub Actions'ın çağırdığı tur: anahtarsız reddedilir, anahtarla çalışır
    assert.strictEqual((await fetch('http://localhost:4001/api/cron/discovery')).status, 401);
    assert.strictEqual((await fetch('http://localhost:4001/api/cron/discovery', { headers: { authorization: 'Bearer yanlis' } })).status, 401);
    const cron = await fetch('http://localhost:4001/api/cron/discovery', { headers: { authorization: 'Bearer cron-test-anahtari' } }).then((r) => r.json());
    assert.ok(cron.ok && cron.liveNow === 5, JSON.stringify(cron));
    console.log('cron OK', JSON.stringify(cron.totals));

    // dosyaya kaydedildi
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'discovery.json'), 'utf8'));
    assert.strictEqual(saved.candidates['ghost-tv'].status, 'notfound');
    console.log('DISCOVERY OK');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close(); mock.close(); fs.rmSync(tmp, { recursive: true, force: true });
  }
});

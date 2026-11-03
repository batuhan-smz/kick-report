// Kalıcı depolama: yayıncı listesi ve otomatik bulma durumu gibi küçük JSON belgeleri.
// - Vercel'de (BLOB_READ_WRITE_TOKEN varsa): özel (private) Vercel Blob deposu
// - Yerelde: data/ klasöründeki dosyalar
// Arayüz: get(key, fallback) -> değer, set(key, value)

const fs = require('fs');
const path = require('path');

function fileStore(files) {
  return {
    kind: 'file',
    async get(key, fallback) {
      try { return JSON.parse(fs.readFileSync(files[key], 'utf8')); } catch { return fallback; }
    },
    async set(key, value) {
      fs.mkdirSync(path.dirname(files[key]), { recursive: true });
      fs.writeFileSync(files[key], JSON.stringify(value, null, key === 'discovery' ? 1 : 2));
    },
  };
}

function blobStore(prefix = 'kick-report/') {
  const blob = require('@vercel/blob');
  const pathname = (key) => `${prefix}${key}.json`;
  return {
    kind: 'blob',
    async get(key, fallback) {
      // useCache: false -> CDN'i atlayıp her zaman son yazılanı oku
      const res = await blob.get(pathname(key), { access: 'private', useCache: false });
      if (!res || res.statusCode !== 200 || !res.stream) return fallback;
      const text = await new Response(res.stream).text();
      try { return JSON.parse(text); } catch { return fallback; }
    },
    async set(key, value) {
      await blob.put(pathname(key), JSON.stringify(value), {
        access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json',
      });
    },
  };
}

function createStore(files) {
  return process.env.BLOB_READ_WRITE_TOKEN ? blobStore(process.env.BLOB_PREFIX) : fileStore(files);
}

module.exports = { createStore };

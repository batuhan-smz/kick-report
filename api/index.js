// Vercel sunucusuz fonksiyonu: bütün /api/* istekleri ve /.well-known/assetlinks.json buraya yönlenir (vercel.json).
// Asıl kod server.js'te; yerelde aynı handler bir http sunucusuyla çalışır.
const { handler } = require('../server');

module.exports = handler;

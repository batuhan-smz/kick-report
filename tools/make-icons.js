// İkon üretici: tek tasarımdan web (PWA) ve Android ikonlarını PNG olarak çizer.
// Çalıştırma (sistemdeki Edge ile):  PW_MODULE=<playwright-core yolu> PW_CHANNEL=msedge node tools/make-icons.js
// Tasarımı değiştirmek için aşağıdaki icon() fonksiyonunu düzenle; public/icons/icon.svg de buradan yazılır.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BG = '#0a0d0e';
const GREEN = '#53fc18';

// rounded: köşe yuvarlama (0 = tam kare), scale: içeriğin boyutu, background: arka plan çizilsin mi
function icon({ rounded = 112, scale = 1, background = true } = {}) {
  const t = 256 - 256 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#18211b"/><stop offset="1" stop-color="${BG}"/></radialGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  ${background ? `<rect width="512" height="512" rx="${rounded}" fill="url(#bg)"/>` : ''}
  <g transform="translate(${t} ${t}) scale(${scale})">
    <g fill="none" stroke="${GREEN}" stroke-width="26" stroke-linecap="round">
      <circle cx="256" cy="256" r="128"/>
      <path d="M256 92v70M256 350v70M92 256h70M350 256h70"/>
    </g>
    <circle cx="256" cy="256" r="38" fill="${GREEN}" filter="url(#glow)"/>
  </g>
</svg>`;
}

const web = (f) => path.join(ROOT, 'public', 'icons', f);
const res = (dir, f) => path.join(ROOT, 'android', 'app', 'src', 'main', 'res', dir, f);
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

const jobs = [
  // PWA
  { out: web('icon-192.png'), size: 192, svg: icon() },
  { out: web('icon-512.png'), size: 512, svg: icon() },
  // maskable: tam kare arka plan, içerik güvenli alanda (%80 daire) kalacak kadar küçük
  { out: web('maskable-512.png'), size: 512, svg: icon({ rounded: 0, scale: 0.72 }) },
  { out: web('apple-touch-icon.png'), size: 180, svg: icon({ rounded: 0, scale: 0.8 }) },
  { out: web('favicon-32.png'), size: 32, svg: icon({ rounded: 96 }) },
  // Android açılış ekranı (arka plan rengi ayrıca verilir)
  { out: res('drawable-nodpi', 'splash.png'), size: 384, svg: icon({ background: false, scale: 0.9 }) },
];
for (const [d, k] of Object.entries(DENSITIES)) {
  // eski cihazlar için klasik ikon (48dp)
  jobs.push({ out: res(`mipmap-${d}`, 'ic_launcher.png'), size: Math.round(48 * k), svg: icon({ rounded: 96 }) });
  // Android 8+ uyarlanabilir ikon ön planı (108dp, içerik ortadaki 66dp güvenli alanda)
  jobs.push({ out: res(`mipmap-${d}`, 'ic_launcher_foreground.png'), size: Math.round(108 * k), svg: icon({ background: false, scale: 0.7 }) });
}

(async () => {
  fs.writeFileSync(web('icon.svg'), icon() + '\n');
  const { chromium } = require(process.env.PW_MODULE || 'playwright');
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  const page = await browser.newPage();
  for (const j of jobs) {
    fs.mkdirSync(path.dirname(j.out), { recursive: true });
    await page.setViewportSize({ width: j.size, height: j.size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${j.svg.replace('<svg ', `<svg width="${j.size}" height="${j.size}" `)}</body></html>`);
    await page.screenshot({ path: j.out, omitBackground: true });
    console.log(path.relative(ROOT, j.out), `${j.size}px`);
  }
  await browser.close();
})();

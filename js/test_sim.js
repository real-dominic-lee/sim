// Puppeteer harness: paints a wide band of sand near the top so it falls through
// empty space (heavy physics load), samples stats repeatedly to capture peak cost,
// then lets it settle and reports final state.
// Usage:
//   node js/test_sim.js           -> GPU renderer (default)
//   node js/test_sim.js soft      -> force SwiftShader software WebGL
const puppeteer = require('puppeteer');

const mode = process.argv[2] === 'soft' ? 'soft' : 'gpu';
const soft = mode === 'soft';

const softFlags = soft
  ? ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--in-process-gpu']
  : [];

(async () => {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', ...softFlags],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  await page.goto('http://127.0.0.1:3000/index.html?stats=150', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 300));

  // Enable stats overlay.
  await page.click('#stuffChk');
  // Max sand brush.
  await page.evaluate(() => {
    document.getElementById('sandSizeSlider').value = 200;
    document.getElementById('sandChk').checked = true;
    document.getElementById('waterChk').checked = false;
  });

  // Paint a wide horizontal band near the top so a lot of sand falls through
  // empty space (heavy physics: fast fall -> many substeps + wake expansion).
  await page.evaluate(() => {
    const canvas = document.getElementById('simCanvas');
    const rect = canvas.getBoundingClientRect();
    const y = rect.top + 60;
    const send = (type, cx, cy) => canvas.dispatchEvent(new PointerEvent(type, {
      clientX: cx, clientY: cy, pointerId: 1, width: 1, height: 1, isPrimary: true, pointerType: 'pen', bubbles: true
    }));
    const x0 = rect.left + 40;
    const x1 = rect.left + rect.width - 40;
    const steps = 30;
    send('pointerdown', x0, y);
    let step = 0;
    const iv = setInterval(() => {
      step++;
      if (step > steps) { send('pointerup', x1, y); clearInterval(iv); return; }
      const cx = x0 + (x1 - x0) * step / steps;
      send('pointermove', cx, y);
    }, 12);
  });

  // Let the band start falling, then sample during the cascade.
  await new Promise(r => setTimeout(r, 500));

  // Sample stats every 150ms during the cascade window.
  const samples = [];
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 150));
    const s = await page.$eval('#stats', el => el.innerText);
    samples.push(s);
  }

  // Let it settle, then capture final.
  await new Promise(r => setTimeout(r, 2500));
  const final = await page.$eval('#stats', el => el.innerText);

  // Parse a stat line like "Phys: 0.30 / pk1.20 / sc0.10"
  const num = (str, re) => { const m = str.match(re); return m ? +m[1] : 0; };
  let peakPhys = 0, peakActive = 0, maxPk = 0;
  for (const s of samples) {
    const pk = num(s, /pk([\d.]+)/);
    const phys = num(s, /Phys: ([\d.]+)/);
    const act = num(s, /Active: (\d+)/);
    if (pk > maxPk) maxPk = pk;
    if (phys > peakPhys) peakPhys = phys;
    if (act > peakActive) peakActive = act;
  }

  console.log('=== MODE === ' + mode);
  console.log('=== FINAL ===\n' + final);
  console.log(`peak Active (mid-fall): ${peakActive}`);
  console.log(`peak Phys avg-window (mid-fall): ${peakPhys.toFixed(2)}ms`);
  console.log(`peak Phys single-tick (mid-fall): ${maxPk.toFixed(2)}ms`);
  console.log('=== SAMPLES ===');
  console.log(samples.join('\n---\n'));
  console.log('=== ERRORS ===');
  console.log(errors.slice(0, 10));
  await browser.close();
})();

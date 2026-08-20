// Main thread: input handling, worker management, stats UI, and app lifecycle.
let worker = null;
let sS = 100, wS = 100, mDown = false, lastX = 0, lastY = 0;
let aC = 0, cTps = 0, counts = [0,0,0,0], fpsF = 0, fpsL = performance.now();
let cRect = null;
const statsDiv = document.getElementById('stats');
const stuffChk = document.getElementById('stuffChk');
const sandChkEl = document.getElementById('sandChk');
const waterChkEl = document.getElementById('waterChk');

function setupEvents() {
    canvas.addEventListener('pointerdown', e => {
        if (e.target.id !== 'simCanvas') return;
        mDown = true; canvas.setPointerCapture(e.pointerId); lastX = e.clientX; lastY = e.clientY;
    });
    canvas.addEventListener('pointermove', e => { if (mDown) { lastX = e.clientX; lastY = e.clientY; } });
    ['pointerup', 'pointercancel'].forEach(ev => canvas.addEventListener(ev, () => mDown = false));
    window.addEventListener('blur', () => mDown = false);
    // Coming back to the tab: the front buffer may be gone, redraw once.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) needDraw = true; });

    document.getElementById('clearBtn').onclick = () => worker && worker.postMessage({ type: 'clear' });
    document.getElementById('sandSizeSlider').oninput = e => sS = +e.target.value;
    document.getElementById('waterSizeSlider').oninput = e => wS = +e.target.value;
}

function initWorker() {
    worker = new Worker('js/physics-worker.js');
    worker.onmessage = e => {
        if (e.data.type === 'render') {
            if (pendQ.length < 16) pendQ.push({ buf: e.data.buf, y0: e.data.y0, rows: e.data.rows });
        } else if (e.data.type === 'stats') {
            aC = e.data.aC;
            cTps = e.data.tps;
            counts = e.data.counts;
        }
    };
    worker.postMessage({ type: 'init', w: canvas.width, h: canvas.height, soft: SOFT });
}

function paint(cx, cy) {
    if (!worker || !cRect) return;
    const x = Math.floor((cx - cRect.left) * (canvas.width / cRect.width)), y = Math.floor((cy - cRect.top) * (canvas.height / cRect.height));
    let items = [];
    if (sandChkEl.checked) items.push({mat: 1, size: sS});
    if (waterChkEl.checked) items.push({mat: 2, size: wS});
    if (items.length > 0) worker.postMessage({ type: 'paint', x, y, items: items });
}

setInterval(() => {
    if (!stuffChk.checked) return;
    let n = performance.now(), dt = n - fpsL, f = dt > 0 ? (fpsF * 1000) / dt : 0;
    fpsL = n; fpsF = 0;
    let sandC = counts[1] || 0;
    let waterC = counts[2] || 0;
    let wetC = counts[3] || 0;
    let totalC = sandC + waterC + wetC;
    let totalCells = canvas.width * canvas.height;
    let emptyC = totalCells - totalC;
    statsDiv.innerText = `FPS: ${f.toFixed(0)}\nFrame: ${ftEMA.toFixed(1)}ms\nTPS: ${cTps}\nActive: ${aC}\nUp: ${upRows} rows\nRenderer: ${RENDERER_STR}\nSand: ${sandC}\nWater: ${waterC}\nWet Sand: ${wetC}\nTotal: ${totalC}\nEmpty: ${emptyC}\nGrid: ${canvas.width}x${canvas.height}`;
}, 500);

function init() {
    canvas.width = Math.max(64, Math.floor(window.innerWidth * RES_SCALE));
    canvas.height = Math.max(64, Math.floor(window.innerHeight * RES_SCALE));
    setupEvents();
    cRect = canvas.getBoundingClientRect();
    try { if (initGL()) { initWorker(); rLoop(); } } catch (e) {}
    window.addEventListener('resize', () => location.reload());
}
init();

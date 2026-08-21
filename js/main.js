const canvas = document.getElementById('simCanvas');
const statsDiv = document.getElementById('stats');
const stuffChk = document.getElementById('stuffChk');
const sandChkEl = document.getElementById('sandChk');
const waterChkEl = document.getElementById('waterChk');

let gl, prog, tex, volTex, vao, pbo;
let sphProg, sphVao, sphVbo, sphParticleTex;
let worker = null;
let sS = 100, wS = 100;
let mDown = false, lastX = 0, lastY = 0;
let aC = 0, cTps = 0, counts = [0, 0, 0, 0];
let fpsL = performance.now(), fpsF = 0;
let pend = null, pendView = null, pendY0 = 0, pendRows = 0, upRows = 0;
let volPend = null, volPendView = null;
let sphPend = null, sphPendView = null;
let cRect = null, ftEMA = 0, lastFT = 0, needDraw = true;

function setupEvents() {
    canvas.addEventListener('pointerdown', e => {
        if (e.target.id !== 'simCanvas') return;
        mDown = true; canvas.setPointerCapture(e.pointerId); lastX = e.clientX; lastY = e.clientY;
    });
    canvas.addEventListener('pointermove', e => { if (mDown) { lastX = e.clientX; lastY = e.clientY; } });
    ['pointerup', 'pointercancel'].forEach(ev => canvas.addEventListener(ev, () => mDown = false));
    window.addEventListener('blur', () => mDown = false);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) needDraw = true; });

    document.getElementById('clearBtn').onclick = () => worker && worker.postMessage({ type: 'clear' });
    document.getElementById('sandSizeSlider').oninput = e => sS = +e.target.value;
    document.getElementById('waterSizeSlider').oninput = e => wS = +e.target.value;

    stuffChk.onchange = () => { statsDiv.style.display = stuffChk.checked ? 'block' : 'none'; };
}

function initGL() {
    gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance', desynchronized: true });
    if (!gl) return false;

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, `#version 300 es\nin vec2 a_pos; out vec2 v_uv; void main(){ v_uv = a_pos*0.5+0.5; v_uv.y = 1.0-v_uv.y; gl_Position = vec4(a_pos, 0.0, 1.0); }`);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        console.error('VS error:', gl.getShaderInfoLog(vs));
        return false;
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, `#version 300 es
        precision highp float;
        in vec2 v_uv;
        uniform highp usampler2D u_grid;
        uniform highp usampler2D u_vol;
        out vec4 c;

        vec4 getCol(uint id) {
            if(id==1u) return vec4(0.76, 0.69, 0.5, 1.0);
            if(id==3u) return vec4(0.55, 0.42, 0.25, 1.0);
            return vec4(1.0, 1.0, 1.0, 1.0);
        }

        void main() {
            uint id = texture(u_grid, v_uv).r;
            if (id == 1u || id == 3u) { c = getCol(id); return; }
            if (id == 2u) {
                c = vec4(0.35, 0.7, 1.0, 1.0);
                return;
            }
            c = vec4(0.05, 0.05, 0.05, 1.0);
        }`);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        console.error('FS error:', gl.getShaderInfoLog(fs));
        return false;
    }

    prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('Program link error:', gl.getProgramInfoLog(prog));
        return false;
    }
    gl.useProgram(prog);

    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const pLoc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(pLoc);
    gl.vertexAttribPointer(pLoc, 2, gl.FLOAT, false, 0, 0);

    tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, canvas.width, canvas.height, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(canvas.width * canvas.height));
    gl.uniform1i(gl.getUniformLocation(prog, "u_grid"), 0);

    volTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, volTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, canvas.width, canvas.height, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(canvas.width * canvas.height));
    gl.uniform1i(gl.getUniformLocation(prog, "u_vol"), 1);

    // SPH particle rendering
    const sphVs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(sphVs, `#version 300 es
        in vec2 a_pos;
        uniform vec2 u_resolution;
        uniform float u_pointSize;
        void main() {
            vec2 clip = (a_pos / u_resolution) * 2.0 - 1.0;
            clip.y *= -1.0;
            gl_Position = vec4(clip, 0.0, 1.0);
            gl_PointSize = u_pointSize;
        }`);
    gl.compileShader(sphVs);
    if (!gl.getShaderParameter(sphVs, gl.COMPILE_STATUS)) {
        console.error('SPH VS error:', gl.getShaderInfoLog(sphVs));
        return false;
    }

    const sphFs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(sphFs, `#version 300 es
        precision highp float;
        out vec4 c;
        void main() {
            float dist = length(gl_PointCoord - vec2(0.5));
            float alpha = 1.0 - smoothstep(0.3, 0.5, dist);
            vec3 base = vec3(0.35, 0.7, 1.0);
            vec3 deep = vec3(0.15, 0.4, 0.85);
            c = vec4(mix(base, deep, 0.5), alpha);
        }`);
    gl.compileShader(sphFs);
    if (!gl.getShaderParameter(sphFs, gl.COMPILE_STATUS)) {
        console.error('SPH FS error:', gl.getShaderInfoLog(sphFs));
        return false;
    }

    sphProg = gl.createProgram();
    gl.attachShader(sphProg, sphVs);
    gl.attachShader(sphProg, sphFs);
    gl.linkProgram(sphProg);
    if (!gl.getProgramParameter(sphProg, gl.LINK_STATUS)) {
        console.error('SPH program link error:', gl.getProgramInfoLog(sphProg));
        return false;
    }

    sphVao = gl.createVertexArray();
    gl.bindVertexArray(sphVao);

    sphVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, sphVbo);
    gl.bufferData(gl.ARRAY_BUFFER, 8000 * 2 * 4, gl.STREAM_DRAW);
    const sphPosLoc = gl.getAttribLocation(sphProg, "a_pos");
    gl.enableVertexAttribArray(sphPosLoc);
    gl.vertexAttribPointer(sphPosLoc, 2, gl.FLOAT, false, 0, 0);

    pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_UNPACK_BUFFER, canvas.width * canvas.height * 2, gl.STREAM_DRAW);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);

    return true;
}

function initWorker() {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = e => {
        if (e.data.type === 'render') {
            pend = e.data.buf;
            pendView = new Uint8Array(pend);
            pendY0 = e.data.y0;
            pendRows = e.data.rows;
            if (e.data.volBuf) {
                volPend = e.data.volBuf;
                volPendView = new Uint8Array(volPend);
            }
            if (e.data.sph && e.data.sph.count > 0) {
                sphPend = e.data.sph;
            }
        } else if (e.data.type === 'stats') {
            aC = e.data.aC;
            cTps = e.data.tps;
            counts = e.data.counts;
        } else if (e.data.type === 'error') {
            console.error('Worker error:', e.data.message, e.data.stack);
            alert('Worker error: ' + e.data.message);
        }
    };
    worker.postMessage({ type: 'init', w: canvas.width, h: canvas.height });
}

function rLoop(now) {
    if (mDown) paint(lastX, lastY);
    if (pend) {
        try {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, pbo);
            gl.bufferSubData(gl.PIXEL_UNPACK_BUFFER, 0, pendView);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, pendY0, canvas.width, pendRows, gl.RED_INTEGER, gl.UNSIGNED_BYTE, 0);
            if (volPend) {
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, volTex);
                gl.bufferSubData(gl.PIXEL_UNPACK_BUFFER, canvas.width * canvas.height, volPendView);
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, pendY0, canvas.width, pendRows, gl.RED_INTEGER, gl.UNSIGNED_BYTE, canvas.width * canvas.height);
                gl.activeTexture(gl.TEXTURE0);
            }
            gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
            upRows = pendRows;
            needDraw = true;
        } catch (e) { console.error('tex update error', e); }
        pend = null; pendView = null;
        volPend = null; volPendView = null;
    }
    if (needDraw) {
        gl.useProgram(prog);
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        needDraw = false;
    }
    if (sphPend && sphPend.count > 0) {
        console.log('SPH render:', sphPend.count, 'particles, first:', sphPend.xs[0], sphPend.ys[0]);
        gl.bindBuffer(gl.ARRAY_BUFFER, sphVbo);
        const positions = new Float32Array(sphPend.count * 2);
        for (let i = 0; i < sphPend.count; i++) {
            positions[i * 2] = sphPend.xs[i];
            positions[i * 2 + 1] = sphPend.ys[i];
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
        gl.useProgram(sphProg);
        gl.bindVertexArray(sphVao);
        gl.uniform2f(gl.getUniformLocation(sphProg, "u_resolution"), canvas.width, canvas.height);
        gl.uniform1f(gl.getUniformLocation(sphProg, "u_pointSize"), 3.0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.POINTS, 0, sphPend.count);
        gl.disable(gl.BLEND);
        gl.useProgram(prog);
        gl.bindVertexArray(vao);
        sphPend = null;
    }
    fpsF++;
    if (lastFT) { let dt = now - lastFT; ftEMA = ftEMA ? ftEMA * 0.9 + dt * 0.1 : dt; }
    lastFT = now;
    requestAnimationFrame(rLoop);
}

function paint(cx, cy) {
    if (!worker || !cRect) return;
    const x = Math.floor((cx - cRect.left) * (canvas.width / cRect.width));
    const y = Math.floor((cy - cRect.top) * (canvas.height / cRect.height));
    let items = [];
    if (sandChkEl.checked) items.push({ mat: 1, size: sS });
    if (waterChkEl.checked) items.push({ mat: 2, size: wS });
    if (items.length > 0) worker.postMessage({ type: 'paint', x, y, items: items });
}

setInterval(() => {
    if (!stuffChk.checked) return;
    let n = performance.now();
    let f = (fpsF * 1000) / (n - fpsL);
    fpsL = n; fpsF = 0;
    let sandC = counts[1] || 0;
    let waterC = counts[2] || 0;
    let wetC = counts[3] || 0;
    let totalC = sandC + waterC + wetC;
    let totalCells = canvas.width * canvas.height;
    let emptyC = totalCells - totalC;
    statsDiv.innerText = `FPS: ${f.toFixed(0)}
Frame: ${ftEMA.toFixed(1)}ms
TPS: ${cTps}
Active: ${aC}
Up: ${upRows} rows
Renderer: GPU
Sand: ${sandC}
Water: ${waterC}
Wet Sand: ${wetC}
Total: ${totalC}
Empty: ${emptyC}
Spawn: ${sS * 50} sand / ${wS * 50} water
Grid: ${canvas.width}x${canvas.height}`;
}, 500);

function init() {
    canvas.width = Math.max(64, window.innerWidth);
    canvas.height = Math.max(64, window.innerHeight);
    setupEvents();
    cRect = canvas.getBoundingClientRect();
    try { if (initGL()) { initWorker(); rLoop(); } } catch (e) {}
    window.addEventListener('resize', () => location.reload());
}
init();
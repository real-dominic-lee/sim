// Renderer: WebGL2 setup, GLSL shaders, render loop, and render-queue management.
const canvas = document.getElementById('simCanvas');
let gl, prog, tex, vao, traceLoc, pbo;
let pendQ = [], upRows = 0;
let needDraw = true, lastTrace = -1, lastDraw = 0;
let ftEMA = 0, lastFT = 0;

// Detect software rasterizer (Chrome "Use GPU" off -> SwiftShader, or Mesa llvmpipe/softpipe).
// Software WebGL is ~100x slower — compensate with lower resolution & shader cost.
function probeSoftwareGL() {
    try {
        let c = document.createElement('canvas'); c.width = c.height = 1;
        let g = c.getContext('webgl2') || c.getContext('webgl');
        if (!g) return false;
        let di = g.getExtension('WEBGL_debug_renderer_info');
        if (!di) return false;
        let r = g.getParameter(di.UNMASKED_RENDERER_WEBGL) || '';
        return /swiftshader|software|llvmpipe|softpipe/gi.test(r);
    } catch (e) { return false; }
}

// Renderer label reported in stats. Set to readable string if available.
let RENDERER_STR = 'GPU';

const SOFT = probeSoftwareGL() || new URLSearchParams(location.search).has('soft');
// Internal (backing-store) size as a fraction of CSS pixels.
// Halving each axis = 1/4 GPU fragments and 1/4 grid cells (physics too).
const RES_SCALE = SOFT ? 0.25 : 1.0;
// Water gap-fill trace: up to 8 texture reads per empty pixel — the #1 shader cost.
// Cosmetic only; cut to 0 under software GL.
const TRACE_DIST = SOFT ? 0 : 4;
// Cap draw rate; idle sim already skips draws via needDraw.
const MAX_FPS = SOFT ? 30 : 60;

function initGL() {
    // alpha:false -> opaque canvas, skips per-frame compositing blend.
    // powerPreference:'high-performance' -> forces the discrete GPU on hybrid laptops.
    // desynchronized:true -> low-latency present path where supported.
    gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance', desynchronized: true }); if (!gl) return false;

    // Capture the actual renderer string for diagnostics.
    try {
        let di = gl.getExtension('WEBGL_debug_renderer_info');
        if (di) { RENDERER_STR = gl.getParameter(di.UNMASKED_RENDERER_WEBGL) || 'WebGL2'; }
        else { RENDERER_STR = gl.getParameter(gl.VERSION) || 'WebGL2'; }
    } catch (e) { RENDERER_STR = 'WebGL2'; }

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, `#version 300 es\nin vec2 a_pos; out vec2 v_uv; void main(){ v_uv = a_pos*0.5+0.5; v_uv.y = 1.0-v_uv.y; gl_Position = vec4(a_pos, 0.0, 1.0); }`);
    gl.compileShader(vs);

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, `#version 300 es
        precision highp float;
        in vec2 v_uv;
        uniform highp usampler2D u_grid;
        uniform vec2 u_texelSize;
        uniform int u_trace;
        out vec4 c;

        vec4 getCol(uint id) {
            if(id==1u) return vec4(0.76, 0.69, 0.5, 1.0);    // Sand
            if(id==2u) return vec4(0.35, 0.7, 1.0, 1.0);     // Water
            if(id==3u) return vec4(0.55, 0.42, 0.25, 1.0);   // Wet Sand
            return vec4(1.0, 1.0, 1.0, 1.0);                 // Empty
        }

        void main() {
            uint id = texture(u_grid, v_uv).r;
            if (id != 0u) { c = getCol(id); return; }
            if (u_trace == 1) {
                // Optimized 4-direction trace for gap filling
                // Horizontal trace (left then right)
                bool foundL = false;
                for(int i=1; i<=${TRACE_DIST}; i++) {
                    uint t = texture(u_grid, v_uv - vec2(u_texelSize.x * float(i), 0.0)).r;
                    if (t != 0u) { if (t == 2u) foundL = true; break; }
                }
                if (foundL) {
                    for(int i=1; i<=${TRACE_DIST}; i++) {
                        uint t = texture(u_grid, v_uv + vec2(u_texelSize.x * float(i), 0.0)).r;
                        if (t != 0u) { if (t == 2u) { c = getCol(2u); return; } break; }
                    }
                }

                // Vertical trace (down then up)
                bool foundD = false;
                for(int i=1; i<=${TRACE_DIST}; i++) {
                    uint t = texture(u_grid, v_uv + vec2(0.0, u_texelSize.y * float(i))).r;
                    if (t != 0u) { if (t == 2u) foundD = true; break; }
                }
                if (foundD) {
                    for(int i=1; i<=${TRACE_DIST}; i++) {
                        uint t = texture(u_grid, v_uv - vec2(0.0, u_texelSize.y * float(i))).r;
                        if (t != 0u) { if (t == 2u) { c = getCol(2u); return; } break; }
                    }
                }

                // Diagonal trace (down-left then up-right)
                bool foundDL = false;
                for(int i=1; i<=${TRACE_DIST}; i++) {
                    uint t = texture(u_grid, v_uv + vec2(-u_texelSize.x * float(i), u_texelSize.y * float(i))).r;
                    if (t != 0u) { if (t == 2u) foundDL = true; break; }
                }
                if (foundDL) {
                    for(int i=1; i<=${TRACE_DIST}; i++) {
                        uint t = texture(u_grid, v_uv + vec2(u_texelSize.x * float(i), -u_texelSize.y * float(i))).r;
                        if (t != 0u) { if (t == 2u) { c = getCol(2u); return; } break; }
                    }
                }

                // Diagonal trace (down-right then up-left)
                bool foundDR = false;
                for(int i=1; i<=${TRACE_DIST}; i++) {
                    uint t = texture(u_grid, v_uv + vec2(u_texelSize.x * float(i), u_texelSize.y * float(i))).r;
                    if (t != 0u) { if (t == 2u) foundDR = true; break; }
                }
                if (foundDR) {
                    for(int i=1; i<=${TRACE_DIST}; i++) {
                        uint t = texture(u_grid, v_uv + vec2(-u_texelSize.x * float(i), -u_texelSize.y * float(i))).r;
                        if (t != 0u) { if (t == 2u) { c = getCol(2u); return; } break; }
                    }
                }
            }
            c = vec4(1.0, 1.0, 1.0, 1.0);
        }`);
    gl.compileShader(fs);

    prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog); gl.useProgram(prog);
    traceLoc = gl.getUniformLocation(prog, "u_trace");
    vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const pLoc = gl.getAttribLocation(prog, "a_pos"); gl.enableVertexAttribArray(pLoc); gl.vertexAttribPointer(pLoc, 2, gl.FLOAT, false, 0, 0);
    tex = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, canvas.width, canvas.height, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(canvas.width * canvas.height));
    gl.uniform1i(gl.getUniformLocation(prog, "u_grid"), 0);
    gl.uniform2f(gl.getUniformLocation(prog, "u_texelSize"), 1.0 / canvas.width, 1.0 / canvas.height);
    // Persistent PBO for async texture uploads (avoids CPU-memory upload sync stalls)
    pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_UNPACK_BUFFER, canvas.width * canvas.height, gl.STREAM_DRAW);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    return true;
}

function rLoop(now = performance.now()) {
    if (mDown) paint(lastX, lastY);
    while (pendQ.length) {
        let p = pendQ.shift();
        try {
            // Upload just the changed row span via PBO
            gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, pbo);
            gl.bufferSubData(gl.PIXEL_UNPACK_BUFFER, 0, new Uint8Array(p.buf));
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, p.y0, canvas.width, p.rows, gl.RED_INTEGER, gl.UNSIGNED_BYTE, 0);
            gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
            upRows = p.rows;
            needDraw = true;
        } catch (e) {}
    }
    // Only draw when something actually changed: new texture data, trace state
    // flipped, first frame, or tab was re-shown. Idle frames cost ~nothing.
    let tr = counts[2] > 0 ? 1 : 0;
    if (tr !== lastTrace) { lastTrace = tr; needDraw = true; }
    if (needDraw && now - lastDraw >= 1000 / MAX_FPS) {
        gl.uniform1i(traceLoc, tr);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        needDraw = false;
        lastDraw = now;
    }
    fpsF++;
    if (lastFT) { let dt = now - lastFT; ftEMA = ftEMA ? ftEMA * 0.9 + dt * 0.1 : dt; }
    lastFT = now;
    requestAnimationFrame(rLoop);
}

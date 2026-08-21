const MAT = { EMPTY: 0, SAND: 1, WATER: 2, WET_SAND: 3, DENSITY: [0, 4, 1, 4], FRICTION: [1, 0.8, 0.998, 0.6] };
const MAX_WATER = 4;
const USE_SPH_WATER = false;

const { SPHWater } = (() => {
    const h = 8.0;
    const h2 = h * h;
    const mass = 1.0;
    const restDensity = 2.0;
    const stiffness = 0.06;
    const nearStiffness = 0.02;
    const viscositySigma = 0.01;
    const viscosityBeta = 0.008;
    const gravity = 10800.0;
    const damping = 0.99;
    const boundaryDamping = 0.001;
    const maxParticles = 8000;

    class SpatialHash {
        constructor(cellSize, width, height) {
            this.cellSize = cellSize;
            this.cols = Math.ceil(width / cellSize);
            this.rows = Math.ceil(height / cellSize);
            this.grid = new Array(this.cols * this.rows);
            for (let i = 0; i < this.grid.length; i++) this.grid[i] = [];
        }
        clear() {
            for (let i = 0; i < this.grid.length; i++) this.grid[i].length = 0;
        }
        getIndex(x, y) {
            const cx = Math.floor(x / this.cellSize);
            const cy = Math.floor(y / this.cellSize);
            if (cx < 0 || cx >= this.cols || cy < 0 || cy >= this.rows) return -1;
            return cy * this.cols + cx;
        }
        add(particle, idx) {
            const i = this.getIndex(particle.x, particle.y);
            if (i >= 0) this.grid[i].push(idx);
        }
        getNeighbors(particle, out) {
            const cx = Math.floor(particle.x / this.cellSize);
            const cy = Math.floor(particle.y / this.cellSize);
            out.length = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = cx + dx, ny = cy + dy;
                    if (nx < 0 || nx >= this.cols || ny < 0 || ny >= this.rows) continue;
                    const cell = this.grid[ny * this.cols + nx];
                    for (let k = 0; k < cell.length; k++) out.push(cell[k]);
                }
            }
        }
    }

    class Particle {
        constructor(x, y, vx = 0, vy = 0) {
            this.x = x; this.y = y;
            this.vx = vx; this.vy = vy;
            this.density = 0; this.nearDensity = 0;
            this.pressure = 0; this.nearPressure = 0;
            this.fx = 0; this.fy = 0;
        }
    }

    class SPHWater {
        constructor(width, height, gridRef) {
            this.width = width;
            this.height = height;
            this.grid = gridRef;
            this.particles = [];
            this.hash = new SpatialHash(h, width, height);
            this.neighbors = [];
            this.predX = new Float32Array(maxParticles);
            this.predY = new Float32Array(maxParticles);
        }

        addParticle(x, y, vx = 0, vy = 0) {
            if (this.particles.length >= maxParticles) return false;
            this.particles.push(new Particle(x, y, vx, vy));
            return true;
        }

        addCircle(cx, cy, r, count, vx = 0, vy = 0) {
            console.log('SPH addCircle:', count, 'at', cx, cy, 'r=', r);
            for (let i = 0; i < count && this.particles.length < maxParticles; i++) {
                const angle = Math.random() * Math.PI * 2;
                const radius = Math.sqrt(Math.random()) * r;
                this.particles.push(new Particle(
                    cx + Math.cos(angle) * radius,
                    cy + Math.sin(angle) * radius,
                    vx + (Math.random() - 0.5) * 0.5,
                    vy + (Math.random() - 0.5) * 0.5
                ));
            }
        }

        clear() {
            this.particles.length = 0;
        }

        step(dt) {
            const p = this.particles;
            const n = p.length;
            if (n === 0) return;

            this.hash.clear();
            for (let i = 0; i < n; i++) this.hash.add(p[i], i);

            for (let i = 0; i < n; i++) {
                const pi = p[i];
                pi.fx = 0; pi.fy = 0;
                pi.density = 0; pi.nearDensity = 0;

                this.hash.getNeighbors(pi, this.neighbors);
                for (let k = 0; k < this.neighbors.length; k++) {
                    const j = this.neighbors[k];
                    if (j === i) continue;
                    const pj = p[j];
                    const dx = pj.x - pi.x;
                    const dy = pj.y - pi.y;
                    const r2 = dx * dx + dy * dy;
                    if (r2 >= h2 || r2 === 0) continue;
                    const r = Math.sqrt(r2);
                    const invR = 1.0 / r;
                    const nx = dx * invR;
                    const ny = dy * invR;

                    const q = 1.0 - r / h;
                    const q2 = q * q;
                    const q3 = q2 * q;
                    pi.density += q2 * mass;
                    pj.density += q2 * mass;
                    pi.nearDensity += q3 * mass;
                    pj.nearDensity += q3 * mass;
                }

                pi.pressure = stiffness * (pi.density - restDensity);
                pi.nearPressure = nearStiffness * pi.nearDensity;
            }

            for (let i = 0; i < n; i++) {
                const pi = p[i];
                this.hash.getNeighbors(pi, this.neighbors);
                for (let k = 0; k < this.neighbors.length; k++) {
                    const j = this.neighbors[k];
                    if (j <= i) continue;
                    const pj = p[j];
                    const dx = pj.x - pi.x;
                    const dy = pj.y - pi.y;
                    const r2 = dx * dx + dy * dy;
                    if (r2 >= h2 || r2 === 0) continue;
                    const r = Math.sqrt(r2);
                    const invR = 1.0 / r;
                    const nx = dx * invR;
                    const ny = dy * invR;

                    const q = 1.0 - r / h;
                    const q2 = q * q;

                    const D = (pi.pressure + pj.pressure) * 0.5 * q + (pi.nearPressure + pj.nearPressure) * 0.5 * q * q;
                    const fx = D * nx * 0.5;
                    const fy = D * ny * 0.5;
                    pi.fx += fx; pi.fy += fy;
                    pj.fx -= fx; pj.fy -= fy;

                    const dvx = pj.vx - pi.vx;
                    const dvy = pj.vy - pi.vy;
                    const u = dvx * nx + dvy * ny;
                    if (u > 0) {
                        const I = q * (viscositySigma * u + viscosityBeta * u * u) * 0.5 * dt;
                        const ivx = I * nx;
                        const ivy = I * ny;
                        pi.vx += ivx; pi.vy += ivy;
                        pj.vx -= ivx; pj.vy -= ivy;
                    }
                }
            }

            const W = this.width, H = this.height;
            const grid = this.grid;
            for (let i = 0; i < n; i++) {
                const pi = p[i];
                pi.vx += pi.fx * dt;
                pi.vy += pi.fy * dt;
                pi.vy += gravity * dt;

                if (!isFinite(pi.vx)) pi.vx = 0;
                if (!isFinite(pi.vy)) pi.vy = 0;

                this.predX[i] = pi.x + pi.vx * dt;
                this.predY[i] = pi.y + pi.vy * dt;

                let px = this.predX[i];
                let py = this.predY[i];

                if (!isFinite(px)) px = h;
                if (!isFinite(py)) py = h;

                if (px < h) { px = h; pi.vx *= -boundaryDamping; }
                if (px > W - h) { px = W - h; pi.vx *= -boundaryDamping; }
                if (py < h) { py = h; pi.vy = Math.max(0, pi.vy); }
                if (py > H - h) { py = H - h; pi.vy *= -boundaryDamping; }

                // Grid collision: sample grid at particle position
                const gx = Math.floor(px);
                const gy = Math.floor(py);
                if (gx >= 0 && gx < W && gy >= 0 && gy < H) {
                    const gIdx = gy * W + gx;
                    const gType = grid[gIdx];
                    if (gType !== 0 && gType !== 2) { // solid: sand (1), wet sand (3)
                        // Push out along velocity normal
                        const speed = Math.sqrt(pi.vx * pi.vx + pi.vy * pi.vy);
                        if (speed > 0.01) {
                            const nx = pi.vx / speed;
                            const ny = pi.vy / speed;
                            // Step back slightly until clear (1-2 steps max)
                            for (let step = 0; step < 2; step++) {
                                px -= nx * 0.5;
                                py -= ny * 0.5;
                                const gx2 = Math.floor(px);
                                const gy2 = Math.floor(py);
                                if (gx2 < 0 || gx2 >= W || gy2 < 0 || gy2 >= H) break;
                                if (grid[gy2 * W + gx2] === 0 || grid[gy2 * W + gx2] === 2) break;
                            }
                            // Slight velocity dampen, minimal reflection
                            pi.vx *= 0.95;
                            pi.vy *= 0.95;
                        } else {
                            // No velocity, tiny nudge
                            py -= 0.1;
                            pi.vy = -0.5;
                        }
                    }
                }

                pi.x = px; pi.y = py;
            }

            for (let i = 0; i < n; i++) {
                const pi = p[i];
                pi.vx *= damping;
                pi.vy *= damping;
            }
        }

        getParticleData() {
            const n = this.particles.length;
            const xs = new Float32Array(n);
            const ys = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                xs[i] = this.particles[i].x;
                ys[i] = this.particles[i].y;
            }
            return { xs, ys, count: n };
        }
    }

    return { SPHWater, h, maxParticles };
})();

function tryDiag(engine, t, cx, cy, cIdx, dir, speed) {
    const W = engine.W, H = engine.H, g = engine.grid, vx = engine.vx, vy = engine.vy, u = engine.upd;
    let tCx = cx + dir;
    if (tCx >= 0 && tCx < W && cy + 1 < H) {
        let sIdx = cy * W + tCx, dIdx = sIdx + W;
        let sType = g[sIdx], dType = g[dIdx];
        let canSide = (sType === MAT.EMPTY) || (sType === MAT.WATER && MAT.DENSITY[t] > MAT.DENSITY[MAT.WATER]);
        let canDown = (dType === MAT.EMPTY) || (dType === MAT.WATER && MAT.DENSITY[t] > MAT.DENSITY[MAT.WATER]);
        if (canSide && canDown) {
            if (t === MAT.SAND && dType === MAT.WATER) {
                // Sand sinks into water; displaced water moves up into the
                // vacated cell (volume conserved, cell marked WATER not EMPTY).
                g[dIdx] = MAT.WET_SAND;
                g[cIdx] = MAT.WATER; vy[cIdx] = -1.5;
                engine.waterVol[cIdx] = engine.waterVol[dIdx]; engine.waterVol[dIdx] = 0;
                vx[cIdx] = 0; vy[cIdx] = 0;
            } else {
                let mv = (t === MAT.WATER) ? engine.waterVol[cIdx] : 0;
                g[dIdx] = t;
                if (dType === MAT.WATER) {
                    g[cIdx] = MAT.WATER; vy[cIdx] = -1.5;
                    engine.waterVol[cIdx] = engine.waterVol[dIdx];
                } else {
                    g[cIdx] = MAT.EMPTY; vx[cIdx] = 0; vy[cIdx] = 0;
                }
                engine.waterVol[dIdx] = mv;
                vx[dIdx] = dir * speed; vy[dIdx] = 0;
            }
            u[dIdx] = 1; u[cIdx] = 1; engine.addA(dIdx); engine.addA(cIdx); engine.wake(cIdx);
            return true;
        }
    }
    return false;
}

function tryDensitySlide(engine, t, cx, cy, cIdx, dir) {
    const W = engine.W, H = engine.H, g = engine.grid, vx = engine.vx, vy = engine.vy, u = engine.upd;
    let tCx = cx + dir;
    if (tCx >= 0 && tCx < W && cy + 1 < H) {
        let sIdx = cy * W + tCx, dIdx = sIdx + W;
        let sType = g[sIdx], dType = g[dIdx];
        let canSide = (sType === MAT.EMPTY) || (sType === MAT.WATER && MAT.DENSITY[t] > MAT.DENSITY[MAT.WATER]);
        let canDown = (dType === MAT.EMPTY) || (dType === MAT.WATER && MAT.DENSITY[t] > MAT.DENSITY[MAT.WATER]);
        if (canSide && canDown) {
            if (t === MAT.SAND && dType === MAT.WATER) {
                g[dIdx] = MAT.WET_SAND;
                g[cIdx] = MAT.WATER; vy[cIdx] = -1.5;
                engine.waterVol[cIdx] = engine.waterVol[dIdx]; engine.waterVol[dIdx] = 0;
                vx[cIdx] = 0; vy[cIdx] = 0;
            } else {
                let mv = (t === MAT.WATER) ? engine.waterVol[cIdx] : 0;
                g[dIdx] = t;
                if (dType === MAT.WATER) {
                    g[cIdx] = MAT.WATER; vy[cIdx] = -1.5;
                    engine.waterVol[cIdx] = engine.waterVol[dIdx];
                } else {
                    g[cIdx] = MAT.EMPTY; vx[cIdx] = 0; vy[cIdx] = 0;
                }
                engine.waterVol[dIdx] = mv;
                vy[dIdx] = 0; vx[dIdx] = dir * 1.5;
            }
            u[dIdx] = 1; u[cIdx] = 1; engine.addA(dIdx); engine.addA(cIdx); engine.wake(cIdx);
            return true;
        }
    }
    return false;
}

function tryRoll(engine, t, cx, cy, cIdx, dir) {
    const W = engine.W, H = engine.H, g = engine.grid, vx = engine.vx, vy = engine.vy, u = engine.upd;
    if (cx + dir < 0 || cx + dir >= W) return false;
    let hIdx = cIdx + dir;
    let dIdx = hIdx + W;
    if (g[hIdx] === MAT.EMPTY && g[dIdx] === t) {
        if (Math.random() < 0.2) {
            g[hIdx] = t; g[cIdx] = MAT.EMPTY;
            if (t === MAT.WATER) {
                engine.waterVol[hIdx] = Math.min(MAX_WATER, engine.waterVol[hIdx] + engine.waterVol[cIdx]);
                engine.waterVol[cIdx] = 0;
            }
            vx[hIdx] = dir * 2.5; vy[hIdx] = -0.2;
            u[hIdx] = 1; u[cIdx] = 1; engine.addA(hIdx); engine.wake(cIdx);
            return true;
        }
    }
    return false;
}

class PhysicsEngine {
    constructor(w, h) {
        this.W = w; this.H = h;
        this.grid = new Uint8Array(w * h);
        this.waterVol = new Uint8Array(w * h);
        this.vx = new Float32Array(w * h);
        this.vy = new Float32Array(w * h);
        this.upd = new Uint8Array(w * h);
        this.maxA = w * h;
        this.actL = new Int32Array(this.maxA);
        this.nxtL = new Int32Array(this.maxA);
        this.ep = new Uint32Array(w * h);
        this.epc = 0; this.actC = 0; this.nxtC = 0; this.paintQ = [];
        this.dMin = h; this.dMax = -1;
        this.tickAlt = false;

        if (USE_SPH_WATER) {
            this.sphWater = new SPHWater(w, h, this.grid);
        }
    }
    clear() { this.grid.fill(0); this.waterVol.fill(0); this.vx.fill(0); this.vy.fill(0); this.ep.fill(0); this.epc = this.actC = this.nxtC = 0; this.paintQ.length = 0; this.dMin = 0; this.dMax = this.H - 1; if (this.sphWater) this.sphWater.clear(); }
    addA(i) {
        let y = (i / this.W) | 0;
        if (y < this.dMin) this.dMin = y;
        if (y > this.dMax) this.dMax = y;
        if (this.ep[i] !== this.epc && this.nxtC < this.maxA) { this.ep[i] = this.epc; this.nxtL[this.nxtC++] = i; }
    }

    wake(i) {
        const W = this.W, H = this.H, ep = this.ep, epc = this.epc, nxtL = this.nxtL, maxA = this.maxA;
        let nc = this.nxtC;
        let x = i % W, y = (i / W) | 0;

        if (y > 0) {
            if (x > 0) { let idx = i - W - 1; if (ep[idx] !== epc && nc < maxA) { ep[idx] = epc; nxtL[nc++] = idx; } }
            { let idx = i - W; if (ep[idx] !== epc && nc < maxA) { ep[idx] = epc; nxtL[nc++] = idx; } }
            if (x < W - 1) { let idx = i - W + 1; if (ep[idx] !== epc && nc < maxA) { ep[idx] = epc; nxtL[nc++] = idx; } }
        }
        if (x > 0) { let idx = i - 1; if (ep[idx] !== epc && nc < maxA) { ep[idx] = epc; nxtL[nc++] = idx; } }
        if (x < W - 1) { let idx = i + 1; if (ep[idx] !== epc && nc < maxA) { ep[idx] = epc; nxtL[nc++] = idx; } }
        if (y < H - 1) {
            if (x > 0) { let idx = i + W - 1; if (ep[idx] !== epc && nc < maxA) { ep[idx] = epc; nxtL[nc++] = idx; } }
            { let idx = i + W; if (ep[idx] !== epc && nc < maxA) { ep[idx] = epc; nxtL[nc++] = idx; } }
            if (x < W - 1) { let idx = i + W + 1; if (ep[idx] !== epc && nc < maxA) { ep[idx] = epc; nxtL[nc++] = idx; } }
        }
        this.nxtC = nc;
    }

    applyCohesion() {
        const W = this.W, H = this.H, g = this.grid, vx = this.vx, vy = this.vy, u = this.upd;
        for (let i = 0; i < W * H; i++) {
            if (g[i] !== MAT.WATER) continue;
            if (u[i]) continue;

            let cx = i % W, cy = (i / W) | 0;
            let supported = (cy + 1 < H) && (g[i + W] !== MAT.EMPTY);
            let neighborCount = 0;
            let avgVx = 0, avgVy = 0;

            if (cy > 0 && g[i - W] === MAT.WATER) { neighborCount++; avgVx += vx[i - W]; avgVy += vy[i - W]; }
            if (cx > 0 && g[i - 1] === MAT.WATER) { neighborCount++; avgVx += vx[i - 1]; avgVy += vy[i - 1]; }
            if (cx < W - 1 && g[i + 1] === MAT.WATER) { neighborCount++; avgVx += vx[i + 1]; avgVy += vy[i + 1]; }
            if (cy < H - 1 && g[i + W] === MAT.WATER) { neighborCount++; avgVx += vx[i + W]; avgVy += vy[i + W]; }

            if (neighborCount >= 2 && supported) {
                avgVx /= neighborCount; avgVy /= neighborCount;
                vx[i] = vx[i] * 0.3 + avgVx * 0.7;
                vy[i] = vy[i] * 0.3 + avgVy * 0.7;
            } else if (neighborCount === 0 && !supported) {
                if (Math.random() < 0.15) { vx[i] = 0; vy[i] = 0; }
            }
        }
    }

    applyBulkFlow() {
        const W = this.W, H = this.H, g = this.grid, vx = this.vx, vy = this.vy, u = this.upd;
        const pressure = new Float32Array(W * H);

        for (let y = H - 1; y >= 0; y--) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                if (g[i] !== MAT.WATER) { pressure[i] = 0; continue; }
                let p = 1.0;
                if (y + 1 < H && g[i + W] === MAT.WATER) p += pressure[i + W] * 0.8;
                pressure[i] = p;
            }
        }

        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                if (g[i] !== MAT.WATER || u[i] || pressure[i] < 1.5) continue;

                let cx = x, cy = y, bestDir = 0, bestP = 0;
                if (cx > 0 && g[i - 1] === MAT.EMPTY) {
                    let p = 0;
                    for (let dx = 1; dx < 8 && cx - dx >= 0; dx++) {
                        const ci = cy * W + (cx - dx);
                        if (g[ci] === MAT.WATER) p += pressure[ci] * 0.7;
                        else if (g[ci] === MAT.EMPTY) p += 0.5;
                        else break;
                    }
                    if (p > bestP) { bestP = p; bestDir = -1; }
                }
                if (cx < W - 1 && g[i + 1] === MAT.EMPTY) {
                    let p = 0;
                    for (let dx = 1; dx < 8 && cx + dx < W; dx++) {
                        const ci = cy * W + (cx + dx);
                        if (g[ci] === MAT.WATER) p += pressure[ci] * 0.7;
                        else if (g[ci] === MAT.EMPTY) p += 0.5;
                        else break;
                    }
                    if (p > bestP) { bestP = p; bestDir = 1; }
                }
                if (cy + 1 < H && g[i + W] === MAT.EMPTY) {
                    let p = pressure[i] * 1.5;
                    if (p > bestP) { bestP = p; bestDir = 0; }
                }

                if (bestDir !== 0 && bestP > 2.0) {
                    const speed = 4.0 + bestP * 0.6;
                    const vol = this.waterVol[i];
                    if (bestDir < 0) {
                        g[i - 1] = MAT.WATER; g[i] = MAT.EMPTY;
                        this.waterVol[i - 1] = vol; this.waterVol[i] = 0;
                        vx[i - 1] = -speed; vy[i - 1] = 0;
                        u[i - 1] = 1; u[i] = 1; this.addA(i - 1); this.wake(i);
                    } else {
                        g[i + 1] = MAT.WATER; g[i] = MAT.EMPTY;
                        this.waterVol[i + 1] = vol; this.waterVol[i] = 0;
                        vx[i + 1] = speed; vy[i + 1] = 0;
                        u[i + 1] = 1; u[i] = 1; this.addA(i + 1); this.wake(i);
                    }
                } else if (bestDir === 0 && bestP > 2.0) {
                    const speed = 6.0 + bestP * 0.4;
                    const vol = this.waterVol[i];
                    g[i + W] = MAT.WATER; g[i] = MAT.EMPTY;
                    this.waterVol[i + W] = vol; this.waterVol[i] = 0;
                    vx[i + W] = 0; vy[i + W] = speed;
                    u[i + W] = 1; u[i] = 1; this.addA(i + W); this.wake(i);
                }
            }
        }
    }

    equalizePressure() {
        const W = this.W, H = this.H, g = this.grid, wv = this.waterVol, vx = this.vx, vy = this.vy, u = this.upd;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                if (g[i] !== MAT.WATER || u[i]) continue;
                const vol = wv[i];
                if (vol <= 1) continue;

                let totalVol = vol;
                let neighbors = [];
                if (x > 0 && g[i - 1] === MAT.WATER) { neighbors.push(i - 1); totalVol += wv[i - 1]; }
                if (x < W - 1 && g[i + 1] === MAT.WATER) { neighbors.push(i + 1); totalVol += wv[i + 1]; }
                if (y > 0 && g[i - W] === MAT.WATER) { neighbors.push(i - W); totalVol += wv[i - W]; }
                if (y < H - 1 && g[i + W] === MAT.WATER) { neighbors.push(i + W); totalVol += wv[i + W]; }

                if (neighbors.length === 0) continue;

                const avgVol = totalVol / (neighbors.length + 1);
                if (vol > avgVol + 0.5) {
                    let give = Math.min(vol - 1, (vol - avgVol) * 0.4);
                    let remaining = give;
                    for (const ni of neighbors) {
                        const free = MAX_WATER - wv[ni];
                        if (free > 0) {
                            const take = Math.min(remaining, free);
                            wv[ni] += take;
                            remaining -= take;
                        }
                    }
                    wv[i] -= give - remaining;
                    vx[i] *= 0.5; vy[i] *= 0.5;
                }
            }
        }
    }

    paint(x, y, items) { this.paintQ.push({ x, y, items }); }
    applyPaints() {
        for (let p of this.paintQ) {
            for (let item of p.items) {
                let mat = item.mat, s = item.size;
                if (s > 0) {
                    let spawnCount = Math.min(s * 50, this.W * this.H);
                    // Spawn in a vertical column below the cursor so it falls
                    // straight down instead of exploding outward in a circle.
                    let colW = Math.ceil(Math.sqrt(spawnCount));
                    let startX = Math.max(0, Math.min(this.W - colW, p.x - (colW >> 1)));
                    let y = p.y;
                    let spawned = 0;
                    for (let c = 0; c < colW && spawned < spawnCount; c++) {
                        let x = startX + c;
                        for (let row = 0; row < colW && spawned < spawnCount; row++) {
                            let ny = y + row;
                            if (ny >= this.H) break;
                            let idx = ny * this.W + x;
                            if (this.grid[idx] === MAT.EMPTY) {
                                this.grid[idx] = mat;
                                this.vx[idx] = 0;
                                this.vy[idx] = 0;
                                if (mat === MAT.WATER) this.waterVol[idx] = MAX_WATER;
                                this.addA(idx); this.wake(idx);
                                spawned++;
                            } else if (mat === MAT.WATER && this.grid[idx] === MAT.WATER && this.waterVol[idx] < MAX_WATER) {
                                // Spawning on existing water: top it up instead of
                                // skipping, so the count isn't silently lost.
                                this.waterVol[idx] = MAX_WATER;
                                this.addA(idx);
                                spawned++;
                            }
                        }
                    }
                }
            }
        }
        this.paintQ.length = 0;
    }
    update() {
        let tL = this.actL; this.actL = this.nxtL; this.nxtL = tL;
        this.actC = this.nxtC; this.nxtC = 0; this.epc++; this.applyPaints();
        if (this.sphWater) {
            for (let i = 0; i < 3; i++) this.sphWater.step(1.0 / 180.0);
            if (this.sphWater.particles.length > 0 && this.actC === 0) {
                // SPH has particles but grid is empty - still need to render
                this.dMin = 0; this.dMax = this.H - 1;
            }
        } else {
            this.applyBulkFlow();
            this.applyCohesion();
            this.equalizePressure();
        }
        let u = this.upd, actL = this.actL, actC = this.actC, W = this.W, dMin = this.dMin, dMax = this.dMax;
        for (let i = 0; i < actC; i++) { let idx = actL[i]; u[idx] = 0; let y = (idx / W) | 0; if (y < dMin) dMin = y; if (y > dMax) dMax = y; }
        this.dMin = dMin; this.dMax = dMax;

        this.tickAlt = !this.tickAlt;
        if (this.tickAlt) {
            for (let i = 0; i < actC; i++) { let idx = actL[i]; if (!u[idx]) this.proc(idx, 0); }
        } else {
            for (let i = actC - 1; i >= 0; i--) { let idx = actL[i]; if (!u[idx]) this.proc(idx, 0); }
        }
    }

    proc(idx, depth) {
        const W = this.W, H = this.H, g = this.grid, vx = this.vx, vy = this.vy, u = this.upd;
        let x = idx % W, y = (idx / W) | 0, t = g[idx];
        if (t === MAT.EMPTY) return;
        u[idx] = 1;

        let pressure = 0;
        if (t === MAT.WATER) {
            for (let py = y - 1; py >= 0; py--) {
                if (g[py * W + x] === MAT.WATER) pressure++;
                else break;
            }
            let soakChance = 0.05 + pressure * 0.05;
            if (Math.random() < soakChance) {
                if (y + 1 < H && g[idx + W] === MAT.SAND) {
                    let nIdx = idx + W;
                    g[idx] = MAT.EMPTY; g[nIdx] = MAT.WET_SAND; vx[idx] = 0; vy[idx] = 0;
                    u[idx] = 1; u[nIdx] = 1; this.addA(idx); this.addA(nIdx); this.wake(idx); this.wake(nIdx); return;
                }
                if (x > 0 && g[idx - 1] === MAT.SAND) {
                    let nIdx = idx - 1;
                    g[idx] = MAT.EMPTY; g[nIdx] = MAT.WET_SAND; vx[idx] = 0; vy[idx] = 0;
                    u[idx] = 1; u[nIdx] = 1; this.addA(idx); this.addA(nIdx); this.wake(idx); this.wake(nIdx); return;
                }
                if (x < W - 1 && g[idx + 1] === MAT.SAND) {
                    let nIdx = idx + 1;
                    g[idx] = MAT.EMPTY; g[nIdx] = MAT.WET_SAND; vx[idx] = 0; vy[idx] = 0;
                    u[idx] = 1; u[nIdx] = 1; this.addA(idx); this.addA(nIdx); this.wake(idx); this.wake(nIdx); return;
                }
                if (y > 0 && g[idx - W] === MAT.SAND) {
                    let nIdx = idx - W;
                    g[idx] = MAT.EMPTY; g[nIdx] = MAT.WET_SAND; vx[idx] = 0; vy[idx] = 0;
                    u[idx] = 1; u[nIdx] = 1; this.addA(idx); this.addA(nIdx); this.wake(idx); this.wake(nIdx); return;
                }
            }
        }

        let vxc = vx[idx];
        let vyc = vy[idx];
        vyc += (t === MAT.WATER) ? 1.8 : 1.2;

        if ((y + 1 >= H || g[idx + W] !== MAT.EMPTY)) {
            vxc *= (t === MAT.WATER) ? 0.975 : MAT.FRICTION[t];
            if (vxc < 0) { if (-vxc < 0.1) vxc = 0; } else { if (vxc < 0.1) vxc = 0; }
        }

        let avx = vxc < 0 ? -vxc : vxc;
        let avy = vyc < 0 ? -vyc : vyc;
        let maxV = avx > avy ? avx : avy;
        let stepsToProcess = maxV | 0;
        if (stepsToProcess > 30) stepsToProcess = 30;

        let stepsTakenX = 0, stepsTakenY = 0;
        let cx = x, cy = y, cIdx = idx, moved = false;
        let finalVx = vxc, finalVy = vyc;

        for (let i = 0; i < stepsToProcess; i++) {
            let sx = 0, sy = 0;
            if (avx > stepsTakenX) { sx = vxc < 0 ? -1 : 1; stepsTakenX++; }
            if (avy > stepsTakenY) { sy = vyc < 0 ? -1 : 1; stepsTakenY++; }
            if (sx === 0 && sy === 0) break;

            let nx = cx + sx, ny = cy + sy;
            if (nx < 0 || nx >= W) { finalVx = 0; sx = 0; nx = cx; }
            if (ny < 0 || ny >= H) { finalVy = 0; sy = 0; ny = cy; }
            if (sx === 0 && sy === 0) break;

            let nIdx = ny * W + nx, nt = g[nIdx];

            if (nt === MAT.EMPTY) {
                g[nIdx] = t; g[cIdx] = MAT.EMPTY; u[nIdx] = 1; u[cIdx] = 1;
                if (t === MAT.WATER) { this.waterVol[nIdx] = this.waterVol[cIdx]; this.waterVol[cIdx] = 0; }
                cx = nx; cy = ny; cIdx = nIdx; moved = true;
            } else if (MAT.DENSITY[t] > MAT.DENSITY[nt]) {
                if (t === MAT.SAND && nt === MAT.WATER) {
                    g[nIdx] = MAT.WET_SAND;
                    g[cIdx] = MAT.WATER; this.waterVol[cIdx] = this.waterVol[nIdx]; this.waterVol[nIdx] = 0;
                    vy[cIdx] = -1.5;
                    vx[cIdx] = 0; vy[cIdx] = 0;
                    u[nIdx] = 1; u[cIdx] = 1; this.addA(nIdx); this.addA(cIdx); this.wake(nIdx); this.wake(cIdx);
                    return;
                }
                g[cIdx] = nt; g[nIdx] = t;
                let tvx = vx[nIdx], tvy = vy[nIdx];
                vx[nIdx] = finalVx * 0.5; vy[nIdx] = finalVy * 0.5; vx[cIdx] = tvx * 0.8; vy[cIdx] = tvy * 0.8 - 1.5;
                if (t === MAT.WATER || nt === MAT.WATER) {
                    let tv = this.waterVol[cIdx]; this.waterVol[cIdx] = this.waterVol[nIdx]; this.waterVol[nIdx] = tv;
                }
                u[nIdx] = 1; u[cIdx] = 1; this.addA(nIdx); this.addA(cIdx); this.wake(nIdx); this.wake(cIdx);
                return;
            } else if (nt === MAT.WATER && t === MAT.WATER) {
                const combined = this.waterVol[cIdx] + this.waterVol[nIdx];
                if (combined <= MAX_WATER) {
                    this.waterVol[nIdx] = combined;
                    this.waterVol[cIdx] = 0;
                    g[nIdx] = MAT.WATER; g[cIdx] = MAT.EMPTY;
                    vx[nIdx] = (vx[nIdx] + finalVx) * 0.75;
                    vy[nIdx] = (vy[nIdx] + finalVy) * 0.75;
                    finalVx *= 0.25; finalVy *= 0.25;
                    vx[cIdx] = finalVx; vy[cIdx] = finalVy;
                    u[nIdx] = 1; u[cIdx] = 1; this.addA(nIdx); this.addA(cIdx); break;
                } else {
                    this.waterVol[nIdx] = MAX_WATER;
                    this.waterVol[cIdx] = combined - MAX_WATER;
                    vx[nIdx] = (vx[nIdx] + finalVx) * 0.75;
                    vy[nIdx] = (vy[nIdx] + finalVy) * 0.75;
                    finalVx *= 0.25; finalVy *= 0.25;
                    vx[cIdx] = finalVx; vy[cIdx] = finalVy;
                    u[nIdx] = 1; u[cIdx] = 1; this.addA(nIdx); this.addA(cIdx); break;
                }
            } else if (nt === t) {
                if ((ny + 1 < H) && (g[nIdx + W] === MAT.EMPTY)) {
                    if (depth < 4) {
                        vx[nIdx] += finalVx * 0.5; vy[nIdx] += finalVy * 0.5;
                        u[nIdx] = 1; this.addA(nIdx); this.proc(nIdx, depth + 1);
                        if (g[nIdx] !== MAT.EMPTY) {
                            finalVx = 0; finalVy = 0; break;
                        } else { finalVx *= 0.5; finalVy *= 0.5; }
                    } else {
                        finalVx = 0; finalVy = 0; break;
                    }
                } else {
                    if (sy > 0) {
                        finalVy = 0;
                        if (t === MAT.WATER) {
                            let force = 4.0 + pressure * 1.2;
                            if (force > 12.0) force = 12.0;
                            if (cx > 0 && g[cIdx - 1] === MAT.EMPTY) finalVx -= vyc * force;
                            if (cx < W - 1 && g[cIdx + 1] === MAT.EMPTY) finalVx += vyc * force;

                            if (finalVx === 0 && finalVy === 0 && pressure > 0) {
                                let lE = cx > 0 && g[cIdx - 1] === MAT.EMPTY;
                                let rE = cx < W - 1 && g[cIdx + 1] === MAT.EMPTY;
                                if (lE && rE) finalVx = (Math.random() < 0.5 ? -1 : 1) * pressure * 0.8;
                                else if (lE) finalVx = -pressure * 0.8;
                                else if (rE) finalVx = pressure * 0.8;
                            }
                            if (vyc > 6.0 && pressure > 3 && Math.random() < 0.2) finalVy = -vyc * 0.3;
                        } else {
                            vy[nIdx] += vyc * 0.1;
                            vx[nIdx] += vxc * 0.1;
                            u[nIdx] = 1; this.addA(nIdx);
                            finalVy = 0;
                            finalVx = 0;
                        }
                        break;
                    } else { finalVx *= -0.1; finalVy *= -0.1; break; }
                }
            } else if (t === MAT.WATER && nt === MAT.SAND) {
                if (Math.random() < 0.1) {
                    g[cIdx] = MAT.EMPTY; g[nIdx] = MAT.WET_SAND; this.waterVol[cIdx] = 0; vx[cIdx] = 0; vy[cIdx] = 0;
                    u[cIdx] = 1; u[nIdx] = 1; this.addA(cIdx); this.addA(nIdx); this.wake(cIdx); this.wake(nIdx); return;
                }
            } else {
                if (sy > 0) {
                    finalVy = 0;
                    if (t === MAT.WATER) {
                        let force = 4.0 + pressure * 1.2;
                        if (force > 12.0) force = 12.0;
                        if (cx > 0 && g[cIdx - 1] === MAT.EMPTY) finalVx -= vyc * force;
                        if (cx < W - 1 && g[cIdx + 1] === MAT.EMPTY) finalVx += vyc * force;

                        if (finalVx === 0 && finalVy === 0 && pressure > 0) {
                            let lE = cx > 0 && g[cIdx - 1] === MAT.EMPTY;
                            let rE = cx < W - 1 && g[cIdx + 1] === MAT.EMPTY;
                            if (lE && rE) finalVx = (Math.random() < 0.5 ? -1 : 1) * pressure * 0.8;
                            else if (lE) finalVx = -pressure * 0.8;
                            else if (rE) finalVx = pressure * 0.8;
                        }
                        if (vyc > 6.0 && pressure > 3 && Math.random() < 0.2) finalVy = -vyc * 0.3;
                    } else {
                        let sDir = finalVx > 0.1 ? 1 : (finalVx < -0.1 ? -1 : (Math.random() < 0.5 ? 1 : -1));
                        if (tryDiag(this, t, cx, cy, cIdx, sDir, (t === MAT.WATER) ? 5.0 : 3.0)) { cx += sDir; cy++; cIdx += W + sDir; moved = true; }
                    }
                    break;
                } else { finalVx *= -0.1; finalVy *= -0.1; break; }
            }
        }

        if (moved) { this.wake(cIdx); this.wake(idx); }
        vx[cIdx] = finalVx; vy[cIdx] = finalVy;

        if (!moved || (Math.abs(finalVx) < 1.0 && Math.abs(finalVy) < 1.0)) {
            let rMoved = false;
            if (t !== MAT.WATER) {
                if (cy + 1 < H && (g[cIdx + W] === MAT.EMPTY || (g[cIdx + W] === MAT.WATER && MAT.DENSITY[t] > MAT.DENSITY[MAT.WATER]))) {
                    let bIdx = cIdx + W;
                    let bType = g[bIdx];
                    g[bIdx] = t; g[cIdx] = bType;
                    if (bType === MAT.WATER) { let tv = this.waterVol[bIdx]; this.waterVol[bIdx] = this.waterVol[cIdx]; this.waterVol[cIdx] = tv; }
                    vy[bIdx] = vy[cIdx] + 1.2; vx[bIdx] = vx[cIdx];
                    vx[cIdx] = 0; vy[cIdx] = bType === MAT.WATER ? -1.0 : 0;
                    u[bIdx] = 1; u[cIdx] = 1; this.addA(bIdx); this.wake(cIdx); cIdx = bIdx; cy++; rMoved = true;
                }
                if (!rMoved) {
                    let d = Math.random() < 0.5 ? 1 : -1;
                    if (tryDensitySlide(this, t, cx, cy, cIdx, d)) { cx += d; cy++; cIdx += W + d; rMoved = true; }
                    else if (tryDensitySlide(this, t, cx, cy, cIdx, -d)) { cx -= d; cy++; cIdx += W - d; rMoved = true; }

                    if (!rMoved && cy + 1 < H && g[cIdx + W] === t && Math.abs(vx[cIdx]) < 0.5) {
                        let rollD = Math.random() < 0.5 ? 1 : -1;
                        if (tryRoll(this, t, cx, cy, cIdx, rollD)) { cx += rollD; cIdx += rollD; rMoved = true; }
                        else if (tryRoll(this, t, cx, cy, cIdx, -rollD)) { cx -= rollD; cIdx -= rollD; rMoved = true; }
                    }

                    if (!rMoved && cy + 1 < H && g[cIdx + W] === t) {
                        if (Math.abs(vx[cIdx]) < 0.1 && Math.random() < 0.02) {
                            let rollDir = (Math.random() < 0.5) ? 1 : -1;
                            if (cx + rollDir >= 0 && cx + rollDir < W) {
                                let sIdx = cIdx + rollDir;
                                let dIdx = cIdx + W + rollDir;
                                if (g[sIdx] === MAT.EMPTY && g[dIdx] === MAT.EMPTY) {
                                    g[dIdx] = t; g[cIdx] = MAT.EMPTY;
                                    if (t === MAT.WATER) { this.waterVol[dIdx] = this.waterVol[cIdx]; this.waterVol[cIdx] = 0; }
                                    vx[dIdx] = rollDir * 2.5; vy[dIdx] = 1.0;
                                    u[dIdx] = 1; u[cIdx] = 1; this.addA(dIdx); this.wake(cIdx);
                                    cIdx = dIdx; cx += rollDir; cy++; rMoved = true;
                                }
                            }
                        }
                    }

                    if (!rMoved && cy + 1 < H && g[cIdx + W] === t && Math.abs(vx[cIdx]) < 0.5) {
                        let dir = (Math.random() < 0.5) ? 1 : -1;
                        if (cx + dir >= 0 && cx + dir < W) {
                            let s1 = cIdx + dir;
                            let d1 = s1 + W;
                            if (g[s1] === t && g[d1] === MAT.EMPTY) {
                                if (Math.random() < 0.05) {
                                    g[s1] = t; g[d1] = t; g[cIdx] = MAT.EMPTY;
                                    if (t === MAT.WATER) { this.waterVol[d1] = this.waterVol[cIdx]; this.waterVol[cIdx] = 0; }
                                    vx[s1] = 0; vy[s1] = 0;
                                    vx[d1] = dir * 2.5; vy[d1] = 1.5;
                                    vx[cIdx] = 0; vy[cIdx] = 0;
                                    u[s1] = 1; u[d1] = 1; u[cIdx] = 1;
                                    this.addA(s1); this.addA(d1); this.addA(cIdx); this.wake(cIdx);
                                    cIdx = s1; cx += dir; rMoved = true;
                                }
                            }
                        }
                    }
                }
            } else {
                if (cy + 1 < H && g[cIdx + W] === MAT.EMPTY) {
                    let bIdx = cIdx + W;
                    g[bIdx] = t; g[cIdx] = MAT.EMPTY;
                    if (t === MAT.WATER) { this.waterVol[bIdx] = this.waterVol[cIdx]; this.waterVol[cIdx] = 0; }
                    vy[bIdx] = vy[cIdx] + 1.2; vx[bIdx] = vx[cIdx]; vx[cIdx] = 0; vy[cIdx] = 0;
                    u[bIdx] = 1; u[cIdx] = 1; this.addA(bIdx); this.wake(cIdx); cIdx = bIdx; cy++; rMoved = true;
                }
                if (!rMoved) {
                    let d = Math.random() < 0.5 ? 1 : -1;
                    if (tryDiag(this, t, cx, cy, cIdx, d, 6.0)) { cx += d; cy++; cIdx += W + d; rMoved = true; }
                    else if (tryDiag(this, t, cx, cy, cIdx, -d, 6.0)) { cx -= d; cy++; cIdx += W - d; rMoved = true; }
                    else {
                        let touchingSand = (cy + 1 < H && g[cIdx + W] === MAT.SAND) || (cy > 0 && g[cIdx - W] === MAT.SAND) || (cx > 0 && g[cIdx - 1] === MAT.SAND) || (cx < W - 1 && g[cIdx + 1] === MAT.SAND);
                        let touchingWetSand = (cy + 1 < H && g[cIdx + W] === MAT.WET_SAND) || (cy > 0 && g[cIdx - W] === MAT.WET_SAND) || (cx > 0 && g[cIdx - 1] === MAT.WET_SAND) || (cx < W - 1 && g[cIdx + 1] === MAT.WET_SAND);

                        if (Math.random() < 0.1 && touchingSand) {
                            if (cy + 1 < H && g[cIdx + W] === MAT.SAND) {
                                let nIdx = cIdx + W; g[cIdx] = MAT.EMPTY; g[nIdx] = MAT.WET_SAND; this.waterVol[cIdx] = 0; vx[cIdx] = 0; vy[cIdx] = 0; u[cIdx] = 1; u[nIdx] = 1; this.addA(cIdx); this.addA(nIdx); this.wake(cIdx); this.wake(nIdx); return;
                            }
                            if (cx + 1 < W && g[cIdx + 1] === MAT.SAND) {
                                let nIdx = cIdx + 1; g[cIdx] = MAT.EMPTY; g[nIdx] = MAT.WET_SAND; this.waterVol[cIdx] = 0; vx[cIdx] = 0; vy[cIdx] = 0; u[cIdx] = 1; u[nIdx] = 1; this.addA(cIdx); this.addA(nIdx); this.wake(cIdx); this.wake(nIdx); return;
                            }
                            if (cx > 0 && g[cIdx - 1] === MAT.SAND) {
                                let nIdx = cIdx - 1; g[cIdx] = MAT.EMPTY; g[nIdx] = MAT.WET_SAND; this.waterVol[cIdx] = 0; vx[cIdx] = 0; vy[cIdx] = 0; u[cIdx] = 1; u[nIdx] = 1; this.addA(cIdx); this.addA(nIdx); this.wake(cIdx); this.wake(nIdx); return;
                            }
                            if (cy > 0 && g[cIdx - W] === MAT.SAND) {
                                let nIdx = cIdx - W; g[cIdx] = MAT.EMPTY; g[nIdx] = MAT.WET_SAND; this.waterVol[cIdx] = 0; vx[cIdx] = 0; vy[cIdx] = 0; u[cIdx] = 1; u[nIdx] = 1; this.addA(cIdx); this.addA(nIdx); this.wake(cIdx); this.wake(nIdx); return;
                            }
                        }

                        if (touchingWetSand && Math.random() < 0.35) {
                            let max_steps = 30;
                            let wx = cx, wy = cy;
                            for (let s = 1; s <= max_steps; s++) {
                                let r = Math.random();
                                let dx = 0, dy = 0;
                                if (r < 0.7) dy = 1;
                                else if (r < 0.85) dx = 1;
                                else dx = -1;

                                let nx = wx + dx, ny = wy + dy;
                                if (nx < 0 || nx >= W || ny < 0 || ny >= H) break;

                                let nIdx = ny * W + nx;
                                if (g[nIdx] === MAT.WET_SAND) {
                                    wx = nx; wy = ny;
                                } else if (g[nIdx] === MAT.SAND) {
                                    let progress = (s - 1) / (max_steps - 1);
                                    let soakChance = Math.pow(1.0 - progress, 3);

                                    if (Math.random() < soakChance) {
                                        g[cIdx] = MAT.EMPTY; g[nIdx] = MAT.WET_SAND; this.waterVol[cIdx] = 0; vx[cIdx] = 0; vy[cIdx] = 0;
                                        u[cIdx] = 1; u[nIdx] = 1; this.addA(cIdx); this.addA(nIdx); this.wake(cIdx); this.wake(nIdx); return;
                                    } else {
                                        break;
                                    }
                                } else {
                                    break;
                                }
                            }
                        }

                        let lE = -1, rE = -1, lD = false, rD = false;
                        for (let i = 1; i <= 60; i++) {
                            if (cx - i < 0) break;
                            let cIdxL = cy * W + (cx - i);
                            if (g[cIdxL] === MAT.SAND || g[cIdxL] === MAT.WET_SAND) break;
                            if (g[cIdxL] === MAT.EMPTY) { lE = i; if (cy + 1 < H && g[cIdxL + W] === MAT.EMPTY) lD = true; break; }
                        }
                        for (let i = 1; i <= 60; i++) {
                            if (cx + i >= W) break;
                            let cIdxR = cy * W + (cx + i);
                            if (g[cIdxR] === MAT.SAND || g[cIdxR] === MAT.WET_SAND) break;
                            if (g[cIdxR] === MAT.EMPTY) { rE = i; if (cy + 1 < H && g[cIdxR + W] === MAT.EMPTY) rD = true; break; }
                        }

                        if (lE !== -1 || rE !== -1) {
                            let dir = (lE !== -1 && rE !== -1) ? ((lD && !rD) ? -1 : (rD && !lD) ? 1 : (lE <= rE ? -1 : 1)) : (lE !== -1 ? -1 : 1);
                            let dist = dir === -1 ? lE : rE;
                            let targetX = cx + (dir * dist), targetIdx = cy * W + targetX;
                            g[targetIdx] = MAT.WATER; g[cIdx] = MAT.EMPTY;
                            this.waterVol[targetIdx] = this.waterVol[cIdx]; this.waterVol[cIdx] = 0;
                            let isDown = (dir == -1 && lD) || (dir == 1 && rD);
                            let speed = isDown ? 18.0 : 10.0;
                            vx[targetIdx] = dir * speed; vy[targetIdx] = isDown ? 5.0 : 0;
                            vx[cIdx] = 0; vy[cIdx] = 0;
                            u[targetIdx] = 1; u[cIdx] = 1; this.addA(targetIdx); this.addA(cIdx); this.wake(cIdx);

                            for (let py = cy - 1; py >= 0; py--) {
                                let upI = py * W + cx;
                                if (g[upI] === MAT.WATER) {
                                    vx[upI] = dir * speed * 0.8;
                                    vy[upI] = 5.0;
                                    u[upI] = 1; this.addA(upI);
                                } else break;
                            }

                            cIdx = targetIdx; cx = targetX; rMoved = true;
                        } else if (touchingSand || touchingWetSand) {
                            this.addA(cIdx);
                            return;
                        }
                    }
                }
            }
            if (!rMoved) {
                vx[cIdx] *= 0.5; vy[cIdx] *= 0.5;
                if (Math.abs(vx[cIdx]) < 0.1) vx[cIdx] = 0;
                if (Math.abs(vy[cIdx]) < 0.1) vy[cIdx] = 0;
                if (vx[cIdx] === 0 && vy[cIdx] === 0) {
                    if (cy + 1 >= H || g[cIdx + W] !== MAT.EMPTY) return;
                }
            }
        }
        this.addA(cIdx);
    }
}

let engine, lastT = 0, acc = 0, tpsC = 0, lastTps = 0, cTps = 0, lastStats = 0;
const TPS = 60, TMS = 1000 / TPS;
let counts = new Int32Array(4);

function tick() {
    try {
        let now = performance.now();
        if (lastT === 0) { lastT = now; lastTps = now; }
        let d = now - lastT; lastT = now; acc += d;
        let t = 0;
        while (acc >= TMS && t < 2) { engine.update(); acc -= TMS; t++; tpsC++; }
        if (acc > TMS * 2) acc = 0;
        if (now - lastTps >= 1000) { cTps = tpsC; tpsC = 0; lastTps = now; }
        if (now - lastStats >= 500) {
            lastStats = now;
            counts.fill(0);
            let g = engine.grid, len = g.length;
            for (let i = 0; i < len; i++) counts[g[i]]++;
            self.postMessage({ type: 'stats', aC: engine.actC, tps: cTps, counts: counts });
        }
        if (engine.dMax >= engine.dMin && engine.dMax >= 0) {
            let W = engine.W, H = engine.H;
            let y0 = engine.dMin < 0 ? 0 : engine.dMin;
            let y1 = engine.dMax >= H ? H - 1 : engine.dMax;
            let start = y0 * W, n = (y1 - y0 + 1) * W;
            let out = new Uint8Array(n);
            out.set(engine.grid.subarray(start, start + n));
            let volOut = new Uint8Array(n);
            volOut.set(engine.waterVol.subarray(start, start + n));
            let sphData = null;
            if (engine.sphWater) {
                sphData = engine.sphWater.getParticleData();
            }
            self.postMessage({ type: 'render', buf: out.buffer, volBuf: volOut.buffer, y0: y0, rows: y1 - y0 + 1, sph: sphData }, [out.buffer, volOut.buffer]);
            engine.dMin = H; engine.dMax = -1;
        }
    } catch (e) {
        self.postMessage({ type: 'error', message: e.message, stack: e.stack });
    }
    let wait = Math.max(0, TMS - acc);
    setTimeout(tick, wait);
}

self.onmessage = e => {
    const d = e.data;
    if (d.type === 'init') { engine = new PhysicsEngine(d.w, d.h); lastT = 0; lastTps = 0; lastStats = 0; tpsC = 0; tick(); }
    else if (d.type === 'paint') { engine.paint(d.x, d.y, d.items); }
    else if (d.type === 'clear') { engine.clear(); }
};
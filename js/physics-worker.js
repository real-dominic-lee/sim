// Physics worker — runs in a Web Worker, posts changed row spans back to main thread.
const MAT = { EMPTY: 0, SAND: 1, WATER: 2, WET_SAND: 3, DENSITY: [0, 4, 1, 4], FRICTION: [1, 0.8, 0.995, 0.6] };
// Sand tuned knobs (gravity per physics tick, terminal fall speed in cells/step).
const GRAV = 1.2, MAX_FALL = 16;

function tryDiag(engine, t, cx, cy, cIdx, dir, speed) {
    const W=engine.W, H=engine.H, g=engine.grid, vx=engine.vx, vy=engine.vy, u=engine.upd;
    let tCx = cx + dir;
    if (tCx >= 0 && tCx < W && cy + 1 < H) {
        let sIdx = cy * W + tCx, dIdx = sIdx + W;
        let sType = g[sIdx], dType = g[dIdx];
        let canSide = (sType === MAT.EMPTY) || (sType === MAT.WATER && MAT.DENSITY[t] > MAT.DENSITY[MAT.WATER]);
        let canDown = (dType === MAT.EMPTY) || (dType === MAT.WATER && MAT.DENSITY[t] > MAT.DENSITY[MAT.WATER]);
        if (canSide && canDown) {
            if (t === MAT.SAND && dType === MAT.WATER) {
                engine.setCell(dIdx, MAT.WET_SAND); engine.setCell(cIdx, MAT.EMPTY); vx[cIdx]=0; vy[cIdx]=0;
            } else {
                engine.setCell(dIdx, t);
                if (dType === MAT.WATER) {
                    engine.setCell(cIdx, MAT.WATER); vy[cIdx] = -1.5;
                } else {
                    engine.setCell(cIdx, MAT.EMPTY); vx[cIdx]=0; vy[cIdx]=0;
                }
                vx[dIdx] = dir * speed; vy[dIdx] = 0;
            }
            u[dIdx] = 1; u[cIdx] = 1; engine.addA(dIdx); engine.addA(cIdx); engine.wake(cIdx);
            return true;
        }
    }
    return false;
}


function tryRoll(engine, t, cx, cy, cIdx, dir) {
    const W=engine.W, H=engine.H, g=engine.grid, vx=engine.vx, vy=engine.vy, u=engine.upd;
    if (cx + dir < 0 || cx + dir >= W) return false;
    let hIdx = cIdx + dir;
    let dIdx = hIdx + W;
    if (g[hIdx] === MAT.EMPTY && g[dIdx] === t) {
        if (Math.random() < 0.2) {
            engine.setCell(hIdx, t); engine.setCell(cIdx, MAT.EMPTY);
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
        this.vx = new Float32Array(w * h);
        this.vy = new Float32Array(w * h);
        this.upd = new Uint8Array(w * h);
        this.maxA = w * h;
        this.actL = new Int32Array(this.maxA);
        this.nxtL = new Int32Array(this.maxA);
        this.ep = new Uint32Array(w * h);
        this.epc = 0; this.actC = 0; this.nxtC = 0; this.paintQ = [];
        // Incremental material counters (avoids full-grid scan every 500ms).
        this.cters = new Int32Array(4);
        this.cters[0] = w * h; // all EMPTY at birth
        // Dirty row span: rows [dMin, dMax] changed since last render send
        this.dMin = h; this.dMax = -1;
    }
    // Set a cell's material, maintaining incremental counters.
    setCell(i, m) {
        let g = this.grid, old = g[i];
        if (old !== m) { this.cters[old]--; this.cters[m]++; g[i] = m; return true; }
        return false;
    }
    // Swap two cells' materials (a relocation: counts unchanged).
    swapCell(a, b) {
        let g = this.grid, tmp = g[a]; g[a] = g[b]; g[b] = tmp;
    }
    clear() { this.grid.fill(0); this.vx.fill(0); this.vy.fill(0); this.ep.fill(0); this.epc = this.actC = this.nxtC = 0; this.paintQ.length = 0; this.cters[0] = this.W * this.H; for (let k=1;k<4;k++) this.cters[k]=0; this.dMin = 0; this.dMax = this.H - 1; }
    addA(i) {
        let y = (i / this.W) | 0;
        if (y < this.dMin) this.dMin = y;
        if (y > this.dMax) this.dMax = y;
        if (this.ep[i] !== this.epc && this.nxtC < this.maxA) { this.ep[i] = this.epc; this.nxtL[this.nxtC++] = i; }
    }

    wake(i) {
        const W=this.W, H=this.H, ep=this.ep, epc=this.epc, nxtL=this.nxtL, maxA=this.maxA;
        let nc = this.nxtC;
        let x=i%W, y=(i/W)|0;

        if(y>0){
            if(x>0) { let idx=i-W-1; if (ep[idx] !== epc && nc < maxA) { ep[idx] = epc; nxtL[nc++] = idx; } }
            { let idx=i-W; if (ep[idx] !== epc && nc < maxA) { ep[idx] = epc; nxtL[nc++] = idx; } }
            if(x<W-1) { let idx=i-W+1; if (ep[idx] !== epc && nc < maxA) { ep[idx] = epc; nxtL[nc++] = idx; } }
        }
        if(x>0) { let idx=i-1; if (ep[idx] !== epc && nc < maxA) { ep[idx] = epc; nxtL[nc++] = idx; } }
        if(x<W-1) { let idx=i+1; if (ep[idx] !== epc && nc < maxA) { ep[idx] = epc; nxtL[nc++] = idx; } }
        if(y<H-1){
            if(x>0) { let idx=i+W-1; if (ep[idx] !== epc && nc < maxA) { ep[idx] = epc; nxtL[nc++] = idx; } }
            { let idx=i+W; if (ep[idx] !== epc && nc < maxA) { ep[idx] = epc; nxtL[nc++] = idx; } }
            if(x<W-1) { let idx=i+W+1; if (ep[idx] !== epc && nc < maxA) { ep[idx] = epc; nxtL[nc++] = idx; } }
        }
        this.nxtC = nc;
    }

    paint(x, y, items) { this.paintQ.push({x, y, items}); }
    applyPaints() {
        for (let p of this.paintQ) {
            for (let item of p.items) {
                let mat = item.mat, s = item.size;
                if (s > 0) {
                    // Fast integer square root approximation for radius
                    let r = 0, s2 = 0;
                    while (s2 < s) { r++; s2 += 2 * r - 1; }
                    let r2 = r * r;

                    for(let i = 0; i < s; i++) {
                        let dx = 0, dy = 0;
                        // Rejection sampling for perfect circle
                        do {
                            dx = ((Math.random() * (2 * r + 1)) | 0) - r;
                            dy = ((Math.random() * (2 * r + 1)) | 0) - r;
                        } while(dx * dx + dy * dy > r2);

                        let nx = p.x + dx;
                        let ny = p.y + dy;
                        if(nx >= 0 && nx < this.W && ny >= 0 && ny < this.H) {
                            let idx = ny * this.W + nx;
                            if(this.grid[idx] === MAT.EMPTY) {
                                this.setCell(idx, mat);
                                this.vx[idx] = 0;
                                this.vy[idx] = 0;
                                this.addA(idx); this.wake(idx);
                            }
                        }
                    }
                }
            }
        }
        this.paintQ.length = 0;
    }
    update() {
        let tL=this.actL; this.actL=this.nxtL; this.nxtL=tL;
        this.actC = this.nxtC; this.nxtC = 0; this.epc++; this.applyPaints();
        let u = this.upd, actL = this.actL, actC = this.actC, W = this.W, g = this.grid, dMin = this.dMin, dMax = this.dMax;
        // Processed cells' origin rows are dirty (they may have vacated)
        for(let i=0; i<actC; i++) { let idx=actL[i]; u[idx] = 0; let y=(idx/W)|0; if(y<dMin)dMin=y; if(y>dMax)dMax=y; }
        this.dMin = dMin; this.dMax = dMax;
        // Mutated target cells get tracked inside addA()
        for(let i=0; i<actC; i++) { let idx=actL[i]; if(!u[idx] && g[idx]!==MAT.EMPTY) this.proc(idx, 0); }
    }

    // Cheap discrete sand solver. Gravity accumulates in vy (capped at MAX_FALL);
    // the grain falls as far as empty space allows in ONE column scan, then
    // diagonally settles / rolls when blocked. No substep loop, no recursion.
    procSand(idx, t) {
        const W=this.W, H=this.H, g=this.grid, vx=this.vx, vy=this.vy;
        let x=idx%W, y=(idx/W)|0;
        let vyc = vy[idx] + GRAV;
        if (vyc > MAX_FALL) vyc = MAX_FALL;
        let vxc = vx[idx] * 0.95;
        if (Math.abs(vxc) < 0.05) vxc = 0;
        // Fall straight down through empty cells, up to floor(vyc) rows.
        let fallDist = vyc|0; if (fallDist < 1) fallDist = 1;
        let dist = 0, wetAt = -1, fellOff = false;
        for (let s = 1; s <= fallDist; s++) {
            if (y + s >= H) { fellOff = true; break; }
            let nt = g[idx + s*W];
            if (nt === MAT.EMPTY) { dist = s; }
            else if (nt === MAT.WATER) { wetAt = idx + s*W; break; }
            else break;
        }
        if (dist > 0 && !wetAt) {
            // Move down through the empty column.
            let nIdx = idx + dist*W;
            this.setCell(idx, MAT.EMPTY);
            this.setCell(nIdx, t);
            vx[nIdx] = vxc * 0.5; vy[nIdx] = vyc * 0.7 + dist * 0.3;
            this.upd[idx]=1; this.upd[nIdx]=1; this.addA(nIdx); this.addA(idx); this.wake(nIdx);
            // Still falling freely if there's empty space directly below the new cell.
            if (y + dist + 1 < H && g[nIdx + W] === MAT.EMPTY && !fellOff) {
                return; // keep momentum, process again next tick
            }
            // Landed on a blocker (or fell off the bottom): re-evaluate at nIdx.
            idx = nIdx; x = idx % W; y = (idx / W) | 0;
            vxc = vx[idx]; vyc = vy[idx];
        }
        if (wetAt !== -1) {
            // Sand reaching water wets in place at the water surface.
            this.setCell(idx, MAT.EMPTY);
            this.setCell(wetAt, MAT.WET_SAND);
            vx[wetAt] = 0; vy[wetAt] = (t === MAT.WET_SAND) ? -1.5 : 0;
            vx[idx] = 0; vy[idx] = 0; this.upd[wetAt]=1; this.upd[idx]=1;
            this.addA(wetAt); this.addA(idx); this.wake(wetAt);
            return;
        }
        // Blocked directly below: try a diagonal slide, then a roll, else rest.
        let slid = false;
        if (y + 1 < H && g[idx + W] === MAT.WATER) {
            // Resting on water surface: sand sinks → wet.
            this.setCell(idx, MAT.EMPTY); this.setCell(idx + W, MAT.WET_SAND);
            vx[idx]=0; vy[idx]=0; vx[idx+W]=0; vy[idx+W]=0;
            this.upd[idx]=1; this.upd[idx+W]=1; this.addA(idx); this.addA(idx+W); this.wake(idx+W);
            return;
        }
        let d = Math.random() < 0.5 ? 1 : -1;
        if (tryDiag(this, t, x, y, idx, d, 1.5)) { slid = true; }
        else if (tryDiag(this, t, x, y, idx, -d, 1.5)) { slid = true; }
        if (!slid) {
            if (tryRoll(this, t, x, y, idx, Math.random() < 0.5 ? 1 : -1)) slid = true;
            else if (tryRoll(this, t, x, y, idx, Math.random() < 0.5 ? 1 : -1)) slid = true;
        }
        if (slid) return;
        // Resting: damp residual velocity; sleep if fully at rest.
        vx[idx] = vxc * 0.4; vy[idx] = vyc * 0.4;
        if (Math.abs(vx[idx]) < 0.1) vx[idx] = 0;
        if (Math.abs(vy[idx]) < 0.1) vy[idx] = 0;
        if (vx[idx] === 0 && vy[idx] === 0) return; // settled -> sleep (not re-added)
        this.addA(idx);
    }

    proc(idx, depth) {
        const W=this.W, H=this.H, g=this.grid, vx=this.vx, vy=this.vy, u=this.upd;
        let x=idx%W, y=(idx/W)|0, t=g[idx];
        if(t===MAT.EMPTY) return;
        u[idx]=1;

        // Sand (and wet sand) use a cheap discrete solver: gravity + column fall
        // + diagonal/roll settling. No 30-substep loop, no same-type recursion.
        if(t===MAT.SAND||t===MAT.WET_SAND){ this.procSand(idx,t); return; }

        let pressure = 0;
        if (t === MAT.WATER) {
            for (let py = y - 1; py >= 0; py--) {
                if (g[py * W + x] === MAT.WATER) pressure++;
                else break;
            }
            let soakChance = 0.05 + pressure * 0.05;
            if (Math.random() < soakChance) {
                if (y+1<H && g[idx+W] === MAT.SAND) {
                    let nIdx = idx+W;
                    g[idx]=MAT.EMPTY; g[nIdx]=MAT.WET_SAND; vx[idx]=0; vy[idx]=0;
                    u[idx]=1; u[nIdx]=1; this.addA(idx); this.addA(nIdx); this.wake(idx); this.wake(nIdx); return;
                }
                if (x>0 && g[idx-1] === MAT.SAND) {
                    let nIdx = idx-1;
                    g[idx]=MAT.EMPTY; g[nIdx]=MAT.WET_SAND; vx[idx]=0; vy[idx]=0;
                    u[idx]=1; u[nIdx]=1; this.addA(idx); this.addA(nIdx); this.wake(idx); this.wake(nIdx); return;
                }
                if (x<W-1 && g[idx+1] === MAT.SAND) {
                    let nIdx = idx+1;
                    g[idx]=MAT.EMPTY; g[nIdx]=MAT.WET_SAND; vx[idx]=0; vy[idx]=0;
                    u[idx]=1; u[nIdx]=1; this.addA(idx); this.addA(nIdx); this.wake(idx); this.wake(nIdx); return;
                }
                if (y>0 && g[idx-W] === MAT.SAND) {
                    let nIdx = idx-W;
                    g[idx]=MAT.EMPTY; g[nIdx]=MAT.WET_SAND; vx[idx]=0; vy[idx]=0;
                    u[idx]=1; u[nIdx]=1; this.addA(idx); this.addA(nIdx); this.wake(idx); this.wake(nIdx); return;
                }
            }
        }

        let vxc = vx[idx];
        let vyc = vy[idx];
        vyc += 1.2;

        if ((y + 1 >= H || g[idx + W] !== MAT.EMPTY)) {
            vxc *= (t===MAT.WATER) ? 0.975 : MAT.FRICTION[t];
            if (vxc < 0) { if (-vxc < 0.1) vxc = 0; } else { if (vxc < 0.1) vxc = 0; }
        }

        let avx = vxc < 0 ? -vxc : vxc;
        let avy = vyc < 0 ? -vyc : vyc;
        let maxV = avx > avy ? avx : avy;
        let stepsToProcess = maxV | 0;
        if (stepsToProcess > 30) stepsToProcess = 30;

        let stepsTakenX = 0, stepsTakenY = 0;
        let cx=x, cy=y, cIdx=idx, moved=false;
        let finalVx = vxc, finalVy = vyc;

        for(let i=0; i<stepsToProcess; i++) {
            let sx=0, sy=0;
            if(avx > stepsTakenX) { sx=vxc < 0 ? -1 : 1; stepsTakenX++; }
            if(avy > stepsTakenY) { sy=vyc < 0 ? -1 : 1; stepsTakenY++; }
            if(sx===0 && sy===0) break;

            let nx=cx+sx, ny=cy+sy;
            if(nx<0||nx>=W) { finalVx=0; sx=0; nx=cx; }
            if(ny<0||ny>=H) { finalVy=0; sy=0; ny=cy; }
            if(sx===0 && sy===0) break;

            let nIdx=ny*W+nx, nt=g[nIdx];

            if(nt===MAT.EMPTY) {
                g[nIdx]=t; g[cIdx]=MAT.EMPTY; u[nIdx]=1; u[cIdx]=1;
                cx=nx; cy=ny; cIdx=nIdx; moved=true;
            } else if (MAT.DENSITY[t] > MAT.DENSITY[nt]) {
                if((t===MAT.SAND || t===MAT.WET_SAND) && nt===MAT.WATER) {
                    if (t===MAT.SAND) { g[cIdx]=MAT.EMPTY; g[nIdx]=MAT.WET_SAND; }
                    else { g[cIdx]=MAT.WATER; g[nIdx]=MAT.WET_SAND; vy[cIdx]=-1.5; }
                    vx[cIdx]=0; vy[cIdx]=0;
                    u[nIdx]=1; u[cIdx]=1; this.addA(nIdx); this.addA(cIdx); this.wake(nIdx); this.wake(cIdx);
                    return;
                }
                g[cIdx]=nt; g[nIdx]=t;
                let tvx=vx[nIdx], tvy=vy[nIdx];
                vx[nIdx]=finalVx*0.5; vy[nIdx]=finalVy*0.5; vx[cIdx]=tvx*0.8; vy[cIdx]=tvy*0.8-1.5;
                u[nIdx]=1; u[cIdx]=1; this.addA(nIdx); this.addA(cIdx); this.wake(nIdx); this.wake(cIdx);
                return;
            } else if (nt === t) {
                if ((ny + 1 < H) && (g[nIdx + W] === MAT.EMPTY)) {
                    // Hit an unsupported particle of the same type.
                    // Transfer momentum and stop to prevent sideways explosions.
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
                    // Hit a supported particle of the same type.
                    if (sy > 0) {
                        finalVy = 0;
                        if (t === MAT.WATER) {
                            let force = 2.5 + pressure * 0.8;
                            if (force > 8.0) force = 8.0;
                            if(cx>0&&g[cIdx-1]===MAT.EMPTY) finalVx -= vyc * force;
                            if(cx<W-1&&g[cIdx+1]===MAT.EMPTY) finalVx += vyc * force;

                            if (finalVx === 0 && finalVy === 0 && pressure > 0) {
                                let lE = cx > 0 && g[cIdx - 1] === MAT.EMPTY;
                                let rE = cx < W - 1 && g[cIdx + 1] === MAT.EMPTY;
                                if (lE && rE) finalVx = (Math.random() < 0.5 ? -1 : 1) * pressure * 0.5;
                                else if (lE) finalVx = -pressure * 0.5;
                                else if (rE) finalVx = pressure * 0.5;
                            }
                            if (vyc > 6.0 && pressure > 3 && Math.random() < 0.2) finalVy = -vyc * 0.3;
                        } else {
                            // Sand hitting sand: transfer some momentum, stop completely. No bounce, no forced slide.
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
                    g[cIdx] = MAT.EMPTY; g[nIdx] = MAT.WET_SAND; vx[cIdx]=0; vy[cIdx]=0;
                    u[cIdx]=1; u[nIdx]=1; this.addA(cIdx); this.addA(nIdx); this.wake(cIdx); this.wake(nIdx); return;
                }
            } else {
                if (sy > 0) {
                    finalVy = 0;
                    if (t === MAT.WATER) {
                        let force = 2.5 + pressure * 0.8;
                        if (force > 8.0) force = 8.0;
                        if(cx>0&&g[cIdx-1]===MAT.EMPTY) finalVx -= vyc * force;
                        if(cx<W-1&&g[cIdx+1]===MAT.EMPTY) finalVx += vyc * force;

                        if (finalVx === 0 && finalVy === 0 && pressure > 0) {
                            let lE = cx > 0 && g[cIdx - 1] === MAT.EMPTY;
                            let rE = cx < W - 1 && g[cIdx + 1] === MAT.EMPTY;
                            if (lE && rE) finalVx = (Math.random() < 0.5 ? -1 : 1) * pressure * 0.5;
                            else if (lE) finalVx = -pressure * 0.5;
                            else if (rE) finalVx = pressure * 0.5;
                        }
                        if (vyc > 6.0 && pressure > 3 && Math.random() < 0.2) finalVy = -vyc * 0.3;
                    } else {
                        let sDir = finalVx > 0.1 ? 1 : (finalVx < -0.1 ? -1 : (Math.random() < 0.5 ? 1 : -1));
                        if (tryDiag(this, t, cx, cy, cIdx, sDir, 3.0)) { cx += sDir; cy++; cIdx += W + sDir; moved = true; }
                    }
                    break;
                } else { finalVx *= -0.1; finalVy *= -0.1; break; }
            }
        }

        if (moved) { this.wake(cIdx); this.wake(idx); }
        vx[cIdx] = finalVx; vy[cIdx] = finalVy;

        if (!moved || (Math.abs(finalVx) < 1.0 && Math.abs(finalVy) < 1.0)) {
            let rMoved = false;
                if (cy + 1 < H && g[cIdx + W] === MAT.EMPTY) {
                    let bIdx = cIdx + W;
                    g[bIdx] = t; g[cIdx] = MAT.EMPTY; vy[bIdx] = vy[cIdx] + 1.2; vx[bIdx] = vx[cIdx]; vx[cIdx] = 0; vy[cIdx] = 0;
                    u[bIdx] = 1; u[cIdx] = 1; this.addA(bIdx); this.wake(cIdx); cIdx = bIdx; cy++; rMoved = true;
                }
                if (!rMoved) {
                    let d = Math.random() < 0.5 ? 1 : -1;
                    if (tryDiag(this, t, cx, cy, cIdx, d, 4.0)) { cx += d; cy++; cIdx += W + d; rMoved = true; }
                    else if (tryDiag(this, t, cx, cy, cIdx, -d, 4.0)) { cx -= d; cy++; cIdx += W - d; rMoved = true; }
                    else {
                        let touchingSand = (cy + 1 < H && g[cIdx + W] === MAT.SAND) || (cy > 0 && g[cIdx - W] === MAT.SAND) || (cx > 0 && g[cIdx - 1] === MAT.SAND) || (cx < W - 1 && g[cIdx + 1] === MAT.SAND);
                        let touchingWetSand = (cy + 1 < H && g[cIdx + W] === MAT.WET_SAND) || (cy > 0 && g[cIdx - W] === MAT.WET_SAND) || (cx > 0 && g[cIdx - 1] === MAT.WET_SAND) || (cx < W - 1 && g[cIdx + 1] === MAT.WET_SAND);

                        if (Math.random() < 0.1 && touchingSand) {
                            if (cy+1<H && g[cIdx+W] === MAT.SAND) {
                                let nIdx = cIdx+W; g[cIdx] = MAT.EMPTY; g[nIdx] = MAT.WET_SAND; vx[cIdx]=0; vy[cIdx]=0; u[cIdx]=1; u[nIdx]=1; this.addA(cIdx); this.addA(nIdx); this.wake(cIdx); this.wake(nIdx); return;
                            }
                            if (cx+1<W && g[cIdx+1] === MAT.SAND) {
                                let nIdx = cIdx+1; g[cIdx] = MAT.EMPTY; g[nIdx] = MAT.WET_SAND; vx[cIdx]=0; vy[cIdx]=0; u[cIdx]=1; u[nIdx]=1; this.addA(cIdx); this.addA(nIdx); this.wake(cIdx); this.wake(nIdx); return;
                            }
                            if (cx>0 && g[cIdx-1] === MAT.SAND) {
                                let nIdx = cIdx-1; g[cIdx] = MAT.EMPTY; g[nIdx] = MAT.WET_SAND; vx[cIdx]=0; vy[cIdx]=0; u[cIdx]=1; u[nIdx]=1; this.addA(cIdx); this.addA(nIdx); this.wake(cIdx); this.wake(nIdx); return;
                            }
                            if (cy>0 && g[cIdx-W] === MAT.SAND) {
                                let nIdx = cIdx-W; g[cIdx] = MAT.EMPTY; g[nIdx] = MAT.WET_SAND; vx[cIdx]=0; vy[cIdx]=0; u[cIdx]=1; u[nIdx]=1; this.addA(cIdx); this.addA(nIdx); this.wake(cIdx); this.wake(nIdx); return;
                            }
                        }

                        // RANDOM WALK PATHFINDING SOAK: 3x max distance (180), Cubic curve falloff
                        if (touchingWetSand && Math.random() < SOAK_PROB) {
                            let maxSteps = 180;
                            let wx = cx, wy = cy;
                            for (let s = 1; s <= maxSteps; s++) {
                                let r = Math.random();
                                let dx = 0, dy = 0;
                                if (r < 0.7) dy = 1;       // 70% chance down (heavy gravity bias for depth)
                                else if (r < 0.85) dx = 1; // 15% right
                                else dx = -1;              // 15% left

                                let nx = wx + dx, ny = wy + dy;
                                if (nx < 0 || nx >= W || ny < 0 || ny >= H) break;

                                let nIdx = ny * W + nx;
                                if (g[nIdx] === MAT.WET_SAND) {
                                    wx = nx; wy = ny; // Continue pathfinding
                                } else if (g[nIdx] === MAT.SAND) {
                                    // Found dry sand! Calculate cubic soak chance (100% at s=1, ~12.5% at halfway, 0% at 180)
                                    let progress = (s - 1) / (maxSteps - 1);
                                    let soakChance = Math.pow(1.0 - progress, 3);

                                    if (Math.random() < soakChance) {
                                        // Soak it!
                                        g[cIdx] = MAT.EMPTY; g[nIdx] = MAT.WET_SAND; vx[cIdx]=0; vy[cIdx]=0;
                                        u[cIdx]=1; u[nIdx]=1; this.addA(cIdx); this.addA(nIdx); this.wake(cIdx); this.wake(nIdx); return;
                                    } else {
                                        // Failed the distance roll, stop the walk.
                                        break;
                                    }
                                } else {
                                    break; // Hit air, water, or wall. Stop walk.
                                }
                            }
                        }

                        let lE = -1, rE = -1, lD = false, rD = false;
                        for (let i=1; i<=30; i++) {
                            if (cx - i < 0) break;
                            let cIdxL = cy * W + (cx - i);
                            if (g[cIdxL] === MAT.SAND || g[cIdxL] === MAT.WET_SAND) break;
                            if (g[cIdxL] === MAT.EMPTY) { lE = i; if (cy+1<H && g[cIdxL+W]===MAT.EMPTY) lD = true; break; }
                        }
                        for (let i=1; i<=30; i++) {
                            if (cx + i >= W) break;
                            let cIdxR = cy * W + (cx + i);
                            if (g[cIdxR] === MAT.SAND || g[cIdxR] === MAT.WET_SAND) break;
                            if (g[cIdxR] === MAT.EMPTY) { rE = i; if (cy+1<H && g[cIdxR+W]===MAT.EMPTY) rD = true; break; }
                        }

                        if (lE !== -1 || rE !== -1) {
                            let dir = (lE !== -1 && rE !== -1) ? ((lD && !rD) ? -1 : (rD && !lD) ? 1 : (lE <= rE ? -1 : 1)) : (lE !== -1 ? -1 : 1);
                            let dist = dir === -1 ? lE : rE;
                            let targetX = cx + (dir * dist), targetIdx = cy * W + targetX;
                            g[targetIdx] = MAT.WATER; g[cIdx] = MAT.EMPTY;
                            let isDown = (dir == -1 && lD) || (dir == 1 && rD);
                            let speed = isDown ? 12.0 : 6.0;
                            vx[targetIdx] = dir * speed; vy[targetIdx] = isDown ? 3.0 : 0;
                            vx[cIdx] = 0; vy[cIdx] = 0;
                            u[targetIdx] = 1; u[cIdx] = 1; this.addA(targetIdx); this.addA(cIdx); this.wake(cIdx);

                            for (let py = cy - 1; py >= 0; py--) {
                                let upI = py * W + cx;
                                if (g[upI] === MAT.WATER) {
                                    vx[upI] = dir * speed * 0.8;
                                    vy[upI] = 3.0;
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
            if (vx[cIdx] === 0 && vy[cIdx] === 0) return;
        }
        this.addA(cIdx);
    }
}
let engine, lastT=0, acc=0, tpsC=0, lastTps=0, cTps=0, lastStats=0, updMs=0, peakUpdMs=0, scanMs=0; let TPS=60, TMS=1000/TPS, SOAK_PROB=0.35, STATS_MS=500;
let counts = new Int32Array(4);
function tick() {
    let now = performance.now(); if(lastT===0){lastT=now;lastTps=now;} let d=now-lastT; lastT=now; acc+=d;
    let t=0; let tickUpdMs=0; while(acc>=TMS && t<2){ let t0=performance.now(); engine.update(); let d2=performance.now()-t0; tickUpdMs += d2; if(d2>peakUpdMs) peakUpdMs=d2; acc-=TMS; t++; tpsC++; } if(acc>TMS*2) acc=0;
    updMs += tickUpdMs;
    if(now-lastTps>=1000){ cTps=tpsC; tpsC=0; lastTps=now; }
    if(STATS_MS && now-lastStats>=STATS_MS){
        lastStats=now;
        counts.fill(0);
        let g=engine.grid, len=g.length;
        let s0=performance.now();
        for(let i=0;i<len;i++) counts[g[i]]++;
        scanMs = performance.now()-s0;
        self.postMessage({type:'stats', aC:engine.actC, tps:cTps, counts:counts, updateMs:updMs, peakMs:peakUpdMs, scanMs:scanMs});
        updMs = 0; peakUpdMs = 0; scanMs = 0;
    }
    // Send only the changed row span, in a fresh buffer. No round-trip needed.
    if(engine.dMax >= engine.dMin && engine.dMax >= 0){
        let W=engine.W, H=engine.H;
        let y0 = engine.dMin < 0 ? 0 : engine.dMin;
        let y1 = engine.dMax >= H ? H - 1 : engine.dMax;
        let start = y0 * W, n = (y1 - y0 + 1) * W;
        let out = new Uint8Array(n);
        out.set(engine.grid.subarray(start, start + n));
        self.postMessage({type:'render', buf: out.buffer, y0: y0, rows: y1 - y0 + 1}, [out.buffer]);
        engine.dMin = H; engine.dMax = -1;
    }
    setTimeout(tick, 0);
}
self.onmessage = e => {
    const d = e.data;
    if(d.type==='init'){
        engine=new PhysicsEngine(d.w,d.h); lastT=0; lastTps=0; lastStats=0; tpsC=0;
        if(d.statsMs){ STATS_MS = +d.statsMs|0; if(STATS_MS<50) STATS_MS=50; }
        if(d.soft){ TPS=30; TMS=1000/TPS; SOAK_PROB=0.12; }
        tick();
    }
    else if(d.type==='paint'){ engine.paint(d.x, d.y, d.items); }
    else if(d.type==='clear'){ engine.clear(); }
};

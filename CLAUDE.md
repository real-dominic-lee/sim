# sim — Falling-Sand / Fluid Engine

Single-bundle browser sandbox: a granular/fluid particle simulation (sand, water, wet sand) with a GPU-accelerated renderer. **One file** (`index.html`) holds everything — no build, no modules, no framework. Open it in a browser to run.

## Architecture

```
            ┌──────────────────────────────────────────────────┐
 index.html │  Worker (Blob URL, inline source = workerCode)    │
            │   ─ PhysicsEngine (grid + velocity + update) ─   │
            │   runs tick() @ TPS=60 (fixed-step), postMessage() │
            │              ▲  ▲                                   │
            │  paint/clear  │                                   │
            │              │                                   │
            │  Main thread  │  WebGL2 renderer (rLoop, rAF)      │
            │  ─ input/paint ─  PBO + dirty-row texSubImage2D   │
            │  ─ UI sliders/checkboxes ─────────────────────────│
            └──────────────────────────────────────────────────┘
```

### Physics engine (worker side)

- `MAT = { EMPTY:0, SAND:1, WATER:2, WET_SAND:3, DENSITY, FRICTION }`.
- Grid: `Uint8Array(W*H)`. Velocity: `Float32Array` x/y. Per-frame `upd` (processed) flag + `ep` (epoch-tagged active queue).
- **Activity lists**: double-buffered `actL`/`nxtL` (Int32Array). `wake()` expands a cell's 8-neighborhood into `nxtL` each frame. `update()` swaps buffers, runs paints, then iterates active cells through `proc()`.
- `addA(i)` records the dirty row span `dMin..dMax` as cells mutate.
- `proc(idx, depth)`: the heart. Sub-step movement (up to 30 sub-steps / `stepsToProcess`), density-based displacement, momentum exchange, sand↔water wetting, water buoyancy/expansion under pressure, soak pathfinding (random walk toward dry sand, cubic falloff), side-slide gap routing.
- No allocation in the hot loop — typed arrays reused, `paintQ` drained each frame.
- Fixed-step: `tick()` accumulates wall-time, runs up to **2** physics ticks per frame to avoid spiral-of-death, resets if behind by >2 frames.

### Renderer (main thread)

- **WebGL2**, opaque canvas (`alpha:false`, `antialias:false`, `depth/stencil:false`, `powerPreference:'high-performance'`, `desynchronized:true`).
- Single full-screen triangle (3 vertices), one draw call, **NEAREST** sampling on an **R8UI** texture.
- Fragment shader maps cell id → color. Water-only gap-filling trace (4 cardinal + 2 diagonal, distance ≤4) fills visually-empty gaps so the water column reads solid.
- **Render path**: worker sends *only the changed row span* (`Uint8Array` + `y0` + `rows`, transferred zero-copy via `buf`). Main thread uploads via **persistent PBO** → `bufferSubData` → `texSubImage2D`. `gl.pixelStorei(UNPACK_ALIGNMENT,1)`.
- **Draw guard**: `needDraw` set on new texture data, trace-state change (water→no-water or reverse), first frame, or tab-visible return. Idle frames draw nothing → ~0 GPU cost when static.
- `requestAnimationFrame(rLoop)`; FPS frame-time EMA in `ftEMA`.

### Input

- Pointer events on canvas. `paint()` maps client→canvas coords, sends `{type:'paint', x, y, items:[{mat,size}]}` to worker. Sand/water + size sliders control paint radius (rejection-sampled circle).

## Files

| file | role |
|------|------|
| `index.html` | entire app: HTML, CSS, inline worker source, main-thread JS, GLSL strings. |

## Layout of `index.html`

1. Head (title, CSS).
2. `<canvas id="simCanvas">`, left UI (sand/water checkboxes + size sliders, clear button), right UI ("stuff" toggle → stats overlay).
3. `workerCode` — the entire physics as a string, turned into a `Worker` via `Blob`+`URL.createObjectURL`.
4. Main-thread code — GL setup, worker init, render loop, paint, stats interval, `init()`.

## Conventions / constraints

- Runs offline, no external assets.
- Worker is a raw string — no lint/compile. GLSL is inline string literals (no `#extension`, GLSL 3.00 ES).
- Canvas size = window size (integer resize reloads via `location.reload()`).
- All math is intentional; constants (gravity `1.2`, friction, soak chance, random-walk step count, pressure force `2.5+pressure*0.8`) are tuned knobs, not magic numbers to "fix."

## How to run / test

```
open index.html   # any modern browser (WebGL2)
```

Stats (FPS / TPS / frame ms / active cells / row-upload count / material counts / grid size) toggle via the "stuff" checkbox in the top-right.

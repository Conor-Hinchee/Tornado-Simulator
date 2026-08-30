/**
 * Mutable simulation state, laid out for the UI thread.
 *
 * All hot data lives in typed arrays wrapped in Reanimated shared values so the
 * per-frame physics step (see simulation.ts) can read and mutate it on the UI
 * thread with zero JS-bridge hops. We use a struct-of-arrays layout (separate
 * px/py/vx/... arrays) rather than an array of objects because it is both
 * cache-friendly and cheap to hand to a worklet.
 *
 * Scalars that the render layer binds to (tornado position, Vmax, EF, timer)
 * are individual shared values so Skia can react to them via useDerivedValue.
 */
import { makeMutable, type SharedValue } from 'react-native-reanimated';
import { STRUCTURES, STRUCTURE_ORDER, TUNING } from './model';

export interface WorldState {
  // --- debris (struct-of-arrays, capacity = MAX_DEBRIS) ---
  dx: SharedValue<Float32Array>;
  dy: SharedValue<Float32Array>;
  dvx: SharedValue<Float32Array>;
  dvy: SharedValue<Float32Array>;
  dmass: SharedValue<Float32Array>;
  dsize: SharedValue<Float32Array>;
  dz: SharedValue<Float32Array>; // height above the ground plane (loft), render + light integration
  dalive: SharedValue<Float32Array>; // 1 = active, 0 = free slot

  // --- structures (small, fixed after init) ---
  sx: SharedValue<Float32Array>;
  sy: SharedValue<Float32Array>;
  shp: SharedValue<Float32Array>;
  shpMax: SharedValue<Float32Array>;
  sbreak: SharedValue<Float32Array>;
  sef: SharedValue<Float32Array>;
  sw: SharedValue<Float32Array>;
  sh: SharedValue<Float32Array>;
  stype: SharedValue<Float32Array>; // index into STRUCTURE_ORDER
  salive: SharedValue<Float32Array>;
  schunks: SharedValue<Float32Array>;
  schunkMass: SharedValue<Float32Array>;

  // --- scalars ---
  tornadoX: SharedValue<number>;
  tornadoY: SharedValue<number>;
  targetX: SharedValue<number>;
  targetY: SharedValue<number>;
  vmax: SharedValue<number>;
  maxEF: SharedValue<number>; // -1 = nothing destroyed yet
  timeLeft: SharedValue<number>;
  running: SharedValue<number>; // 1 = live, 0 = roped out
  debrisCount: SharedValue<number>;
  tick: SharedValue<number>; // increments each frame; Skia derived values read it to recompute
  spin: SharedValue<number>; // accumulated funnel rotation (radians); advances with wind speed

  // bounds
  width: number;
  height: number;
}

/** Deterministic-ish PRNG so field layouts are reproducible while iterating. */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Create all shared values once (on mount). Capacity is fixed; `resetWorld`
 * repopulates without reallocating.
 */
export function createWorld(width: number, height: number): WorldState {
  const N = TUNING.MAX_DEBRIS;
  const S = 40; // max structures
  const f32 = (n: number) => makeMutable<Float32Array>(new Float32Array(n));

  const w: WorldState = {
    dx: f32(N), dy: f32(N), dvx: f32(N), dvy: f32(N),
    dmass: f32(N), dsize: f32(N), dz: f32(N), dalive: f32(N),

    sx: f32(S), sy: f32(S), shp: f32(S), shpMax: f32(S),
    sbreak: f32(S), sef: f32(S), sw: f32(S), sh: f32(S),
    stype: f32(S), salive: f32(S), schunks: f32(S), schunkMass: f32(S),

    tornadoX: makeMutable(width / 2),
    tornadoY: makeMutable(height / 2),
    targetX: makeMutable(width / 2),
    targetY: makeMutable(height / 2),
    vmax: makeMutable(TUNING.VMAX_START),
    maxEF: makeMutable(-1),
    timeLeft: makeMutable(TUNING.RUN_SECONDS),
    running: makeMutable(1),
    debrisCount: makeMutable(0),
    tick: makeMutable(0),
    spin: makeMutable(0),

    width,
    height,
  };
  resetWorld(w, 12345);
  return w;
}

/**
 * Scatter a fresh field of structures and reset all run state.
 *
 * IMPORTANT: this runs on the JS thread. A Reanimated shared value that holds a
 * TypedArray keeps a separate copy on the UI thread, and mutating elements in
 * place (`w.sx.value[i] = x`) does NOT propagate across threads. So we build
 * plain local arrays and ASSIGN them (`w.sx.value = arr`), which triggers the
 * JS -> UI sync. From then on, per-frame mutations happen inside the worklet
 * (UI thread) and stay coherent with what Skia draws.
 */
export function resetWorld(w: WorldState, seed = Math.floor(Math.random() * 1e6)) {
  const rng = makeRng(seed);
  const N = w.dx.value.length;
  const S = w.sx.value.length;

  // fresh, empty debris pool (assign whole arrays so the UI thread sees them)
  w.dx.value = new Float32Array(N);
  w.dy.value = new Float32Array(N);
  w.dvx.value = new Float32Array(N);
  w.dvy.value = new Float32Array(N);
  w.dmass.value = new Float32Array(N);
  w.dsize.value = new Float32Array(N);
  w.dz.value = new Float32Array(N);
  w.dalive.value = new Float32Array(N);

  // scalars (these sync fine on their own)
  w.tornadoX.value = w.width / 2;
  w.tornadoY.value = w.height / 2;
  w.targetX.value = w.width / 2;
  w.targetY.value = w.height / 2;
  w.vmax.value = TUNING.VMAX_START;
  w.maxEF.value = -1;
  w.timeLeft.value = TUNING.RUN_SECONDS;
  w.running.value = 1;
  w.debrisCount.value = 0;
  w.tick.value = 0;
  w.spin.value = 0;

  // Field composition: lots of trees, some trailers, fewer houses, a couple silos.
  const plan: string[] = [
    ...Array(24).fill('tree'),
  ];

  const sx = new Float32Array(S);
  const sy = new Float32Array(S);
  const shp = new Float32Array(S);
  const shpMax = new Float32Array(S);
  const sbreak = new Float32Array(S);
  const sef = new Float32Array(S);
  const sw = new Float32Array(S);
  const sh = new Float32Array(S);
  const stype = new Float32Array(S);
  const salive = new Float32Array(S);
  const schunks = new Float32Array(S);
  const schunkMass = new Float32Array(S);

  const margin = 60;
  const topMargin = 290; // keep props below the storm cloud AND the score/HUD band
  const botMargin = 55;
  const keepClear = 120; // don't spawn right on top of the tornado start

  for (let i = 0; i < plan.length; i++) {
    const t = STRUCTURES[plan[i]];
    const ti = STRUCTURE_ORDER.indexOf(plan[i] as any);
    let x = 0, y = 0, ok = false, tries = 0;
    while (!ok && tries++ < 40) {
      x = margin + rng() * (w.width - 2 * margin);
      y = topMargin + rng() * (w.height - topMargin - botMargin);
      const dx = x - w.width / 2;
      const dy = y - w.height / 2;
      ok = dx * dx + dy * dy > keepClear * keepClear;
    }
    sx[i] = x;
    sy[i] = y;
    shp[i] = t.hp;
    shpMax[i] = t.hp;
    sbreak[i] = t.breakWind;
    sef[i] = t.ef;
    sw[i] = t.w;
    sh[i] = t.h;
    stype[i] = ti;
    schunks[i] = t.chunks;
    schunkMass[i] = t.chunkMass;
    salive[i] = 1;
  }

  // assign whole arrays -> syncs to the UI thread
  w.sx.value = sx;
  w.sy.value = sy;
  w.shp.value = shp;
  w.shpMax.value = shpMax;
  w.sbreak.value = sbreak;
  w.sef.value = sef;
  w.sw.value = sw;
  w.sh.value = sh;
  w.stype.value = stype;
  w.salive.value = salive;
  w.schunks.value = schunks;
  w.schunkMass.value = schunkMass;
}

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
  // --- debris & uprooted structures (struct-of-arrays, capacity = MAX_DEBRIS) ---
  // Everything the tornado picks up lives in funnel-relative coords so it renders
  // as part of the funnel's wind: dphase = angle around the axis, dh = height
  // progress up the funnel (0 base .. 1 top), drf = radius as a multiple of the
  // funnel's radius at that height.
  dalive: SharedValue<Float32Array>;  // 1 = active, 0 = free slot
  dkind: SharedValue<Float32Array>;   // 0 = debris chunk, 1 = whole uprooted structure
  dtype: SharedValue<Float32Array>;   // on a whole (kind=1) entity: origin STRUCTURE_ORDER index, so the render layer can pick a matching shape (e.g. a fence piece instead of the default tree icon)
  dphase: SharedValue<Float32Array>;  // angle around the funnel axis (rad)
  drf: SharedValue<Float32Array>;     // radial factor (x funnel radius at height dh)
  dtargrf: SharedValue<Float32Array>; // radial factor it eases toward
  dh: SharedValue<Float32Array>;      // height progress up the funnel, 0..1
  drise: SharedValue<Float32Array>;   // chunk ascent rate (h/s); on a whole tree, reused as chunk count
  dspin: SharedValue<Float32Array>;   // self-rotation for tumble render (rad)
  dspinv: SharedValue<Float32Array>;  // self-rotation speed (rad/s)
  dsize: SharedValue<Float32Array>;   // base render size (px)
  dmass: SharedValue<Float32Array>;   // eat gain per chunk; on a whole tree, reused as chunk mass
  dtimer: SharedValue<Float32Array>;  // whole-tree spin-before-burst countdown (s)

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
  strain: SharedValue<number>; // 0..1 effort face while tugging a stubborn tree
  pop: SharedValue<number>; // 0..1 "big O" celebration pulse right after an uproot
  introShake: SharedValue<number>; // seconds left on the one-time first-tree face shake
  introUsed: SharedValue<number>; // 1 once the intro shake has been triggered this run
  popVariant: SharedValue<number>; // celebration mouth: 0 = grin, 1 = open mouth (chosen per pop)

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
  const S = 160; // max structures (100 trees + 2 corrals x (4 fence sides + 8 cows) + 1 barn + 1 silo = 126, with headroom)
  const f32 = (n: number) => makeMutable<Float32Array>(new Float32Array(n));

  const w: WorldState = {
    dalive: f32(N), dkind: f32(N), dtype: f32(N), dphase: f32(N), drf: f32(N),
    dtargrf: f32(N), dh: f32(N), drise: f32(N), dspin: f32(N),
    dspinv: f32(N), dsize: f32(N), dmass: f32(N), dtimer: f32(N),

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
    strain: makeMutable(0),
    pop: makeMutable(0),
    introShake: makeMutable(0),
    introUsed: makeMutable(0),
    popVariant: makeMutable(0),

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
  const N = w.dalive.value.length;
  const S = w.sx.value.length;

  // fresh, empty debris pool (assign whole arrays so the UI thread sees them)
  w.dalive.value = new Float32Array(N);
  w.dkind.value = new Float32Array(N);
  w.dtype.value = new Float32Array(N);
  w.dphase.value = new Float32Array(N);
  w.drf.value = new Float32Array(N);
  w.dtargrf.value = new Float32Array(N);
  w.dh.value = new Float32Array(N);
  w.drise.value = new Float32Array(N);
  w.dspin.value = new Float32Array(N);
  w.dspinv.value = new Float32Array(N);
  w.dsize.value = new Float32Array(N);
  w.dmass.value = new Float32Array(N);
  w.dtimer.value = new Float32Array(N);

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
  w.strain.value = 0;
  w.pop.value = 0;
  w.introShake.value = 0;
  w.introUsed.value = 0;
  w.popVariant.value = 0;

  // Field composition: a grove of trees + two pastures + one farmstead
  // (barn + silo, scenery only for now). EF1+ still parked.
  const plan: string[] = [
    // EF0 phase: a grove of trees. Fences and cows are NOT listed here —
    // they're correlated groups (4 sides + a herd of 8 sharing one corral
    // center) placed by the dedicated PASTURES block below, so each side
    // and each cow can be knocked down independently instead of the whole
    // square vanishing at once. Destroying a tree, a fence segment or a cow
    // certifies EF0 (rating goes "—" -> EF0) and shatters it into debris;
    // eaten debris raises Vmax (the "peak mph" number). Mobile homes / EF1
    // come back once this phase feels right.
    //
    // Count is derived from world size, not chosen: hold ~1 prop per
    // 10,400 world px² or the field goes sparse. See [[world-scale]].
    ...Array(100).fill('tree'),
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

  // ================= PASTURES =================
  // Two corrals, each a square of 4 INDEPENDENT fence segments (one per side,
  // so a side can be blown down without the whole square vanishing) with a
  // herd of 8 cows standing inside it. Built by one loop rather than two
  // copies of the same block: every corral is identical apart from where its
  // center lands, and the tree keep-out below just iterates the centers this
  // loop records.
  //
  // Placement: the world is split into CORRALS equal-width LANES and each
  // corral is placed inside its own lane, which is what puts the second one
  // out on the right. Lanes are how the two are guaranteed never to overlap —
  // a pair of independent random centers in one big range would need an
  // explicit corral-vs-corral rejection test and could thrash on retries. The
  // `laneGutter` inset keeps them off their shared lane boundary too, so
  // worst case they still sit ~60 world px apart instead of rail-to-rail.
  const ft = STRUCTURES.fence;
  const fti = STRUCTURE_ORDER.indexOf('fence');
  const ct = STRUCTURES.cow;
  const cti = STRUCTURE_ORDER.indexOf('cow');

  // Half the corral's side, in world px. Everything else about a corral is
  // DERIVED from this — the segment lengths, the herd layout inside it, and
  // the tree keep-out box — so resizing the pastures is a one-number change.
  const fenceHalf = 140;
  const fenceSide = fenceHalf * 2; // corner-to-corner length of one side
  const CORRALS = 2;
  const laneGutter = 30;
  const cowRows = [3, 2, 3]; // 8 cows per corral
  const cowInset = 24; // keep the herd off the rails
  const cowSpan = fenceSide - cowInset * 2;

  const corralCx: number[] = [];
  const corralCy: number[] = [];
  let slot = plan.length;

  const laneW = (w.width - 2 * margin) / CORRALS;
  for (let k = 0; k < CORRALS; k++) {
    const laneX0 = margin + k * laneW;
    const inset = fenceHalf + laneGutter;
    let fenceCx = 0, fenceCy = 0, fOk = false, fTries = 0;
    while (!fOk && fTries++ < 60) {
      fenceCx = laneX0 + inset + rng() * (laneW - 2 * inset);
      fenceCy = topMargin + fenceHalf + rng() * (w.height - topMargin - botMargin - 2 * fenceHalf);
      // Keep the tornado's START position outside the corral. This used to be
      // a point check (`distance from center > keepClear`), which was fine
      // when the corral was 110 units across but is wrong at 280: a center
      // 130 units away passes a point check while the rails sit right on top
      // of the funnel, so the run would open by eating the fence and the
      // whole herd. Tested as a BOX against the corral's own footprint
      // instead — the same square keep-out shape the tree loop uses below —
      // plus a margin for the funnel's own radius.
      const dx = Math.abs(fenceCx - w.width / 2);
      const dy = Math.abs(fenceCy - w.height / 2);
      const clear = fenceHalf + 40;
      fOk = dx > clear || dy > clear;
    }
    corralCx.push(fenceCx);
    corralCy.push(fenceCy);

    // --- 4 fence sides ---
    // [x, y, w, h] per segment; sw>=sh means horizontal (top/bottom), sh>sw
    // means vertical (left/right). See useStructurePath's fence branch — it
    // reads orientation straight back off sw/sh.
    const fenceSegs: [number, number, number, number][] = [
      [fenceCx, fenceCy - fenceHalf, fenceSide, 20], // top
      [fenceCx, fenceCy + fenceHalf, fenceSide, 20], // bottom
      [fenceCx - fenceHalf, fenceCy, 20, fenceSide], // left
      [fenceCx + fenceHalf, fenceCy, 20, fenceSide], // right
    ];
    for (let sg = 0; sg < fenceSegs.length; sg++) {
      const [sxp, syp, swp, shp2] = fenceSegs[sg];
      sx[slot] = sxp;
      sy[slot] = syp;
      shp[slot] = ft.hp;
      shpMax[slot] = ft.hp;
      sbreak[slot] = ft.breakWind;
      sef[slot] = ft.ef;
      sw[slot] = swp;
      sh[slot] = shp2;
      stype[slot] = fti;
      schunks[slot] = ft.chunks;
      schunkMass[slot] = ft.chunkMass;
      salive[slot] = 1;
      slot++;
    }

    // --- herd of 8 ---
    // Three staggered rows (3 / 2 / 3) rather than a plain grid: the middle
    // row's two cows sit in the GAPS of the rows either side, which is what
    // makes it read as a scattered herd instead of a parade. Row and column
    // steps derive from fenceHalf, so a bigger corral spreads the herd out
    // instead of leaving it clustered in the middle.
    //
    // Spacing is deliberately tight-but-not-touching: a cow's art spans 61
    // world units nose-to-tail (lx -25..36.5) and project() scales world-x
    // gaps by the SAME depth factor `p` it scales the cow's own art by, so a
    // world-unit gap here stays a proportional gap on screen at any depth.
    // With fenceHalf 140 the 3-cow rows step 77 units — about a 16-unit gap.
    // Shrink the corral much below this and the herd starts to overlap; since
    // all the cows share one Skia path per layer there is no per-instance
    // z-ordering, so overlapping cows merge into one white blob.
    for (let r = 0; r < cowRows.length; r++) {
      const n = cowRows[r];
      const rowY = fenceCy + (r - (cowRows.length - 1) / 2) * (cowSpan / cowRows.length);
      for (let c = 0; c < n; c++) {
        // -6 re-centers the cow: its art is asymmetric about its ground x
        // (head hangs off the front), spanning lx -25..36.5.
        const colX = fenceCx + (c - (n - 1) / 2) * (cowSpan / n) - 6;
        // Jitter, so the rows aren't ruler-straight. Kept SMALL on x on
        // purpose: neighbours in a 3-cow row sit ~16 units apart, and two
        // cows leaning toward each other by more than half that would overlap
        // into a single white blob.
        sx[slot] = colX + (rng() - 0.5) * 10;
        sy[slot] = rowY + (rng() - 0.5) * 10;
        shp[slot] = ct.hp;
        shpMax[slot] = ct.hp;
        sbreak[slot] = ct.breakWind;
        sef[slot] = ct.ef;
        sw[slot] = ct.w;
        sh[slot] = ct.h;
        stype[slot] = cti;
        schunks[slot] = ct.chunks;
        schunkMass[slot] = ct.chunkMass;
        salive[slot] = 1;
        slot++;
      }
    }
  }

  // ================= FARMSTEAD =================
  // A barn and a grain silo standing side by side just outside ONE of the
  // corrals, so the pasture, the herd and the farm buildings read as one
  // place rather than three unrelated props dropped on a field.
  //
  // SCENERY, deliberately. Both are spawned as ordinary structure slots —
  // they get depth scaling, ground shadows and the damage-shrink factor for
  // free that way, and switching them on later is a one-line change — but
  // their `sbreak` is overridden to SCENERY_BREAK, which is above VMAX_CAP
  // (210). simulation.ts skips a structure whose local wind never exceeds
  // sbreak, so these two can never take damage, never uproot, and can never
  // certify their EF rating. Their real breakWind/ef/hp live in STRUCTURES
  // and are untouched, ready for the day they go live.
  //
  // WHEN THEY DO GO LIVE: they have no mid-air uproot shape yet, so a
  // destroyed one would tumble through the funnel drawn as the generic tree
  // icon. Give each a `dtype`-filtered uproot path (the way uprootedFences /
  // uprootedCows do) at the same time as removing the override.
  const SCENERY_BREAK = 9999;
  const bt = STRUCTURES.barn;
  const bti = STRUCTURE_ORDER.indexOf('barn');
  const st = STRUCTURES.silo;
  const sti = STRUCTURE_ORDER.indexOf('silo');

  // The pair's shared footprint, measured from the BARN's ground x: the barn
  // is 84 wide (half 42) and the silo stands SILO_DX to its right, 32 wide
  // (half 16). So the pair spans -46 .. +86 about the barn, i.e. a box of
  // half-width 66 centred 20 to the barn's right. farmCx/farmCy below track
  // that BOX centre (what every keep-out test uses); the barn's own ground
  // position is derived back off it at the end.
  const SILO_DX = 66; // silo centre, right of the barn's centre
  const SILO_DY = -10; // and slightly further back, so it renders behind the barn
  const farmOff = 20; // box centre, right of the barn's ground x
  const farmHalfW = 66;
  const farmHalfH = 40; // the pair are billboards; this is elbow room, not a real depth
  const farmGap = 40; // clearance between the corral's rail and the nearest farm edge

  // Try the four sides of the chosen corral in a rotated order (so which side
  // the farm lands on varies by seed), and take the first that fits on the
  // field. Every candidate clears the corral by construction — farmGap is the
  // gap between the rail and the farm's own edge — so the only things left to
  // test are the world bounds, the OTHER corral, and the tornado's start.
  const farmCorral = Math.floor(rng() * CORRALS) % CORRALS;
  const fcx = corralCx[farmCorral], fcy = corralCy[farmCorral];
  const sideOff = fenceHalf + farmGap;
  const sides: [number, number][] = [
    [fcx + sideOff + farmHalfW, fcy],
    [fcx - sideOff - farmHalfW, fcy],
    [fcx, fcy + sideOff + farmHalfH],
    [fcx, fcy - sideOff - farmHalfH],
  ];
  const first = Math.floor(rng() * sides.length) % sides.length;

  const farmFits = (x: number, y: number) => {
    if (x - farmHalfW < margin || x + farmHalfW > w.width - margin) return false;
    if (y < topMargin + 20 || y > w.height - botMargin) return false;
    // clear of BOTH corrals (the chosen one included — the offsets above
    // already satisfy this, but the other corral is a real risk)
    for (let k = 0; k < corralCx.length; k++) {
      const okx = Math.abs(x - corralCx[k]) > fenceHalf + farmHalfW + 20;
      const oky = Math.abs(y - corralCy[k]) > fenceHalf + farmHalfH + 20;
      if (!okx && !oky) return false;
    }
    // clear of the tornado's start, same box test the corrals use
    const okTx = Math.abs(x - w.width / 2) > farmHalfW + 90;
    const okTy = Math.abs(y - w.height / 2) > farmHalfH + 90;
    return okTx || okTy;
  };

  let farmCx = 0, farmCy = 0, farmPlaced = false;
  for (let k = 0; k < sides.length && !farmPlaced; k++) {
    const [cxi, cyi] = sides[(first + k) % sides.length];
    if (farmFits(cxi, cyi)) { farmCx = cxi; farmCy = cyi; farmPlaced = true; }
  }
  if (!farmPlaced) {
    // No side of the chosen corral works (a corral hard against a world edge,
    // say). Fall back to anywhere on the field that passes the same tests —
    // it stops being "the farm next to that pasture", but a farm somewhere
    // beats no farm, and it still can't overlap anything.
    let tries = 0;
    while (!farmPlaced && tries++ < 60) {
      const cxi = margin + farmHalfW + rng() * (w.width - 2 * (margin + farmHalfW));
      const cyi = topMargin + 20 + rng() * (w.height - botMargin - topMargin - 20);
      if (farmFits(cxi, cyi)) { farmCx = cxi; farmCy = cyi; farmPlaced = true; }
    }
    if (!farmPlaced) { farmCx = sides[first][0]; farmCy = sides[first][1]; }
  }

  const barnX = farmCx - farmOff;
  const barnY = farmCy;
  const farmProps: [typeof bt, number, number, number][] = [
    [st, sti, barnX + SILO_DX, barnY + SILO_DY], // silo first: it stands further
    [bt, bti, barnX, barnY],                     // back, and lower stype draws first
  ];
  for (let k = 0; k < farmProps.length; k++) {
    const [t, ti, px, py] = farmProps[k];
    sx[slot] = px;
    sy[slot] = py;
    shp[slot] = t.hp;
    shpMax[slot] = t.hp;
    sbreak[slot] = SCENERY_BREAK; // <- the ONE line that makes these scenery
    sef[slot] = t.ef;
    sw[slot] = t.w;
    sh[slot] = t.h;
    stype[slot] = ti;
    schunks[slot] = t.chunks;
    schunkMass[slot] = t.chunkMass;
    salive[slot] = 1;
    slot++;
  }

  // Clearance so a generic prop (tree, ...) doesn't spawn overlapping a
  // corral's footprint: fenceHalf (the corral's own half-side) plus a margin
  // for a tree's own visual radius/lean, checked as a square keep-out box
  // around EACH corral center (matches the corral's actual square shape,
  // rather than approximating it with a circle). Because the herd lives
  // inside that box, this keeps trees off the cows for free.
  const fenceClear = fenceHalf + 35;

  for (let i = 0; i < plan.length; i++) {
    const t = STRUCTURES[plan[i]];
    const ti = STRUCTURE_ORDER.indexOf(plan[i] as any);
    // 60 tries, not 40: the corral keep-out boxes grew with fenceHalf and
    // there are two of them now, so a random candidate is rejected more often
    // and the search needs more attempts before it falls back to accepting
    // whatever the last try landed on.
    let x = 0, y = 0, ok = false, tries = 0;
    while (!ok && tries++ < 60) {
      x = margin + rng() * (w.width - 2 * margin);
      y = topMargin + rng() * (w.height - topMargin - botMargin);
      const dx = x - w.width / 2;
      const dy = y - w.height / 2;
      const okTornado = dx * dx + dy * dy > keepClear * keepClear;
      let okFence = true;
      for (let k = 0; k < corralCx.length; k++) {
        if (Math.abs(x - corralCx[k]) <= fenceClear && Math.abs(y - corralCy[k]) <= fenceClear) {
          okFence = false;
          break;
        }
      }
      // ...and off the farmstead, same square keep-out idea as the corrals,
      // sized to the barn+silo box rather than a corral.
      const okFarm =
        Math.abs(x - farmCx) > farmHalfW + 30 || Math.abs(y - farmCy) > farmHalfH + 30;
      ok = okTornado && okFence && okFarm;
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

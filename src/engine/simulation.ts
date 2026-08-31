/**
 * The physics step. Runs entirely on the UI thread inside a Reanimated
 * frame callback (see TornadoGame.tsx), so every function here is a worklet.
 *
 * Model summary:
 *   - Damage: a structure takes damage only when the local wind exceeds its
 *     breakWind. Wind here is a flat-top core (full Vmax inside RMAX, 1/r outside)
 *     so the funnel shreds whatever it sits on.
 *   - Uproot lifecycle: at 0 hp a structure does NOT instantly shatter. It is
 *     handed to the vortex as ONE whole spinning entity that spirals in and rises
 *     for UPROOT_TIME seconds, THEN bursts into debris chunks.
 *   - Everything the tornado picks up lives in funnel-relative coords (angle,
 *     radius-factor, height 0..1) and coils UP the funnel, so it reads as part of
 *     the wind rather than orbiting on the ground. A chunk that reaches the top is
 *     consumed and feeds Vmax, which is what powers the ramp.
 */
import { TUNING } from './model';
import type { WorldState } from './state';

/**
 * Advance the world by dt seconds. Mutates the shared typed arrays in place.
 * Returns nothing; the render layer reads the same shared values.
 */
export function stepWorld(w: WorldState, dt: number): void {
  'worklet';
  if (w.running.value === 0) return;

  // clamp dt so a dropped frame doesn't explode the integrator
  if (dt > 0.05) dt = 0.05;

  const rmax = TUNING.RMAX;

  // --- steer the tornado toward the drag target ---
  const ease = 1 - Math.exp(-TUNING.STEER_EASE * dt);
  let tx = w.tornadoX.value + (w.targetX.value - w.tornadoX.value) * ease;
  let ty = w.tornadoY.value + (w.targetY.value - w.tornadoY.value) * ease;
  if (tx < 0) tx = 0; else if (tx > w.width) tx = w.width;
  if (ty < 0) ty = 0; else if (ty > w.height) ty = w.height;
  w.tornadoX.value = tx;
  w.tornadoY.value = ty;

  const vmax = w.vmax.value;
  const vscale = TUNING.TORNADO_SCALE * (1 + 0.5 * (vmax / TUNING.VMAX_CAP));

  // debris & uprooted structures (funnel-relative particles; see state.ts)
  const dalive = w.dalive.value, dkind = w.dkind.value, dtype = w.dtype.value, dphase = w.dphase.value;
  const drf = w.drf.value, dtargrf = w.dtargrf.value, dh = w.dh.value;
  const drise = w.drise.value, dspin = w.dspin.value, dspinv = w.dspinv.value;
  const dsize = w.dsize.value, dmass = w.dmass.value, dtimer = w.dtimer.value;
  const N = dalive.length;

  // --- structures: damage, then UPROOT (they lift out whole and spin) ---
  const sx = w.sx.value, sy = w.sy.value, shp = w.shp.value, shpMax = w.shpMax.value;
  const sbreak = w.sbreak.value, sef = w.sef.value, salive = w.salive.value;
  const schunks = w.schunks.value, schunkMass = w.schunkMass.value;
  const stype = w.stype.value;

  // How many WHOLE (kind=1) structures the funnel is already carrying, PER
  // TYPE. Per-type is the whole point: one shared budget let a couple of fence
  // sides freeze the herd behind them, since everything in a corral competes
  // for the same slots. Counted fresh each frame rather than tracked
  // incrementally, so it can't drift out of sync with the debris pool; the
  // loop below increments it as it lifts more. dtype is only meaningful on
  // kind=1 slots (chunks leave it stale), hence the dkind guard.
  // Sized off the cap table rather than a literal, so appending a structure
  // type to STRUCTURE_ORDER can't leave this array one slot short.
  const aloftByType = TUNING.LIFT_CAP_BY_TYPE.map(() => 0);
  for (let k = 0; k < N; k++) {
    if (dalive[k] === 1 && dkind[k] === 1) aloftByType[dtype[k]]++;
  }
  let efIdx = w.maxEF.value;
  if (efIdx < 0) efIdx = 0; else if (efIdx > 5) efIdx = 5;

  let strainTarget = 0; // 1 this frame if we're still wrestling a stubborn tree
  for (let i = 0; i < salive.length; i++) {
    if (salive[i] === 0) continue;
    const rx = sx[i] - tx;
    const ry = sy[i] - ty;
    const r = Math.sqrt(rx * rx + ry * ry);
    // Nothing outside the pull radius is touched at all, however strong the
    // tornado is. Checked first so far-off props cost one compare — with 124
    // structures in a 6x world most of the field is out of range on any
    // given frame.
    if (r >= TUNING.PULL_RADIUS) continue;

    // Damage intensity uses a flat-top core (full Vmax inside RMAX, 1/r falloff
    // outside) so sitting the funnel on a structure actually shreds it — the raw
    // Rankine field has a dead centre. See stack_and_build memory for the why.
    //
    // That 1/r tail then gets multiplied by a taper that reaches 0 at
    // PULL_RADIUS, so the cap is a smooth rim rather than a hard edge. Without
    // it a prop one pixel inside the radius would still be hit at full 1/r
    // strength and die instantly while its neighbour one pixel out was
    // untouched — a visible ring sweeping through the grove. See PULL_RADIUS
    // in model.ts for the numbers this changes.
    const taper = 1 - Math.pow(r / TUNING.PULL_RADIUS, TUNING.PULL_FALLOFF);
    const dwind = (r <= rmax ? vmax : (vmax * rmax) / r) * taper;
    if (dwind <= sbreak[i]) continue; // threshold gate: below it, nothing happens

    shp[i] -= (dwind - sbreak[i]) * TUNING.DAMAGE_K * dt;
    if (shp[i] > 0) {
      // still wrestling this one -> show the effort face, but only once the tree
      // is ~1/4 of the way uprooted (25% damage), and only while a pull is
      // genuinely slow/hard (early game, low Vmax). Once Vmax is high, trees pop
      // instantly and we skip the tugging face entirely.
      if (vmax < TUNING.STRAIN_VMAX_MAX && shp[i] <= 0.75 * shpMax[i]) {
        strainTarget = 1;
        // one-time little shake on the very FIRST tree we ever wrestle this run
        if (w.introUsed.value === 0) {
          w.introUsed.value = 1;
          w.introShake.value = TUNING.INTRO_SHAKE_SECS;
        }
      }
      continue;
    }

    // hp is gone. Two things can still stop the funnel taking it THIS frame:
    // its own TYPE's lift cap is full, or the debris pool is out of slots. In
    // either case hold the structure at the BRINK — hp pinned just above zero,
    // so it stays rooted and fully damage-shrunk — and let it pop the instant
    // capacity frees up. Damage keeps landing, so it re-enters this branch
    // every frame until it gets a turn.
    //
    // The cap is per-type, so a queue of trees never blocks a cow or a fence
    // side (`0` in LIFT_CAP_BY_TYPE = that type is uncapped).
    //
    // The pool case used to fall through and destroy the structure anyway
    // without a slot, which made it vanish with no debris and no Vmax gain —
    // silent, and invisible until you counted props. Same guard now covers it.
    const ti = stype[i];
    const capBase = TUNING.LIFT_CAP_BY_TYPE[ti];
    if (capBase > 0 && aloftByType[ti] >= capBase + TUNING.LIFT_CAP_EF_STEP * efIdx) {
      shp[i] = 0.0001;
      continue;
    }
    let slot = -1;
    for (let k = 0; k < N; k++) { if (dalive[k] === 0) { slot = k; break; } }
    if (slot < 0) { shp[i] = 0.0001; continue; }

    // taken -> UPROOT: certify EF now, and hand the whole structure to the
    // vortex as ONE spinning entity. It spirals in, rises a little, and only
    // later bursts into chunks (handled in the debris loop below).
    salive[i] = 0;
    aloftByType[ti]++;
    if (sef[i] > w.maxEF.value) w.maxEF.value = sef[i];
    // "big O!" — always on a hard struggle pull, and now and then even while
    // freely eating trees, for a little spontaneous delight
    if (vmax < TUNING.STRAIN_VMAX_MAX || Math.random() < TUNING.POP_FREE_CHANCE) {
      w.pop.value = 1;
      w.popVariant.value = Math.random() < TUNING.POP_OPEN_CHANCE ? 1 : 0;
    }

    let rf = r / (TUNING.FUNNEL_BASE_R * vscale);
    if (rf < 1) rf = 1; else if (rf > 5) rf = 5;
    dkind[slot] = 1; // whole structure
    dtype[slot] = stype[i]; // remember what it was, for the render layer
    dphase[slot] = Math.atan2(ry, rx); // its real bearing from the core
    drf[slot] = rf; // start at its real distance...
    dtargrf[slot] = 1.0; // ...and spiral onto the funnel surface
    dh[slot] = 0;
    drise[slot] = schunks[i]; // reused on a whole tree: chunk count for the burst
    dspin[slot] = 0;
    dspinv[slot] = TUNING.TREE_TUMBLE;
    dsize[slot] = TUNING.TREE_SIZE;
    dmass[slot] = schunkMass[i]; // reused on a whole tree: base chunk mass
    dtimer[slot] = TUNING.UPROOT_TIME;
    dalive[slot] = 1;
  }

  // --- debris & uprooted trees: coil UP the funnel ---
  let vmaxNew = vmax;
  let count = 0;

  for (let i = 0; i < N; i++) {
    if (dalive[i] === 0) continue;

    // orbit the axis (a touch slower higher up) and tumble in place
    const spinRate = (TUNING.DEBRIS_SPIN_BASE + vmax * TUNING.DEBRIS_SPIN_VK) * (1 - 0.35 * dh[i]);
    dphase[i] += spinRate * dt;
    dspin[i] += dspinv[i] * dt;

    if (dkind[i] === 1) {
      // whole tree: spiral inward onto the funnel + rise a little, then burst
      drf[i] += (dtargrf[i] - drf[i]) * Math.min(1, TUNING.UPROOT_INWARD * dt);
      dh[i] += (TUNING.TREE_RISE_H - dh[i]) * Math.min(1, TUNING.UPROOT_RISE * dt);
      dtimer[i] -= dt;
      if (dtimer[i] <= 0) {
        dalive[i] = 0;
        const nCh = drise[i] < 1 ? 5 : Math.round(drise[i]);
        const cmass = dmass[i] > 0 ? dmass[i] : 0.45;
        for (let c = 0; c < nCh; c++) {
          let slot = -1;
          for (let k = 0; k < N; k++) { if (dalive[k] === 0) { slot = k; break; } }
          if (slot < 0) break;
          const hsh = i * 13 + c * 7;
          const j1 = (hsh % 100) / 100;
          const j2 = ((hsh * 3) % 100) / 100;
          dkind[slot] = 0;
          dphase[slot] = dphase[i] + (c / nCh) * 6.28318;
          drf[slot] = 0.75 + j1 * 0.6;
          dtargrf[slot] = 0.6 + j2 * 0.7; // 0.6..1.3 x funnel radius
          dh[slot] = dh[i] + j1 * 0.05;
          drise[slot] = TUNING.CHUNK_RISE_MIN + j2 * (TUNING.CHUNK_RISE_MAX - TUNING.CHUNK_RISE_MIN);
          dspin[slot] = j1 * 6.28318;
          dspinv[slot] = TUNING.CHUNK_TUMBLE * (0.6 + j2);
          dsize[slot] = 3 + j2 * 3;
          dmass[slot] = cmass * (0.75 + j1 * 0.5);
          dtimer[slot] = 0;
          dalive[slot] = 1;
        }
        continue;
      }
    } else {
      // chunk: climb the funnel, easing onto its funnel-hugging radius
      dh[i] += drise[i] * dt;
      drf[i] += (dtargrf[i] - drf[i]) * Math.min(1, TUNING.CHUNK_SETTLE * dt);
      if (dh[i] >= 1) {
        // reached the top -> consumed by the storm -> grows Vmax (the ramp)
        dalive[i] = 0;
        vmaxNew += TUNING.EAT_GAIN * dmass[i];
        continue;
      }
    }
    count++;
  }

  if (vmaxNew > TUNING.VMAX_CAP) vmaxNew = TUNING.VMAX_CAP;
  w.vmax.value = vmaxNew;
  w.debrisCount.value = count;

  // effort face: build strain while tugging, release fast; fade the pop pulse
  const strainEase = strainTarget > w.strain.value ? TUNING.STRAIN_RISE : TUNING.STRAIN_FALL;
  w.strain.value += (strainTarget - w.strain.value) * Math.min(1, strainEase * dt);
  w.pop.value -= dt * TUNING.POP_FALL;
  if (w.pop.value < 0) w.pop.value = 0;
  if (w.introShake.value > 0) {
    w.introShake.value -= dt;
    if (w.introShake.value < 0) w.introShake.value = 0;
  }

  // No run clock: the sim runs indefinitely (timer removed).
}

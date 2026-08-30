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
  const vscale = 1 + 0.5 * (vmax / TUNING.VMAX_CAP);

  // debris & uprooted structures (funnel-relative particles; see state.ts)
  const dalive = w.dalive.value, dkind = w.dkind.value, dphase = w.dphase.value;
  const drf = w.drf.value, dtargrf = w.dtargrf.value, dh = w.dh.value;
  const drise = w.drise.value, dspin = w.dspin.value, dspinv = w.dspinv.value;
  const dsize = w.dsize.value, dmass = w.dmass.value, dtimer = w.dtimer.value;
  const N = dalive.length;

  // --- structures: damage, then UPROOT (they lift out whole and spin) ---
  const sx = w.sx.value, sy = w.sy.value, shp = w.shp.value;
  const sbreak = w.sbreak.value, sef = w.sef.value, salive = w.salive.value;
  const schunks = w.schunks.value, schunkMass = w.schunkMass.value;

  for (let i = 0; i < salive.length; i++) {
    if (salive[i] === 0) continue;
    const rx = sx[i] - tx;
    const ry = sy[i] - ty;
    const r = Math.sqrt(rx * rx + ry * ry);
    // Damage intensity uses a flat-top core (full Vmax inside RMAX, 1/r falloff
    // outside) so sitting the funnel on a structure actually shreds it — the raw
    // Rankine field has a dead centre. See stack_and_build memory for the why.
    const dwind = r <= rmax ? vmax : (vmax * rmax) / r;
    if (dwind <= sbreak[i]) continue; // threshold gate: below it, nothing happens

    shp[i] -= (dwind - sbreak[i]) * TUNING.DAMAGE_K * dt;
    if (shp[i] > 0) continue;

    // destroyed -> UPROOT: certify EF now, and hand the whole structure to the
    // vortex as ONE spinning entity. It spirals in, rises a little, and only
    // later bursts into chunks (handled in the debris loop below).
    salive[i] = 0;
    if (sef[i] > w.maxEF.value) w.maxEF.value = sef[i];

    let slot = -1;
    for (let k = 0; k < N; k++) { if (dalive[k] === 0) { slot = k; break; } }
    if (slot >= 0) {
      let rf = r / (TUNING.FUNNEL_BASE_R * vscale);
      if (rf < 1) rf = 1; else if (rf > 5) rf = 5;
      dkind[slot] = 1; // whole tree
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

  // No run clock: the sim runs indefinitely (timer removed).
}

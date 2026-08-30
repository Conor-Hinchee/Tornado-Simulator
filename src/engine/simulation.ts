/**
 * The physics step. Runs entirely on the UI thread inside a Reanimated
 * frame callback (see TornadoGame.tsx), so every function here is a worklet.
 *
 * Model summary (ported from the browser prototype):
 *   - Rankine combined vortex: tangential wind rises linearly to Vmax at the core
 *     edge (RMAX), then decays as 1/r outside it.
 *   - Radial flow = a baseline inward pull plus an outward gust that peaks just
 *     outside the core (the updraft). Net effect: debris spirals inward far out,
 *     gets flung outward near the core edge, and recirculates — which is what
 *     reads as "spiraling up and out" rather than collapsing to the center.
 *   - Debris coupling is mass-dependent, so light chunks snap into the flow and
 *     heavy chunks lumber.
 *   - Structures take damage only when local wind exceeds their breakWind. On
 *     destruction they shatter into debris and certify their EF. Eating debris
 *     at the core raises Vmax, which is the only way to reach the next threshold.
 */
import { TUNING } from './model';
import type { WorldState } from './state';

/** Rankine combined vortex tangential wind (mph) at radius r (px). */
export function tangentialWind(r: number, rmax: number, vmax: number): number {
  'worklet';
  if (r < 1) return 0;
  return r <= rmax ? vmax * (r / rmax) : vmax * (rmax / r);
}

/** Updraft strength [0..1], a gaussian peaking just outside the core. */
export function updraft(r: number, rmax: number): number {
  'worklet';
  const peak = TUNING.UPDRAFT_PEAK * rmax;
  const s = TUNING.UPDRAFT_WIDTH * rmax;
  const d = r - peak;
  return Math.exp(-(d * d) / (2 * s * s));
}

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
  const eatR = TUNING.EAT_RADIUS_FRAC * rmax;
  const eatR2 = eatR * eatR;

  // --- steer the tornado toward the drag target ---
  const ease = 1 - Math.exp(-TUNING.STEER_EASE * dt);
  let tx = w.tornadoX.value + (w.targetX.value - w.tornadoX.value) * ease;
  let ty = w.tornadoY.value + (w.targetY.value - w.tornadoY.value) * ease;
  if (tx < 0) tx = 0; else if (tx > w.width) tx = w.width;
  if (ty < 0) ty = 0; else if (ty > w.height) ty = w.height;
  w.tornadoX.value = tx;
  w.tornadoY.value = ty;

  const vmax = w.vmax.value;

  // --- structures: damage + destruction ---
  const sx = w.sx.value, sy = w.sy.value, shp = w.shp.value;
  const sbreak = w.sbreak.value, sef = w.sef.value, salive = w.salive.value;
  const stype = w.stype.value, schunks = w.schunks.value, schunkMass = w.schunkMass.value;

  const dx = w.dx.value, dy = w.dy.value, dvx = w.dvx.value, dvy = w.dvy.value;
  const dmass = w.dmass.value, dsize = w.dsize.value, dz = w.dz.value, dalive = w.dalive.value;
  const N = dalive.length;

  for (let i = 0; i < salive.length; i++) {
    if (salive[i] === 0) continue;
    const rx = sx[i] - tx;
    const ry = sy[i] - ty;
    const r = Math.sqrt(rx * rx + ry * ry);
    const wind = tangentialWind(r, rmax, vmax);
    if (wind <= sbreak[i]) continue; // threshold gate: below it, nothing happens

    shp[i] -= (wind - sbreak[i]) * TUNING.DAMAGE_K * dt;
    if (shp[i] > 0) continue;

    // destroyed -> certify EF and shatter into debris
    salive[i] = 0;
    if (sef[i] > w.maxEF.value) w.maxEF.value = sef[i];

    const chunks = schunks[i];
    const cmass = schunkMass[i];
    for (let c = 0; c < chunks; c++) {
      // find a free debris slot
      let slot = -1;
      for (let k = 0; k < N; k++) {
        if (dalive[k] === 0) { slot = k; break; }
      }
      if (slot < 0) break; // pool full
      // pseudo-random scatter around the structure using cheap trig hashing
      const a = (i * 7.13 + c * 2.399) % 6.283;
      const spread = 6 + ((c * 13 + i * 5) % 18);
      dx[slot] = sx[i] + Math.cos(a) * spread;
      dy[slot] = sy[i] + Math.sin(a) * spread;
      dvx[slot] = Math.cos(a) * 30;
      dvy[slot] = Math.sin(a) * 30;
      const m = cmass * (0.75 + ((c * 17 + i * 11) % 50) / 100);
      dmass[slot] = m;
      dsize[slot] = 2 + m * 3.2;
      dz[slot] = 0;
      dalive[slot] = 1;
      w.debrisCount.value += 1;
    }
  }

  // --- debris: advect in the vortex, eat at the core ---
  const PX = TUNING.PX_PER_MPH;
  const damp = TUNING.DAMP;
  let vmaxNew = vmax;
  let count = 0;

  for (let i = 0; i < N; i++) {
    if (dalive[i] === 0) continue;

    const rx = dx[i] - tx;
    const ry = dy[i] - ty;
    const r2 = rx * rx + ry * ry;

    // eat at the core -> grow strength
    if (r2 < eatR2) {
      dalive[i] = 0;
      vmaxNew += TUNING.EAT_GAIN * dmass[i];
      continue;
    }
    count++;

    const r = Math.sqrt(r2);
    const inv = 1 / r;
    const nrx = rx * inv; // radial unit (outward)
    const nry = ry * inv;
    const trx = -nry; // tangential unit (counter-clockwise)
    const try_ = nrx;

    // updraft governs both the outward gust and how high the chunk lofts
    const up = updraft(r, rmax);

    // ease debris height toward the local updraft strength (render z-axis)
    const targetZ = up * TUNING.LOFT_MAX;
    dz[i] += (targetZ - dz[i]) * Math.min(TUNING.LOFT_EASE * dt, 1);

    // wind velocity field at this point (px/s)
    const tanSpeed = tangentialWind(r, rmax, vmax) * PX;
    const radial = up * TUNING.OUTFLOW - TUNING.INFLOW;
    const wvx = trx * tanSpeed + nrx * radial;
    const wvy = try_ * tanSpeed + nry * radial;

    // mass-dependent coupling: light debris snaps to the flow
    const k = (TUNING.COUPLING / dmass[i]) * dt;
    let vx = dvx[i] + (wvx - dvx[i]) * Math.min(k, 1);
    let vy = dvy[i] + (wvy - dvy[i]) * Math.min(k, 1);
    vx *= damp;
    vy *= damp;

    dvx[i] = vx;
    dvy[i] = vy;
    dx[i] += vx * dt;
    dy[i] += vy * dt;
  }

  if (vmaxNew > TUNING.VMAX_CAP) vmaxNew = TUNING.VMAX_CAP;
  w.vmax.value = vmaxNew;
  w.debrisCount.value = count;

  // --- run clock ---
  const t = w.timeLeft.value - dt;
  if (t <= 0) {
    w.timeLeft.value = 0;
    w.running.value = 0; // rope out
  } else {
    w.timeLeft.value = t;
  }
}

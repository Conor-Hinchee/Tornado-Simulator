/**
 * Static game model: structure types, EF labels, and tunable constants.
 *
 * This file is plain data + pure helpers. Nothing here runs on the UI thread,
 * so it stays free of Reanimated / Skia imports and is trivially unit-testable.
 *
 * The core design idea ported from the browser prototype:
 *   - A structure has a `breakWind` (mph). Below it, the tornado does LITERALLY
 *     nothing to that structure. There is no HP bar shown to the player and no
 *     unlock screen — the wind threshold IS the progression gate.
 *   - When destroyed, a structure certifies an EF rating. Your run's rating is
 *     the worst thing you've flattened (max EF over destroyed structures), which
 *     mirrors real meteorology: EF is assigned from surveyed damage, not measured
 *     wind.
 *   - Destroyed structures shatter into debris. Debris drifts in the vortex; when
 *     it reaches the core it is "eaten", raising the tornado's peak wind (Vmax),
 *     which is what eventually pushes you past the next structure's threshold.
 */

export interface StructureType {
  key: string;
  label: string;
  /** Wind (mph) at the structure below which the tornado does nothing. */
  breakWind: number;
  /** EF rating certified when this structure is destroyed. */
  ef: number;
  /** Structural integrity; damage accrues only once wind exceeds breakWind. */
  hp: number;
  /** Footprint in px (top-down). */
  w: number;
  h: number;
  /** Number of debris chunks spawned on destruction. */
  chunks: number;
  /** Debris mass for this structure's chunks (heavier = lumbers in the flow). */
  chunkMass: number;
  color: string;
}

export const STRUCTURES: Record<string, StructureType> = {
  tree: {
    key: 'tree', label: 'Tree', breakWind: 65, ef: 0, hp: 45,
    w: 26, h: 46, chunks: 5, chunkMass: 0.45, color: '#5cc25f',
  },
  trailer: {
    key: 'trailer', label: 'Mobile home', breakWind: 86, ef: 1, hp: 95,
    w: 66, h: 38, chunks: 8, chunkMass: 0.8, color: '#f3cf72',
  },
  house: {
    key: 'house', label: 'House', breakWind: 112, ef: 2, hp: 170,
    w: 82, h: 66, chunks: 12, chunkMass: 1.3, color: '#ff8f5e',
  },
  silo: {
    key: 'silo', label: 'Grain silo', breakWind: 136, ef: 3, hp: 250,
    w: 52, h: 92, chunks: 11, chunkMass: 1.1, color: '#8fb7d8',
  },
};

export const STRUCTURE_ORDER = ['tree', 'trailer', 'house', 'silo'] as const;
export type StructureKey = (typeof STRUCTURE_ORDER)[number];

export const EF_LABELS = ['EF0', 'EF1', 'EF2', 'EF3', 'EF4', 'EF5'];

/** Tunables. Kept in one object so feel-tuning is a single place to touch. */
export const TUNING = {
  // Run length (seconds) before the tornado ropes out.
  RUN_SECONDS: 150,

  // --- Rankine combined vortex ---
  RMAX: 58, // core radius (px): solid-body rotation inside, decay outside
  VMAX_START: 70, // starting peak wind (mph): trees (65) yes, trailers (86) no
  VMAX_CAP: 210, // ceiling on peak wind
  EAT_GAIN: 26, // Vmax gained per unit mass eaten

  // --- flow field ---
  PX_PER_MPH: 2.2, // maps mph -> px/s of tangential debris velocity
  INFLOW: 42, // baseline inward pull (px/s) — lets debris reach the core to be eaten
  OUTFLOW: 165, // outward push at the updraft peak (px/s) — makes debris spiral OUT
  UPDRAFT_PEAK: 1.15, // updraft peaks at 1.15 * RMAX (just outside the core)
  UPDRAFT_WIDTH: 0.5, // gaussian width as a fraction of RMAX

  // --- debris ---
  COUPLING: 6.0, // how hard wind drags debris; divided by mass (light snaps in)
  DAMP: 0.994, // per-step velocity damping
  EAT_RADIUS_FRAC: 0.4, // eat debris inside this fraction of RMAX

  // --- damage ---
  DAMAGE_K: 0.9, // hp lost per (mph over threshold) per second

  // --- steering ---
  STEER_EASE: 2.5, // how quickly the tornado chases the drag target (lower = slower/weightier)

  // --- 2.5D projection ---
  // Ground plane recedes toward the top of the screen. TILT_K controls how much
  // the field narrows with depth (0 = flat top-down, ~0.6 = strong tilt). The
  // projection is invertible so the drag-to-steer gesture stays exact.
  TILT_K: 0.5,

  // --- volumetric funnel ---
  FUNNEL_HEIGHT: 200, // screen px the funnel rises from its base
  FUNNEL_BASE_R: 26, // funnel radius at the ground (narrow)
  FUNNEL_TOP_R: 108, // funnel radius at the top (wide)
  FUNNEL_RINGS: 17, // stacked ellipse rings up the funnel
  FUNNEL_DOTS: 15, // swirling dots per ring
  RING_FLATTEN: 0.34, // ellipse y/x ratio — sells the tilt of each ring
  FUNNEL_TWIST: 2.2, // how much the arms coil from base to top

  // --- debris loft (the z axis, render + light integration only) ---
  LOFT_MAX: 70, // max height (px) debris rises in the updraft
  LOFT_EASE: 2.6, // how fast debris eases toward its target height

  // --- capacity ---
  MAX_DEBRIS: 360,
};

/** Convert a peak wind (mph) to an EF rating index using EF-scale wind bands. */
export function efFromWind(mph: number): number {
  if (mph >= 200) return 5;
  if (mph >= 166) return 4;
  if (mph >= 136) return 3;
  if (mph >= 111) return 2;
  if (mph >= 86) return 1;
  if (mph >= 65) return 0;
  return -1;
}

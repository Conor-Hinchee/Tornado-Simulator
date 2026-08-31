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
    key: 'tree', label: 'Tree', breakWind: 65, ef: 0, hp: 15,
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
    // Grain silo. Currently spawned as SCENERY next to a pasture (see the
    // FARMSTEAD block in state.ts's resetWorld): the spawn overrides sbreak
    // with a threshold above VMAX_CAP so the funnel can never touch it, but
    // the real numbers below are left intact and correct — flipping the silo
    // on later is deleting that one override line (plus giving it its own
    // mid-air uproot shape, see [[structures_and_fence]]'s checklist).
    // w/h is a nominal footprint; the drawn silo is 32 wide x 66 tall to the
    // eave (81 with its dome) in world units, see useStructurePath.
    key: 'silo', label: 'Grain silo', breakWind: 136, ef: 3, hp: 250,
    w: 32, h: 66, chunks: 11, chunkMass: 1.1, color: '#e6e0d2',
  },
  fence: {
    // ONE STRAIGHT SEGMENT of a pasture fence, not a whole square — 4 of
    // these are spawned together (see the dedicated pasture-fence block in
    // state.ts's resetWorld, not the generic per-plan-item loop) to outline
    // a square corral, each with its OWN hp so a side can be knocked down
    // independently of its neighbors. w/h here is just the DEFAULT/reference
    // orientation (w = length, h = thickness marker; a spawned instance sets
    // its own sw/sh — w>=h means horizontal, h>w means vertical — see
    // useStructurePath's fence branch, TornadoGame.tsx). Peaked dark posts
    // (fencePosts) show through gaps in two thick rail bands (this color).
    // Weaker than a tree (real fences fail before trees do), so it tends to
    // go first, and stays inside the EF0 phase.
    key: 'fence', label: 'Fence', breakWind: 50, ef: 0, hp: 8,
    w: 110, h: 20, chunks: 4, chunkMass: 0.25, color: '#c9793f',
  },
  cow: {
    // The pasture cow — was purely decorative (fixed cowX/cowY scalars in
    // state.ts, no STRUCTURES entry) until "lets eat the cow!!": now a real,
    // single-instance structure spawned at the fence's own center (see
    // state.ts's resetWorld, right after the fence's 4 segments), so it
    // goes through the exact same generic damage/uproot/debris pipeline as
    // every other prop — no simulation.ts changes needed. Deliberately the
    // WEAKEST thing in the field (lighter than even the fence) so it gets
    // gobbled up fast once the funnel reaches the pasture — a quick, fun
    // snack, not a real obstacle. w/h is a nominal footprint only (unlike
    // fence, this instance never repurposes sw/sh for orientation).
    key: 'cow', label: 'Cow', breakWind: 35, ef: 0, hp: 5,
    w: 40, h: 30, chunks: 3, chunkMass: 0.2, color: '#fdfbf7',
  },
  barn: {
    // The farmstead barn — a gambrel-roofed red barn that stands beside the
    // grain silo just outside one of the pastures. Like the silo it is
    // SCENERY for now: the FARMSTEAD block in state.ts overrides sbreak with
    // a threshold above VMAX_CAP, so it never takes damage, never uproots and
    // never certifies a rating, no matter how strong the run gets. The
    // numbers below are the ones it should have when it goes live (EF2, a
    // notch under a house: a barn is a big timber shell, not a slab-built
    // home), so switching it on is deleting the override.
    // w/h is a nominal footprint; the drawn barn is 84 wide x 75 tall to the
    // roof peak (90 with its cupola) in world units, see useStructurePath.
    key: 'barn', label: 'Barn', breakWind: 120, ef: 2, hp: 200,
    w: 84, h: 75, chunks: 10, chunkMass: 1.1, color: '#c8503f',
  },
};

export const STRUCTURE_ORDER = ['tree', 'trailer', 'house', 'silo', 'fence', 'cow', 'barn'] as const;
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
  EAT_GAIN: 14, // Vmax gained per unit mass eaten (tuned so it takes several trees' worth of eaten debris to ramp Vmax 70 -> past the 86 mph EF1 gate, not one chunk)

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
  DAMAGE_K: 1.4, // hp lost per (mph over threshold) per second

  // --- pull radius cap ---
  // Hard outer limit (world px) on how far the damage field reaches, no
  // matter how strong the tornado gets.
  //
  // Why this exists: the Rankine field falls off as 1/r, so the radius at
  // which a prop still takes damage grows LINEARLY with Vmax — reach =
  // Vmax * RMAX / breakWind. At the EF0 peak (VMAX_CAP 210) that put the
  // cow-eating radius at 348px, wider than an entire 280px corral, so the
  // funnel could sit ~200px OUTSIDE a pasture and still vacuum up the herd
  // and the fence without ever entering it. It also badly overran the drawn
  // funnel, so the physics reached much further than anything on screen
  // suggested it should.
  //
  // PULL_RADIUS is that ceiling; PULL_FALLOFF is how sharply the field
  // tapers into it. The taper is `1 - (r / PULL_RADIUS) ^ PULL_FALLOFF`,
  // clamped at 0 — a high exponent keeps the near field essentially
  // untouched (at r = RMAX the multiplier is 0.999) and does all its work
  // out at the rim, so the early game feels the same and only the
  // late-game overreach is cut. At 210 mph this takes the cow radius
  // 348 -> 162, fence 244 -> 153, tree 187 -> 142; at the 70 mph start the
  // cow radius only moves 116 -> 110 and the tree radius not at all.
  //
  // Lower PULL_RADIUS to force the funnel further into a pasture before it
  // can clear one. Note this caps REACH, not damage rate: anything inside
  // the radius at full Vmax still dies almost instantly (a 5hp cow in
  // ~0.05s), so if clearing a corral still feels too easy the next knobs
  // are DAMAGE_K and the per-structure hp, not this.
  PULL_RADIUS: 180,
  PULL_FALLOFF: 6,

  // --- lift capacity ---
  // How many WHOLE structures of EACH TYPE the funnel can carry at once.
  // Indexed by STRUCTURE_ORDER (tree, trailer, house, silo, fence, cow, barn);
  // 0 means that type is NOT capped.
  //
  // Why per-type and not one shared pool: a shared pool was the first cut,
  // and it made the pasture feel broken. Driving into a corral, one fence
  // side and one cow would lift and everything else sat frozen at the brink
  // waiting its turn — the herd read as stuck rather than as a queue, because
  // a corral holds 12 destructible things and they were all competing for the
  // same 4 slots. Trees are the case the cap was actually for (a dense grove
  // vanishing in one frame), so the cap now lives on trees and the pasture
  // lifts freely.
  //
  // A capped type whose hp runs out while its own cap is full is held at the
  // BRINK (hp pinned just above zero, so it stays rooted and fully
  // damage-shrunk) and pops the instant one of ITS OWN kind frees a slot,
  // which happens every UPROOT_TIME (0.8s) as each whole entity bursts into
  // chunks. So a cap is really a throughput limit: cap / UPROOT_TIME of that
  // type per second, in visible batches — ~5 trees/s at EF0.
  //
  // Uncapped types are still bounded by MAX_DEBRIS; that path now holds at
  // the brink too rather than silently destroying the structure.
  LIFT_CAP_BY_TYPE: [4, 3, 2, 2, 0, 0, 2],

  // Extra simultaneous lifts granted per EF level, added to a capped type's
  // base above. NOTE: every structure in the field today is `ef: 0` (tree,
  // fence, cow), so maxEF never climbs past 0 and this currently contributes
  // NOTHING — the caps resolve to their base values. It only starts mattering
  // when EF1+ props (mobile homes) come back into `plan`, see state.ts.
  LIFT_CAP_EF_STEP: 2,

  // --- tree sway ---
  // A tree leans toward the funnel by ROTATING about its base through this
  // many radians at full wind (~17deg), clamped to TREE_BEND_MAX (~34deg)
  // once the near-death "grab" multiplies it.
  //
  // It rotates rather than translating, which was the fix for trees looking
  // "too stretchy": the old code displaced the trunk top and canopy sideways
  // while leaving the trunk's vertical length fixed, so the trunk quad's
  // diagonal grew with the lean and the canopy drifted away from the trunk
  // top — up to 80px of sideways offset on a 16px trunk. Rotating about the
  // base preserves every length, so the tree bends as one rigid piece.
  TREE_BEND: 0.30,
  TREE_BEND_MAX: 0.60,

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
  FUNNEL_RINGS: 17, // RETIRED (the funnel is one continuous silhouette now, not stacked rings)
  FUNNEL_DOTS: 15, // swirling dots per ring
  RING_FLATTEN: 0.34, // ellipse y/x ratio — sells the tilt of each ring
  FUNNEL_TWIST: 2.2, // how much the arms coil from base to top

  // --- turbulence / dirt-devil texture (wind-swept look) ---
  FUNNEL_JITTER: 0.16, // radians of chaotic wobble added to each strand sample
  FUNNEL_JITTER_FREQ: 0.15, // how fast the turbulence noise churns per frame (tick)
  DUST_COUNT: 46, // ground-hugging swirling grit particles around the funnel base
  DUST_SPREAD: 1.9, // how far the dust skirt spreads beyond the funnel base radius
  WIND_STREAK_COUNT: 24, // short tangent speed-lines swept around the funnel surface
  RING_TWIST_COIL: 0.18, // how far the cone's center spirals off-axis at each height (x its own radius)
  FUNNEL_SPIN: 1.4, // how fast the whole cone's coil rotates (shared by EVERY funnel layer)
  // Silhouette profile. The radius follows a POWER curve (thin tail, fast flare)
  // and then rolls back in above DOME_START so the top rounds over into a billowy
  // cap instead of ending in a flat "bucket rim".
  FUNNEL_TAIL_R: 16, // drawn radius at the ground: the thin twisty tail (widened 2026-08-31, was too tapered)
  FUNNEL_TAPER: 1.5, // >1 keeps the lower funnel thin and flares it near the top (lowered 2026-08-31 to widen the base)
  FUNNEL_DOME: 0, // how far the radius pulls back in at the very top (2026-08-31: user wants the top taper gone, top stays full width)
  FUNNEL_DOME_START: 0.72, // height where the dome roll-off begins
  FUNNEL_BANDS: 6, // helical shading ribbons wrapping the cone
  FUNNEL_BAND_SWEEP: 250, // degrees each dark shading ribbon wraps around the cone
  FUNNEL_BAND_LIGHT_SWEEP: 150, // degrees each light highlight ribbon wraps
  FUNNEL_BAND_RISE: 0.1, // how much height a ribbon climbs while it wraps (the helix)
  FUNNEL_BAND_THICK: 0.075, // ribbon thickness in height units
  // Swoosh ribbons orbit WIDER than the body, so they're visible in the air on
  // both sides and only hidden across the stretch that passes behind the funnel.
  SWOOSH_R: 1.32, // swoosh orbit radius as a multiple of the body radius
  SWOOSH_SWEEP: 215, // base degrees a swoosh wraps (plus a per-ribbon jitter)
  // Viewing angle, driven by the DIRECTION OF TRAVEL (not screen position):
  // driving toward the camera tips the funnel so you see down into its open top;
  // driving away tips it over so the top rotates out of sight. Standing still is
  // the neutral mid view. Drives every ring's y/x ratio.
  VIEW_FLAT_MIN: 0.18, // ring flatten multiplier when driving away (edge-on, top hidden)
  VIEW_FLAT_RANGE: 1.42, // extra flatten gained as it turns toward the camera
  VIEW_NEUTRAL: 0.55, // the view value while standing still
  LEAN_REF_SPEED: 260, // px/s of travel that counts as a "full" lean
  LEAN_EASE: 4.0, // how fast the lean follows a change of direction
  LEAN_X_PX: 26, // how far the funnel's top leans into left/right travel

  // --- debris loft (the z axis, render + light integration only) ---
  LOFT_MAX: 70, // max height (px) debris rises in the updraft
  LOFT_EASE: 2.6, // how fast debris eases toward its target height

  // --- debris + uproot lifecycle (funnel-coiling model) ---
  // Everything the tornado picks up is expressed in funnel-relative coords and
  // coils UP the funnel, so it reads as part of the wind rather than orbiting on
  // the ground. A destroyed tree first lifts out WHOLE and spins for UPROOT_TIME
  // seconds, then bursts into chunks that keep climbing until they reach the top
  // (where they're consumed and feed Vmax).
  DEBRIS_SPIN_BASE: 3.3, // rad/s base angular speed around the funnel axis
  DEBRIS_SPIN_VK: 0.07, // extra rad/s per mph of Vmax (a stronger storm whips faster)
  DEBRIS_COIL_SPEED: 2.5, // couples debris coil to the funnel strands' own rotation
  UPROOT_TIME: 0.8, // seconds a tree spins around whole before it shatters
  UPROOT_INWARD: 3.8, // how fast an uprooted tree spirals in onto the funnel
  UPROOT_RISE: 2.9, // how fast an uprooted tree climbs while still whole
  TREE_RISE_H: 0.42, // height (0..1) an uprooted tree reaches before bursting
  TREE_TUMBLE: 7.0, // self-rotation speed (rad/s) of a tumbling whole tree
  TREE_SIZE: 22, // render size (px) of a whole uprooted tree
  CHUNK_RISE_MIN: 0.26, // chunk ascent rate (h per second) range after a burst
  CHUNK_RISE_MAX: 0.6,
  CHUNK_SETTLE: 4.0, // how fast a chunk eases onto its funnel-hugging radius
  CHUNK_TUMBLE: 10.0, // chunk self-rotation speed (rad/s)

  // --- effort face (only while pulling is genuinely hard, i.e. early game) ---
  STRAIN_VMAX_MAX: 105, // above this Vmax trees pop easily -> no tugging face
  STRAIN_RISE: 5.0, // how fast the strain face builds while holding a tree
  STRAIN_FALL: 9.0, // how fast it relaxes once the tree lets go
  POP_FALL: 2.6, // how fast the "big O" celebration fades after an uproot
  POP_FREE_CHANCE: 0.22, // odds of a spontaneous "big O" per free (easy) uproot
  INTRO_SHAKE_SECS: 2, // one-time little face shake on the very first tree pull
  POP_OPEN_CHANCE: 0.45, // odds the happy celebration is the open-mouth variant (else a grin)

  // --- overall tornado visual scale ---
  // Multiplies the whole funnel/face/arcs/shadow size at every wind level (start
  // AND max). Purely visual — physics (RMAX, damage reach, steering) is unchanged.
  TORNADO_SCALE: 0.75,

  // --- capacity ---
  MAX_DEBRIS: 480, // raised with the 6x world / 100-tree grove. This is a pure capacity ceiling, not a feel knob — but it fails SILENTLY: simulation.ts's chunk burst does `if (slot < 0) break`, so an exhausted pool makes a destroyed prop vanish with no debris and no Vmax gain. Trees burst into 5 chunks each.
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

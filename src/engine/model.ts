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
    // Grain silo, standing beside the barn at the farmstead (see the FARMSTEAD
    // block in state.ts's resetWorld). The toughest thing on the field: it
    // takes 136 mph to touch it, and flattening it certifies EF3. Uprooted it
    // tumbles through the funnel as a cream cylinder with its slate dome (see
    // uprootedSilos in TornadoGame.tsx), then bursts into cream chunks.
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
    // The farmstead barn: a gambrel-roofed red barn beside the grain silo,
    // just outside one of the pastures. EF2, a notch under a house (a barn is
    // a big timber shell, not a slab-built home). Uprooted it tumbles through
    // the funnel as a little red barn with its slate roof (uprootedBarns in
    // TornadoGame.tsx), then bursts into red planks.
    // w/h is a nominal footprint; the drawn barn is 84 wide x 75 tall to the
    // roof peak (90 with its cupola) in world units, see useStructurePath.
    key: 'barn', label: 'Barn', breakWind: 120, ef: 2, hp: 200,
    w: 84, h: 75, chunks: 10, chunkMass: 1.1, color: '#c8503f',
  },
  truck: {
    // A blue farm pickup parked beside the barn. The only EF1 structure on
    // the field (trailers are still parked), so it bridges the gap between
    // the EF0 grove/pastures and the EF2 barn: 100 mph rolls it, flattening
    // it certifies EF1. Uprooted it tumbles as a whole truck (uprootedTrucks
    // in TornadoGame.tsx), then bursts into blue panels.
    // Art is 62 wide x 34 tall in world units, facing right, see drawTruck.
    key: 'truck', label: 'Pickup truck', breakWind: 100, ef: 1, hp: 110,
    w: 62, h: 34, chunks: 7, chunkMass: 0.9, color: '#3f7fbf',
  },
};

export const STRUCTURE_ORDER = ['tree', 'trailer', 'house', 'silo', 'fence', 'cow', 'barn', 'truck'] as const;
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
  // Indexed by STRUCTURE_ORDER (tree, trailer, house, silo, fence, cow, barn, truck);
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
  LIFT_CAP_BY_TYPE: [4, 3, 2, 2, 0, 0, 2, 0],

  // Extra simultaneous lifts granted per EF level, added to a capped type's
  // base above. Now live: flattening the barn (EF2) or silo (EF3) raises
  // maxEF, so the tree cap grows from 4 to 8 or 10 and the late game clears
  // the grove faster.
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
  UPROOT_TIME: 0.8, // LEGACY: simulation now reads UPROOT_TIME_BY_TYPE. Seconds a tree spins around whole before it shatters
  UPROOT_INWARD: 3.8, // how fast an uprooted tree spirals in onto the funnel
  UPROOT_RISE: 2.9, // how fast an uprooted tree climbs while still whole
  TREE_RISE_H: 0.42, // height (0..1) an uprooted tree reaches before bursting
  TREE_TUMBLE: 7.0, // LEGACY (see UPROOT_TUMBLE_BY_TYPE) — self-rotation speed (rad/s) of a tumbling whole tree
  TREE_SIZE: 22, // LEGACY (see UPROOT_SIZE_BY_TYPE) — render size (px) of a whole uprooted tree
  CHUNK_RISE_MIN: 0.26, // chunk ascent rate (h per second) range after a burst
  CHUNK_RISE_MAX: 0.6,
  CHUNK_SETTLE: 4.0, // how fast a chunk eases onto its funnel-hugging radius
  CHUNK_TUMBLE: 10.0, // chunk self-rotation speed (rad/s)

  // --- per-type uproot feel ---
  // Indexed by STRUCTURE_ORDER (tree, trailer, house, silo, fence, cow, barn),
  // same as LIFT_CAP_BY_TYPE. A barn lifting off should NOT read like a tree:
  // it's drawn bigger, tumbles slower (it's heavy), and hangs in the funnel
  // whole for longer before it comes apart, which is the payoff moment.
  UPROOT_SIZE_BY_TYPE: [22, 30, 34, 30, 22, 22, 38, 34], // render size (px) of the whole entity
  UPROOT_TUMBLE_BY_TYPE: [7.0, 5.0, 4.0, 3.2, 7.0, 7.0, 2.6, 4.2], // self-rotation (rad/s)
  UPROOT_TIME_BY_TYPE: [0.8, 1.0, 1.2, 1.5, 0.8, 0.8, 1.6, 1.2], // seconds aloft whole before the burst

  // --- big-structure impact ---
  // A structure whose breakWind is at or above this counts as BIG (barn,
  // silo, house): wrestling one shows the strain face at ANY Vmax (normally it
  // only shows below STRAIN_VMAX_MAX), and ripping one up always pops the
  // "big O" and shakes the whole scene.
  BIG_BREAK: 110,
  QUAKE_SECS: 0.55, // how long the scene shakes when a big structure goes
  QUAKE_PX: 9, // peak shake amplitude (screen px)

  // --- haptics (see the frame callback in TornadoGame.tsx) ---
  // Each uproot raises a "thud" weight by the structure's breakWind: below
  // THUD_MEDIUM it's a light tap (cows, fences, trees), up to BIG_BREAK a
  // medium knock (the truck), and big structures a heavy hit followed by a
  // rumble of heavy taps for as long as the scene quakes. Wrestling a
  // stubborn structure (the strain face) gives a soft rumble whose rate
  // rises with the strain. HAPTIC_GAP is the minimum time between any two
  // taps, so a grove vanishing at once doesn't turn into a buzz.
  THUD_MEDIUM: 90,
  HAPTIC_GAP: 0.06,
  QUAKE_RUMBLE_GAP: 0.08,
  STRAIN_RUMBLE_GAP: 0.16, // at full strain; halfway strain taps half as often

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

/**
 * The playable surface: a Skia canvas driven by a UI-thread physics loop, plus a
 * drag-to-steer gesture and a lightweight HUD.
 *
 * World vs screen: the world is wider than the screen (WORLD_W). A horizontal
 * camera (camX) follows the tornado so it stays centered while the scene scrolls
 * past. The projection folds the camera in BEFORE the perspective scale, so near
 * props parallax past faster than far ones. The gesture inverts the whole thing
 * (camera + perspective) so steering still tracks the finger exactly.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';
import { Canvas, Rect, LinearGradient, Path, PathOp, Skia, vec } from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  runOnJS,
} from 'react-native-reanimated';

import { STRUCTURE_ORDER, STRUCTURES, EF_LABELS, TUNING } from '../engine/model';
import { createWorld, resetWorld, type WorldState } from '../engine/state';
import { stepWorld } from '../engine/simulation';

interface Props {
  width: number;
  height: number;
}

interface Hud {
  ef: number;
  wind: number;
  timeLeft: number;
  debris: number;
  running: boolean;
}

const PROP_W = [34, 58, 52, 32, 0, 44, 84]; // tree, trailer, house, silo, fence, cow, barn. The fence entry is UNUSED — propShadows reads that instance's own sw[i], since the corral's size is derived in state.ts. The cow entry is its HOOF-print, not its full nose-to-tail width, and is offset in propShadows.

// Rolling hills on the horizon: [baseY, amplitude, k1, k2, parallax], far to
// near. baseY/amplitude are SCREEN px (these are backdrop, not world props, so
// they never go through project()); k1/k2 are the two sine frequencies whose
// sum makes the ridgeline; parallax is the fraction of camX the ridge shifts
// by. k2 is deliberately NOT a harmonic of k1 (roughly 0.5x, phase-offset) so
// crest heights vary instead of repeating a wave the eye can lock onto.
const HILLS: readonly (readonly [number, number, number, number, number])[] = [
  [214, 16, 0.0180, 0.0091, 0.08],
  [243, 21, 0.0132, 0.0068, 0.14],
  [272, 14, 0.0210, 0.0104, 0.22],
];

// Deterministic pseudo-random in [0,1) from a numeric seed — scatters dust/grit
// particles and wind streaks without needing a dedicated RNG shared value.
const hash1 = (i: number) => {
  'worklet';
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

export default function TornadoGame({ width, height }: Props) {
  // World is wider than the screen so there's scene to scroll into. Width is
  // the ONLY axis that scales: there is no camY, and project() derives depth
  // from `gy / H` where H is the SCREEN height, so `sy` doubles as a screen
  // coordinate everywhere. The world is a strip as tall as the phone; making
  // it taller needs a vertical camera AND depth-sorted prop rendering (props
  // are billboards drawn in fixed layer order), not a bigger number here.
  //
  // 6x (2026-08-31, was 2.2x). Nothing else is bounded by width — camMax
  // below absorbs it — but prop COUNT has to scale with it or the field goes
  // sparse, and the field has no off-screen culling: every structure is
  // rebuilt into a Skia path every frame across 14 passes (8 standalone
  // layers + useStructurePath x6). At ~112 props that's ~1.6k iterations a
  // frame, comfortable. Past roughly 400 props, add an off-screen skip on
  // projected x in those loops before raising the count further.
  const WORLD_W = width * 6;
  const world: WorldState = useMemo(
    () => createWorld(WORLD_W, height),
    [WORLD_W, height],
  );

  const [hud, setHud] = useState<Hud>({
    ef: -1,
    wind: TUNING.VMAX_START,
    timeLeft: TUNING.RUN_SECONDS,
    debris: 0,
    running: true,
  });

  const hudAccum = useSharedValue(0);

  // --- "on top" thrash: when a finger is held directly over the funnel core, the
  // tornado sways left/right rapidly and rips up out of its ground circle ---
  const touchDown = useSharedValue(0); // 1 while a drag is active
  const agitation = useSharedValue(0); // eased 0..1 "how much it's thrashing"
  const ripPhase = useSharedValue(0);  // fast oscillator driving the sway
  const dragV = useSharedValue(0);     // finger drag speed (px/s); decays each frame

  // --- direction-of-travel lean: which way the tornado is being driven decides
  // the angle we view it from (see funnelFrame). leanY -1 = driving away (top
  // tips out of sight), +1 = driving toward the camera (top opens up). ---
  const leanX = useSharedValue(0);
  const leanY = useSharedValue(0);
  const prevTX = useSharedValue(0);
  const prevTY = useSharedValue(0);

  const pushHud = useCallback(
    (ef: number, wind: number, timeLeft: number, debris: number, running: number) => {
      setHud({ ef, wind: Math.round(wind), timeLeft, debris, running: running === 1 });
    },
    [],
  );

  // ---- the loop ----
  useFrameCallback((info) => {
    'worklet';
    const dt = (info.timeSincePreviousFrame ?? 16) / 1000;
    stepWorld(world, dt);
    world.tick.value += 1;
    world.spin.value += dt * (5.5 + world.vmax.value * 0.09);

    // Agitate ONLY when the finger is held roughly STILL on top of the funnel —
    // not while dragging the tornado around (that was shaking the face + debris
    // during normal movement). dragV decays each frame, so a stopped finger
    // resumes the thrash; a moving one suppresses it.
    // travel velocity -> lean (this is what turns the funnel toward/away from us)
    const inv = 1 / Math.max(dt, 0.001);
    const vxT = (world.tornadoX.value - prevTX.value) * inv;
    const vyT = (world.tornadoY.value - prevTY.value) * inv;
    prevTX.value = world.tornadoX.value;
    prevTY.value = world.tornadoY.value;
    const ly = Math.max(-1, Math.min(1, vyT / TUNING.LEAN_REF_SPEED));
    const lx = Math.max(-1, Math.min(1, vxT / TUNING.LEAN_REF_SPEED));
    const le = Math.min(1, dt * TUNING.LEAN_EASE);
    leanY.value += (ly - leanY.value) * le;
    leanX.value += (lx - leanX.value) * le;

    dragV.value *= Math.exp(-dt * 6);
    const adx = world.targetX.value - world.tornadoX.value;
    const ady = world.targetY.value - world.tornadoY.value;
    const onTop = adx * adx + ady * ady < TUNING.RMAX * TUNING.RMAX;
    const still = dragV.value < 70; // px/s; above this the finger is dragging
    const want = touchDown.value === 1 && onTop && still ? 1 : 0;
    agitation.value += (want - agitation.value) * Math.min(1, dt * 7);
    ripPhase.value = (ripPhase.value + dt * 40) % 6.28318; // ~6 Hz sway

    hudAccum.value += dt;
    if (hudAccum.value >= 0.14) {
      hudAccum.value = 0;
      runOnJS(pushHud)(
        world.maxEF.value,
        world.vmax.value,
        world.timeLeft.value,
        world.debrisCount.value,
        world.running.value,
      );
    }
  });

  const FENCE_TYPE = STRUCTURE_ORDER.indexOf('fence'); // used by uprootedFences below and the fencePosts layer further down
  const COW_TYPE = STRUCTURE_ORDER.indexOf('cow'); // used by uprootedCows below and the cow branch in useStructurePath
  // The farmstead pair. Both are SCENERY (state.ts spawns them with a
  // breakWind above VMAX_CAP), so they only ever render ROOTED — neither has
  // a mid-air uproot shape, and neither needs one until that override goes.
  const SILO_TYPE = STRUCTURE_ORDER.indexOf('silo');
  const BARN_TYPE = STRUCTURE_ORDER.indexOf('barn');
  const H = height;
  const cxScreen = width / 2;
  const K = TUNING.TILT_K;
  const camMax = WORLD_W - width;

  // ---- drag to steer (invert camera + perspective) ----
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onBegin((e) => {
          'worklet';
          touchDown.value = 1;
          dragV.value = 0;
          const p = 1 - K + K * (e.y / H);
          const camX = Math.max(0, Math.min(camMax, world.tornadoX.value - width / 2));
          world.targetX.value = camX + cxScreen + (e.x - cxScreen) / p;
          world.targetY.value = e.y;
        })
        .onChange((e) => {
          'worklet';
          dragV.value = Math.sqrt(e.velocityX * e.velocityX + e.velocityY * e.velocityY);
          const p = 1 - K + K * (e.y / H);
          const camX = Math.max(0, Math.min(camMax, world.tornadoX.value - width / 2));
          world.targetX.value = camX + cxScreen + (e.x - cxScreen) / p;
          world.targetY.value = e.y;
        })
        .onFinalize(() => {
          'worklet';
          touchDown.value = 0;
          dragV.value = 0;
        }),
    [world, H, K, cxScreen, camMax, width, touchDown, dragV],
  );

  // ================= rolling hills =================
  // Three ridges of low hills between the storm cloud and the top of the
  // playfield. This is the only PARALLAX layer in the game: each ridge shifts
  // by camX * its own factor, so panning across the 6x world makes the far
  // ridge crawl while the near one slides. That difference is what gives the
  // flat 2.5D field a sense of distance — props can't provide it, since they
  // sit at real world x and track the camera 1:1.
  //
  // Each layer fills from its own ridgeline all the way to the BOTTOM of the
  // canvas, not to a shared baseline. A shared baseline would leave a hard
  // horizontal seam wherever the fill stopped; this way each layer is simply
  // painted over by the next one down. The consequence is that the NEAREST
  // layer becomes the ground, which is why it carries the ground gradient in
  // the JSX (pale sage at the horizon, warming into the same sand the sky
  // Rect ends on) instead of a flat color.
  const useHillPath = (layer: number) =>
    useDerivedValue(() => {
      world.tick.value;
      const baseY = HILLS[layer][0], amp = HILLS[layer][1];
      const k1 = HILLS[layer][2], k2 = HILLS[layer][3], par = HILLS[layer][4];
      const camX = Math.max(0, Math.min(camMax, world.tornadoX.value - width / 2));
      const off = camX * par;
      const path = Skia.PathBuilder.Make();
      const N = 40;
      for (let i = 0; i <= N; i++) {
        const x = (i / N) * width;
        const y = baseY + amp * Math.sin(k1 * (x + off)) + amp * 0.45 * Math.sin(k2 * (x + off) + 1.7);
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      path.lineTo(width, height);
      path.lineTo(0, height);
      path.close();
      return path.detach();
    });

  const hillPaths = [useHillPath(0), useHillPath(1), useHillPath(2)];

  // ================= projection =================
  // Fold camera + perspective into one place. Returns [screenX, depthScale p].
  // Height is applied by the caller as sy = gy - gz * p.
  const project = (gx: number, gy: number) => {
    'worklet';
    const p = 1 - K + K * (gy / H);
    const camX = Math.max(0, Math.min(camMax, world.tornadoX.value - width / 2));
    return [cxScreen + (gx - camX - cxScreen) * p, p] as const;
  };

  // Horizontal sway + vertical lift applied to the funnel/face while agitated.
  // swayX oscillates fast (ripPhase); lift raises the base up off the ground
  // circle so the funnel visibly "rips" out of its shadow. Returns depth-scaled
  // pixels so near/far look consistent.
  const agitOffset = (pb: number) => {
    'worklet';
    const a = agitation.value;
    const swayX = Math.sin(ripPhase.value) * 30 * a * pb;
    const lift = a * 48 * pb;
    return [swayX, lift, a] as const;
  };

  // ================= funnel =================
  // COHESION RULE: every funnel layer (silhouette, shading ribbons, highlight
  // ribbons, swoosh bands, wind streaks) is built from `coneAt` below. They all
  // read the same center/radius/rotation at a given height, so they move as ONE
  // twisting body instead of drifting as separate pieces. If you change the
  // funnel's shape or motion, change it HERE and every layer follows.

  /** Common per-frame funnel frame: base point, depth scale, base Y, sway, scale, spin. */
  const funnelFrame = () => {
    'worklet';
    const [bx, pb] = project(world.tornadoX.value, world.tornadoY.value);
    const [swayX, lift] = agitOffset(pb);
    const baseY = world.tornadoY.value - lift;
    const vscale = TUNING.TORNADO_SCALE * (1 + 0.5 * (world.vmax.value / TUNING.VMAX_CAP));
    // The angle we see the funnel from, driven by WHICH WAY IT'S BEING DRIVEN:
    // driving toward the camera (leanY > 0) tips it so you look down into the open
    // top; driving away (leanY < 0) tips it over until the top is out of sight;
    // standing still sits at VIEW_NEUTRAL. Every ring's y/x ratio comes from this,
    // so the whole tornado turns as one object.
    const view = Math.max(0, Math.min(1,
      TUNING.VIEW_NEUTRAL + (1 - TUNING.VIEW_NEUTRAL) * leanY.value));
    const flat = TUNING.RING_FLATTEN * (TUNING.VIEW_FLAT_MIN + TUNING.VIEW_FLAT_RANGE * view);
    return { bx, pb, baseY, swayX, vscale, s: world.spin.value, view, flat };
  };

  /** The camera's look-down amount on its own, for props that fade with it. */
  const viewAmount = useDerivedValue(() => {
    world.tick.value;
    return funnelFrame().view;
  });

  /**
   * The cone's geometry at height h (0 = ground tip, 1 = top opening).
   * Returns [centerX, centerY, radiusX, rotation]. Includes the per-height coil
   * offset and a gentle wind wobble so the edge isn't a sterile straight cone.
   */
  const coneAt = (
    h: number, bx: number, pb: number, baseY: number,
    swayX: number, vscale: number, s: number,
  ) => {
    'worklet';
    const wob = Math.sin(s * TUNING.FUNNEL_JITTER_FREQ * 10 + h * 4.2) * TUNING.FUNNEL_JITTER;
    const t = Math.pow(h, TUNING.FUNNEL_TAPER);
    // roll the radius back in above DOME_START so the top rounds over
    const d = Math.max(0, (h - TUNING.FUNNEL_DOME_START) / (1 - TUNING.FUNNEL_DOME_START));
    const dome = 1 - TUNING.FUNNEL_DOME * (d * d * (3 - 2 * d));
    const rr =
      (TUNING.FUNNEL_TAIL_R + (TUNING.FUNNEL_TOP_R - TUNING.FUNNEL_TAIL_R) * t) *
      dome * pb * vscale * (1 + wob * 0.35);
    const rot = h * TUNING.FUNNEL_TWIST + s * TUNING.FUNNEL_SPIN;
    const cx =
      bx + swayX * (0.5 + h) + Math.cos(rot) * rr * TUNING.RING_TWIST_COIL +
      leanX.value * h * TUNING.LEAN_X_PX * pb; // top leans into left/right travel
    const cy = baseY - h * TUNING.FUNNEL_HEIGHT * pb * vscale;
    return [cx, cy, rr, rot] as const;
  };

  // ---- debris & uprooted trees (coil UP the funnel, using the SAME helix the
  // funnel strands are drawn with, so they read as part of the wind) ----
  const debrisChunks = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const { bx, pb, baseY, swayX, vscale, s, flat } = funnelFrame();
    const alive = world.dalive.value, kind = world.dkind.value;
    const ph = world.dphase.value, rf = world.drf.value, dh = world.dh.value;
    const dsz = world.dsize.value;
    for (let i = 0; i < alive.length; i++) {
      if (alive[i] === 0 || kind[i] !== 0) continue;
      const h = dh[i] < 0 ? 0 : dh[i] > 1 ? 1 : dh[i];
      // ride the SAME cone the body is drawn from, so debris hugs the funnel's
      // actual surface instead of an old straight-cone approximation
      const [ccx, ccy, crr] = coneAt(h, bx, pb, baseY, swayX, vscale, s);
      const rr = crr * rf[i];
      const ry = rr * flat;
      const rot = ph[i] + h * TUNING.FUNNEL_TWIST + s * TUNING.DEBRIS_COIL_SPEED;
      const cx = ccx + Math.cos(rot) * rr;
      const cy = ccy + Math.sin(rot) * ry;
      path.addCircle(cx, cy, dsz[i] * pb * (0.6 + 0.4 * (1 - h)));
    }
    return path.detach();
  });

  // uprootedTrees: the DEFAULT whole-entity render — a trunk quad + canopy
  // blob, tumbling by its own self-spin. Used for every uprooted structure
  // type EXCEPT fence, which gets its own shape (uprootedFences, right
  // below) so it doesn't fly into the funnel looking like a tree. Still the
  // fallback for trailer/house/silo if those come back — see
  // [[structures_and_fence]] for why that's fine to leave as-is for now.
  const uprootedTrees = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const { bx, pb, baseY, swayX, vscale, s, flat } = funnelFrame();
    const alive = world.dalive.value, kind = world.dkind.value, dtype = world.dtype.value;
    const ph = world.dphase.value, rf = world.drf.value, dh = world.dh.value;
    const spin = world.dspin.value, dsz = world.dsize.value;
    for (let i = 0; i < alive.length; i++) {
      if (alive[i] === 0 || kind[i] !== 1 || dtype[i] === FENCE_TYPE || dtype[i] === COW_TYPE) continue;
      const h = dh[i] < 0 ? 0 : dh[i];
      const [ccx, ccy, crr] = coneAt(h, bx, pb, baseY, swayX, vscale, s);
      const rr = crr * rf[i];
      const ry = rr * flat;
      const rot = ph[i] + h * TUNING.FUNNEL_TWIST + s * TUNING.DEBRIS_COIL_SPEED;
      const cx = ccx + Math.cos(rot) * rr;
      const cy = ccy + Math.sin(rot) * ry;
      // tumbling whole tree: a trunk quad + canopy blob, rotated by its self-spin
      const sc = dsz[i] * pb;
      const ca = Math.cos(spin[i]), sa = Math.sin(spin[i]); // tree's "up" axis
      const px = -sa, py = ca; // perpendicular (trunk width)
      const len = 1.1 * sc, half = 0.28 * sc;
      const bxr = cx - ca * len * 0.5, byr = cy - sa * len * 0.5; // trunk root
      const bxt = cx + ca * len * 0.5, byt = cy + sa * len * 0.5; // trunk top
      path.moveTo(bxr + px * half, byr + py * half);
      path.lineTo(bxr - px * half, byr - py * half);
      path.lineTo(bxt - px * half, byt - py * half);
      path.lineTo(bxt + px * half, byt + py * half);
      path.close();
      path.addCircle(cx + ca * (len * 0.75), cy + sa * (len * 0.75), 0.78 * sc);
    }
    return path.detach();
  });

  // uprootedFences: a tumbling fence PIECE (a long plank + a small post-stub
  // square at each end) instead of the default tree icon, for any kind=1
  // entity whose origin type (dtype, set once in simulation.ts when it's
  // handed to the vortex) is a fence segment. Same rotate-by-self-spin
  // approach as uprootedTrees, just a different silhouette.
  const uprootedFences = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const { bx, pb, baseY, swayX, vscale, s, flat } = funnelFrame();
    const alive = world.dalive.value, kind = world.dkind.value, dtype = world.dtype.value;
    const ph = world.dphase.value, rf = world.drf.value, dh = world.dh.value;
    const spin = world.dspin.value, dsz = world.dsize.value;
    for (let i = 0; i < alive.length; i++) {
      if (alive[i] === 0 || kind[i] !== 1 || dtype[i] !== FENCE_TYPE) continue;
      const h = dh[i] < 0 ? 0 : dh[i];
      const [ccx, ccy, crr] = coneAt(h, bx, pb, baseY, swayX, vscale, s);
      const rr = crr * rf[i];
      const ry = rr * flat;
      const rot = ph[i] + h * TUNING.FUNNEL_TWIST + s * TUNING.DEBRIS_COIL_SPEED;
      const cx = ccx + Math.cos(rot) * rr;
      const cy = ccy + Math.sin(rot) * ry;
      // tumbling fence plank + a post-stub square at each end, rotated by
      // its own self-spin — reads as a board, not a tree.
      const sc = dsz[i] * pb;
      const ca = Math.cos(spin[i]), sa = Math.sin(spin[i]);
      const px = -sa, py = ca;
      const len = 1.5 * sc, half = 0.16 * sc;
      const bxr = cx - ca * len * 0.5, byr = cy - sa * len * 0.5;
      const bxt = cx + ca * len * 0.5, byt = cy + sa * len * 0.5;
      path.moveTo(bxr + px * half, byr + py * half);
      path.lineTo(bxr - px * half, byr - py * half);
      path.lineTo(bxt - px * half, byt - py * half);
      path.lineTo(bxt + px * half, byt + py * half);
      path.close();
      const stub = 0.34 * sc;
      path.addRect(Skia.XYWHRect(bxr - stub / 2, byr - stub / 2, stub, stub));
      path.addRect(Skia.XYWHRect(bxt - stub / 2, byt - stub / 2, stub, stub));
    }
    return path.detach();
  });

  // uprootedCows: a tumbling cow — chubby body quad + a bigger head circle
  // at one end (same trunk-quad + canopy-circle trick as uprootedTrees, just
  // chubbier proportions and a bigger "head" so it reads as the chibi cow
  // mid-flight, not a log), for any kind=1 entity whose origin type is the
  // pasture cow. "lets eat the cow!!" — the tornado can now actually
  // swallow it, and it should look like ITSELF while flying in, not a tree.
  const uprootedCows = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const { bx, pb, baseY, swayX, vscale, s, flat } = funnelFrame();
    const alive = world.dalive.value, kind = world.dkind.value, dtype = world.dtype.value;
    const ph = world.dphase.value, rf = world.drf.value, dh = world.dh.value;
    const spin = world.dspin.value, dsz = world.dsize.value;
    for (let i = 0; i < alive.length; i++) {
      if (alive[i] === 0 || kind[i] !== 1 || dtype[i] !== COW_TYPE) continue;
      const h = dh[i] < 0 ? 0 : dh[i];
      const [ccx, ccy, crr] = coneAt(h, bx, pb, baseY, swayX, vscale, s);
      const rr = crr * rf[i];
      const ry = rr * flat;
      const rot = ph[i] + h * TUNING.FUNNEL_TWIST + s * TUNING.DEBRIS_COIL_SPEED;
      const cx = ccx + Math.cos(rot) * rr;
      const cy = ccy + Math.sin(rot) * ry;
      const sc = dsz[i] * pb;
      const ca = Math.cos(spin[i]), sa = Math.sin(spin[i]);
      const px = -sa, py = ca;
      const len = 1.0 * sc, half = 0.34 * sc; // chubby, shorter than the tree trunk
      const bxr = cx - ca * len * 0.5, byr = cy - sa * len * 0.5;
      const bxt = cx + ca * len * 0.5, byt = cy + sa * len * 0.5;
      path.moveTo(bxr + px * half, byr + py * half);
      path.lineTo(bxr - px * half, byr - py * half);
      path.lineTo(bxt - px * half, byt - py * half);
      path.lineTo(bxt + px * half, byt + py * half);
      path.close();
      path.addCircle(bxt + ca * (len * 0.3), byt + sa * (len * 0.3), 0.62 * sc); // big chibi head
    }
    return path.detach();
  });

  const uprootedCowMarkings = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const { bx, pb, baseY, swayX, vscale, s, flat } = funnelFrame();
    const alive = world.dalive.value, kind = world.dkind.value, dtype = world.dtype.value;
    const ph = world.dphase.value, rf = world.drf.value, dh = world.dh.value;
    const spin = world.dspin.value, dsz = world.dsize.value;
    for (let i = 0; i < alive.length; i++) {
      if (alive[i] === 0 || kind[i] !== 1 || dtype[i] !== COW_TYPE) continue;
      const h = dh[i] < 0 ? 0 : dh[i];
      const [ccx, ccy, crr] = coneAt(h, bx, pb, baseY, swayX, vscale, s);
      const rr = crr * rf[i];
      const ry = rr * flat;
      const rot = ph[i] + h * TUNING.FUNNEL_TWIST + s * TUNING.DEBRIS_COIL_SPEED;
      const cx = ccx + Math.cos(rot) * rr;
      const cy = ccy + Math.sin(rot) * ry;
      const sc = dsz[i] * pb;
      const ca = Math.cos(spin[i]), sa = Math.sin(spin[i]);
      const len = 1.0 * sc;
      const bxt = cx + ca * len * 0.5, byt = cy + sa * len * 0.5;
      const headX = bxt + ca * (len * 0.3), headY = byt + sa * (len * 0.3);
      path.addCircle(cx - ca * (len * 0.15), cy - sa * (len * 0.15), 0.2 * sc); // one holstein spot
      path.addCircle(headX + ca * 0.2 * sc, headY + sa * 0.2 * sc, 0.12 * sc); // eye dot
    }
    return path.detach();
  });

  // ---- cute prop billboards ----
  const COW_LEG_X = [30, 23, 8, 1]; // rear pair, then front pair (the cow faces LEFT)

  const useStructurePath = (typeIndex: number) =>
    useDerivedValue(() => {
      world.tick.value;
      const path = Skia.PathBuilder.Make();
      const sx = world.sx.value, sy = world.sy.value;
      const stype = world.stype.value, salive = world.salive.value;
      const shp = world.shp.value, shpMax = world.shpMax.value;
      const sw = world.sw.value, sh = world.sh.value;
      for (let i = 0; i < salive.length; i++) {
        if (salive[i] === 0 || stype[i] !== typeIndex) continue;
        const dmg = shpMax[i] > 0 ? shp[i] / shpMax[i] : 1;
        const [bx, p] = project(sx[i], sy[i]);
        const sc = p * (0.72 + 0.28 * Math.max(dmg, 0));
        const by = sy[i];
        if (typeIndex === 0) {
          const R = 20 * sc, trunk = 16 * sc;
          // Sway: the tree ROTATES about its base toward the tornado. Rotation,
          // not translation — the previous version slid the trunk top and the
          // canopy sideways while keeping the trunk's vertical length fixed, so
          // the trunk quad's diagonal stretched with the lean and the canopy
          // pulled away from the trunk top (up to 80px of offset on a 16px
          // trunk). Everything below places points at a FIXED distance from the
          // base along a rotated axis, so no length can change.
          const rdx = world.tornadoX.value - sx[i];
          const rdy = world.tornadoY.value - sy[i];
          const dist = Math.sqrt(rdx * rdx + rdy * rdy) || 1;
          // How hard the wind is working on this tree. Zero by 1.5x the pull
          // radius, so a tree the funnel cannot even damage isn't bent double —
          // the old falloff saturated at full lean out to ~270px.
          const windR = TUNING.PULL_RADIUS * 1.5;
          let prox = 1 - dist / windR;
          if (prox < 0) prox = 0;
          const strength = prox * prox * (0.35 + 0.65 * (world.vmax.value / TUNING.VMAX_CAP));
          // gentle per-tree shimmer, so the grove breathes even in calm air
          const wob = 0.055 * Math.sin(world.tick.value * 0.12 + i);
          // as the tree nears death (dmg -> 0) it gets yanked HARDER toward the
          // funnel, telegraphing the uproot so it's clear the tornado grabbed it
          const grab = 1 + (1 - Math.max(dmg, 0)) * 1.6;
          let bend = TUNING.TREE_BEND * strength * grab + wob;
          if (bend > TUNING.TREE_BEND_MAX) bend = TUNING.TREE_BEND_MAX;
          else if (bend < -TUNING.TREE_BEND_MAX) bend = -TUNING.TREE_BEND_MAX;

          // rotated "up" axis: screen-up tipped toward the tornado's bearing,
          // with the y component flattened by the same 0.4 the ground plane uses
          const ux = rdx / dist, uy = (rdy / dist) * 0.4;
          const sB = Math.sin(bend), cB = Math.cos(bend);
          const tipX = bx + sB * trunk * ux;
          const tipY = by - cB * trunk + sB * trunk * uy;

          // trunk: rooted flat on the ground, thickness taken PERPENDICULAR to
          // the leaning axis at the top so the quad shears instead of fanning
          const tw = 4 * sc;
          const axX = tipX - bx, axY = tipY - by;
          const alen = Math.sqrt(axX * axX + axY * axY) || 1;
          const nx = -axY / alen, ny = axX / alen;
          path.moveTo(bx - tw, by);
          path.lineTo(bx + tw, by);
          path.lineTo(tipX + nx * tw, tipY + ny * tw);
          path.lineTo(tipX - nx * tw, tipY - ny * tw);
          path.close();

          // canopy rides the SAME axis at a fixed distance from the base, so it
          // stays welded to the trunk top however far the tree bends
          const canL = trunk + R * 0.7;
          path.addCircle(bx + sB * canL * ux, by - cB * canL + sB * canL * uy, R);
        } else if (typeIndex === 1) {
          // mobile home: a low box with a shallow roof cap. Uses addRect, NOT the
          // deprecated addRRect (which warns / no-ops in react-native-skia 2.x).
          const w = 58 * sc, h = 26 * sc;
          path.addRect(Skia.XYWHRect(bx - w / 2, by - h, w, h));
          path.moveTo(bx - w / 2 - 2 * sc, by - h);
          path.lineTo(bx, by - h - 10 * sc);
          path.lineTo(bx + w / 2 + 2 * sc, by - h);
          path.close();
        } else if (typeIndex === 2) {
          const w = 52 * sc, bh = 34 * sc, rh = 24 * sc;
          path.addRect(Skia.XYWHRect(bx - w / 2, by - bh, w, bh));
          path.moveTo(bx - w / 2 - 3 * sc, by - bh);
          path.lineTo(bx, by - bh - rh);
          path.lineTo(bx + w / 2 + 3 * sc, by - bh);
          path.close();
        } else if (typeIndex === SILO_TYPE) {
          // grain silo BODY only — the concrete cylinder. Its stave bands and
          // shaded side (siloShade) and its galvanized dome (farmRoofs) are
          // separate type-filtered layers further down, same arrangement the
          // fence has with fencePosts and the cow has with its detail layers.
          // Local units: 32 wide, 66 tall to the eave; the dome adds 15 more.
          path.addRRect(Skia.RRectXY(Skia.XYWHRect(bx - 16 * sc, by - 66 * sc, 32 * sc, 66 * sc), 3 * sc, 3 * sc));
        } else if (typeIndex === FENCE_TYPE) {
          // pasture fence RAILS: one straight segment (this structure is now
          // ONE SIDE of the corral, not the whole square — 4 independent
          // instances are spawned together, see the dedicated block in
          // state.ts's resetWorld, so each side can be knocked down on its
          // own). Orientation comes from this instance's own footprint:
          // sw>=sh means horizontal (top/bottom), sh>sw means vertical
          // (left/right) — set at spawn time, see STRUCTURES.fence's comment.
          //
          // Two thick rail boards are drawn on top of the (separately
          // rendered, darker) fencePosts path — see fencePosts below — so
          // each post's mid-shaft is occluded here and only its peak, a gap
          // sliver, and its ground leg show through. That layering is what
          // gives the picket-and-rail look.
          //
          // Each board is built around a CENTERLINE at a fixed height above
          // the ground (true elevation, via the same gz*p convention project()
          // uses for every other billboard's height), then given thickness by
          // offsetting PERPENDICULAR TO THE SEGMENT — not vertically. A
          // vertical offset degenerates on a near-vertical (left/right)
          // segment: the offset ends up almost PARALLEL to the segment
          // instead of across it, so the board's width collapses to nearly
          // nothing (the original "feels flat" bug, back when one instance
          // drew all 4 sides as edges of a square). Perpendicular offset
          // keeps the board equally thick regardless of which way the
          // segment runs on screen.
          const dmgScale = 0.72 + 0.28 * Math.max(dmg, 0);
          const isHorizontal = sw[i] >= sh[i];
          const segHalf = ((isHorizontal ? sw[i] : sh[i]) / 2) * dmgScale;
          const wx = sx[i], wy = sy[i];
          const ax0 = isHorizontal ? wx - segHalf : wx;
          const ay0 = isHorizontal ? wy : wy - segHalf;
          const bx0 = isHorizontal ? wx + segHalf : wx;
          const by0 = isHorizontal ? wy : wy + segHalf;
          const railCenterH = [25 * dmgScale, 7 * dmgScale]; // centerline height above ground
          // vertical (left/right) segments read a touch heavier than
          // horizontal ones at the same half-thickness once they're properly
          // solid (see the perpendicular-offset note above), so trim them.
          const sideTrim = isHorizontal ? 1 : 0.7;
          const railHalfT = [5 * dmgScale * sideTrim, 5 * dmgScale * sideTrim];
          const [ax, pa] = project(ax0, ay0);
          const ay = ay0;
          const [bxp, pbp] = project(bx0, by0);
          const byp = by0;
          for (let b = 0; b < 2; b++) {
            const ch = railCenterH[b], ht = railHalfT[b];
            const cAx = ax, cAy = ay - ch * pa;
            const cBx = bxp, cBy = byp - ch * pbp;
            const edx = cBx - cAx, edy = cBy - cAy;
            const elen = Math.sqrt(edx * edx + edy * edy) || 1;
            const nx = -edy / elen, ny = edx / elen; // unit perpendicular
            path.moveTo(cAx + nx * ht * pa, cAy + ny * ht * pa);
            path.lineTo(cBx + nx * ht * pbp, cBy + ny * ht * pbp);
            path.lineTo(cBx - nx * ht * pbp, cBy - ny * ht * pbp);
            path.lineTo(cAx - nx * ht * pa, cAy - ny * ht * pa);
            path.close();
          }
        } else if (typeIndex === COW_TYPE) {
          // pasture cow BODY — the WHITE silhouette layer. Faces LEFT, in
          // chibi-holstein proportions taken from the reference art: chunky
          // rounded torso, four short stubby legs, a big round head with
          // droopy ears and stubby horns, a snout, and an udder. The tail is
          // its own stroked layer (cowTail) and the tan/pink/black details
          // are their own type-filtered layers, all further down — the same
          // relationship fencePosts has to the fence's rails.
          //
          // Local coords are world units: lx = horizontal offset from the
          // cow's ground position (NEGATIVE = toward the head), lh = height
          // above ground, so the cow spans lx -25..34 and lh 0..38. `sc`
          // (computed once per instance at the top of this loop, same as
          // every other prop) already folds in BOTH the camera depth scale
          // and the damage shrink, so the whole cow visibly shrinks as it's
          // eaten.
          //
          // IMPORTANT: horns, ears, snout and udder are part of THIS path so
          // that the dark outline — which is just this same path re-stroked
          // in the JSX — traces the full silhouette. The tan and pink fills
          // are then painted over the white, and re-stroked themselves, so
          // the head's outline doesn't run across the muzzle.
          const cpx = (lx: number) => bx + lx * sc;
          const cpy = (lh: number) => by - lh * sc;

          // torso: a rounded rect, not an oval — the reference cow's body is
          // a soft brick, and an oval alone reads as a sausage
          path.addRRect(Skia.RRectXY(Skia.XYWHRect(cpx(-2), cpy(34), 34 * sc, 22 * sc), 9 * sc, 9 * sc));
          // four short legs
          for (let k = 0; k < COW_LEG_X.length; k++) {
            const lx = COW_LEG_X[k];
            path.addRRect(Skia.RRectXY(Skia.XYWHRect(cpx(lx - 2.75), cpy(13), 5.5 * sc, 13 * sc), 2.4 * sc, 2.4 * sc));
          }
          // udder, slung under the belly just ahead of the hind legs
          path.addOval(Skia.XYWHRect(cpx(12), cpy(15), 10 * sc, 7 * sc));
          // ears (far ear first, so the head circle swallows its root)
          path.addOval(Skia.XYWHRect(cpx(-7), cpy(30), 8 * sc, 4.5 * sc));
          path.addOval(Skia.XYWHRect(cpx(-25), cpy(30), 8 * sc, 4.5 * sc));
          // stubby horns, poking up between the ears
          path.moveTo(cpx(-18.5), cpy(31.5));
          path.lineTo(cpx(-21), cpy(36.5));
          path.lineTo(cpx(-14.5), cpy(33));
          path.close();
          path.moveTo(cpx(-6), cpy(31.5));
          path.lineTo(cpx(-3), cpy(36.5));
          path.lineTo(cpx(-9.5), cpy(33));
          path.close();
          // head + snout
          path.addCircle(cpx(-12), cpy(24), 10 * sc);
          path.addOval(Skia.XYWHRect(cpx(-21.5), cpy(22), 12 * sc, 8 * sc));
        } else if (typeIndex === BARN_TYPE) {
          // barn WALLS + GABLE — the red silhouette. The slate gambrel roof
          // (farmRoofs), the cream door / windows / hayloft / cupola
          // (farmTrim) and the door's X brace (barnBrace) are their own
          // layers below, painted over this in that order.
          //
          // NOTE this branch must stay an explicit `else if`, never a bare
          // trailing `else`: it is currently the LAST link in the chain, and
          // a bare else here would silently swallow whatever type is appended
          // to STRUCTURE_ORDER next (exactly the bug the fence branch had
          // before the cow was added).
          //
          // Local units, lx from the ground x / lh above ground: 84 wide,
          // walls to lh 38, roof peak at 75, cupola finial at 90.
          const bpx = (lx: number) => bx + lx * sc;
          const bpy = (lh: number) => by - lh * sc;
          path.addRect(Skia.XYWHRect(bpx(-42), bpy(38), 84 * sc, 38 * sc));
          // gable face: the red showing between the eaves and the peak. Its
          // outline follows the gambrel's own break so the roof band above it
          // sits flush instead of leaving a red sliver at the kink.
          path.moveTo(bpx(-42), bpy(38));
          path.lineTo(bpx(-32), bpy(60));
          path.lineTo(bpx(0), bpy(72));
          path.lineTo(bpx(32), bpy(60));
          path.lineTo(bpx(42), bpy(38));
          path.close();
        }
      }
      return path.detach();
    });

  const structurePaths = [
    useStructurePath(0),
    useStructurePath(1),
    useStructurePath(2),
    useStructurePath(3),
    useStructurePath(4),
    useStructurePath(5),
    useStructurePath(6),
  ];

  // Pasture fence posts: a SEPARATE, darker layer drawn under the fence's
  // own rails path (typeIndex 4 above). 8 posts per fence (4 corners + 4
  // edge midpoints, corners shared between adjoining sides), each a peaked
  // stick. Rendered as its own <Path> so it can carry its own (darker)
  // color — every other prop here is a single-color silhouette, but the
  // picket-and-rail look needs two tones.
  const fencePosts = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const sx = world.sx.value, sy = world.sy.value;
    const stype = world.stype.value, salive = world.salive.value;
    const shp = world.shp.value, shpMax = world.shpMax.value;
    const sw = world.sw.value, sh = world.sh.value;
    for (let i = 0; i < salive.length; i++) {
      if (salive[i] === 0 || stype[i] !== FENCE_TYPE) continue;
      const dmg = shpMax[i] > 0 ? shp[i] / shpMax[i] : 1;
      const dmgScale = 0.72 + 0.28 * Math.max(dmg, 0);
      // 3 posts per SEGMENT (start, middle, end) — this instance is one side
      // of the corral, not the whole square, so posts aren't shared with a
      // neighboring side's own instance any more (a real corner ends up with
      // one post from each of its two adjoining segments, which just
      // overdraws harmlessly in the same spot).
      const isHorizontal = sw[i] >= sh[i];
      const segHalf = ((isHorizontal ? sw[i] : sh[i]) / 2) * dmgScale;
      const wx = sx[i], wy = sy[i];
      const ax0 = isHorizontal ? wx - segHalf : wx;
      const ay0 = isHorizontal ? wy : wy - segHalf;
      const bx0 = isHorizontal ? wx + segHalf : wx;
      const by0 = isHorizontal ? wy : wy + segHalf;
      const postWX = [ax0, (ax0 + bx0) / 2, bx0];
      const postWY = [ay0, (ay0 + by0) / 2, by0];
      const postPeakH = 40 * dmgScale, peakH = 6 * dmgScale, halfW = 4 * dmgScale;
      for (let k = 0; k < 3; k++) {
        const [gx0, p0] = project(postWX[k], postWY[k]);
        const groundY = postWY[k];
        const shaftTopY = groundY - (postPeakH - peakH) * p0;
        const tipY = groundY - postPeakH * p0;
        path.moveTo(gx0 - halfW * p0, groundY);
        path.lineTo(gx0 - halfW * p0, shaftTopY);
        path.lineTo(gx0, tipY);
        path.lineTo(gx0 + halfW * p0, shaftTopY);
        path.lineTo(gx0 + halfW * p0, groundY);
        path.close();
      }
    }
    return path.detach();
  });

  const propShadows = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const sx = world.sx.value, sy = world.sy.value;
    const stype = world.stype.value, salive = world.salive.value;
    const shp = world.shp.value, shpMax = world.shpMax.value;
    const sw = world.sw.value, sh = world.sh.value;
    for (let i = 0; i < salive.length; i++) {
      if (salive[i] === 0) continue;
      // The corral's LEFT and RIGHT sides get no shadow. Every entry in
      // PROP_W is a width, and this loop lays it down as a horizontal
      // ellipse — fine for the top/bottom rails, which really do run left to
      // right, but the vertical sides (sh > sw, see the fence branch of
      // useStructurePath) run INTO the screen, so a 90-wide horizontal blob
      // pooled out sideways across the pasture instead of tracking the rail.
      // A correct one would have to be a rotated/segment-shaped shadow, and
      // at this size the sides read fine with none at all.
      if (stype[i] === FENCE_TYPE && sh[i] > sw[i]) continue;
      const dmg = shpMax[i] > 0 ? shp[i] / shpMax[i] : 1;
      const [bx, p] = project(sx[i], sy[i]);
      const sc = p * (0.72 + 0.28 * Math.max(dmg, 0));
      // The fence reads its width from its OWN instance footprint rather than
      // the PROP_W table: the corral's side length is derived from fenceHalf
      // in state.ts, so a fixed table entry would silently stop matching the
      // rails the moment the pasture is resized.
      const propW = stype[i] === FENCE_TYPE ? sw[i] : PROP_W[stype[i]];
      const rx = (propW / 2) * sc * 1.15;
      const ry = rx * 0.4;
      // every other prop is drawn symmetrically about its ground x, so a
      // shadow centered on bx sits right underneath it. The cow isn't: it
      // faces LEFT with its head hanging off the front, so its hoof-print
      // (lx -1..33) is pushed to the RIGHT of bx. Nudge just the cow's
      // shadow over by that much so it doesn't pool out in front of its nose.
      const shx = stype[i] === COW_TYPE ? 16 * sc : 0;
      path.addOval(Skia.XYWHRect(bx + shx - rx, sy[i] - ry, rx * 2, ry * 2));
    }
    return path.detach();
  });

  // ================= farmstead: barn + silo extra layers =================
  // The barn's red walls/gable and the silo's cream cylinder are drawn
  // generically by useStructurePath + the STRUCTURE_ORDER.map() JSX loop,
  // like every other prop. These four layers paint the rest, in this order:
  // siloShade (stave bands + the cylinder's shaded side) -> the dark INK
  // OUTLINE, which is just the barn's and silo's own body paths re-stroked
  // (the same trick the cow uses, and why the outlines match the herd's) ->
  // farmRoofs (slate: the gambrel roof, the cupola cap, the silo dome) ->
  // farmTrim (cream: door, windows, hayloft, cupola box) -> barnBrace (the
  // red X on the door). Each loops every structure instance and recomputes
  // `sc` (depth x damage-shrink) the way the body branches do, so the whole
  // building would shrink as one piece if these ever became destructible.
  //
  // Sharing ONE slate for the barn roof and the silo dome is deliberate: it
  // is what makes the two read as one farmstead rather than two props that
  // happen to be near each other, and it saves a whole per-frame path pass.

  // silo: the darker cream on its right flank (the cylinder's turn away from
  // the light) plus four stave bands. Both are inset ~0.8 units from the
  // body's edge so the body's rounded corners and a light rim survive
  // underneath — there is no clipping in a Skia Path, so a full-width band
  // would square the cylinder's corners off.
  const siloShade = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const sx = world.sx.value, sy = world.sy.value;
    const stype = world.stype.value, salive = world.salive.value;
    const shp = world.shp.value, shpMax = world.shpMax.value;
    for (let i = 0; i < salive.length; i++) {
      if (salive[i] === 0 || stype[i] !== SILO_TYPE) continue;
      const dmg = shpMax[i] > 0 ? shp[i] / shpMax[i] : 1;
      const [bx, p] = project(sx[i], sy[i]);
      const sc = p * (0.72 + 0.28 * Math.max(dmg, 0));
      const by = sy[i];
      const spx = (lx: number) => bx + lx * sc;
      const spy = (lh: number) => by - lh * sc;
      path.addRect(Skia.XYWHRect(spx(7), spy(64), 8.2 * sc, 62 * sc));
      for (let k = 1; k <= 4; k++) {
        path.addRect(Skia.XYWHRect(spx(-15.2), spy(k * 13 + 1.1), 30.4 * sc, 2.2 * sc));
      }
    }
    return path.detach();
  });

  // slate roofs: the barn's gambrel band + its cupola cap, and the silo's
  // dome + finial. One path, one color, both types.
  const farmRoofs = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const sx = world.sx.value, sy = world.sy.value;
    const stype = world.stype.value, salive = world.salive.value;
    const shp = world.shp.value, shpMax = world.shpMax.value;
    for (let i = 0; i < salive.length; i++) {
      if (salive[i] === 0) continue;
      const t = stype[i];
      if (t !== BARN_TYPE && t !== SILO_TYPE) continue;
      const dmg = shpMax[i] > 0 ? shp[i] / shpMax[i] : 1;
      const [bx, p] = project(sx[i], sy[i]);
      const sc = p * (0.72 + 0.28 * Math.max(dmg, 0));
      const by = sy[i];
      const fx = (lx: number) => bx + lx * sc;
      const fy = (lh: number) => by - lh * sc;
      if (t === BARN_TYPE) {
        // A gambrel is TWO slopes a side, not one: steep from the eave up to
        // a break at lh 60, then shallow to the peak. Drawn as a closed BAND
        // (out along the top edge, back along the inner edge) rather than a
        // filled triangle, so the red gable shows below it.
        path.moveTo(fx(-50), fy(35));
        path.lineTo(fx(-34), fy(60));
        path.lineTo(fx(0), fy(75));
        path.lineTo(fx(34), fy(60));
        path.lineTo(fx(50), fy(35));
        path.lineTo(fx(44), fy(31));
        path.lineTo(fx(32), fy(54));
        path.lineTo(fx(0), fy(68));
        path.lineTo(fx(-32), fy(54));
        path.lineTo(fx(-44), fy(31));
        path.close();
        // cupola cap, sitting on the peak
        path.moveTo(fx(-7.5), fy(83));
        path.lineTo(fx(0), fy(90));
        path.lineTo(fx(7.5), fy(83));
        path.close();
      } else {
        // silo dome: the TOP HALF of an oval centred on the cylinder's eave.
        // addArc(oval, 180, 180) traces left-edge -> over the top ->
        // right-edge; close() lays the flat chord back across the eave.
        path.addArc(Skia.XYWHRect(bx - 18.5 * sc, fy(66) - 15 * sc, 37 * sc, 30 * sc), 180, 180);
        path.close();
        path.addCircle(bx, fy(81), 3.2 * sc);
      }
    }
    return path.detach();
  });

  // cream trim on the barn: the big sliding door, a little window either side
  // of it, the hayloft door up in the gable, and the cupola's box.
  const farmTrim = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const sx = world.sx.value, sy = world.sy.value;
    const stype = world.stype.value, salive = world.salive.value;
    const shp = world.shp.value, shpMax = world.shpMax.value;
    for (let i = 0; i < salive.length; i++) {
      if (salive[i] === 0 || stype[i] !== BARN_TYPE) continue;
      const dmg = shpMax[i] > 0 ? shp[i] / shpMax[i] : 1;
      const [bx, p] = project(sx[i], sy[i]);
      const sc = p * (0.72 + 0.28 * Math.max(dmg, 0));
      const by = sy[i];
      const fx = (lx: number) => bx + lx * sc;
      const fy = (lh: number) => by - lh * sc;
      path.addRRect(Skia.RRectXY(Skia.XYWHRect(fx(-12), fy(25), 24 * sc, 25 * sc), 3 * sc, 3 * sc));
      path.addRRect(Skia.RRectXY(Skia.XYWHRect(fx(-31), fy(29), 9 * sc, 9 * sc), 2 * sc, 2 * sc));
      path.addRRect(Skia.RRectXY(Skia.XYWHRect(fx(22), fy(29), 9 * sc, 9 * sc), 2 * sc, 2 * sc));
      path.addRRect(Skia.RRectXY(Skia.XYWHRect(fx(-5.5), fy(55), 11 * sc, 10 * sc), 2 * sc, 2 * sc));
      path.addRRect(Skia.RRectXY(Skia.XYWHRect(fx(-5), fy(83), 10 * sc, 8 * sc), 2 * sc, 2 * sc));
    }
    return path.detach();
  });

  // the red X brace across the barn door. Its own STROKED layer because it
  // has to be barn-red ON the cream door: as part of the body path it would
  // pick up the ink outline and turn to mud at small scale.
  const barnBrace = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const sx = world.sx.value, sy = world.sy.value;
    const stype = world.stype.value, salive = world.salive.value;
    const shp = world.shp.value, shpMax = world.shpMax.value;
    for (let i = 0; i < salive.length; i++) {
      if (salive[i] === 0 || stype[i] !== BARN_TYPE) continue;
      const dmg = shpMax[i] > 0 ? shp[i] / shpMax[i] : 1;
      const [bx, p] = project(sx[i], sy[i]);
      const sc = p * (0.72 + 0.28 * Math.max(dmg, 0));
      const by = sy[i];
      const fx = (lx: number) => bx + lx * sc;
      const fy = (lh: number) => by - lh * sc;
      path.moveTo(fx(-9), fy(3));
      path.lineTo(fx(9), fy(22));
      path.moveTo(fx(9), fy(3));
      path.lineTo(fx(-9), fy(22));
    }
    return path.detach();
  });

  // ================= cute pasture cow: extra layers =================
  // The cow's WHITE silhouette (torso, legs, head, ears, horns, snout, udder,
  // tail) is drawn generically by useStructurePath's COW_TYPE branch above +
  // the STRUCTURE_ORDER.map() JSX loop, same as every other prop. These
  // layers paint the rest of the holstein look ON TOP of that white, in this
  // paint order: the tail (fat dark stroke + thin white stroke) -> the dark
  // OUTLINE, which is just that same body path re-stroked (this is why the
  // horns, ears, snout and udder live in it) -> tan horns, filled then
  // re-stroked -> pink snout/inner-ears/udder, filled then re-stroked (that
  // second stroke is what hides the head circle's outline where it would
  // otherwise run straight across the muzzle) -> black spots, hooves, eyes,
  // nostrils and tail tuft -> eye sparkles -> muzzle smile. Each is its own
  // type-filtered useDerivedValue,
  // the same relationship fencePosts has to the fence's rails. All of them
  // loop over every structure instance (there's normally just one cow, but
  // this stays correct if that ever changes) and recompute `sc` (depth *
  // damage-shrink) exactly the way the body branch does, so the whole cow
  // shrinks as one piece while it's being eaten.

  // tan horn triangles — same two triangles the body path already contains,
  // re-filled here in horn color over the white
  const cowHorns = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const sx = world.sx.value, sy = world.sy.value;
    const stype = world.stype.value, salive = world.salive.value;
    const shp = world.shp.value, shpMax = world.shpMax.value;
    for (let i = 0; i < salive.length; i++) {
      if (salive[i] === 0 || stype[i] !== COW_TYPE) continue;
      const dmg = shpMax[i] > 0 ? shp[i] / shpMax[i] : 1;
      const [bx, p] = project(sx[i], sy[i]);
      const sc = p * (0.72 + 0.28 * Math.max(dmg, 0));
      const by = sy[i];
      const px = (lx: number) => bx + lx * sc;
      const py = (lh: number) => by - lh * sc;

      path.moveTo(px(-18.5), py(31.5));
      path.lineTo(px(-21), py(36.5));
      path.lineTo(px(-14.5), py(33));
      path.close();
      path.moveTo(px(-6), py(31.5));
      path.lineTo(px(-3), py(36.5));
      path.lineTo(px(-9.5), py(33));
      path.close();
    }
    return path.detach();
  });

  // the pink bits: snout, inner ears, udder + teats. The snout and udder
  // ovals here are the SAME ovals the body path draws — refilled pink over
  // the white, then re-stroked in the JSX so they keep their outline.
  const cowPink = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const sx = world.sx.value, sy = world.sy.value;
    const stype = world.stype.value, salive = world.salive.value;
    const shp = world.shp.value, shpMax = world.shpMax.value;
    for (let i = 0; i < salive.length; i++) {
      if (salive[i] === 0 || stype[i] !== COW_TYPE) continue;
      const dmg = shpMax[i] > 0 ? shp[i] / shpMax[i] : 1;
      const [bx, p] = project(sx[i], sy[i]);
      const sc = p * (0.72 + 0.28 * Math.max(dmg, 0));
      const by = sy[i];
      const px = (lx: number) => bx + lx * sc;
      const py = (lh: number) => by - lh * sc;

      path.addOval(Skia.XYWHRect(px(-21.5), py(22), 12 * sc, 8 * sc)); // snout
      path.addOval(Skia.XYWHRect(px(-23.5), py(29), 6 * sc, 3.5 * sc)); // inner ear (near)
      path.addOval(Skia.XYWHRect(px(-5.5), py(29), 6 * sc, 3.5 * sc)); // inner ear (far)
      path.addOval(Skia.XYWHRect(px(12), py(15), 10 * sc, 7 * sc)); // udder
      path.addCircle(px(14.5), py(7.8), 1.4 * sc); // teats
      path.addCircle(px(19.5), py(7.8), 1.4 * sc);
    }
    return path.detach();
  });

  const cowMarkings = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const sx = world.sx.value, sy = world.sy.value;
    const stype = world.stype.value, salive = world.salive.value;
    const shp = world.shp.value, shpMax = world.shpMax.value;
    for (let i = 0; i < salive.length; i++) {
      if (salive[i] === 0 || stype[i] !== COW_TYPE) continue;
      const dmg = shpMax[i] > 0 ? shp[i] / shpMax[i] : 1;
      const [bx, p] = project(sx[i], sy[i]);
      const sc = p * (0.72 + 0.28 * Math.max(dmg, 0));
      const by = sy[i];
      const px = (lx: number) => bx + lx * sc;
      const py = (lh: number) => by - lh * sc;

      // holstein spots — kept well inside the torso rrect (lx -2..32,
      // lh 12..34, corner radius 9) so they read as markings, not as blobs
      // hanging off the edge
      path.addCircle(px(13), py(27), 4.6 * sc);
      path.addCircle(px(24), py(29), 3.4 * sc);
      path.addCircle(px(9), py(18.5), 3.8 * sc);
      path.addCircle(px(26), py(20), 2.6 * sc);
      // forelock patch between the horns
      path.addCircle(px(-12), py(31), 2.5 * sc);

      // hooves
      for (let k = 0; k < COW_LEG_X.length; k++) {
        const lx = COW_LEG_X[k];
        path.addRect(Skia.XYWHRect(px(lx - 2.9), py(3), 5.8 * sc, 3 * sc));
      }

      // eyes + nostrils + tail tuft
      path.addCircle(px(-16), py(26.5), 2.3 * sc);
      path.addCircle(px(-8), py(26.5), 2.3 * sc);
      path.addCircle(px(-18.5), py(18), 1.1 * sc);
      path.addCircle(px(-13), py(18), 1.1 * sc);
      path.addCircle(px(33.5), py(19), 2.8 * sc);
    }
    return path.detach();
  });

  // tiny sparkle in each eye, painted last over the dark pupils
  const cowHighlights = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const sx = world.sx.value, sy = world.sy.value;
    const stype = world.stype.value, salive = world.salive.value;
    const shp = world.shp.value, shpMax = world.shpMax.value;
    for (let i = 0; i < salive.length; i++) {
      if (salive[i] === 0 || stype[i] !== COW_TYPE) continue;
      const dmg = shpMax[i] > 0 ? shp[i] / shpMax[i] : 1;
      const [bx, p] = project(sx[i], sy[i]);
      const sc = p * (0.72 + 0.28 * Math.max(dmg, 0));
      const by = sy[i];
      const px = (lx: number) => bx + lx * sc;
      const py = (lh: number) => by - lh * sc;

      path.addCircle(px(-16.8), py(27.5), 0.9 * sc);
      path.addCircle(px(-8.8), py(27.5), 0.9 * sc);
    }
    return path.detach();
  });

  // the tail. Deliberately NOT part of the body path: as a filled polyline it
  // needed one quad per segment, and the quads left visible notches at the
  // joints. Here it's a plain 3-segment polyline that the JSX strokes TWICE —
  // a fat dark stroke, then a thinner white one on top — which gives a clean
  // outlined whip with round joins for free.
  const cowTail = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const sx = world.sx.value, sy = world.sy.value;
    const stype = world.stype.value, salive = world.salive.value;
    const shp = world.shp.value, shpMax = world.shpMax.value;
    for (let i = 0; i < salive.length; i++) {
      if (salive[i] === 0 || stype[i] !== COW_TYPE) continue;
      const dmg = shpMax[i] > 0 ? shp[i] / shpMax[i] : 1;
      const [bx, p] = project(sx[i], sy[i]);
      const sc = p * (0.72 + 0.28 * Math.max(dmg, 0));
      const by = sy[i];
      const px = (lx: number) => bx + lx * sc;
      const py = (lh: number) => by - lh * sc;

      path.moveTo(px(31), py(32));
      path.lineTo(px(34.5), py(35));
      path.lineTo(px(36.5), py(31));
      path.lineTo(px(36), py(25));
      path.lineTo(px(34), py(21));
    }
    return path.detach();
  });

  // small stroked smile on the snout, same addArc(20deg, 140deg sweep) as the
  // tornado's own relaxed-face mouth
  const cowMouth = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const sx = world.sx.value, sy = world.sy.value;
    const stype = world.stype.value, salive = world.salive.value;
    const shp = world.shp.value, shpMax = world.shpMax.value;
    for (let i = 0; i < salive.length; i++) {
      if (salive[i] === 0 || stype[i] !== COW_TYPE) continue;
      const dmg = shpMax[i] > 0 ? shp[i] / shpMax[i] : 1;
      const [bx, p] = project(sx[i], sy[i]);
      const sc = p * (0.72 + 0.28 * Math.max(dmg, 0));
      const by = sy[i];
      const px = (lx: number) => bx + lx * sc;
      const py = (lh: number) => by - lh * sc;

      const mw = 7 * sc, mh = 5 * sc;
      const mcx = px(-15.5), mcy = py(16.5);
      path.addArc(Skia.XYWHRect(mcx - mw / 2, mcy - mh / 2, mw, mh), 20, 140);
    }
    return path.detach();
  });

  // ================= funnel body =================
  // ---- ONE continuous silhouette: up the left edge, over the top rim, down the
  // right edge, around the base. Filled solid, this is the single cohesive body
  // that everything else shades. (Previously this was 17 separate floating ovals,
  // which is exactly what read as "disjointed".) ----
  const funnelBodyPath = () => {
    'worklet';
    const { bx, pb, baseY, swayX, vscale, s, flat } = funnelFrame();
    const path = Skia.PathBuilder.Make();
    const N = 24;
    for (let i = 0; i <= N; i++) {
      const [cx, cy, rr] = coneAt(i / N, bx, pb, baseY, swayX, vscale, s);
      if (i === 0) path.moveTo(cx - rr, cy);
      else path.lineTo(cx - rr, cy);
    }
    // over the top rim (upper half of the top ellipse: 180deg -> 360deg passes the top)
    const [tcx, tcy, trr] = coneAt(1, bx, pb, baseY, swayX, vscale, s);
    const tryy = trr * flat;
    for (let a = 180; a <= 360; a += 12) {
      const t = (a * Math.PI) / 180;
      path.lineTo(tcx + Math.cos(t) * trr, tcy + Math.sin(t) * tryy);
    }
    for (let i = N; i >= 0; i--) {
      const [cx, cy, rr] = coneAt(i / N, bx, pb, baseY, swayX, vscale, s);
      path.lineTo(cx + rr, cy);
    }
    path.close(); // flat across the tail tip; the ground shadow covers the join
    return path.detach();
  };

  const funnelBody = useDerivedValue(() => {
    world.tick.value;
    return funnelBodyPath();
  });

  // ---- shading ribbons: filled quad-strips wrapping the cone between two
  // heights. Because their start angle is coneAt's own rotation, each ribbon
  // tilts with the twist and they stack into one continuous coil down the body. ----
  const buildBands = (startH: number, sweepDeg: number, offsetDeg: number, thick: number) => {
    'worklet';
    const { bx, pb, baseY, swayX, vscale, s, flat } = funnelFrame();
    const path = Skia.PathBuilder.Make();
    const nb = TUNING.FUNNEL_BANDS;
    const span = (sweepDeg * Math.PI) / 180;
    const off = (offsetDeg * Math.PI) / 180;
    const M = 24;
    for (let b = 0; b < nb; b++) {
      const h0 = startH + (b / nb) * (0.98 - startH);
      const a0 = coneAt(h0, bx, pb, baseY, swayX, vscale, s)[3] + off + b * 0.9;
      // A ribbon wraps around AND climbs at the same time — a true helix. (Drawing
      // it as a strip between two fixed heights tore into jagged triangles.)
      for (let k = 0; k <= M; k++) {
        const u = k / M;
        const [cx, cy, rr] = coneAt(h0 + TUNING.FUNNEL_BAND_RISE * u, bx, pb, baseY, swayX, vscale, s);
        const t = a0 + span * u;
        const x = cx + Math.cos(t) * rr, y = cy + Math.sin(t) * rr * flat;
        if (k === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      for (let k = M; k >= 0; k--) {
        const u = k / M;
        const [cx, cy, rr] = coneAt(
          h0 + TUNING.FUNNEL_BAND_RISE * u - thick, bx, pb, baseY, swayX, vscale, s);
        const t = a0 + span * u;
        path.lineTo(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr * flat);
      }
      path.close();
    }
    // clip the shading to the silhouette: a ribbon's ellipse dips below its own
    // height, so without this it spills past the body edge and breaks the illusion
    // that this is ONE object.
    const bands = path.detach();
    return Skia.Path.MakeFromOp(bands, funnelBodyPath(), PathOp.Intersect) ?? bands;
  };

  const funnelBandsDark = useDerivedValue(() =>
    buildBands(0.1, TUNING.FUNNEL_BAND_SWEEP, 150, TUNING.FUNNEL_BAND_THICK),
  );
  const funnelBandsLight = useDerivedValue(() =>
    buildBands(0.16, TUNING.FUNNEL_BAND_LIGHT_SWEEP, -40, TUNING.FUNNEL_BAND_THICK * 0.7),
  );

  // dark hollow throat at the top opening — sits ON the silhouette's top rim
  const funnelTopCore = useDerivedValue(() => {
    world.tick.value;
    const { bx, pb, baseY, swayX, vscale, s, flat } = funnelFrame();
    const [cx, cy, rr] = coneAt(1, bx, pb, baseY, swayX, vscale, s);
    const r = rr * 0.62;
    const ry = r * flat;
    const path = Skia.PathBuilder.Make();
    path.addOval(Skia.XYWHRect(cx - r, cy - ry * 0.7, r * 2, ry * 2));
    return path.detach();
  });

  // the top opening closes off entirely once the funnel tips away from us
  const throatOpacity = useDerivedValue(() =>
    Math.max(0, viewAmount.value - 0.28) * 0.72,
  );

  // ---- swoosh ribbons: they ORBIT the funnel at SWOOSH_R (wider than the body),
  // so each one is visible in the air on both sides and only disappears across
  // the stretch that passes behind. `side` splits a ribbon into its near half
  // (+1, drawn over the body) and far half (-1, drawn under it) — that
  // pass-behind-and-re-emerge is what makes the funnel read as a 3D object. ----
  const buildSwoosh = (side: number) => {
    'worklet';
    const { bx, pb, baseY, swayX, vscale, s, flat } = funnelFrame();
    const path = Skia.PathBuilder.Make();
    const heights = [0.22, 0.5, 0.8];
    const M = 40;
    for (let bi = 0; bi < heights.length; bi++) {
      const [cx, cy, rr, rot] = coneAt(heights[bi], bx, pb, baseY, swayX, vscale, s);
      const rad = rr * TUNING.SWOOSH_R;
      const a0 = rot + ((200 + bi * 26) * Math.PI) / 180;
      const span = ((TUNING.SWOOSH_SWEEP + hash1(bi * 3.1) * 60) * Math.PI) / 180;
      let run = -1;
      for (let k = 0; k <= M; k++) {
        const t = a0 + span * (k / M);
        // sin > 0 is the near half of the ellipse (below centre), sin < 0 the far half
        const sd = Math.sin(t) >= 0 ? 1 : -1;
        if (sd === side) {
          if (run < 0) run = k;
        } else if (run >= 0) {
          for (let j = run; j <= k - 1; j++) {
            const tj = a0 + span * (j / M);
            const x = cx + Math.cos(tj) * rad, y = cy + Math.sin(tj) * rad * flat;
            if (j === run) path.moveTo(x, y);
            else path.lineTo(x, y);
          }
          run = -1;
        }
      }
      if (run >= 0) {
        for (let j = run; j <= M; j++) {
          const tj = a0 + span * (j / M);
          const x = cx + Math.cos(tj) * rad, y = cy + Math.sin(tj) * rad * flat;
          if (j === run) path.moveTo(x, y);
          else path.lineTo(x, y);
        }
      }
    }
    return path.detach();
  };

  const swooshBack = useDerivedValue(() => buildSwoosh(-1));
  const swooshFront = useDerivedValue(() => buildSwoosh(1));

  const windArcs = useDerivedValue(() => {
    world.tick.value;
    const { bx, pb, swayX, vscale, s, flat } = funnelFrame();
    const [, lift] = agitOffset(pb);
    const cx = bx + swayX * 0.4;
    const cy = world.tornadoY.value - lift * 0.5; // base swirl lifts partway with the funnel
    const path = Skia.PathBuilder.Make();
    for (let k = 0; k < 4; k++) {
      const jitter = hash1(k * 2.3);
      const rad = TUNING.RMAX * (1.3 + 0.5 * k + jitter * 0.18) * pb * vscale;
      const ry = rad * flat;
      const startDeg = (s * (52 + k * 7) * (1 + 0.12 * k) + k * 80 + jitter * 40) % 360;
      const sweep = 110 + hash1(k * 1.7 + 9) * 70; // varying length -> less mechanical
      path.addArc(Skia.XYWHRect(cx - rad, cy - ry, rad * 2, ry * 2), startDeg, sweep);
    }
    return path.detach();
  });

  // ---- ground-hugging dust skirt: swirling grit spread wide around the base,
  // the classic dirt-devil silhouette (a dust column, not just a clean funnel) ----
  const dustSkirt = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const { bx, pb, baseY, swayX, vscale, s, flat } = funnelFrame();
    const funnelR = TUNING.FUNNEL_BASE_R * pb * vscale;
    const n = TUNING.DUST_COUNT;
    for (let i = 0; i < n; i++) {
      const a = hash1(i * 5.13);
      const b = hash1(i * 9.71 + 1);
      const rf = 0.5 + a * TUNING.DUST_SPREAD; // spreads well beyond the funnel base
      const speed = 3.4 + b * 3.2; // grit whips around faster than the funnel body
      const rot = a * 6.28318 + s * speed;
      const bob = Math.max(0, Math.sin(world.tick.value * 0.08 + i * 1.7));
      const rr = funnelR * (1.1 + rf);
      const ry = rr * flat * 1.25;
      const cx = bx + swayX * 0.3 + Math.cos(rot) * rr;
      const cy = baseY - bob * TUNING.FUNNEL_HEIGHT * pb * vscale * 0.12 + Math.sin(rot) * ry;
      const sz = Math.max(0.6, (1 + b * 2.6) * pb * (1.1 - rf * 0.25));
      path.addCircle(cx, cy, sz);
    }
    return path.detach();
  });

  // ---- wind streaks: short tangent speed-lines swept around the funnel surface,
  // selling velocity the way motion lines do ----
  const windStreaks = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.PathBuilder.Make();
    const { bx, pb, baseY, swayX, vscale, s, flat } = funnelFrame();
    const n = TUNING.WIND_STREAK_COUNT;
    for (let i = 0; i < n; i++) {
      const seed = hash1(i + 500);
      const seed2 = hash1(i * 4.4 + 77);
      const h = 0.12 + seed * 0.8;
      // ride the SAME cone the body is built from, just slightly proud of its
      // surface, so the streaks read as wind ON the funnel rather than near it.
      const [ccx, ccy, crr, crot] = coneAt(h, bx, pb, baseY, swayX, vscale, s);
      const rot = crot + seed * 6.28318;
      const rr = crr * (1.02 + seed2 * 0.1);
      const ry = rr * flat;
      const cx = ccx + Math.cos(rot) * rr;
      const cy = ccy + Math.sin(rot) * ry;
      // tangent direction at this point on the ellipse -> the streak follows the flow
      const tdx = -Math.sin(rot), tdy = Math.cos(rot) * flat;
      const len = (7 + seed2 * 15) * pb;
      path.moveTo(cx - tdx * len, cy - tdy * len);
      path.lineTo(cx + tdx * len, cy + tdy * len);
    }
    return path.detach();
  });

  const shadowPath = useDerivedValue(() => {
    world.tick.value;
    const { bx, pb, vscale, flat } = funnelFrame();
    const ty = world.tornadoY.value;
    const rx = TUNING.RMAX * 1.0 * pb * vscale;
    const ry = rx * flat; // the ground circle turns with the same camera angle
    const path = Skia.PathBuilder.Make();
    path.addOval(Skia.XYWHRect(bx - rx, ty - ry, rx * 2, ry * 2));
    return path.detach();
  });

  // ---- the face ----
  const faceGeom = () => {
    'worklet';
    const tx = world.tornadoX.value, ty = world.tornadoY.value;
    const [bx, pb] = project(tx, ty);
    const [, lift] = agitOffset(pb);
    const vscale = TUNING.TORNADO_SCALE * (1 + 0.5 * (world.vmax.value / TUNING.VMAX_CAP));
    // Face sits at a FIXED spot on the funnel: no idle bob AND no horizontal sway,
    // so it never shakes side to side. Only the smooth vertical lift is applied so
    // it still rises with the funnel when it rips out of the ground.
    const faceY = ty - lift - TUNING.FUNNEL_HEIGHT * 0.6 * pb * vscale;
    const eyeDX = 19 * pb * vscale;
    const look = Math.max(-1, Math.min(1, (world.targetX.value - tx) / 60));
    // a little ONE-TIME shake during the first tree pull (introShake secs left),
    // fading out over its final ~0.6s. ripPhase already advances every frame.
    const is = world.introShake.value;
    const shakeX = is > 0 ? Math.sin(ripPhase.value * 1.6) * 5 * pb * Math.min(1, is / 0.6) : 0;
    return { bx: bx + shakeX, faceY, eyeDX, pb, vscale, look };
  };

  // eye openness: 1 normal, squeezed shut while straining, wide on the pop.
  const eyeOpen = () => {
    'worklet';
    return Math.max(0.12, 1 - 0.85 * world.strain.value);
  };

  const faceWhites = useDerivedValue(() => {
    const g = faceGeom();
    const path = Skia.PathBuilder.Make();
    if (world.pop.value > 0.3) return path.detach(); // happy "- -" eyes take over on the pop
    const open = eyeOpen();
    const rx = 13 * g.pb * g.vscale;
    const ry = 15 * g.pb * g.vscale * open; // flattens to a slit when straining
    path.addOval(Skia.XYWHRect(g.bx - g.eyeDX - rx, g.faceY - ry, rx * 2, ry * 2));
    path.addOval(Skia.XYWHRect(g.bx + g.eyeDX - rx, g.faceY - ry, rx * 2, ry * 2));
    return path.detach();
  });

  const facePupils = useDerivedValue(() => {
    const g = faceGeom();
    const path = Skia.PathBuilder.Make();
    if (world.pop.value > 0.3) return path.detach(); // no pupils during the happy "- -" eyes
    const open = eyeOpen();
    if (open < 0.4) return path.detach(); // eyes squeezed shut -> no pupils
    const r = 6 * g.pb * g.vscale * Math.min(1.15, open);
    const ox = g.look * 5 * g.pb, oy = 3 * g.pb;
    path.addCircle(g.bx - g.eyeDX + ox, g.faceY + oy, r);
    path.addCircle(g.bx + g.eyeDX + ox, g.faceY + oy, r);
    return path.detach();
  });

  // FACE 😄/😲 happy "- -" (slant) eyes: two dashes shown during the celebration pop
  const faceHappyEyes = useDerivedValue(() => {
    const g = faceGeom();
    const path = Skia.PathBuilder.Make();
    if (world.pop.value <= 0.3) return path.detach();
    const halfW = 10 * g.pb * g.vscale;
    path.moveTo(g.bx - g.eyeDX - halfW, g.faceY);
    path.lineTo(g.bx - g.eyeDX + halfW, g.faceY);
    path.moveTo(g.bx + g.eyeDX - halfW, g.faceY);
    path.lineTo(g.bx + g.eyeDX + halfW, g.faceY);
    return path.detach();
  });

  const faceMouth = useDerivedValue(() => {
    const g = faceGeom();
    const s = world.strain.value, o = world.pop.value;
    const path = Skia.PathBuilder.Make();
    if (o > 0.25) {
      // FACE 😄/😲 celebration (pairs with the "- -" slant eyes): popVariant picks
      // 😲 open-mouth (dash eyes + O) or 😄 grin (dash eyes + big smile) per pop.
      const my = g.faceY + 16 * g.pb * g.vscale;
      if (world.popVariant.value > 0.5) {
        const mw = (30 + 8 * o) * g.pb * g.vscale;
        const mh = (26 + 12 * o) * g.pb * g.vscale;
        path.addOval(Skia.XYWHRect(g.bx - mw / 2, my - mh / 2, mw, mh));
      } else {
        const mw = (40 + 8 * o) * g.pb * g.vscale;
        const mh = (32 + 10 * o) * g.pb * g.vscale;
        path.addArc(Skia.XYWHRect(g.bx - mw / 2, my - mh / 2, mw, mh), 10, 160);
      }
      return path.detach();
    }
    if (s > 0.4) {
      // FACE 😫 straining (slant/slit-eye effort face): an OPEN mouth that grows
      // taller with effort — a grunt/"hnngh". (Below strain 0.4 it's 🙂 smile.)
      const mw = (16 + 6 * s) * g.pb * g.vscale;
      const mh = (10 + 18 * s) * g.pb * g.vscale;
      const my = g.faceY + 18 * g.pb * g.vscale;
      path.addOval(Skia.XYWHRect(g.bx - mw / 2, my - mh / 2, mw, mh));
      return path.detach();
    }
    // FACE 🙂 relaxed/cruising: a normal smile arc
    const mw = 34 * g.pb * g.vscale;
    const mh = 30 * g.pb * g.vscale;
    const my = g.faceY + 20 * g.pb * g.vscale;
    path.addArc(Skia.XYWHRect(g.bx - mw / 2, my - mh / 2, mw, mh), 20, 140);
    return path.detach();
  });

  // FACE 😫 furrowed brows: only appear while the tornado is straining
  const faceBrows = useDerivedValue(() => {
    const g = faceGeom();
    const s = world.strain.value;
    const path = Skia.PathBuilder.Make();
    if (s < 0.15) return path.detach();
    const len = 15 * g.pb * g.vscale;
    const drop = 7 * s * g.pb * g.vscale; // inner ends pull DOWN toward the nose
    const by = g.faceY - 15 * g.pb * g.vscale;
    path.moveTo(g.bx - g.eyeDX - len * 0.5, by - drop * 0.3);
    path.lineTo(g.bx - g.eyeDX + len * 0.5, by + drop);
    path.moveTo(g.bx + g.eyeDX + len * 0.5, by - drop * 0.3);
    path.lineTo(g.bx + g.eyeDX - len * 0.5, by + drop);
    return path.detach();
  });

  // ---- deep dark storm cloud across the top (static; the ominous ceiling) ----
  const cloudBack = useMemo(() => {
    const p = Skia.PathBuilder.Make();
    const baseY = 92;
    p.addRect(Skia.XYWHRect(0, 0, width, baseY));
    const n = 6, r = 44;
    for (let i = 0; i <= n; i++) p.addCircle((i / n) * width, baseY, r);
    return p.detach();
  }, [width]);

  const cloudFront = useMemo(() => {
    const p = Skia.PathBuilder.Make();
    const baseY = 70;
    p.addRect(Skia.XYWHRect(0, 0, width, baseY));
    const n = 7, r = 36;
    for (let i = 0; i <= n; i++) p.addCircle(((i + 0.5) / n) * width, baseY, r);
    return p.detach();
  }, [width]);

  const restart = useCallback(() => {
    resetWorld(world);
    setHud({ ef: -1, wind: TUNING.VMAX_START, timeLeft: TUNING.RUN_SECONDS, debris: 0, running: true });
  }, [world]);

  const efText = hud.ef < 0 ? '—' : EF_LABELS[hud.ef];

  return (
    <View style={styles.root}>
      <GestureDetector gesture={pan}>
        <Canvas style={{ width, height }}>
          <Rect x={0} y={0} width={width} height={height}>
            <LinearGradient
              start={vec(0, 0)}
              end={vec(0, height)}
              colors={['#a9e2f6', '#cfeaf2', '#f6e6be', '#f0d79b']}
              positions={[0, 0.34, 0.62, 1]}
            />
          </Rect>

          {/* rolling hills, far to near. Colors get less hazy and more green
              with each step forward — aerial perspective, the same cue the
              ground gradient above uses. The nearest ridge carries the ground
              gradient because it IS the ground from its ridgeline down; see
              useHillPath for why the layers fill to the canvas bottom. */}
          <Path path={hillPaths[0]} color="#bcd0dd" />
          <Path path={hillPaths[1]} color="#adc4bd" />
          <Path path={hillPaths[2]}>
            <LinearGradient
              start={vec(0, 250)}
              end={vec(0, height)}
              colors={['#d8e4cf', '#f6e6be', '#f0d79b']}
              positions={[0, 0.46, 1]}
            />
          </Path>

          <Path path={propShadows} color="#7a6a49" opacity={0.22} />
          <Path path={fencePosts} color="#5e3320" />
          {STRUCTURE_ORDER.map((key, i) => (
            <Path key={key} path={structurePaths[i]} color={STRUCTURES[key].color} />
          ))}
          {/* cow paint order: tan horns and pink snout/udder land on top of the
              white silhouette, then that SAME silhouette path is re-stroked in
              dark ink so every piece (horns, ears, snout, legs, udder, tail)
              gets the reference art's clean outline, then spots/eyes on top */}
          {/* cow paint order. The white silhouette (drawn by the map above) is
              outlined by re-stroking that SAME path, then the tan horns and
              pink snout/ears/udder are filled over it and re-stroked
              themselves — that second stroke is what hides the head circle's
              outline where it would otherwise run straight across the muzzle.
              Tail goes on first (fat dark stroke + thin white stroke) so it
              tucks behind the rump. */}
          <Path path={cowTail} color="#33291f" style="stroke" strokeWidth={4.2} strokeJoin="round" strokeCap="round" />
          <Path path={cowTail} color="#fdfbf7" style="stroke" strokeWidth={2.4} strokeJoin="round" strokeCap="round" />
          <Path path={structurePaths[COW_TYPE]} color="#33291f" style="stroke" strokeWidth={1.3} strokeJoin="round" />
          <Path path={cowHorns} color="#e8cda2" />
          <Path path={cowHorns} color="#33291f" style="stroke" strokeWidth={1.3} strokeJoin="round" />
          <Path path={cowPink} color="#f4aebd" />
          <Path path={cowPink} color="#33291f" style="stroke" strokeWidth={1.3} strokeJoin="round" />
          <Path path={cowMarkings} color="#2b2320" />
          <Path path={cowHighlights} color="#ffffff" />
          <Path path={cowMouth} color="#8a5a46" style="stroke" strokeWidth={1.4} strokeCap="round" />

          {/* farmstead paint order (see the farm layers above): the silo's
              shading and stave bands land on its cream cylinder, then BOTH
              bodies are re-stroked in the same dark ink the cow uses, then
              the slate roofs, then the cream trim, then the door's red X.
              The bodies are stroked BEFORE the roofs go down so the wall
              outline can't cut across the roof band. */}
          <Path path={siloShade} color="#cdc4b1" />
          <Path path={structurePaths[SILO_TYPE]} color="#33291f" style="stroke" strokeWidth={1.3} strokeJoin="round" />
          <Path path={structurePaths[BARN_TYPE]} color="#33291f" style="stroke" strokeWidth={1.3} strokeJoin="round" />
          <Path path={farmRoofs} color="#5b6875" />
          <Path path={farmRoofs} color="#33291f" style="stroke" strokeWidth={1.3} strokeJoin="round" />
          <Path path={farmTrim} color="#f7f1e3" />
          <Path path={farmTrim} color="#33291f" style="stroke" strokeWidth={1.2} strokeJoin="round" />
          <Path path={barnBrace} color="#c8503f" style="stroke" strokeWidth={2.2} strokeCap="round" />

          {/* storm cloud drawn OVER the props so far ones tuck behind the horizon */}
          <Path path={cloudBack} color="#1e2a35" />
          <Path path={cloudFront} color="#2a3947" />

          <Path path={shadowPath} color="#3b4a55" opacity={0.28} />
          <Path path={windArcs} color="#6b7f92" style="stroke" strokeWidth={2} strokeCap="round" opacity={0.4} />
          <Path path={dustSkirt} color="#9d9384" opacity={0.34} />

          {/* far half of the swoosh ribbons: the body draws OVER these, so each
              ribbon disappears behind the funnel and re-emerges in front */}
          <Path path={swooshBack} color="#b9cedd" style="stroke" strokeWidth={7} strokeJoin="round" strokeCap="round" opacity={0.45} />

          {/* one solid body, then shading that lives ON it — same palette ramp */}
          <Path path={funnelBody} color="#7d93ab" />
          <Path path={funnelBandsDark} color="#4e6579" opacity={0.5} />
          <Path path={funnelBandsLight} color="#b3c5d4" opacity={0.45} />
          <Path path={funnelTopCore} color="#2b3947" opacity={throatOpacity} />

          {/* near half of the swoosh ribbons, over the body */}
          <Path path={swooshFront} color="#eef4f8" style="stroke" strokeWidth={7} strokeJoin="round" strokeCap="round" opacity={0.72} />
          <Path path={windStreaks} color="#dfe9f0" style="stroke" strokeWidth={1.3} strokeCap="round" opacity={0.3} />

          <Path path={faceWhites} color="#ffffff" />
          <Path path={facePupils} color="#232f38" />
          <Path path={faceHappyEyes} color="#232f38" style="stroke" strokeWidth={3.4} strokeCap="round" />
          <Path path={faceMouth} color="#232f38" style="stroke" strokeWidth={3.4} strokeCap="round" />
          <Path path={faceBrows} color="#232f38" style="stroke" strokeWidth={3} strokeCap="round" />

          <Path path={uprootedTrees} color="#5cc25f" />
          <Path path={uprootedFences} color="#c9793f" />
          <Path path={uprootedCows} color="#fdfbf7" />
          <Path path={uprootedCowMarkings} color="#2b2320" />
          <Path path={debrisChunks} color="#6f5c42" />
        </Canvas>
      </GestureDetector>

      <View style={styles.hud} pointerEvents="none">
        <View style={styles.efBox}>
          <Text style={styles.efLabel}>{efText}</Text>
          <Text style={styles.efCaption}>rating</Text>
        </View>
        <View style={styles.stats}>
          <Text style={styles.stat}>{hud.wind} mph peak</Text>
          <Text style={styles.statDim}>{hud.debris} debris aloft</Text>
        </View>
      </View>

      {!hud.running && (
        <View style={styles.overlay}>
          <Text style={styles.overlayTitle}>Roped out</Text>
          <Text style={styles.overlayEf}>
            {efText === '—' ? 'No damage surveyed' : `Final rating: ${efText}`}
          </Text>
          <Pressable style={styles.button} onPress={restart}>
            <Text style={styles.buttonText}>New run</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#a9e2f6' },
  hud: {
    position: 'absolute', top: 150, left: 20, right: 20,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
  },
  efBox: { alignItems: 'flex-start' },
  efLabel: { color: '#22333d', fontSize: 46, fontWeight: '800', letterSpacing: 1 },
  efCaption: { color: '#5a6b73', fontSize: 12, marginTop: -6, letterSpacing: 2, textTransform: 'uppercase' },
  stats: { alignItems: 'flex-end' },
  stat: { color: '#2b3d47', fontSize: 16, fontWeight: '700' },
  statDim: { color: '#63737b', fontSize: 13, marginTop: 2 },
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(248,235,201,0.86)', alignItems: 'center', justifyContent: 'center',
  },
  overlayTitle: { color: '#22333d', fontSize: 30, fontWeight: '800' },
  overlayEf: { color: '#4a5a63', fontSize: 17, marginTop: 8 },
  button: {
    marginTop: 26, backgroundColor: '#ef7d4e', paddingHorizontal: 30, paddingVertical: 13, borderRadius: 30,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});

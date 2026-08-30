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
import { Canvas, Rect, LinearGradient, Path, Skia, vec } from '@shopify/react-native-skia';
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

const PROP_W = [34, 58, 52, 34];

export default function TornadoGame({ width, height }: Props) {
  // World is wider than the screen so there's scene to scroll into.
  const WORLD_W = width * 2.2;
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
          const p = 1 - K + K * (e.y / H);
          const camX = Math.max(0, Math.min(camMax, world.tornadoX.value - width / 2));
          world.targetX.value = camX + cxScreen + (e.x - cxScreen) / p;
          world.targetY.value = e.y;
        })
        .onChange((e) => {
          'worklet';
          const p = 1 - K + K * (e.y / H);
          const camX = Math.max(0, Math.min(camMax, world.tornadoX.value - width / 2));
          world.targetX.value = camX + cxScreen + (e.x - cxScreen) / p;
          world.targetY.value = e.y;
        }),
    [world, H, K, cxScreen, camMax, width],
  );

  // ================= projection =================
  // Fold camera + perspective into one place. Returns [screenX, depthScale p].
  // Height is applied by the caller as sy = gy - gz * p.
  const project = (gx: number, gy: number) => {
    'worklet';
    const p = 1 - K + K * (gy / H);
    const camX = Math.max(0, Math.min(camMax, world.tornadoX.value - width / 2));
    return [cxScreen + (gx - camX - cxScreen) * p, p] as const;
  };

  // ---- debris ----
  const debrisPath = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.Path.Make();
    const dx = world.dx.value, dy = world.dy.value, ds = world.dsize.value;
    const dz = world.dz.value, alive = world.dalive.value;
    for (let i = 0; i < alive.length; i++) {
      if (alive[i] === 0) continue;
      const [sx, p] = project(dx[i], dy[i]);
      path.addCircle(sx, dy[i] - dz[i] * p, ds[i] * p);
    }
    return path;
  });

  const debrisStreaks = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.Path.Make();
    const dx = world.dx.value, dy = world.dy.value;
    const dvx = world.dvx.value, dvy = world.dvy.value;
    const dz = world.dz.value, alive = world.dalive.value;
    const lag = 0.05;
    for (let i = 0; i < alive.length; i++) {
      if (alive[i] === 0) continue;
      const gx0 = dx[i] - dvx[i] * lag, gy0 = dy[i] - dvy[i] * lag;
      const [sx0, p0] = project(gx0, gy0);
      const [sx1, p1] = project(dx[i], dy[i]);
      path.moveTo(sx0, gy0 - dz[i] * p0);
      path.lineTo(sx1, dy[i] - dz[i] * p1);
    }
    return path;
  });

  // ---- cute prop billboards ----
  const useStructurePath = (typeIndex: number) =>
    useDerivedValue(() => {
      world.tick.value;
      const path = Skia.Path.Make();
      const sx = world.sx.value, sy = world.sy.value;
      const stype = world.stype.value, salive = world.salive.value;
      const shp = world.shp.value, shpMax = world.shpMax.value;
      for (let i = 0; i < salive.length; i++) {
        if (salive[i] === 0 || stype[i] !== typeIndex) continue;
        const dmg = shpMax[i] > 0 ? shp[i] / shpMax[i] : 1;
        const [bx, p] = project(sx[i], sy[i]);
        const sc = p * (0.72 + 0.28 * Math.max(dmg, 0));
        const by = sy[i];
        if (typeIndex === 0) {
          const R = 20 * sc, trunk = 16 * sc;
          // sway: the tree bends toward the tornado, harder when the wind is near,
          // plus a gentle per-tree shimmer so the grove is always breathing.
          const rdx = world.tornadoX.value - sx[i];
          const rdy = world.tornadoY.value - sy[i];
          const dist = Math.sqrt(rdx * rdx + rdy * rdy) || 1;
          const strength = Math.min(1, (world.vmax.value * 1.3) / dist);
          const wob = 1 + 0.12 * Math.sin(world.tick.value * 0.12 + i);
          const lean = 24 * strength * wob * p;
          const lx = (rdx / dist) * lean;
          const ly = (rdy / dist) * lean * 0.4;
          const tw = 4 * sc;
          const tX = bx + lx * 0.55, tY = by - trunk + ly * 0.55; // leaned trunk top
          // trunk as a bent quad rooted at the ground
          path.moveTo(bx - tw, by);
          path.lineTo(bx + tw, by);
          path.lineTo(tX + tw, tY);
          path.lineTo(tX - tw, tY);
          path.close();
          // canopy leans a little further than the trunk top
          path.addCircle(bx + lx, by - (trunk + R * 0.7) + ly, R);
        } else if (typeIndex === 1) {
          const w = 58 * sc, h = 30 * sc;
          path.addRRect(Skia.RRectXY(Skia.XYWHRect(bx - w / 2, by - h, w, h), 8 * sc, 8 * sc));
        } else if (typeIndex === 2) {
          const w = 52 * sc, bh = 34 * sc, rh = 24 * sc;
          path.addRect(Skia.XYWHRect(bx - w / 2, by - bh, w, bh));
          path.moveTo(bx - w / 2 - 3 * sc, by - bh);
          path.lineTo(bx, by - bh - rh);
          path.lineTo(bx + w / 2 + 3 * sc, by - bh);
          path.close();
        } else {
          const w = 34 * sc, bh = 56 * sc;
          path.addRect(Skia.XYWHRect(bx - w / 2, by - bh, w, bh));
          path.addCircle(bx, by - bh, w / 2);
        }
      }
      return path;
    });

  const structurePaths = [
    useStructurePath(0),
    useStructurePath(1),
    useStructurePath(2),
    useStructurePath(3),
  ];

  const propShadows = useDerivedValue(() => {
    world.tick.value;
    const path = Skia.Path.Make();
    const sx = world.sx.value, sy = world.sy.value;
    const stype = world.stype.value, salive = world.salive.value;
    const shp = world.shp.value, shpMax = world.shpMax.value;
    for (let i = 0; i < salive.length; i++) {
      if (salive[i] === 0) continue;
      const dmg = shpMax[i] > 0 ? shp[i] / shpMax[i] : 1;
      const [bx, p] = project(sx[i], sy[i]);
      const sc = p * (0.72 + 0.28 * Math.max(dmg, 0));
      const rx = (PROP_W[stype[i]] / 2) * sc * 1.15;
      const ry = rx * 0.4;
      path.addOval(Skia.XYWHRect(bx - rx, sy[i] - ry, rx * 2, ry * 2));
    }
    return path;
  });

  // ---- funnel ----
  const buildStrands = (strandCount: number, phaseOffset: number, speed: number) => {
    'worklet';
    const s = world.spin.value;
    const [bx, pb] = project(world.tornadoX.value, world.tornadoY.value);
    const ty = world.tornadoY.value;
    const vscale = 1 + 0.5 * (world.vmax.value / TUNING.VMAX_CAP);
    const samples = 30;
    const path = Skia.Path.Make();
    for (let st = 0; st < strandCount; st++) {
      const phase = phaseOffset + (st / strandCount) * 6.28318;
      for (let j = 0; j < samples; j++) {
        const h = j / (samples - 1);
        const ringY = ty - h * TUNING.FUNNEL_HEIGHT * pb * vscale;
        const rr =
          (TUNING.FUNNEL_BASE_R + (TUNING.FUNNEL_TOP_R - TUNING.FUNNEL_BASE_R) * h) * pb * vscale;
        const ry = rr * TUNING.RING_FLATTEN;
        const rot = phase + h * TUNING.FUNNEL_TWIST + s * speed;
        const x = bx + Math.cos(rot) * rr;
        const y = ringY + Math.sin(rot) * ry;
        if (j === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
    }
    return path;
  };

  const funnelBack = useDerivedValue(() => buildStrands(7, 0, 1.9));
  const funnelFront = useDerivedValue(() => buildStrands(6, 0.5, 2.25));

  const windArcs = useDerivedValue(() => {
    const s = world.spin.value;
    const [bx, pb] = project(world.tornadoX.value, world.tornadoY.value);
    const ty = world.tornadoY.value;
    const vscale = 1 + 0.5 * (world.vmax.value / TUNING.VMAX_CAP);
    const path = Skia.Path.Make();
    for (let k = 0; k < 3; k++) {
      const rad = TUNING.RMAX * (1.35 + 0.5 * k) * pb * vscale;
      const ry = rad * TUNING.RING_FLATTEN;
      const startDeg = (s * 55 * (1 + 0.12 * k) + k * 80) % 360;
      path.addArc(Skia.XYWHRect(bx - rad, ty - ry, rad * 2, ry * 2), startDeg, 150);
    }
    return path;
  });

  const shadowPath = useDerivedValue(() => {
    world.tick.value;
    const [bx, pb] = project(world.tornadoX.value, world.tornadoY.value);
    const ty = world.tornadoY.value;
    const vscale = 1 + 0.5 * (world.vmax.value / TUNING.VMAX_CAP);
    const rx = TUNING.RMAX * 1.0 * pb * vscale;
    const ry = rx * TUNING.RING_FLATTEN;
    const path = Skia.Path.Make();
    path.addOval(Skia.XYWHRect(bx - rx, ty - ry, rx * 2, ry * 2));
    return path;
  });

  // ---- the face ----
  const faceGeom = () => {
    'worklet';
    const tx = world.tornadoX.value, ty = world.tornadoY.value;
    const [bx, pb] = project(tx, ty);
    const vscale = 1 + 0.5 * (world.vmax.value / TUNING.VMAX_CAP);
    const bob = Math.sin(world.spin.value * 0.6) * 3 * pb;
    const faceY = ty - TUNING.FUNNEL_HEIGHT * 0.6 * pb * vscale + bob;
    const eyeDX = 19 * pb * vscale;
    const look = Math.max(-1, Math.min(1, (world.targetX.value - tx) / 60));
    return { bx, faceY, eyeDX, pb, vscale, look };
  };

  const faceWhites = useDerivedValue(() => {
    const g = faceGeom();
    const path = Skia.Path.Make();
    const rx = 13 * g.pb * g.vscale, ry = 15 * g.pb * g.vscale;
    path.addOval(Skia.XYWHRect(g.bx - g.eyeDX - rx, g.faceY - ry, rx * 2, ry * 2));
    path.addOval(Skia.XYWHRect(g.bx + g.eyeDX - rx, g.faceY - ry, rx * 2, ry * 2));
    return path;
  });

  const facePupils = useDerivedValue(() => {
    const g = faceGeom();
    const path = Skia.Path.Make();
    const r = 6 * g.pb * g.vscale;
    const ox = g.look * 5 * g.pb, oy = 3 * g.pb;
    path.addCircle(g.bx - g.eyeDX + ox, g.faceY + oy, r);
    path.addCircle(g.bx + g.eyeDX + ox, g.faceY + oy, r);
    return path;
  });

  const faceMouth = useDerivedValue(() => {
    const g = faceGeom();
    const path = Skia.Path.Make();
    const mw = 34 * g.pb * g.vscale, mh = 30 * g.pb * g.vscale;
    const my = g.faceY + 20 * g.pb * g.vscale;
    path.addArc(Skia.XYWHRect(g.bx - mw / 2, my - mh / 2, mw, mh), 20, 140);
    return path;
  });

  // ---- deep dark storm cloud across the top (static; the ominous ceiling) ----
  const cloudBack = useMemo(() => {
    const p = Skia.Path.Make();
    const baseY = 92;
    p.addRect(Skia.XYWHRect(0, 0, width, baseY));
    const n = 6, r = 44;
    for (let i = 0; i <= n; i++) p.addCircle((i / n) * width, baseY, r);
    return p;
  }, [width]);

  const cloudFront = useMemo(() => {
    const p = Skia.Path.Make();
    const baseY = 70;
    p.addRect(Skia.XYWHRect(0, 0, width, baseY));
    const n = 7, r = 36;
    for (let i = 0; i <= n; i++) p.addCircle(((i + 0.5) / n) * width, baseY, r);
    return p;
  }, [width]);

  const restart = useCallback(() => {
    resetWorld(world);
    setHud({ ef: -1, wind: TUNING.VMAX_START, timeLeft: TUNING.RUN_SECONDS, debris: 0, running: true });
  }, [world]);

  const timePct = Math.max(0, Math.min(1, hud.timeLeft / TUNING.RUN_SECONDS));
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

          <Path path={propShadows} color="#7a6a49" opacity={0.22} />
          {STRUCTURE_ORDER.map((key, i) => (
            <Path key={key} path={structurePaths[i]} color={STRUCTURES[key].color} />
          ))}

          {/* storm cloud drawn OVER the props so far ones tuck behind the horizon */}
          <Path path={cloudBack} color="#1e2a35" />
          <Path path={cloudFront} color="#2a3947" />

          <Path path={shadowPath} color="#3b4a55" opacity={0.28} />
          <Path path={windArcs} color="#6b7f92" style="stroke" strokeWidth={2} strokeCap="round" opacity={0.4} />

          <Path path={funnelBack} color="#7d93ab" style="stroke" strokeWidth={3.4} strokeJoin="round" strokeCap="round" opacity={0.55} />
          <Path path={funnelFront} color="#33465e" style="stroke" strokeWidth={2} strokeJoin="round" strokeCap="round" opacity={0.85} />

          <Path path={faceWhites} color="#ffffff" />
          <Path path={facePupils} color="#232f38" />
          <Path path={faceMouth} color="#232f38" style="stroke" strokeWidth={3.4} strokeCap="round" />

          <Path path={debrisStreaks} color="#8a765a" style="stroke" strokeWidth={1.6} strokeCap="round" opacity={0.5} />
          <Path path={debrisPath} color="#6f5c42" style="fill" />
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

      <View style={styles.timerTrack} pointerEvents="none">
        <View style={[styles.timerFill, { width: `${timePct * 100}%` }]} />
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
  timerTrack: {
    position: 'absolute', bottom: 34, left: 20, right: 20, height: 7,
    borderRadius: 4, backgroundColor: '#e7d3a6', overflow: 'hidden',
  },
  timerFill: { height: 7, backgroundColor: '#ef7d4e' },
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

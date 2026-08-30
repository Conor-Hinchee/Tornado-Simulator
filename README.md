# Tornado Simulator

A React Native (Expo) game where **you are the tornado**. Drag to steer. You
have 150 seconds per run before you rope out. Your EF rating is the worst thing
you've flattened — just like real meteorology, where EF is assigned from
surveyed damage, not measured wind.

## Stack

- **Expo SDK 57** / React Native 0.86 / React 19 (New Architecture)
- **@shopify/react-native-skia** — canvas rendering, one draw call for all debris
- **react-native-reanimated 4** + **react-native-worklets** — the physics loop
  runs on the UI thread via `useFrameCallback`, so it never touches the JS bridge
- **react-native-gesture-handler** — drag-to-steer

## Run it

```bash
npm install          # installs Skia's native libs against your real disk
npx expo run:ios     # or: npx expo run:android
```

`npx expo start` + Expo Go will NOT work — Skia and Reanimated worklets need a
native build (a dev client). Use `expo run:ios` / `expo run:android`, or build a
dev client with EAS.

## How it works

Everything lives in `src/`:

- **`engine/model.ts`** — structure types, EF bands, and every tunable constant
  in one `TUNING` object. Start here to change the feel.
- **`engine/state.ts`** — the world as struct-of-arrays inside Reanimated shared
  values (cache-friendly, cheap to hand to a worklet). `resetWorld` scatters a
  fresh field.
- **`engine/simulation.ts`** — the physics, all worklets:
  - **Rankine combined vortex**: tangential wind rises linearly to `Vmax` at the
    core edge, then decays as `1/r` outside it.
  - **Updraft** peaks *just outside* the core, so debris spirals out and up
    instead of collapsing to the center.
  - **Mass-dependent coupling**: light debris snaps into the flow, heavy debris
    lumbers.
  - **Wind thresholds, not HP gates**: a structure below its `breakWind` takes
    zero damage. A house (112 mph) literally ignores you until you've eaten
    enough trailers to raise `Vmax`. The physics *is* the progression.
- **`components/TornadoGame.tsx`** — Skia canvas, the `useFrameCallback` loop,
  the pan gesture, and a HUD that reads scalars at ~7Hz (off the hot path).

## Progression loop

Start at 70 mph → trees (65) fall → eat their debris → `Vmax` climbs → trailers
(86) fall → houses (112) → grain silos (136). No XP bar, no unlock screen.

## Known weak spot (build this next)

Destruction is currently instant: a structure pops into debris. The real payoff
is a house that **sheds its roof as a separate object, then walls, then slab**.
That's the thing that will tell you whether this is a weekend or a season.

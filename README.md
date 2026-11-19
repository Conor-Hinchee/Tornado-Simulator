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

Start at 70 mph → cows (35), fences (50) and trees (65) fall → eat their debris
→ `Vmax` climbs → the town's mobile homes (86 mph) and the farmstead pickup
truck (100 mph), EF1 → houses (112) and the barn (120), EF2 → the grain silo
(136) and the general store (150), EF3 → the town water tower (175 mph), EF4.
No XP bar, no unlock screen.

## The field

A grove of trees, two fenced pastures with a herd each, the farmstead (truck,
barn, silo) beside one pasture, and a small town beside the other: two mobile
homes on the pasture end, four houses in three paint colors on two streets, and
the general store and water tower at the far end. The town is drawn
`TOWN_SCALE` (1.6x) up from its art units so it reads at barn scale next to the
chunky cows, and its back row is painted before its front row so the rows
overlap correctly. It's placed before the farmstead (it's the hard one to fit:
~500 units wide), box-tested against the corrals, the tornado's start and the
world edges; the farm then works around it.

Big structures (breakWind ≥ `BIG_BREAK`, 118: barn, silo, store, water tower)
are a real wrestle: the strain face shows at any wind speed, ripping one up
always pops the "big O" and kicks the scene with a double jolt (two thumps,
each with a heavy haptic hit), and each tumbles through the funnel as a mini version of itself before
bursting into its own colored debris (red barn planks, cream silo shards,
brick from the store, steel from the tower).
The truck isn't "big", but it rocks on its suspension while the wind works on
it and tumbles as a whole pickup before bursting into blue panels.

## Haptics

`expo-haptics` (native module: adding it needs a rebuild). The sim only raises
flags (`world.thud` on each uproot, `quake`, `strain`, `maxEF`) and the frame
callback turns them into taps, rate-limited by `HAPTIC_GAP`: a light tap per
small uproot, a medium knock for mobile homes, houses and the truck, a heavy
hit on each of the two jolts for a big structure, a soft tug that speeds up with the
strain face, and a success buzz on each new EF rating.

## Known weak spot (build this next)

Destruction is currently instant: a structure pops into debris. The real payoff
is a house that **sheds its roof as a separate object, then walls, then slab**.
That's the thing that will tell you whether this is a weekend or a season.

# Kitchen Clash

An arcade-style 3D pickleball game for the browser (TypeScript + Vite + Three.js).
Part of [Augustine's Arcade](https://augustinesarcade.com).

## Run it

```sh
npm install
npm run dev        # opens http://localhost:5173
```

- `npm run build`: typecheck and build for production into `dist/`
- `npx tsx tools/sim/practice-sim.ts [seconds] [timingNoise]`: headless bot-vs-bot rally simulation with stats
- `npm run models`: rebuild the 3D models in `public/models/` from the Blender scripts in `tools/blender/` (needs Blender; set `BLENDER=/path/to/blender` if it's not in `/Applications`)

## Code layout

| Folder | What's in it |
| --- | --- |
| `src/game` | Game loop, court dimensions |
| `src/physics` | Ball flight (gravity, drag, spin), bounces, net collision, shot solver |
| `src/render` | Stylized rendering (PBR materials, AO, outlines), court, crowd, procedural textures |
| `src/camera` | Arcade camera |
| `src/input` | Keyboard + gamepad |
| `src/players` | Player movement, Blender model + procedural animation, swings, shot selection, timing |
| `src/ai` | Computer players (phase 2 practice bot) |
| `src/ui` | HUD and pop-up messages |
| `src/debug` | Ball Lab test harness |
| `tools/blender` | Python scripts that build the `.glb` models in Blender |

## Debug URL options

- `?lab`: Ball Lab (fire preset shots to test physics); add `&auto` for an auto rally
- `?autoplay`: a bot plays your side too
- `?warp=6`: fast-forward 6 seconds before the first frame (for screenshots)
- `?hifx`: add ambient occlusion (soft contact shadows); needs a strong GPU

# Pickle Pop!

An arcade-style 3D pickleball game for the browser (TypeScript + Vite + Three.js).
Part of [Augustine's Arcade](https://augustinesarcade.com).

## Run it

```sh
npm install
npm run dev        # opens http://localhost:5173
```

- `npm run build`: typecheck and build for production into `dist/`
- `npm run models`: rebuild the 3D models in `public/models/` from the Blender scripts in `tools/blender/` (needs Blender; set `BLENDER=/path/to/blender` if it's not in `/Applications`)

## Code layout

| Folder | What's in it |
| --- | --- |
| `src/game` | Game loop, court dimensions |
| `src/physics` | Ball flight (gravity, drag, spin), bounces, net collision, shot solver |
| `src/render` | Cartoon (cel-shaded + outlined) rendering, court and ball visuals |
| `src/camera` | Arcade camera |
| `src/input` | Keyboard (gamepad in phase 2) |
| `src/ui` | HUD and pop-up messages |
| `src/debug` | Ball Lab test harness |
| `tools/blender` | Python scripts that build the `.glb` models in Blender |

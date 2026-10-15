// Rebuilds the game's .glb models by running the Blender scripts in tools/blender headlessly.
// Usage: npm run models   (set BLENDER=/path/to/blender if it isn't in the default macOS spot)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const candidates = [process.env.BLENDER, '/Applications/Blender.app/Contents/MacOS/Blender'].filter(Boolean);
const blender = candidates.find((c) => existsSync(c)) ?? 'blender';

const jobs = [['tools/blender/build_court.py', 'public/models/court.glb']];

mkdirSync('public/models', { recursive: true });
for (const [script, out] of jobs) {
  console.log(`\n▶ ${script} → ${out}`);
  const r = spawnSync(blender, ['-b', '--factory-startup', '--python-exit-code', '1', '-P', script, '--', resolve(out)], {
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

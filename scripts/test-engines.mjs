// Runs every game's own engine tests (web/<game>/test/*.test.mjs), one after another.
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

let failed = 0;
for (const game of readdirSync('web')) {
  const dir = join('web', game, 'test');
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.test.mjs'))) {
    const path = join(dir, file);
    process.stdout.write(`\n▶ ${path}\n`);
    const res = spawnSync(process.execPath, [path], { stdio: 'inherit' });
    if (res.status !== 0) failed++;
  }
}
if (failed) {
  console.error(`\n${failed} engine test file(s) failed`);
  process.exit(1);
}

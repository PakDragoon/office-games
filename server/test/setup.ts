import { applyD1Migrations, env } from 'cloudflare:test';
import { afterAll } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Rooms tell their Lobby about changes in the background (ctx.waitUntil). Give those calls a moment to land
// before vitest tears the runtime down, or a pending one fails the run with EnvironmentTeardownError.
afterAll(() => new Promise<void>((resolve) => setTimeout(resolve, 500)));

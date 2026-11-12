import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, SERVER_SECRET: 'test-secret' } },
      }),
    ],
    test: {
      include: ['server/test/**/*.test.ts'],
      setupFiles: ['server/test/setup.ts'],
    },
  };
});

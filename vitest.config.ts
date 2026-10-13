import { defineConfig } from 'vitest/config'

// DSH_LEGACY=1: the 0.2.0-rc.x line has no managed activations or working-directory service,
// so the real-runtime integration suite (which drives them) is covered by the headless e2e instead.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: process.env.DSH_LEGACY ? ['test/dsh-integration.test.ts'] : [],
    testTimeout: 20000,
  },
})

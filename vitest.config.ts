import path from 'node:path'
import { defineConfig } from 'vitest/config'

const projectRoot = import.meta.dirname

// Same aliases as vite.config.ts and tsconfig.json `paths`. The test config is
// separate from vite.config.ts on purpose: tests must not run the React
// Compiler Babel pass or the dev-server proxy plugins.
const aliases = {
  '@core': path.resolve(projectRoot, 'src/core'),
  '@modules': path.resolve(projectRoot, 'src/modules'),
  '@ui': path.resolve(projectRoot, 'src/ui'),
  '@admin': path.resolve(projectRoot, 'src/admin'),
  '@site': path.resolve(projectRoot, 'src/admin/pages/site'),
  '@content': path.resolve(projectRoot, 'src/admin/pages/content'),
  '@plugins': path.resolve(projectRoot, 'src/admin/pages/plugins'),
  '@users': path.resolve(projectRoot, 'src/admin/pages/users'),
}

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: ['{server,src,scripts}/**/*.test.{ts,tsx}'],
    // The happy-dom globals are installed by the setup file (see its header),
    // so every file runs in the plain Node environment.
    environment: 'node',
    setupFiles: ['./src/__tests__/setup.ts'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'json'],
      reportsDirectory: '.coverage',
      include: ['server/**', 'src/**'],
    },
  },
})

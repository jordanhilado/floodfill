import { defineConfig } from 'vitest/config'

// Kept separate from vite.config.ts so unit tests run in plain Node without the Workers runtime.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })

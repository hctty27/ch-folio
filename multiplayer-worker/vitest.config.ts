import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: {
                configPath: './wrangler.jsonc',
            },
            miniflare: {
                compatibilityDate: '2026-07-29',
                bindings: {
                    AUTHORITATIVE_BENCHMARK_TOKEN: 'task-18-worker-test-secret-at-least-32-chars',
                },
            },
        }),
    ],
    test: {
        include: [ 'test/**/*.test.ts' ],
    },
})

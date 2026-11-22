import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.mjs'],
        passWithNoTests: false,
        allowOnly: false,
        coverage: {
            provider: 'v8',
            include: ['api/**/*.js', 'config.js', 'index.js', 'mongo.js', 'reddit*.js'],
            reporter: ['text', 'html', 'json-summary'],
            thresholds: {
                statements: 90,
                branches: 90,
                functions: 93,
                lines: 90,
            },
        },
    },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No specific pool or wrangler configuration needed for standard Node.js environment
    // You can add other Vitest options here if you need them, e.g.:
    // globals: true,
    // environment: 'node', // This is usually the default if not specified
  },
});

declare module "cloudflare:test" {
  // ProvidedEnv controls the type of `import("cloudflare:test").env`
  // It makes bindings defined in your wrangler.toml available to your tests.
  interface ProvidedEnv extends ProjectEnv {
    // You can define additional test-specific environment variables here if needed,
    // for example, if you add them via the `miniflare.bindings` option in vitest.config.ts.
    // TEST_VARIABLE?: string;
  }
}

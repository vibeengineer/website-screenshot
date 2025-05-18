// biome-ignore-all lint/suspicious/noExplicitAny: we're using this to deal with untyped code so any is required
declare module "@duckduckgo/autoconsent/dist/autoconsent.playwright.js" {
  const mod: any;
  export default mod;
}

declare module "@duckduckgo/autoconsent/rules/rules.json" {
  const rules: any;
  export default rules;
}

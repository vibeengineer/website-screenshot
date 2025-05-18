// biome-ignore lint/suspicious/noExplicitAny: 3rd-party CJS modules
import { PlaywrightBlocker } from "@ghostery/adblocker-playwright";
import fetch from "cross-fetch";
import { getInjectableScript } from "idcac-playwright";
import type { Logger } from "pino";
import type { Page } from "playwright-core";
import { VIEWPORT_HEIGHT, VIEWPORT_WIDTH } from "../utils/constants.js";

/* ── lazy-loaded DuckDuckGo Autoconsent ─────────────────────────────── */
let ac: any;
let rules: any[];

async function ensureAutoconsent() {
  if (ac) return { ac, rules };

  const { default: autoconsent } = await import(
    "@duckduckgo/autoconsent/dist/autoconsent.playwright.js"
  );
  const { default: json } = await import("@duckduckgo/autoconsent/rules/rules.json", {
    assert: { type: "json" },
  });

  const cmps = json.consentomatic ?? {};
  rules = [
    ...autoconsent.rules,
    ...Object.keys(cmps).map((k) => new autoconsent.ConsentOMaticCMP(`com_${k}`, cmps[k])),
    ...json.autoconsent.map((s: any) => autoconsent.createAutoCMP(s)),
  ];
  ac = autoconsent;
  return { ac, rules };
}

/* ── *very* generic banner clicker – runs inside the page ───────────── */
async function clickGenericAccept(page: Page) {
  await page
    .evaluate(() => {
      (() => {
        const RX =
          /^(allow(?: (?:all|essential(?: and)? optional))? cookies?|allow all|allow|accept(?: all cookies?)?|accept all|accept|agree|got ?it|ok(?:ay)?|enable|yes[,ʼ' ]?i'?m happy|close)$/i;

        const candidates = Array.from(
          document.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>(
            'button, a, [role="button"]'
          )
        );

        for (const el of candidates) {
          if (el.offsetParent === null) continue; // invisible
          const txt = el.textContent?.trim().toLowerCase() ?? "";
          if (RX.test(txt)) {
            (el as HTMLElement).click();
            return;
          }
        }
      })();
    })
    .catch(() => {
      /* ignore evaluation errors */
    });
}

/* ── exported setup ─────────────────────────────────────────────────── */
export type SetupOptions = { adBlock?: boolean };

export async function setupPage(page: Page, { adBlock = true }: SetupOptions, logger: Logger) {
  /* 1️⃣  IDCAC “I don’t care about cookies” */
  await page.context().addInitScript(getInjectableScript());

  /* 2️⃣  Ghostery blocker (ads + Fanboy CookieMonster) */
  if (adBlock) {
    const core = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch);
    await core.enableBlockingInPage(page);

    const cookies = await PlaywrightBlocker.fromLists(fetch, [
      "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt",
    ]);
    await cookies.enableBlockingInPage(page);

    logger.debug("Blocker (ads + CookieMonster) enabled");
  }

  /* 3️⃣  viewport + cosmetics */
  await page.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
  await page.addStyleTag({
    content: "::-webkit-scrollbar{display:none!important}html,body{overflow:hidden}",
  });

  /* 4️⃣  Auto-consent CMP fallback */
  page.on("domcontentloaded", async () => {
    try {
      const { ac, rules } = await ensureAutoconsent();
      const tab = ac.attachToPage(page, page.url(), rules, 10);
      await tab.checked;
      await tab.doOptIn(); // opt-in = minimal tracking
      logger.debug("Autoconsent handled CMP");
    } catch {
      /* silent */
    }
  });

  /* 5️⃣  fire once as soon as full page loads */
  page.once("load", () => void clickGenericAccept(page));

  /* 6️⃣  expose helper for the screenshot service */
  await page.exposeFunction("waitUntilClean", async () => {
    const deadline = Date.now() + 10_000; // 10 s hard limit

    while (Date.now() < deadline) {
      await clickGenericAccept(page);
      const done = await page
        .evaluate(() => {
          const sel = [
            "[data-cookiebanner]",
            '[jscontroller="H6eOGe"]', // Google
            "#cookieBanner",
            '[aria-modal="true"][role="dialog"]',
            '[data-testid="cookie-policy-dialog"]',
            '[data-role="cookie-banner"]',
          ];
          return sel.every((s) => !document.querySelector(s));
        })
        .catch(() => false);

      if (done) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    /* hide stubborn 3rd-party iframes */
    try {
      await page.addStyleTag({
        content:
          'iframe[src*="consent."],iframe[src*="cookiebot"],iframe[src*="gdpr"],iframe[src*="datadome"],iframe[src*="trustarc"]{display:none!important}',
      });
    } catch {
      /* ignore */
    }
  });
}

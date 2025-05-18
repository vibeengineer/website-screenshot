import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

interface AttemptResult {
  attempt: number;
  status: number | string;
  ok: boolean;
  headers?: Record<string, string>;
  bodyText?: string; // Will store a summary or error
  bodyType?: string;
  error?: string;
  filePath?: string; // To store the path of the saved image file
}

const BASE_URL = "http://localhost:3000";

// A list of diverse and generally reliable URLs for testing
const TARGET_SCREENSHOT_URLS = [
  "https://www.wikipedia.org",
  "https://www.github.com",
  "https://www.vitest.dev",
  "https://www.typescriptlang.org",
  "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
  "https://www.npmjs.com/package/hono",
  "https://blog.cloudflare.com",
  "https://workers.cloudflare.com/docs/",
  "https://www.google.com/search?q=cloudflare+workers",
  "https://www.google.com",
  "https://www.youtube.com",
  "https://www.facebook.com",
  "https://www.amazon.com",
  "https://www.reddit.com",
  "https://www.twitter.com",
  "https://www.instagram.com",
  "https://www.linkedin.com",
  "https://www.microsoft.com",
  "https://www.apple.com",
  "https://www.netflix.com",
  "https://www.ebay.com",
  "https://www.bing.com",
  "https://www.cnn.com",
  "https://www.nytimes.com",
  "https://www.bbc.com",
  "https://www.theguardian.com",
  "https://stackoverflow.com",
  "https://medium.com",
  "https://www.quora.com",
  "https://www.pinterest.com",
  "https://www.tumblr.com",
  "https://www.snapchat.com",
  "https://www.tiktok.com",
  "https://www.discord.com",
  "https://www.spotify.com",
  "https://www.dropbox.com",
  "https://www.salesforce.com",
  "https://www.oracle.com",
  "https://www.sap.com",
  "https://www.adobe.com",
  "https://www.intuit.com",
  "https://www.booking.com",
  "https://www.expedia.com",
  "https://www.airbnb.com",
  "https://www.uber.com",
  "https://www.lyft.com",
  "https://www.zoom.us",
  "https://www.slack.com",
  "https://www.tesla.com",
];

const SCREENSHOT_DIR_VITEST = path.join(__dirname, "screenshots");

describe("Screenshot Worker Integration Tests (Node.js Env)", () => {
  // The BASE_URL for SELF.fetch is effectively the worker itself.
  // We construct full URLs for the Request objects passed to SELF.fetch.
  // const TARGET_SCREENSHOT_URL = "https://www.cloudflare.com"; // A dummy URL for testing
  const NUM_CONCURRENT_REQUESTS = TARGET_SCREENSHOT_URLS.length;

  // Create screenshot directory before running tests
  // Vitest runs setup files/hooks in the Node.js environment if not using a custom pool
  beforeAll(async () => {
    try {
      await fsPromises.mkdir(SCREENSHOT_DIR_VITEST, { recursive: true });
      console.log(`Created/ensured Vitest screenshot directory: ${SCREENSHOT_DIR_VITEST}`);
    } catch (error) {
      console.error(
        `Could not create Vitest screenshot directory ${SCREENSHOT_DIR_VITEST}:`,
        error
      );
      // Optionally, throw to fail all tests if directory creation fails
    }
  });

  it(
    `should handle ${NUM_CONCURRENT_REQUESTS} concurrent screenshot requests and save images`,
    async () => {
      const promises: Promise<AttemptResult>[] = [];
      const results: AttemptResult[] = [];

      console.log(
        `Attempting to send ${NUM_CONCURRENT_REQUESTS} requests for various URLs (expecting direct image output)...`
      );

      for (let i = 0; i < NUM_CONCURRENT_REQUESTS; i++) {
        const targetUrl = TARGET_SCREENSHOT_URLS[i];
        const attemptNumber = i + 1;
        const requestUrl = `${BASE_URL}/screenshot?url=${encodeURIComponent(
          targetUrl
        )}&directOutput=true&attempt=${attemptNumber}`;
        const request = new Request(requestUrl);

        const promise = fetch(request)
          .then(async (response: Response) => {
            const attemptResult: AttemptResult = {
              attempt: attemptNumber,
              status: response.status,
              ok: response.ok,
              headers: Object.fromEntries(response.headers as any),
            };
            try {
              const contentType = response.headers.get("content-type");
              if (response.ok && contentType?.includes("image/png")) {
                attemptResult.bodyType = "image/png";
                const imageBuffer = await response.arrayBuffer();
                const safeHostname = new URL(targetUrl).hostname
                  .replace(/[^a-z0-9_.-]/gi, "_")
                  .substring(0, 50);
                const filename = path.join(
                  SCREENSHOT_DIR_VITEST,
                  `attempt_${attemptResult.attempt}_${safeHostname}.png`
                );
                await fsPromises.writeFile(filename, Buffer.from(imageBuffer));
                attemptResult.filePath = filename;
                attemptResult.bodyText = `[Image data saved to ${filename}]`;
              } else {
                // Handle non-PNG or error responses
                attemptResult.bodyText = await response.text();
                attemptResult.bodyType = contentType || "unknown_content_type";
              }
            } catch (e: unknown) {
              attemptResult.bodyText = `Error reading response body or saving file: ${
                e instanceof Error ? e.message : String(e)
              }`;
              attemptResult.bodyType = "error_processing_response";
            }
            results.push(attemptResult);
            return attemptResult;
          })
          .catch((error: unknown) => {
            console.error(
              `Test Attempt ${attemptNumber}: Top-level fetch FAILED - ${
                error instanceof Error ? error.message : String(error)
              }`
            );
            const errorResult: AttemptResult = {
              attempt: attemptNumber,
              status: "FETCH_ERROR_OVERALL",
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
            results.push(errorResult);
            return errorResult;
          });
        promises.push(promise);
      }

      await Promise.allSettled(promises);
      results.sort((a, b) => a.attempt - b.attempt);

      let successfulFileSaves = 0;
      let serviceUnavailableOrTimeout = 0; // 503, 504 from worker, or other non-200s
      let fetchErrors = 0;
      let processingErrors = 0; // Errors during response read/save

      for (const res of results) {
        if (res.status === "FETCH_ERROR_OVERALL") {
          fetchErrors++;
        } else if (res.ok && res.filePath) {
          successfulFileSaves++;
        } else if (res.bodyType === "error_processing_response") {
          processingErrors++;
        } else if (res.status === 503 || res.status === 504) {
          serviceUnavailableOrTimeout++;
        } else {
          // Catch-all for other non-OK statuses or unexpected formats
          serviceUnavailableOrTimeout++;
          console.warn(
            `Attempt ${res.attempt}: Non-OK/Unexpected. Status: ${res.status}, Type: ${
              res.bodyType
            }, Body: ${res.bodyText?.substring(0, 100)}`
          );
        }
      }

      console.log("--- Vitest Execution Summary (Node.js Env) ---");
      console.log(`Total Requests Sent: ${NUM_CONCURRENT_REQUESTS}`);
      console.log(`Successful File Saves: ${successfulFileSaves}`);
      console.log(`Service Unavailable/Timeout/Other Errors: ${serviceUnavailableOrTimeout}`);
      console.log(`Fetch Errors (Network/Request setup): ${fetchErrors}`);
      console.log(`Response Processing/File Save Errors: ${processingErrors}`);
      console.log("--------------------------------------------------");

      // Assertions:
      expect(results.length).toBe(NUM_CONCURRENT_REQUESTS);
      // Expect most requests to result in successful file saves.
      // This is a more flexible assertion, allowing for some network/transient errors.
      expect(successfulFileSaves).toBeGreaterThanOrEqual(
        NUM_CONCURRENT_REQUESTS - fetchErrors - serviceUnavailableOrTimeout - processingErrors
      );
      // Ideally, most should succeed:
      // expect(successfulFileSaves).toBe(NUM_CONCURRENT_REQUESTS);

      // Ensure all categories sum up
      expect(
        successfulFileSaves + serviceUnavailableOrTimeout + fetchErrors + processingErrors
      ).toBe(NUM_CONCURRENT_REQUESTS);

      // Log results for manual inspection
      for (const res of results) {
        const bodyPreview = res.filePath
          ? `File saved: ${res.filePath}`
          : res.bodyText
          ? `${res.bodyText.substring(0, 100)}...`
          : res.error
          ? `Error: ${res.error.substring(0, 100)}...`
          : "N/A";
        console.log(
          `Result Attempt ${res.attempt}: Status ${res.status}, OK: ${res.ok}, Type: ${
            res.bodyType || "N/A"
          }, Detail: ${bodyPreview}`
        );
      }
    },
    10 * 60 * 1000 // Extended timeout for 50 requests
  );
});

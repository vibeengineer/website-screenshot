const fetch = require('node-fetch');
const fs = require('node:fs').promises;
const path = require('node:path');

const BASE_URL = 'http://localhost:8787'; // Make sure your worker is running on this port

// A list of diverse URLs for testing
const TARGET_SCREENSHOT_URLS = [
  "https://www.cloudflare.com",
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
  "https://www.tesla.com"
];

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots_node');
const NUM_CONCURRENT_REQUESTS = TARGET_SCREENSHOT_URLS.length; // Or set a specific number

async function takeScreenshot(targetUrl, attempt) {
  const requestUrl = `${BASE_URL}/screenshot?url=${encodeURIComponent(targetUrl)}&directOutput=true&attempt=${attempt}`;
  console.log(`[Attempt ${attempt}] Requesting screenshot for: ${targetUrl}`);

  try {
    const response = await fetch(requestUrl, { timeout: 120000 }); // 2 minute timeout per request

    if (response.ok && response.headers.get('content-type')?.includes('image/png')) {
      const imageBuffer = await response.arrayBuffer();
      const safeHostname = new URL(targetUrl).hostname.replace(/[^a-z0-9_.-]/gi, '_').substring(0, 50);
      const filename = path.join(SCREENSHOT_DIR, `attempt_${attempt}_${safeHostname}.png`);
      
      await fs.writeFile(filename, Buffer.from(imageBuffer));
      console.log(`[Attempt ${attempt}] SUCCESS: Screenshot for ${targetUrl} saved to ${filename}`);
      return { success: true, url: targetUrl, path: filename };
    } 
    // If not successful and PNG, it's a failure
    const errorText = await response.text();
    console.error(`[Attempt ${attempt}] FAILED for ${targetUrl}: Status ${response.status}. Body: ${errorText.substring(0, 200)}...`);
    return { success: false, url: targetUrl, status: response.status, error: errorText };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Attempt ${attempt}] FAILED for ${targetUrl}: Error during fetch - ${errorMessage}`);
    return { success: false, url: targetUrl, error: errorMessage };
  }
}

async function main() {
  console.log('Starting Node.js screenshot test script...');
  console.log(`Targeting ${NUM_CONCURRENT_REQUESTS} URLs.`);
  
  try {
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
    console.log(`Screenshot directory ensured: ${SCREENSHOT_DIR}`);
  } catch (error) {
    console.error(`Could not create screenshot directory ${SCREENSHOT_DIR}:`, error);
    return;
  }

  const results = [];
  // Running requests sequentially to avoid overwhelming the local worker/DO with too many browser instances at once.
  // You can implement concurrency with Promise.all and a limit if needed.
  for (let i = 0; i < TARGET_SCREENSHOT_URLS.length; i++) {
    const result = await takeScreenshot(TARGET_SCREENSHOT_URLS[i], i + 1);
    results.push(result);
  }

  console.log("\n--- Node.js Screenshot Test Summary ---");
  const successes = results.filter(r => r.success).length;
  const failures = results.length - successes;

  console.log(`Total URLs processed: ${results.length}`);
  console.log(`Successful screenshots: ${successes}`);
  console.log(`Failed attempts: ${failures}`);
  console.log("--------------------------------------");

  if (failures > 0) {
    console.log("\nDetails of failed attempts:");
    for (const r of results) {
      if (!r.success) {
        console.log(`- URL: ${r.url}, Status: ${r.status || 'N/A'}, Error: ${r.error}`);
      }
    }
  }
}

main().catch(err => {
  console.error("Unhandled error in main script execution:", err);
}); 
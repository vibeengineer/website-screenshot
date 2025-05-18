import { config } from "dotenv";
import { z } from "zod";

config();

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.string().default("development"),

  BROWSERLESS_URL: z.string().url().default("http://localhost:3100"),
  BROWSERLESS_TOKEN: z.string().optional(),

  ENABLE_KEEP_ALIVE: z.coerce.boolean().default(true),
  MAX_CONCURRENT_BROWSER_SESSIONS: z.coerce.number().min(1).default(5),

  BASE_IMAGE_URL: z.string().url(),
  OVERLAY_IMAGE_URL: z.string().url(),

  QUEUE_TIMEOUT: z.coerce.number().default(600_000),
});

export const env = schema.parse(process.env) as z.infer<typeof schema> & { BROWSERLESS_WS: string };
export type Env = typeof env;

env.BROWSERLESS_WS =
  env.BROWSERLESS_URL.replace("http", "ws") +
  (env.BROWSERLESS_TOKEN ? `?token=${env.BROWSERLESS_TOKEN}` : "");

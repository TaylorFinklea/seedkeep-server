import { z } from 'zod';

/**
 * Validated environment loader. Reads from `process.env` (Bun populates it
 * from `.env` automatically) and produces a typed `Env` object that the
 * rest of the app imports. Crashes fast at boot if a required variable is
 * missing — better than failing on the first request.
 */

const schema = z.object({
  // Server
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),

  // Database
  DATABASE_URL: z.url(),

  // S3-compatible storage
  S3_ENDPOINT: z.url().optional(), // optional: AWS S3 omits this
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  // MinIO requires path-style; AWS S3 / R2 use virtual-host. String env vars
  // come in as "true"/"false" — coerce.
  S3_FORCE_PATH_STYLE: z
    .union([z.boolean(), z.literal('true'), z.literal('false')])
    .default(false)
    .transform((v) => v === true || v === 'true'),

  // Auth
  BETTER_AUTH_SECRET: z.string().min(16),
  APPLE_CLIENT_ID: z.string().min(1),
  APPLE_CLIENT_SECRET: z.string().min(1),

  // AI providers (optional — extraction route gates on this)
  ANTHROPIC_API_KEY: z.string().optional().transform((v) => v?.trim() || undefined),

  // Apple App Store shared secret (for IAP receipt validation). Optional —
  // /api/subscriptions/verify returns 503 not_configured when missing.
  APPLE_IAP_SHARED_SECRET: z.string().optional().transform((v) => v?.trim() || undefined),

  // AES-256-GCM master key for encrypting users' BYOK Anthropic API keys.
  // Must decode to exactly 32 bytes (base64-encoded). Generate with:
  //   openssl rand -base64 32
  // Optional at boot — /api/households/me/assistant_key routes 503 when missing.
  ASSISTANT_KEY_MASTER: z.string().optional().transform((v) => v?.trim() || undefined),

  // Models
  DEFAULT_VISION_MODEL: z.string().default('claude-sonnet-4-6'),
  DEFAULT_REVIEW_MODEL: z.string().default('claude-haiku-4-5-20251001'),

  // Phase 4D · admin surface secret. When unset, admin routes return 503
  // not_configured — explicit fail-closed rather than silent open.
  // Must be at least 32 characters when set (prod uses 64-char value).
  ADMIN_SECRET: z.string().min(32).optional().transform((v) => v?.trim() || undefined),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * Lazily-validated env. Call once at boot via `loadEnv()`; subsequent
 * imports get the cached object. Tests pass `process.env`-shaped fixtures.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Reset the cache. Test-only. */
export function _resetEnv(): void {
  cached = null;
}

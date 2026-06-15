import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_URL: z.string().url().default("http://localhost:3000"),
  JWT_SECRET: z.string().min(32),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_WEBHOOK_SECRET_FILE: z.string().optional(),
  AUTH_COOKIE_SECURE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["true", "false"]).optional()
  ),
  SEAT_HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_SESSION_TTL_DAYS: z.coerce.number().int().positive().default(90),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development")
});

const nodeEnv = process.env.NODE_ENV ?? "development";
const buildSafeDefaults = {
  DATABASE_URL: "postgresql://seats:seats@localhost:5432/seats?schema=public"
};
const testOnlyDefaults =
  nodeEnv === "test" || process.env.VITEST
    ? {
        JWT_SECRET: "test-jwt-secret-long-enough-for-unit-tests",
        STRIPE_SECRET_KEY: "sk_test_for_unit_tests",
        STRIPE_WEBHOOK_SECRET: "whsec_for_unit_tests"
      }
    : {};

export const env = envSchema.parse({
  ...buildSafeDefaults,
  ...testOnlyDefaults,
  ...process.env,
  NODE_ENV: nodeEnv
});

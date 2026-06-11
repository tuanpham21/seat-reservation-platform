#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import * as argon2 from "argon2";

const allowPlaceholderStripe = process.argv.includes("--allow-placeholder-stripe");
const requiredEnv = [
  "DATABASE_URL",
  "APP_URL",
  "JWT_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SEAT_HOLD_TTL_SECONDS",
  "ACCESS_TOKEN_TTL_SECONDS",
  "REFRESH_SESSION_TTL_DAYS"
];

const checks = [];

function addCheck(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function parseEnvFile(path) {
  if (!fs.existsSync(path)) return {};

  const result = {};
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[match[1]] = value;
  }

  return result;
}

function setEnvDefaults() {
  const envFile = parseEnvFile(".env");
  for (const [key, value] of Object.entries(envFile)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

function checkCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe"
  });

  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  };
}

function printReport() {
  for (const check of checks) {
    const marker = check.ok ? "PASS" : "FAIL";
    console.log(`${marker} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
  }
}

async function main() {
  setEnvDefaults();

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  addCheck("Node.js >= 20", nodeMajor >= 20, `current ${process.versions.node}`);

  addCheck(".env exists", fs.existsSync(".env"), "copy .env.example to .env if missing");

  const missingEnv = requiredEnv.filter((key) => !process.env[key]);
  addCheck(
    "required environment variables",
    missingEnv.length === 0,
    missingEnv.length ? `missing ${missingEnv.join(", ")}` : "all present"
  );

  addCheck(
    "JWT_SECRET configured",
    Boolean(process.env.JWT_SECRET && process.env.JWT_SECRET !== "replace-with-a-random-32-byte-secret"),
    "use openssl rand -base64 32"
  );

  const docker = checkCommand("docker", ["compose", "ps", "postgres"]);
  addCheck("Docker compose postgres visible", docker.ok, docker.ok ? "postgres service found" : docker.output);

  const stripeSecret = process.env.STRIPE_SECRET_KEY ?? "";
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  const stripeConfigured =
    stripeSecret.startsWith("sk_test_") &&
    stripeSecret !== "sk_test_replace_me" &&
    webhookSecret.startsWith("whsec_") &&
    webhookSecret !== "whsec_replace_me";

  addCheck(
    "Stripe test keys configured",
    allowPlaceholderStripe || stripeConfigured,
    stripeConfigured
      ? "test secret and webhook secret look usable"
      : "set STRIPE_SECRET_KEY=sk_test_... and STRIPE_WEBHOOK_SECRET=whsec_..."
  );

  const prisma = new PrismaClient();

  try {
    const seats = await prisma.seat.findMany({
      orderBy: { sortOrder: "asc" },
      select: { id: true, label: true, isEnabled: true }
    });
    addCheck(
      "seeded seats",
      seats.length === 3 && seats.every((seat) => seat.isEnabled),
      `found ${seats.length} seats`
    );

    const demoUser = await prisma.user.findUnique({
      where: { email: "demo@example.com" },
      select: { passwordHash: true }
    });
    const demoPasswordWorks = demoUser
      ? await argon2.verify(demoUser.passwordHash, "Password123!")
      : false;
    addCheck(
      "demo login",
      demoPasswordWorks,
      demoPasswordWorks ? "demo@example.com / Password123! works" : "run npm run db:seed"
    );
  } catch (error) {
    addCheck(
      "database connection",
      false,
      error instanceof Error ? error.message : "unable to query database"
    );
  } finally {
    await prisma.$disconnect();
  }

  printReport();

  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

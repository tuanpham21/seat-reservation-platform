# Seat Reservation Platform

Public seat reservation assessment app built with Next.js, TypeScript, Prisma/Postgres, and Stripe Checkout.

Implemented reviewer-facing behavior:

- authenticated users can hold one of three public seats;
- payment starts through Stripe Checkout in test mode;
- a reservation is finalized only after Stripe webhook confirmation;
- Postgres owns seat/hold/reservation state through Prisma;
- tests, typechecking, build, and submission packaging are runnable from npm scripts.

## Prerequisites

- Node.js 20 or newer
- npm
- Docker Desktop or a compatible Docker engine
- Optional for full payment confirmation: a Stripe account for test mode keys
- Optional for local full payment confirmation: Stripe CLI for webhook forwarding

No Stripe account is required for the basic reviewer smoke path. With the
placeholder keys in `.env.example`, reviewers can boot the app, log in, hold
seats, replace a user's active hold, see held seats become unavailable, and
verify checkout fails with a clear configuration message. Completing the full
`select -> pay -> reserve` flow requires Stripe test credentials and webhook
forwarding.

## Quick Start

After cloning, the app can be started with placeholder Stripe keys in three
commands:

```bash
npm ci
cp .env.example .env
docker compose up -d postgres && npm run db:generate && npm run db:deploy && npm run db:seed && npm run dev
```

Open `http://localhost:3000`.

The primary reviewer artifacts are this `README.md`, `DECISIONS.md`, and
`.env.example`. `REVIEWER_HANDOFF.md` is a short optional checklist with the
same setup path, preflight command, Stripe webhook steps, and integration-test
database warning.

## Repository Layout

```text
src/app/                 Next.js routes and the reviewer-facing reservation UI
src/server/auth/         credentials auth, rotating refresh sessions, cookies
src/server/seats/        seat availability and active-hold domain logic
src/server/payments/     Stripe Checkout, webhook verification, fulfillment
prisma/                  schema, migrations, and reviewer seed data
scripts/                 reviewer preflight, Docker entrypoint, packaging
Dockerfile               production-like app container for review
docker-compose.yml       Postgres, app, and optional Stripe CLI sidecar
```

Seeded reviewer login:

- email: `demo@example.com`
- password: `Password123!`

If you only need to verify TypeScript and packaging without running the app:

```bash
npm run typecheck
npm test
npm run build
npm run package:submission
```

`npm test` runs unit tests and skips database-backed race/idempotency tests unless `RUN_DB_TESTS=1` is set.

## Docker Reviewer Run

For the lowest-friction review path, run the app and Postgres together:

```bash
docker compose up --build
```

Open `http://localhost:3000`. The app container applies committed Prisma
migrations and reseeds the three seats plus `demo@example.com / Password123!`
before starting Next.js.

If port 3000 is already in use, set both the published port and callback URL:

```bash
APP_PORT=3001 APP_URL=http://localhost:3001 docker compose up --build
```

With the default placeholder Stripe keys, the app still boots and reviewers can
exercise auth, seat availability, hold creation/replacement, held-seat
unavailable behavior, and the checkout configuration-failure path. Confirmed
reservation/payment states require real Stripe test credentials and webhook
forwarding. Checkout is intentionally blocked until a real Stripe test key and
usable webhook signing secret are provided.

For full Stripe Checkout from Docker, keep secrets outside git and run:

```bash
STRIPE_SECRET_KEY=sk_test_... docker compose --profile stripe up --build
```

The `stripe-listener` sidecar forwards Stripe webhooks to the app container and
writes the generated `whsec_...` signing secret into a shared Docker volume. The
app reads that file when verifying webhook signatures, so reviewers do not need
to manually paste `STRIPE_WEBHOOK_SECRET` for the Docker path. The sidecar maps
`STRIPE_SECRET_KEY` into the Stripe CLI API key; no host Stripe CLI install is
needed for this Docker path.

Before paying through Checkout, confirm the sidecar has written the generated
webhook secret:

```bash
docker compose exec app sh -lc 'test -r /run/stripe/webhook-secret && grep -q "^whsec_" /run/stripe/webhook-secret'
```

If you are not using the Docker Stripe sidecar, run `stripe listen` locally and
copy its `whsec_...` value into `STRIPE_WEBHOOK_SECRET` as described below.

Reset the Docker database and remove any locally generated webhook secret with:

```bash
docker compose down -v
```

If host port 5432 is already used by another Postgres instance, change the
published database port:

```bash
POSTGRES_PORT=5433 docker compose up -d postgres
```

For host-side Prisma/npm commands against that port, also update `.env`:

```bash
DATABASE_URL="postgresql://seats:seats@localhost:5433/seats?schema=public"
```

The app container always talks to Postgres on the internal Docker address
`postgres:5432`.

## Environment

Copy `.env.example` to `.env` and replace placeholders locally. Do not commit `.env` files.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Local or hosted Postgres connection string used by Prisma. The default matches `docker-compose.yml`. |
| `APP_URL` | Public base URL used for absolute callback, success, and cancel URLs. |
| `AUTH_COOKIE_SECURE` | Optional override for refresh-cookie `Secure`; blank infers from `APP_URL`. |
| `JWT_SECRET` | High-entropy signing secret for application sessions. Generate a local value with `openssl rand -base64 32`. |
| `STRIPE_SECRET_KEY` | Stripe test secret key. Use an `sk_test_...` key, never a live key for local assessment runs. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret from `stripe listen` or the Stripe dashboard webhook endpoint. |
| `STRIPE_WEBHOOK_SECRET_FILE` | Optional Docker path for a Stripe CLI sidecar-generated webhook signing secret. |
| `SEAT_HOLD_TTL_SECONDS` | Time a seat hold remains valid before it can be released. |
| `ACCESS_TOKEN_TTL_SECONDS` | Short-lived access token lifetime. |
| `REFRESH_SESSION_TTL_DAYS` | Refresh-session lifetime for rotating sessions. |

## Postgres

Start the local database with:

```bash
docker compose up -d postgres
```

The compose service uses Postgres 16 and exposes `localhost:5432` with:

- database: `seats`
- user: `seats`
- password: `seats`

The matching Prisma URL is already present in `.env.example`.

Useful database commands:

```bash
npm run db:generate
npm run db:migrate
npm run db:deploy
npm run db:seed
npm run db:reset
```

Use `db:migrate` for local development migrations and `db:deploy` for applying committed migrations in CI or hosted environments.

The migration includes raw Postgres partial unique indexes for the core invariants:

- one active seat hold per seat;
- one active seat hold per authenticated user;
- one confirmed reservation per seat.

## Stripe Test Mode

Use Stripe Checkout in test mode only for this assessment.

1. Put an `sk_test_...` key in `STRIPE_SECRET_KEY`.
2. Forward local webhook events. Either authenticate the Stripe CLI first with
   `stripe login`, or pass the API key directly:

   ```bash
   STRIPE_API_KEY=sk_test_... stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```

3. Copy the printed `whsec_...` value into `STRIPE_WEBHOOK_SECRET`.
4. Restart `npm run dev` after editing `.env` so Next.js picks up the new Stripe values.
5. Use Stripe test cards, for example `4242 4242 4242 4242` with any future expiry date, CVC, and postal code.

The bundled `sk_test_replace_me` placeholder is intentionally rejected before checkout starts, so reviewers get a clear configuration response instead of a generic payment failure or a stuck local payment row.

Checkout success redirects should be treated as a user experience signal only. Reservation fulfillment must be driven by verified webhook events so refreshes, retries, and abandoned redirects do not create duplicate reservations.

The success page polls `/api/payments/:paymentId` until the payment reaches `succeeded`, `requires_review`, `failed`, or `expired`.

## Manual Reviewer Checklist

1. Start with `docker compose up --build` or the local Quick Start.
2. Log in as `demo@example.com / Password123!`.
3. Hold an available seat and verify any previous hold by that user is released.
4. Register a second account in another browser/session and verify seats held by another user are unavailable immediately after selection attempts.
5. With placeholder Stripe keys, start checkout and confirm the app returns a clear configuration error without creating a stuck local payment.
6. With Stripe test keys and webhook forwarding, pay with `4242 4242 4242 4242` and confirm the reservation reaches a terminal state without continued polling.
7. For host-side validation, run `npm ci` if you used the Docker-only path, copy `.env.example` to `.env` if missing, replace `JWT_SECRET` in `.env` with `openssl rand -base64 32`, keep Postgres running, then run `npm run reviewer:preflight -- --allow-placeholder-stripe`, `npm test`, `npm run typecheck`, and `npm run build` before packaging.

`reviewer:preflight` intentionally still expects `JWT_SECRET` to be replaced
with a local random value, even when `--allow-placeholder-stripe` is used. The
flag only allows placeholder Stripe keys for non-payment review.

## Tests

Default unit tests do not require a running database:

```bash
npm test
```

Database-backed assessment tests cover the required race/idempotency cases:

```bash
docker compose up -d postgres
npm run db:deploy
RUN_DB_TESTS=1 npm test
# or
npm run test:integration
```

These integration tests clean the configured database. Use a disposable test
database or reseed reviewer data with `npm run db:seed` afterward.

Those integration tests verify:

- two concurrent authenticated users attempting the same seat produce only one active hold;
- selecting a different seat releases the authenticated user's previous active hold;
- concurrent refresh reuse allows one rotation and then revokes the token family;
- duplicate Stripe webhook delivery creates only one processing effect;
- successful Stripe payment after hold expiry becomes `requires_review` without creating a reservation.

## NPM Scripts

| Script | Behavior |
| --- | --- |
| `npm run dev` | Start the Next.js development server. |
| `npm run build` | Generate Prisma client and build the Next.js app. |
| `npm start` | Serve the production build. |
| `npm run lint` | Run Next.js ESLint checks. |
| `npm run typecheck` | Run TypeScript without emitting files. |
| `npm test` | Run Vitest once. |
| `npm run test:integration` | Run DB-backed assessment tests with `RUN_DB_TESTS=1`. |
| `npm run test:watch` | Run Vitest in watch mode. |
| `npm run reviewer:preflight` | Check reviewer setup, seeded data, and Stripe test-key readiness. |
| `npm run docker:review` | Build and run app plus Postgres with Docker Compose. |
| `npm run docker:review:stripe` | Build and run app, Postgres, and Stripe webhook forwarding sidecar. |
| `npm run db:generate` | Generate Prisma client. |
| `npm run db:migrate` | Run Prisma development migrations. |
| `npm run db:deploy` | Apply committed migrations. |
| `npm run db:seed` | Run the Prisma seed script. |
| `npm run db:reset` | Reset the local database. |
| `npm run package:submission` | Create `dist/seat-reservation-platform-submission.zip`. |

## Submission Package

Create a clean zip with:

```bash
npm run package:submission
```

The script writes `dist/seat-reservation-platform-submission.zip` and excludes generated or local-only content, including:

- `node_modules/`
- `.next/`, `out/`, `dist/`, and coverage output
- `.idea/`, `.vscode/`, and local workspace context files
- `.env` and `.env.*` files except `.env.example`
- logs
- local SQLite or database files
- git metadata and OS/editor noise

## Assessment Notes

`DECISIONS.md` documents the architecture choices, concurrency model, idempotency strategy, known shortcuts, and how the design should evolve at higher scale.

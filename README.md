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
- A Stripe account for test mode keys
- Stripe CLI for local webhook testing

## Quick Start

```bash
npm ci
cp .env.example .env
docker compose up -d postgres
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

Open `http://localhost:3000`.

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

## Environment

Copy `.env.example` to `.env` and replace placeholders locally. Do not commit `.env` files.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Local or hosted Postgres connection string used by Prisma. The default matches `docker-compose.yml`. |
| `APP_URL` | Public base URL used for absolute callback, success, and cancel URLs. |
| `JWT_SECRET` | High-entropy signing secret for application sessions. Generate a local value with `openssl rand -base64 32`. |
| `STRIPE_SECRET_KEY` | Stripe test secret key. Use an `sk_test_...` key, never a live key for local assessment runs. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret from `stripe listen` or the Stripe dashboard webhook endpoint. |
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
2. Forward local webhook events:

   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```

3. Copy the printed `whsec_...` value into `STRIPE_WEBHOOK_SECRET`.
4. Use Stripe test cards, for example `4242 4242 4242 4242` with any future expiry date, CVC, and postal code.

Checkout success redirects should be treated as a user experience signal only. Reservation fulfillment must be driven by verified webhook events so refreshes, retries, and abandoned redirects do not create duplicate reservations.

The success page polls `/api/payments/:paymentId` until the payment reaches `succeeded`, `requires_review`, `failed`, or `expired`.

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

Those integration tests verify:

- two concurrent authenticated users attempting the same seat produce only one active hold;
- concurrent refresh reuse allows one rotation and then revokes the token family;
- duplicate Stripe webhook delivery creates only one processing effect.

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
- `.env` and `.env.*` files except `.env.example`
- logs
- local SQLite or database files
- git metadata and OS/editor noise

## Assessment Notes

`DECISIONS.md` documents the architecture choices, concurrency model, idempotency strategy, known shortcuts, and how the design should evolve at higher scale.

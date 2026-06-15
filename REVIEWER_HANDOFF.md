# Reviewer Quick Guide

The primary assessment artifacts are `README.md`, `DECISIONS.md`, and
`.env.example`. This file is only a short checklist for reviewers who want the
fastest path through setup, validation, and Stripe Checkout.

The normal app can start without real Stripe keys. Without a Stripe account,
reviewers can verify auth, seat availability, hold creation/replacement,
held-seat unavailable behavior, and the checkout configuration-failure path. The
full `select -> pay -> reserve` flow requires Stripe test-mode configuration
and a forwarded webhook.

## Docker Fast Path

```bash
cp .env.example .env
docker compose up --build
```

Open `http://localhost:3000`.

This starts Postgres and the Next.js app, applies committed migrations, seeds
the reviewer data, and exposes `/api/health/live` plus `/api/health/ready`.
With placeholder Stripe keys, Checkout is intentionally blocked with a
configuration message. `/api/seats/stream` is also available as the in-process
SSE boundary for seat availability fan-out. The placeholder `.env.example`
values are acceptable for this Docker-only smoke path.

If port 3000 is busy:

```bash
APP_PORT=3001 APP_URL=http://localhost:3001 docker compose up --build
```

For full Stripe Checkout with Docker:

```bash
STRIPE_SECRET_KEY="sk_test_..." docker compose --profile stripe up --build
```

The Stripe listener sidecar forwards webhooks to the app and writes the
generated `whsec_...` signing secret into a shared Docker volume. Do not commit
or package real Stripe secrets. The Docker sidecar uses `STRIPE_SECRET_KEY` as
the Stripe CLI API key, so no host Stripe CLI install is needed for this path.

If you want to inspect the proxy/rate-limit skeleton as well, run:

```bash
docker compose --profile edge up --build
```

That adds `nginx` plus a placeholder `redis` container. The default fast path
stays app + Postgres so reviewers do not need extra infrastructure unless they
want to inspect the edge story. Use `http://localhost:8080` for the proxy path;
`http://localhost:3000` still talks directly to the app container.

Before paying through Checkout, confirm the sidecar secret is available:

```bash
docker compose exec app sh -lc 'test -r /run/stripe/webhook-secret && grep -q "^whsec_" /run/stripe/webhook-secret'
```

After Stripe review, `docker compose down -v` removes the database volume and
the generated local webhook secret volume.

If local port 5432 is already occupied, run Docker with `POSTGRES_PORT=5433`.
For host-side npm/Prisma commands against that database, also set
`DATABASE_URL="postgresql://seats:seats@localhost:5433/seats?schema=public"` in
`.env`. The app container still uses Docker's internal `postgres:5432` address.

## Run The App

```bash
npm ci
cp .env.example .env
docker compose up -d postgres && npm run db:generate && npm run db:deploy && npm run db:seed && npm run dev
```

Open `http://localhost:3000`.

Demo login:

- Email: `demo@example.com`
- Password: `Password123!`

With placeholder Stripe keys, the app intentionally blocks Checkout with a
configuration error instead of creating a stuck local payment. Confirmed
reservation/payment states require a real `sk_test_...` key plus webhook
forwarding.

## Optional Local Checks

If you used only the Docker fast path, run `npm ci`, copy `.env.example` to
`.env` if missing, replace `JWT_SECRET` in `.env` with `openssl rand -base64
32`, and keep Postgres running before running host-side checks.

```bash
npm run reviewer:preflight -- --allow-placeholder-stripe
npm run typecheck
npm test
npm run lint
npm run build
```

`--allow-placeholder-stripe` only relaxes Stripe-key checks. Generate a local
`JWT_SECRET` before running preflight:

```bash
openssl rand -base64 32
```

## Manual Smoke Checklist

1. Log in with the demo account.
2. Hold an available seat.
3. Register or log in as a second account in another browser/session.
4. Try to select the first user's held seat and confirm the UI refreshes to unavailable.
5. Keep placeholder Stripe keys and confirm checkout fails with a configuration message.
6. Add Stripe test keys/webhook forwarding, pay with the test card, and confirm polling stops after the terminal payment state.

## Full Stripe Checkout Verification

1. Put a Stripe test secret key in `.env`:

   ```bash
   STRIPE_SECRET_KEY="sk_test_..."
   ```

2. Start webhook forwarding. Either run `stripe login` first, or pass the API
   key directly:

   ```bash
   STRIPE_API_KEY=sk_test_... stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```

3. Copy the printed webhook secret into `.env`:

   ```bash
   STRIPE_WEBHOOK_SECRET="whsec_..."
   ```

4. Restart `npm run dev`.

5. Run the strict preflight:

   ```bash
   npm run reviewer:preflight
   ```

6. Hold an available seat, proceed to Checkout, and pay with Stripe test card
   `4242 4242 4242 4242`.

The success page polls payment status only until the backend reaches a terminal
state. Reservation creation is driven by ack-fast webhook receipt plus the
verified background worker path, not the redirect URL.

## Database Safety

`npm run test:integration` and `RUN_DB_TESTS=1 npm test` clean the configured
database. Use a dedicated test database for those commands. If they are run
against the normal local dev database, restore reviewer data with:

```bash
npm run db:seed
```

## Submission Package

```bash
npm run package:submission
```

The zip is written to:

```bash
dist/seat-reservation-platform-submission.zip
```

The package excludes `.env`, `node_modules`, `.next`, `dist`, logs, and other
local/generated files. It keeps `.env.example`, `README.md`,
`REVIEWER_HANDOFF.md`, `DECISIONS.md`, source, Prisma schema, and migrations.

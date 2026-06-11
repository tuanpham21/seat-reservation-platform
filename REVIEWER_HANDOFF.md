# Reviewer Quick Guide

The primary assessment artifacts are `README.md`, `DECISIONS.md`, and
`.env.example`. This file is only a short checklist for reviewers who want the
fastest path through setup, validation, and Stripe Checkout.

The normal app can start without real Stripe keys. The full payment flow
requires Stripe test-mode configuration and a forwarded webhook.

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
configuration error instead of creating a stuck local payment.

## Optional Local Checks

```bash
npm run reviewer:preflight -- --allow-placeholder-stripe
npm run typecheck
npm test
npm run lint
npm run build
```

## Full Stripe Checkout Verification

1. Put a Stripe test secret key in `.env`:

   ```bash
   STRIPE_SECRET_KEY="sk_test_..."
   ```

2. Start webhook forwarding:

   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
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
state. Reservation creation is driven by the verified Stripe webhook, not the
redirect URL.

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

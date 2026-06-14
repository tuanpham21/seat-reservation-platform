# Decisions

This document is a first-class reviewer artifact for the seat reservation assessment. It captures the intended architecture and tradeoffs for a public app where authenticated users reserve one of three seats after Stripe payment confirmation.

## Key Decisions

| Decision | Alternatives Considered | Why | With More Time |
| --- | --- | --- | --- |
| Next.js modular monolith with auth, seats, and payments modules | NestJS services, microservices, event-driven services | Small three-seat domain; easiest to run and review; keeps auth and concurrency fully implemented without distributed failure modes. | Extract auth or webhook processing only after measured operational pressure; add queue, replay, and dead-letter handling. |
| Postgres and Prisma as source of truth | SQLite, MySQL, MongoDB, Redis locks as authority | Seat allocation needs transactions and partial unique indexes; Prisma gives typed queries and migrations in TypeScript. | Add query-plan-driven covering indexes, archival or partitioning for webhook events, and read replicas after measurement. |
| DB-enforced seat exclusivity | UI checks, in-memory locks, Redis SETNX, broad pessimistic locks | Partial unique indexes enforce one active hold per seat, one active hold per user, and one confirmed reservation per seat; serializable retries handle races. | Escalate hot seats to row locks, advisory locks, or Redis locks when conflict rate justifies it. |
| Stripe Checkout with verified webhook fulfillment | Mock-only PSP, redirect-success fulfillment, raw card collection | Hosted Checkout lowers PCI scope; webhook is canonical and retryable; redirect is UX only. | Persist webhook receipt first, process asynchronously, add replay/dead-letter tooling and refund automation. |
| Local credentials with rotating refresh cookie | Managed IdP, refresh token in localStorage, long-lived JWT sessions | Makes security choices visible; refresh token is opaque, hashed, revocable, rotated, and stored in an HttpOnly/SameSite cookie. | Add device/session management, account recovery, Redis-backed rate limits/session cache, and managed IdP support for SSO/social login. |
| Natural/business idempotency keys | Generic client idempotency table | This flow has stable keys: hold id, payment id, Stripe Checkout Session, PaymentIntent, Stripe event id, and reservation uniqueness. | Add a generic idempotency table only when supporting multiple arbitrary payment/reservation commands. |

## 0. Run It

After cloning, the local app starts with placeholder Stripe keys in three commands:

```bash
npm ci
cp .env.example .env
docker compose up -d postgres && npm run db:generate && npm run db:deploy && npm run db:seed && npm run dev
```

Open `http://localhost:3000` and log in with `demo@example.com` / `Password123!`.
The full payment path requires Stripe test keys and a forwarded webhook; `README.md`
contains those setup steps.

Reviewer Docker path:

```bash
docker compose up --build
```

For full Stripe Checkout in Docker, provide `STRIPE_SECRET_KEY=sk_test_...` and
enable the `stripe` Compose profile. The Stripe CLI sidecar writes the generated
webhook signing secret into a Docker volume; the app reads that secret from a
file when verifying webhook signatures. Real Stripe secrets are intentionally
kept out of git and generated submission zips.

## 1. Next.js Modular Monolith

Decision: keep the app as a Next.js modular monolith instead of splitting into separate services.

Why:

- The domain is small: auth, seat inventory, holds, payments, and reservations.
- Server routes can share validation, Prisma access, and session helpers without network hops.
- A single deployment keeps the assessment easy to run and review.
- TypeScript types can stay close to the UI and server behavior.

Boundary expectation:

- UI code should live under app routes/components.
- Domain logic should be extracted into seat, payment, and auth modules rather than embedded directly in route handlers.
- Route handlers should do transport concerns: parse input, check auth, call domain functions, return typed responses.

What changes at scale:

- Move payment webhook processing behind a queue.
- Split read-heavy public seat availability from write-heavy reservation flows.
- Add an admin/back-office surface separately from the public seat reservation flow.
- Consider service extraction only after module boundaries and operational pressure justify it.

## 2. Postgres And Prisma

Decision: use Postgres as the source of truth with Prisma as the application data mapper.

Why:

- Seat allocation is relational and benefits from transactions, unique constraints, and row-level consistency.
- Prisma gives readable migrations, typed queries, and a low setup cost for a TypeScript assessment.
- Postgres supports the later path to stronger locking, advisory locks, and richer reporting.

Data ownership:

- `User` owns identity and credential/session metadata.
- `Seat` owns the public inventory.
- `SeatHold` owns temporary exclusivity before payment.
- `Reservation` owns the final confirmed booking.
- `Payment` records own Stripe correlation, business payment state, and review flags.
- `PaymentEvent` records Stripe event ids for idempotency.

What changes at scale:

- Add further covering/query-plan-driven indexes for hold expiry scans, user reservations, Stripe identifiers, and active seat availability.
- Add archival or partitioning if payment/webhook event tables grow large.
- Introduce read replicas only after the write path is stable and measured.

## 3. Stripe Checkout

Decision: use hosted Stripe Checkout rather than collecting card details directly.

Why:

- It avoids handling raw card data and keeps PCI exposure low.
- Test mode is easy for reviewers to exercise.
- Checkout sessions provide stable identifiers for idempotency and webhook reconciliation.

Fulfillment rule:

- Redirect success pages must not create reservations.
- Only verified Stripe webhook events should finalize a reservation.
- The app should verify the Stripe signature with `STRIPE_WEBHOOK_SECRET` before touching reservation state.

Webhook model:

- Store processed Stripe event IDs so repeated deliveries are harmless.
- Store Checkout Session and PaymentIntent IDs with unique constraints.
- Run payment event processing inside one database transaction.
- If the related seat hold is inactive or expired, mark payment `requires_review` and do not create a reservation.

What changes at scale:

- Persist webhook receipt first, then process asynchronously.
- Add dead-letter handling and replay tooling.
- Emit internal domain events after reservation confirmation.

## 4. Auth And Sessions

Decision: keep auth local to the app for the assessment, using password hashing, short-lived bearer access tokens, and revocable rotating user sessions.

Why:

- `argon2` is already available for password hashing.
- `jose` supports short-lived signed access tokens without adding a larger auth framework.
- A local implementation makes the security choices visible to reviewers.

Tradeoffs:

- The refresh token is opaque and stored only in an `HttpOnly`, `SameSite=Strict` cookie scoped to `/api/auth`.
- The refresh cookie is `Secure` for HTTPS and production deployments, with an explicit local HTTP override for reviewer Docker runs.
- Only the refresh token hash and CSRF token hash are stored in Postgres.
- Access tokens are bearer JWTs with `sub`, `email`, and `sessionFamilyId`, expiring after roughly 15 minutes.
- Refresh rotation is atomic. Presenting a revoked or rotated refresh token revokes the entire token family.
- Business API bearer checks verify that the token family still has an active unrevoked user session, so logout or token-family theft detection invalidates outstanding access tokens before their natural expiry.
- Cookie-auth endpoints require a CSRF header token returned from login/register/refresh.
- Business APIs require `Authorization: Bearer <accessToken>` and do not use the refresh cookie.
- The browser stores only the short-lived access token and CSRF token in `sessionStorage`, and clears/migrates the legacy local-storage key on startup. A production app would further reduce browser token exposure with stronger client hardening and a fuller auth architecture.
- Argon2 password verification is intentionally CPU-expensive. The assessment uses in-process rate limiting; multi-instance production should move auth rate limits to Redis or an edge limiter.

What changes at scale:

- Add device/session management and user-visible session revocation.
- Replace in-memory auth rate limiting with Redis or an edge rate limiter.
- Consider a managed identity provider if social login, enterprise SSO, or account recovery requirements expand.

## 5. Seat Concurrency

Decision: the database owns exclusivity; the UI is never trusted for seat availability.

Expected model:

- Creating a hold should happen in a transaction.
- A seat can have at most one active hold.
- An authenticated user can have at most one active hold.
- A seat can have at most one confirmed reservation.
- Expired holds should be ignored during availability checks and cleaned up opportunistically or by a scheduled job.

Implementation options:

- Use conditional writes or unique indexes to prevent duplicate active holds.
- Use transactions around hold creation and reservation confirmation.
- For heavier contention, use Postgres row locks or advisory locks around the seat ID.

Failure behavior:

- If a hold expires before payment confirmation, the webhook should not create a reservation.
- If payment succeeds after expiry, the app should record the payment state and surface a support/refund path rather than silently double-book.

Reviewer answer: two users racing for the same seat enter a serializable
transaction after expired holds are cleaned up. Postgres partial unique indexes
enforce one active hold per seat, one active hold per user, and one confirmed
reservation per seat. The loser receives a conflict/unavailable response; the UI
is never the authority. A paid webhook only converts an active, unexpired hold.
Failed/expired payments currently rely on hold TTL and lazy cleanup rather than
immediate server-side release; explicit payment-failure release is intentionally
deferred.

## 6. Idempotency

Decision: every payment-facing mutation should be retry-safe.

Required safeguards:

- Stripe event IDs should be processed once.
- Checkout Session and PaymentIntent IDs should be unique in the database.
- Reservation creation should be guarded by a unique seat reservation constraint.
- Checkout creation reuses an existing active checkout for the same hold instead of creating duplicates.
- Stripe webhook fulfillment validates the stored Checkout Session ID when present, metadata identifiers, expected amount/currency, `client_reference_id`, and test-mode event status before mutating business state.
- Serializable transactions are retried a small number of times for retryable Postgres serialization/deadlock failures.

Natural/business idempotency in this implementation:

- The app does not add a generic client-supplied `idempotency_key` column.
- Checkout creation is keyed by the active seat hold. The database allows only one active checkout per hold, and the Stripe API call uses `seat-hold:{holdId}` as the provider idempotency key.
- Webhook processing is keyed by Stripe event ID, while Checkout Session and PaymentIntent IDs are unique.
- Reservation fulfillment is guarded by unique `seatHoldId` plus the confirmed-seat partial unique index.
- This deliberately avoids duplicating narrower business invariants with a generic idempotency table. A generic table becomes useful when the API supports multiple arbitrary payment/reservation commands with no stable business key.

Why:

- Stripe webhooks can be retried.
- Users can double-click, refresh, or retry network requests.
- Deployment restarts can happen between payment creation and webhook completion.

## 7. What's Intentionally Missing

Known acceptable shortcuts and intentionally deferred production work for this assessment:

- Small fixed public inventory rather than a generalized venue/seat-map model.
- Fixed pricing at USD 50.00 through a small pricing module. Dynamic amount/currency is future work.
- Minimal seed data: exactly three seats and one demo authenticated user.
- Local credentials auth rather than a full identity provider.
- No email verification, password reset, account recovery, or email receipt flow.
- In-memory rate limiting for login/register/refresh.
- Lazy seat hold cleanup instead of a scheduled cleanup worker.
- Basic polling or server-rendered refreshes instead of realtime availability.
- Docker Compose reviewer setup instead of production-grade ingress, secret management, and CI/CD.
- No production refund automation. Payments that succeed after hold expiry are marked `requires_review` for support/refund handling.
- Simple operational scripts instead of a full CI/CD pipeline.
- No dynamic currency or price books.

Shortcuts that should not be taken:

- Do not fulfill reservations from Checkout redirect URLs.
- Do not trust client-submitted prices or seat availability.
- Do not store live Stripe keys or real secrets.
- Do not rely on in-memory locks for reservation correctness.

## 8. Higher-Scale Path

If the product grew beyond the assessment:

- Add a background worker for hold expiry, webhook processing, and email receipts.
- Add observability around checkout creation, webhook receipt, reservation success, and hold expiry.
- Add abuse protection around auth and hold creation.
- Add admin tooling for refunds, manual releases, and customer support.
- Move from fixed seats to event/venue inventory with seat maps and price books.
- Add load tests around concurrent hold and reservation creation.

## 9. Failure Paths To Test

- Placeholder Stripe keys block checkout before creating a stuck local payment.
- Missing webhook forwarding blocks checkout with a configuration error once a real-shaped `sk_test_...` key is configured.
- `RUN_DB_TESTS=1 npm test` verifies concurrent hold races, refresh-token reuse, duplicate Stripe webhook handling, hold replacement, and paid-after-expiry review behavior.
- Success redirects do not fulfill reservations; only verified Stripe webhooks do.
- Webhook validation mismatches, expired/inactive holds after payment, and already-reserved seats are recorded as `requires_review` rather than silently confirming a reservation.
- A process crash after Stripe creates a Checkout Session but before `checkoutUrl` is persisted can leave an initializing local payment; retry surfaces `checkout_initializing` rather than creating another active checkout. Production would add reconciliation/replay tooling.

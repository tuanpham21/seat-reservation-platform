# Decisions

This document is a first-class reviewer artifact for the seat reservation assessment. It captures the intended architecture and tradeoffs for a public app where authenticated users reserve one of three seats after Stripe payment confirmation.

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

- Add explicit indexes for hold expiry scans, user reservations, Stripe identifiers, and active seat availability.
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
- Only the refresh token hash and CSRF token hash are stored in Postgres.
- Access tokens are bearer JWTs with `sub`, `email`, and `sessionFamilyId`, expiring after roughly 15 minutes.
- Refresh rotation is atomic. Presenting a revoked or rotated refresh token revokes the entire token family.
- Business API bearer checks verify that the token family still has an active unrevoked user session, so logout or token-family theft detection invalidates outstanding access tokens before their natural expiry.
- Cookie-auth endpoints require a CSRF header token returned from login/register/refresh.
- Business APIs require `Authorization: Bearer <accessToken>` and do not use the refresh cookie.
- The browser stores the access token and CSRF token in local storage for assessment simplicity. A production app would revisit this UX/security tradeoff with stronger client hardening.

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

## 6. Idempotency

Decision: every payment-facing mutation should be retry-safe.

Required safeguards:

- Stripe event IDs should be processed once.
- Checkout Session and PaymentIntent IDs should be unique in the database.
- Reservation creation should be guarded by a unique seat reservation constraint.
- Checkout creation reuses an existing active checkout for the same hold instead of creating duplicates.
- Stripe webhook fulfillment validates the stored Checkout Session ID when present, metadata identifiers, expected amount/currency, `client_reference_id`, and test-mode event status before mutating business state.
- Serializable transactions are retried a small number of times for retryable Postgres serialization/deadlock failures.

Why:

- Stripe webhooks can be retried.
- Users can double-click, refresh, or retry network requests.
- Deployment restarts can happen between payment creation and webhook completion.

## 7. Assessment Shortcuts

Known acceptable shortcuts for this assessment:

- Small fixed public inventory rather than a generalized venue/seat-map model.
- Fixed pricing at USD 50.00 through a small pricing module. Dynamic amount/currency is future work.
- Minimal seed data: exactly three seats and one demo authenticated user.
- Local credentials auth rather than a full identity provider.
- No email verification, password reset, account recovery, or email receipt flow.
- In-memory rate limiting for login/register/refresh.
- Lazy seat hold cleanup instead of a scheduled cleanup worker.
- Basic polling or server-rendered refreshes instead of realtime availability.
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

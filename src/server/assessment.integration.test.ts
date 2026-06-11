import { PaymentStatus, SeatHoldStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { prisma } from "@/server/prisma";
import { hashPassword } from "./auth/passwords";
import { refreshUserSession, registerUser } from "./auth/service";
import { hashToken } from "./auth/tokens";
import { processStripeWebhookEvent } from "./payments/webhook";
import { holdSeat } from "./seats/service";

const runDbTests = process.env.RUN_DB_TESTS === "1";
const describeDb = runDbTests ? describe : describe.skip;

describeDb("assessment integration requirements", () => {
  beforeEach(async () => {
    await cleanDatabase();
    await seedSeats();
  });

  it("allows only one concurrent active hold for the same seat", async () => {
    const [firstUser, secondUser] = await Promise.all([
      createUser("first@example.com"),
      createUser("second@example.com")
    ]);

    const results = await Promise.allSettled([
      holdSeat({ seatId: "seat-1", userId: firstUser.id }),
      holdSeat({ seatId: "seat-1", userId: secondUser.id })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(
      prisma.seatHold.count({
        where: {
          seatId: "seat-1",
          status: SeatHoldStatus.active
        }
      })
    ).resolves.toBe(1);
  });

  it("rotates one concurrent refresh and treats reuse as family theft", async () => {
    const session = await registerUser("refresh@example.com", "Password123!");

    const results = await Promise.allSettled([
      refreshUserSession(session.refreshToken, session.csrfToken),
      refreshUserSession(session.refreshToken, session.csrfToken)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const oldSession = await prisma.userSession.findUniqueOrThrow({
      where: { refreshTokenHash: hashToken(session.refreshToken) }
    });
    const family = await prisma.userSession.findMany({
      where: { sessionFamilyId: oldSession.sessionFamilyId }
    });

    expect(family.length).toBeGreaterThanOrEqual(2);
    expect(family.every((record) => record.revokedAt)).toBe(true);
  });

  it("processes a duplicate Stripe event once", async () => {
    const user = await createUser("stripe@example.com");
    const hold = await holdSeat({ seatId: "seat-1", userId: user.id });
    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        seatHoldId: hold.hold.id,
        amountCents: 5000,
        currency: "usd",
        status: PaymentStatus.checkout_created,
        metadata: { pricing: "fixed_usd_50" }
      }
    });
    await prisma.payment.update({
      where: { id: payment.id },
      data: { stripeCheckoutSessionId: "cs_test_duplicate" }
    });
    const event = checkoutCompletedEvent(payment.id, hold.hold.id, user.id);

    await expect(processStripeWebhookEvent(event)).resolves.toMatchObject({
      status: "processed",
      action: "reservation_finalized"
    });
    await expect(processStripeWebhookEvent(event)).resolves.toMatchObject({
      status: "duplicate"
    });

    await expect(prisma.paymentEvent.count({ where: { stripeEventId: event.id } })).resolves.toBe(1);
    await expect(prisma.reservation.count({ where: { seatHoldId: hold.hold.id } })).resolves.toBe(1);
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).resolves.toMatchObject({
      status: PaymentStatus.succeeded
    });
  });

  it("replaces a user's active hold when they choose another seat", async () => {
    const user = await createUser("replace@example.com");

    const first = await holdSeat({ seatId: "seat-1", userId: user.id });
    const second = await holdSeat({ seatId: "seat-2", userId: user.id });

    expect(first.replacedHoldId).toBeNull();
    expect(second.replacedHoldId).toBe(first.hold.id);

    const holds = await prisma.seatHold.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" }
    });

    expect(holds).toHaveLength(2);
    expect(holds[0].status).toBe(SeatHoldStatus.released);
    expect(holds[1].status).toBe(SeatHoldStatus.active);
    expect(holds.filter((record) => record.status === SeatHoldStatus.active)).toHaveLength(1);
  });

  it("marks a paid checkout that succeeds after hold expiry as requires_review", async () => {
    const user = await createUser("late-success@example.com");
    const hold = await holdSeat({ seatId: "seat-1", userId: user.id, now: new Date("2026-06-11T00:00:00.000Z"), ttlMs: 60_000 });
    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        seatHoldId: hold.hold.id,
        amountCents: 5000,
        currency: "usd",
        status: PaymentStatus.checkout_created,
        metadata: { pricing: "fixed_usd_50" },
        stripeCheckoutSessionId: "cs_test_late_success"
      }
    });
    const expiredEvent = checkoutCompletedEvent(payment.id, hold.hold.id, user.id, "cs_test_late_success");

    const result = await processStripeWebhookEvent(expiredEvent, {
      now: new Date("2026-06-11T00:11:00.000Z")
    });

    expect(result).toMatchObject({
      status: "processed",
      action: "marked_requires_review"
    });
    await expect(prisma.reservation.count({ where: { seatHoldId: hold.hold.id } })).resolves.toBe(0);
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).resolves.toMatchObject({
      status: PaymentStatus.requires_review
    });
  });
});

async function cleanDatabase() {
  await prisma.paymentEvent.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.seatHold.deleteMany();
  await prisma.userSession.deleteMany();
  await prisma.user.deleteMany();
  await prisma.seat.deleteMany();
}

async function seedSeats() {
  await prisma.seat.createMany({
    data: [
      { id: "seat-1", label: "Seat 1", sortOrder: 1 },
      { id: "seat-2", label: "Seat 2", sortOrder: 2 },
      { id: "seat-3", label: "Seat 3", sortOrder: 3 }
    ]
  });
}

async function createUser(email: string) {
  return prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword("Password123!")
    }
  });
}

function checkoutCompletedEvent(
  paymentId: string,
  holdId: string,
  userId: string,
  checkoutSessionId = "cs_test_duplicate"
) {
  return {
    id: "evt_duplicate_test",
    object: "event",
    type: "checkout.session.completed",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: checkoutSessionId,
        object: "checkout.session",
        payment_status: "paid",
        status: "complete",
        payment_intent: "pi_test_duplicate",
        client_reference_id: paymentId,
        amount_total: 5000,
        currency: "usd",
        metadata: {
          payment_id: paymentId,
          hold_id: holdId,
          user_id: userId
        }
      }
    }
  } as unknown as Stripe.Event;
}

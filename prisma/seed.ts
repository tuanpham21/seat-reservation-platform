import { PrismaClient } from "@prisma/client";
import { SEED_SEATS } from "../src/server/seats/catalog";
import { hashPassword } from "../src/server/auth/passwords";

const prisma = new PrismaClient();

async function main() {
  const demoPasswordHash = await hashPassword("Password123!");

  await prisma.$transaction(async (tx) => {
    await tx.seat.deleteMany({
      where: {
        id: {
          notIn: SEED_SEATS.map((seat) => seat.id)
        }
      }
    });

    for (const seat of SEED_SEATS) {
      await tx.seat.upsert({
        where: { id: seat.id },
        update: {
          label: seat.label,
          sortOrder: seat.sortOrder,
          isEnabled: true
        },
        create: {
          id: seat.id,
          label: seat.label,
          sortOrder: seat.sortOrder,
          isEnabled: true
        }
      });
    }

    await tx.user.upsert({
      where: { email: "demo@example.com" },
      update: {
        passwordHash: demoPasswordHash
      },
      create: {
        email: "demo@example.com",
        passwordHash: demoPasswordHash
      }
    });
  });

  console.log(`Seeded ${SEED_SEATS.length} seats and demo@example.com.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});

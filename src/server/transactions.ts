import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export const SERIALIZABLE_TRANSACTION = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable
} as const;

export async function runSerializableTransaction<T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  maxAttempts = 3
) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(callback, SERIALIZABLE_TRANSACTION);
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === maxAttempts) {
        throw error;
      }
    }
  }

  throw lastError;
}

export function isRetryableTransactionError(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  return error.code === "P2034" || error.meta?.code === "40001" || error.meta?.code === "40P01";
}

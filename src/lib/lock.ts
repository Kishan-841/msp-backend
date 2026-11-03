import { prisma } from './prisma.js';

/**
 * Runs `fn` while holding Postgres advisory locks on `keys` (e.g. "quote:<id>").
 *
 * Money actions follow check-then-write ("is there still enough left to bill / pay?"). Without
 * a lock, two quick clicks both pass the check and both write — an invoice billed twice, a
 * payment above what's owed. Requests for the same key now queue: the second one runs its
 * check only after the first has finished writing.
 *
 * The lock lives in a transaction that stays open while `fn` runs (fn itself uses the normal
 * client), so it works across server instances too. Keys are locked in sorted order to avoid
 * deadlocks when one action needs two (e.g. an advance and an invoice).
 */
export async function withLock<T>(keys: string | string[], fn: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(Array.isArray(keys) ? keys : [keys])].sort();
  return prisma.$transaction(
    async (tx) => {
      for (const key of sorted) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      }
      return fn();
    },
    { maxWait: 10_000, timeout: 30_000 }
  );
}

import { Prisma } from '../generated/prisma/client.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Indian financial year (1 Apr – 31 Mar, in IST) as "2026-27" */
export function financialYear(date: Date = new Date()): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const startYear = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Today's date in IST as YYYYMMDD — for QT-/PO- numbers (the server may run in UTC) */
export function istDateStamp(date: Date = new Date()): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}${String(ist.getUTCMonth() + 1).padStart(2, '0')}${String(ist.getUTCDate()).padStart(2, '0')}`;
}

/** A unique-constraint error on this particular column (not, say, a duplicate vendor invoice no.) */
function isDuplicateOf(err: unknown, field: string) {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  return JSON.stringify(err.meta ?? {}).includes(field);
}

/**
 * Creates a record with the next number in a series: takes the highest existing number with
 * `series` as prefix (not a count — counts break when records are deleted) and retries if
 * another request grabbed the same number. Only a duplicate on `field` is retried; any other
 * unique clash is a real conflict and is thrown.
 */
async function createWithNextNumber<T>(
  series: string,
  field: string,
  latestNumber: (startsWith: string) => Promise<string | null>,
  create: (number: string) => Promise<T>
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const latest = await latestNumber(series);
    const next = latest ? Number(latest.slice(series.length)) + 1 : 1;
    try {
      return await create(`${series}${String(next).padStart(4, '0')}`);
    } catch (err) {
      if (!isDuplicateOf(err, field)) throw err;
    }
  }
  throw new Error(`Could not allocate a number in ${series} — please retry.`);
}

/**
 * Per-financial-year series, e.g. INV/2026-27/0007. GST requires invoice numbers to be unique
 * and consecutive within a financial year.
 */
export function createWithFyNumber<T>(
  prefix: string,
  date: Date,
  latestNumber: (startsWith: string) => Promise<string | null>,
  create: (number: string) => Promise<T>,
  field = 'number'
): Promise<T> {
  return createWithNextNumber(`${prefix}/${financialYear(date)}/`, field, latestNumber, create);
}

/** Per-day series in IST, e.g. QT-20261029-0003 */
export function createWithDailyNumber<T>(
  prefix: string,
  latestNumber: (startsWith: string) => Promise<string | null>,
  create: (number: string) => Promise<T>,
  field: string
): Promise<T> {
  return createWithNextNumber(`${prefix}-${istDateStamp()}-`, field, latestNumber, create);
}

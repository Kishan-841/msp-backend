import cron from 'node-cron';
import { basePrisma } from '../lib/prisma.js';
import { auditContext } from '../lib/auditContext.js';
import { withLock } from '../lib/lock.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { PageParams } from '../utils/paginate.js';
import { envelope } from '../utils/paginate.js';

// System log — reading it, and the sign-in events (record changes are captured automatically
// in lib/auditCapture.ts).

export type AuthAction = 'LOGIN' | 'LOGIN_FAILED' | 'LOGIN_BLOCKED' | 'LOGOUT' | 'SESSION_REVOKED';

/** Sign-in / sign-out events. Never throws — a log failure must not break logging in. */
export async function recordAuthEvent(
  action: AuthAction,
  who: { id?: string | null; name?: string | null; email?: string | null; role?: string | null },
  meta?: Record<string, unknown>
) {
  const ctx = auditContext();
  try {
    await basePrisma.auditLog.create({
      data: {
        category: 'AUTH',
        action,
        actorId: who.id ?? null,
        actorName: who.name ?? who.email ?? 'Unknown',
        actorEmail: who.email ?? null,
        actorRole: who.role ?? null,
        entityType: 'User',
        entityId: who.id ?? null,
        entityLabel: who.name ?? who.email ?? null,
        meta: meta as object | undefined,
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
      },
    });
  } catch (err) {
    console.error('Audit log write failed', err);
  }
}

export interface AuditFilters {
  search?: string;
  category?: string;
  action?: string;
  actorId?: string;
  leadId?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
}

function where(f: AuditFilters): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [];
  if (f.category) and.push({ category: f.category });
  if (f.action) and.push({ action: f.action });
  if (f.actorId) and.push({ actorId: f.actorId });
  if (f.leadId) and.push({ leadId: f.leadId });
  if (f.entityType) and.push({ entityType: f.entityType });
  if (f.entityId) and.push({ entityId: f.entityId });
  if (f.from || f.to) and.push({ createdAt: { ...(f.from && { gte: f.from }), ...(f.to && { lt: f.to }) } });
  if (f.search) {
    const q = { contains: f.search, mode: 'insensitive' as const };
    and.push({
      OR: [{ actorName: q }, { actorEmail: q }, { entityLabel: q }, { entityId: f.search }, { ip: { startsWith: f.search } }],
    });
  }
  return { AND: and };
}

export async function listLogs(f: AuditFilters, p: PageParams) {
  const w = where(f);
  const [items, total] = await Promise.all([
    basePrisma.auditLog.findMany({ where: w, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.limit }),
    basePrisma.auditLog.count({ where: w }),
  ]);
  return envelope(items, total, p);
}

/** Up to `max` rows for a CSV download */
export function exportLogs(f: AuditFilters, max = 10_000) {
  return basePrisma.auditLog.findMany({ where: where(f), orderBy: { createdAt: 'desc' }, take: max });
}

/** People who appear in the log — for the "who" filter (includes deleted users) */
export async function listActors() {
  const rows = await basePrisma.auditLog.groupBy({
    by: ['actorId', 'actorName', 'actorRole'],
    where: { actorId: { not: null } },
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: 'desc' } },
    take: 300,
  });
  // one row per person (their latest name / role)
  const seen = new Set<string>();
  return rows
    .filter((r) => r.actorId && !seen.has(r.actorId) && seen.add(r.actorId))
    .map((r) => ({ id: r.actorId!, name: r.actorName ?? 'Unknown', role: r.actorRole }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Retention: entries older than AUDIT_RETENTION_DAYS (default 365) are removed nightly.
const RETENTION_DAYS = Math.max(30, parseInt(process.env.AUDIT_RETENTION_DAYS || '365', 10) || 365);

export async function pruneOldLogs() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  const { count } = await basePrisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (count) console.log(`System log: removed ${count} entr${count === 1 ? 'y' : 'ies'} older than ${RETENTION_DAYS} days`);
}

export function startAuditJobs() {
  cron.schedule(
    '30 3 * * *',
    () => void withLock('audit-prune', pruneOldLogs).catch((err) => console.error('System log cleanup failed', err)),
    { timezone: 'Asia/Kolkata' }
  );
}

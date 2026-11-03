import type { PrismaClient } from '../generated/prisma/client.js';
import { auditContext } from './auditContext.js';

// Records every create / update / delete on business records into AuditLog, with the values
// before and after — done once here, in the Prisma client, so no service can forget it.
// Writes go through the plain client (no recursion) and don't hold up the request.

/** Prisma model → log category. Models not listed (sessions, notifications, the activity
 *  timeline, the log itself) are not audited. */
const CATEGORY: Record<string, string> = {
  Lead: 'LEAD',
  Meeting: 'MEETING',
  Quote: 'QUOTE',
  PurchaseOrder: 'PURCHASE_ORDER',
  SalesInvoice: 'ACCOUNTS',
  PurchaseInvoice: 'ACCOUNTS',
  Payment: 'ACCOUNTS',
  PaymentAllocation: 'ACCOUNTS',
  AdjustmentNote: 'ACCOUNTS',
  User: 'USER',
  Vendor: 'VENDOR',
  Material: 'MATERIAL',
  CompanySettings: 'SETTINGS',
  IntegrationClient: 'SETTINGS',
  Attachment: 'FILE',
};

const WRITES = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

/** Never compared / stored */
const IGNORE = new Set(['updatedAt', 'createdAt']);
const IGNORE_BY_MODEL: Record<string, string[]> = { IntegrationClient: ['lastUsedAt'] };

/** Stored only as "changed" — the value itself must never be in a log */
const SECRET = new Set(['password', 'keyHash']);
const MAX_VALUE_CHARS = 20_000;
const MAX_BULK_ROWS = 500;

type Row = Record<string, unknown>;
type Change = { from: unknown; to: unknown; fromLabel?: string | null; toLabel?: string | null };

const lowerFirst = (s: string) => s[0].toLowerCase() + s.slice(1);

/** Dates → ISO, Decimals → strings, JSON stays JSON */
function plain(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  return JSON.parse(JSON.stringify(v));
}

function storable(field: string, v: unknown): unknown {
  if (v === null) return null;
  if (SECRET.has(field)) return '••••••';
  if (field === 'logoDataUrl' && typeof v === 'string') return '[image]';
  const s = JSON.stringify(v);
  return s.length > MAX_VALUE_CHARS ? `[${Math.round(s.length / 1024)} KB of data]` : v;
}

const isEmpty = (v: unknown) => v === null || (Array.isArray(v) && v.length === 0) || v === '';

function diff(model: string, before: Row | null, after: Row | null): Record<string, Change> {
  const skip = new Set([...IGNORE, ...(IGNORE_BY_MODEL[model] ?? [])]);
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: Record<string, Change> = {};
  for (const k of keys) {
    if (skip.has(k)) continue;
    const a = plain(before?.[k]);
    const b = plain(after?.[k]);
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    // a new record: list what was filled in; a deleted one: what it held
    if (!before && isEmpty(b)) continue;
    if (!after && isEmpty(a)) continue;
    out[k] = { from: storable(k, a), to: storable(k, b) };
  }
  return out;
}

function entityLabel(model: string, row: Row | null): string | null {
  if (!row) return null;
  const pick = (...f: string[]) => f.map((k) => row[k]).find((v) => typeof v === 'string' && v) as string | undefined;
  switch (model) {
    case 'Lead':
      return pick('companyName') ?? null;
    case 'Quote':
      return pick('quoteNumber') ?? null;
    case 'PurchaseOrder':
      return pick('poNumber') ?? null;
    case 'SalesInvoice':
      return pick('invoiceNumber') ?? null;
    case 'PurchaseInvoice':
      return pick('billNumber', 'vendorInvoiceNumber') ?? null;
    case 'Payment':
    case 'AdjustmentNote':
      return pick('number') ?? null;
    case 'User':
      return [pick('name'), pick('email') && `(${row.email})`].filter(Boolean).join(' ') || null;
    case 'Attachment':
      return pick('originalName') ?? null;
    case 'CompanySettings':
      return 'Company settings';
    case 'Meeting':
      return row.meetingDate ? `Meeting ${new Date(row.meetingDate as string).toISOString().slice(0, 10)}` : 'Meeting';
    default:
      return pick('name', 'number') ?? null;
  }
}

function leadIdOf(model: string, row: Row | null): string | null {
  if (!row) return null;
  if (model === 'Lead') return (row.id as string) ?? null;
  return typeof row.leadId === 'string' ? row.leadId : null;
}

// ids → names, so the log says "Assigned to: Priya" rather than a uuid
const USER_REF = /(ById|^assignedToId|^mspTlId|^userId|^systemUserId)$/;

async function addLabels(base: PrismaClient, changes: Record<string, Change>[]) {
  const userIds = new Set<string>();
  const vendorIds = new Set<string>();
  const leadIds = new Set<string>();
  const each = (fn: (field: string, v: unknown) => void) => {
    for (const c of changes) for (const [f, ch] of Object.entries(c)) [ch.from, ch.to].forEach((v) => fn(f, v));
  };
  each((f, v) => {
    if (typeof v !== 'string') return;
    if (USER_REF.test(f)) userIds.add(v);
    else if (f === 'vendorId') vendorIds.add(v);
    else if (f === 'leadId') leadIds.add(v);
  });
  if (!userIds.size && !vendorIds.size && !leadIds.size) return;
  const [users, vendors, leads] = await Promise.all([
    userIds.size ? base.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } }) : [],
    vendorIds.size ? base.vendor.findMany({ where: { id: { in: [...vendorIds] } }, select: { id: true, name: true } }) : [],
    leadIds.size ? base.lead.findMany({ where: { id: { in: [...leadIds] } }, select: { id: true, companyName: true } }) : [],
  ]);
  const name = new Map<string, string>([
    ...users.map((u) => [u.id, u.name] as [string, string]),
    ...vendors.map((v) => [v.id, v.name] as [string, string]),
    ...leads.map((l) => [l.id, l.companyName] as [string, string]),
  ]);
  for (const c of changes)
    for (const [f, ch] of Object.entries(c)) {
      if (!(USER_REF.test(f) || f === 'vendorId' || f === 'leadId')) continue;
      if (typeof ch.from === 'string') ch.fromLabel = name.get(ch.from) ?? null;
      if (typeof ch.to === 'string') ch.toLabel = name.get(ch.to) ?? null;
    }
}

async function record(
  base: PrismaClient,
  model: string,
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  pairs: { before: Row | null; after: Row | null }[],
  meta?: Record<string, unknown>
) {
  const ctx = auditContext();
  const entries = pairs
    .map(({ before, after }) => ({ before, after, changes: diff(model, before, after) }))
    .filter((e) => action !== 'UPDATE' || Object.keys(e.changes).length > 0); // nothing really changed
  if (!entries.length) return;
  await addLabels(base, entries.map((e) => e.changes));
  const actor = ctx?.actor;
  await base.auditLog.createMany({
    data: entries.map(({ before, after, changes }) => {
      const row = after ?? before;
      return {
        category: CATEGORY[model],
        action,
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? 'System',
        actorEmail: actor?.email ?? null,
        actorRole: actor?.role ?? 'SYSTEM',
        entityType: model,
        entityId: row?.id != null ? String(row.id) : null,
        entityLabel: entityLabel(model, row),
        leadId: leadIdOf(model, after) ?? leadIdOf(model, before),
        changes: changes as object,
        meta: meta as object | undefined,
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
      };
    }),
  });
}

/** The client every service uses: the plain client plus change capture */
export function withAudit(base: PrismaClient) {
  return base.$extends({
    name: 'audit',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!CATEGORY[model] || !WRITES.has(operation) || auditContext()?.skip) return query(args);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const delegate = (base as any)[lowerFirst(model)];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const a = args as any;
          const log = (p: Promise<unknown>) => p.catch((err) => console.error('Audit log write failed', err));

          // ---- one record
          if (operation === 'create' || operation === 'update' || operation === 'upsert' || operation === 'delete') {
            const before: Row | null = operation === 'create' ? null : await delegate.findUnique({ where: a.where }).catch(() => null);
            const result = (await query(args)) as Row | null;
            if (operation === 'delete') {
              void log(record(base, model, 'DELETE', [{ before, after: null }]));
              return result;
            }
            // the call may have selected only a few fields — read the full row for the log
            const id = result?.id ?? before?.id;
            void log(
              (async () => {
                const after: Row | null = id != null ? await delegate.findUnique({ where: { id } }) : result;
                await record(base, model, before ? 'UPDATE' : 'CREATE', [{ before, after }]);
              })()
            );
            return result;
          }

          // ---- many records
          if (operation === 'updateMany' || operation === 'updateManyAndReturn' || operation === 'deleteMany') {
            const befores: Row[] = await delegate.findMany({ where: a.where, take: MAX_BULK_ROWS });
            const result = await query(args);
            if (!befores.length) return result;
            void log(
              (async () => {
                if (operation === 'deleteMany') {
                  await record(base, model, 'DELETE', befores.map((b) => ({ before: b, after: null })));
                  return;
                }
                const afters: Row[] = await delegate.findMany({ where: { id: { in: befores.map((b) => b.id) } } });
                const byId = new Map(afters.map((r) => [r.id, r]));
                await record(base, model, 'UPDATE', befores.map((b) => ({ before: b, after: byId.get(b.id) ?? null })));
              })()
            );
            return result;
          }

          // createMany / createManyAndReturn
          const result = await query(args);
          const rows: Row[] = Array.isArray(result) ? (result as Row[]) : (Array.isArray(a.data) ? a.data : [a.data]);
          void log(record(base, model, 'CREATE', rows.map((r) => ({ before: null, after: r }))));
          return result;
        },
      },
    },
  });
}

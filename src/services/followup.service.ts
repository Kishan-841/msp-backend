import type { Prisma, UserRole } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { envelope, startOfTodayIST, type PageParams } from '../utils/paginate.js';
import { assertLeadOpen, assertQuoteAccess, assertSalesInvoiceAccess, leadVisibility, type Actor } from './access.service.js';

// Follow-ups: everything stuck, per role, with how many days it has been waiting (oldest first).
// Each group is a query, so counts and pages come from the database. Quotes sent and overdue
// customer invoices can have a follow-up logged, which hides them until the next date.

export interface FollowUpRow {
  id: string;
  company: string;
  reference: string;
  contactPerson?: string;
  phone?: string;
  since: Date | null;
  days: number;
  amount?: number;
  owner?: string | null;
  link: string;
  canLog?: 'QUOTE' | 'INVOICE';
  lastFollowUpAt?: Date | null;
  lastFollowUpNote?: string | null;
}

/** Whole calendar days in IST since a moment (0 = today) */
function daysSince(d: Date | null | undefined) {
  if (!d) return 0;
  const ist = (x: Date) => Math.floor((x.getTime() + 330 * 60_000) / 86_400_000);
  return Math.max(0, ist(new Date()) - ist(d));
}

const leadBits = { id: true, companyName: true, contactPerson: true, phone: true, assignedTo: { select: { name: true } } } as const;
type LeadBits = { id: string; companyName: string; contactPerson: string; phone: string; assignedTo: { name: string } | null };

const fromLead = (l: LeadBits): Pick<FollowUpRow, 'company' | 'contactPerson' | 'phone' | 'owner'> => ({
  company: l.companyName,
  contactPerson: l.contactPerson,
  phone: l.phone,
  owner: l.assignedTo?.name ?? null,
});

/** Open leads the actor sees. `mine`: Sales work — an MSP TL only gets leads assigned to them
 *  (they see every lead, but only work the ones they took). */
const open = (actor: Actor, mine = false) => ({
  ...leadVisibility(actor),
  droppedAt: null,
  ...(mine && actor.role === 'MSP_TL' ? { assignedToId: actor.id } : {}),
});

interface Group {
  key: string;
  label: string;
  hint: string; // what to do
  roles: UserRole[];
  count: (a: Actor) => Promise<number>;
  rows: (a: Actor, skip: number, take: number) => Promise<FollowUpRow[]>;
}

// ── builders per record type ────────────────────────────────────────────────

function leadGroup(
  g: Pick<Group, 'key' | 'label' | 'hint' | 'roles'>,
  where: (now: Date) => Prisma.LeadWhereInput,
  since: 'createdAt' | 'updatedAt' | 'callbackAt' | 'quoteRequestedAt',
  link: (id: string) => string = (id) => `/leads/${id}/workspace`
): Group {
  const w = (a: Actor) => ({ AND: [open(a, g.roles === SALES), where(new Date())] });
  return {
    ...g,
    count: (a) => prisma.lead.count({ where: w(a) }),
    rows: async (a, skip, take) => {
      const rows = await prisma.lead.findMany({
        where: w(a),
        select: { ...leadBits, orderNo: true, createdAt: true, updatedAt: true, callbackAt: true, quoteRequestedAt: true },
        orderBy: { [since]: 'asc' },
        skip,
        take,
      });
      return rows.map((l) => ({
        id: l.id,
        ...fromLead(l),
        reference: l.orderNo > 1 ? `Order #${l.orderNo}` : '',
        since: l[since],
        days: daysSince(l[since]),
        link: link(l.id),
      }));
    },
  };
}

function quoteGroup(
  g: Pick<Group, 'key' | 'label' | 'hint' | 'roles'>,
  where: (now: Date) => Prisma.QuoteWhereInput,
  since: 'createdAt' | 'updatedAt' | 'sentAt' | 'acceptedAt',
  opts: { canLog?: boolean; link?: (q: { id: string }) => string } = {}
): Group {
  const w = (a: Actor) => ({ AND: [{ lead: open(a, g.roles === SALES) }, where(new Date())] });
  return {
    ...g,
    count: (a) => prisma.quote.count({ where: w(a) }),
    rows: async (a, skip, take) => {
      const rows = await prisma.quote.findMany({
        where: w(a),
        select: {
          id: true, quoteNumber: true, totalAmount: true, createdAt: true, updatedAt: true, sentAt: true, acceptedAt: true,
          lastFollowUpAt: true, lastFollowUpNote: true, lead: { select: leadBits },
        },
        orderBy: { [since]: 'asc' },
        skip,
        take,
      });
      return rows.map((q) => ({
        id: q.id,
        ...fromLead(q.lead),
        reference: q.quoteNumber,
        amount: q.totalAmount,
        since: q[since],
        days: daysSince(q[since]),
        link: opts.link ? opts.link(q) : `/quotes/${q.id}`,
        ...(opts.canLog ? { canLog: 'QUOTE' as const, lastFollowUpAt: q.lastFollowUpAt, lastFollowUpNote: q.lastFollowUpNote } : {}),
      }));
    },
  };
}

function poGroup(
  g: Pick<Group, 'key' | 'label' | 'hint' | 'roles'>,
  where: Prisma.PurchaseOrderWhereInput,
  since: 'updatedAt' | 'confirmedAt' | 'sentAt'
): Group {
  const w = (a: Actor) => ({ AND: [{ lead: open(a, g.roles === SALES) }, where] });
  return {
    ...g,
    count: (a) => prisma.purchaseOrder.count({ where: w(a) }),
    rows: async (a, skip, take) => {
      const rows = await prisma.purchaseOrder.findMany({
        where: w(a),
        select: {
          id: true, poNumber: true, totalAmount: true, updatedAt: true, confirmedAt: true, sentAt: true,
          vendor: { select: { name: true } }, lead: { select: leadBits },
        },
        orderBy: { [since]: 'asc' },
        skip,
        take,
      });
      return rows.map((p) => ({
        id: p.id,
        ...fromLead(p.lead),
        contactPerson: p.vendor.name,
        phone: undefined,
        reference: p.poNumber,
        amount: p.totalAmount,
        since: p[since],
        days: daysSince(p[since]),
        link: `/purchase-orders/${p.id}`,
      }));
    },
  };
}

const notSnoozed = (now: Date) => ({ OR: [{ nextFollowUpAt: null }, { nextFollowUpAt: { lte: now } }] });
const TL_ADMIN: UserRole[] = ['MSP_TL', 'ADMIN'];
// Sales work — also an MSP TL's own assigned leads (see `open`)
const SALES: UserRole[] = ['SALES', 'MSP_TL', 'ADMIN'];
const ACCOUNTS: UserRole[] = ['ACCOUNTS', 'ADMIN'];

const GROUPS: Group[] = [
  quoteGroup(
    { key: 'quotesNoResponse', label: 'Quote sent, no response', hint: 'Call the customer, then log what they said.', roles: SALES },
    (now) => ({ status: 'SENT', ...notSnoozed(now) }),
    'sentAt',
    { canLog: true }
  ),
  leadGroup(
    { key: 'callbacksDue', label: 'Call-backs overdue', hint: 'You promised to call these customers back.', roles: SALES },
    (now) => ({ status: 'ASSIGNED', callbackAt: { lte: now } }),
    'callbackAt'
  ),
  leadGroup(
    { key: 'notCalled', label: 'Assigned, never called', hint: 'Make the first call and log the outcome.', roles: SALES },
    () => ({ status: 'ASSIGNED', callbackAt: null }),
    'updatedAt'
  ),
  {
    key: 'meetingsNoMom',
    label: 'Meeting held, no MOM',
    hint: 'Add the meeting notes.',
    roles: SALES,
    count: (a) => prisma.meeting.count({ where: { momContent: null, meetingDate: { lt: new Date() }, lead: open(a, true) } }),
    rows: async (a, skip, take) => {
      const rows = await prisma.meeting.findMany({
        where: { momContent: null, meetingDate: { lt: new Date() }, lead: open(a, true) },
        select: { id: true, meetingDate: true, location: true, lead: { select: leadBits } },
        orderBy: { meetingDate: 'asc' },
        skip,
        take,
      });
      return rows.map((m) => ({
        id: m.id,
        ...fromLead(m.lead),
        reference: m.location,
        since: m.meetingDate,
        days: daysSince(m.meetingDate),
        link: `/leads/${m.lead.id}/workspace`,
      }));
    },
  },
  leadGroup(
    { key: 'requirementPending', label: 'MOM done, requirement not sent', hint: 'Send the final requirement to MSP TL.', roles: SALES },
    () => ({ status: 'MOM_ADDED' }),
    'updatedAt'
  ),
  quoteGroup(
    { key: 'quotesNotSent', label: 'Approved, not sent to customer', hint: 'Email the quote or mark it as sent.', roles: SALES },
    () => ({ status: 'APPROVED' }),
    'updatedAt'
  ),
  poGroup(
    { key: 'posNotSent', label: 'PO confirmed, not sent to vendor', hint: 'Email the PO to the vendor or mark it as sent.', roles: SALES },
    { status: 'CONFIRMED' },
    'confirmedAt'
  ),

  quoteGroup(
    { key: 'quotesToApprove', label: 'Quote waiting for approval', hint: 'Approve or reject it.', roles: ['ADMIN'] },
    () => ({ status: 'SUBMITTED' }),
    'updatedAt'
  ),

  leadGroup(
    { key: 'notCategorized', label: 'Lead not categorized', hint: 'Pick Hardware / Software and the products.', roles: TL_ADMIN },
    () => ({ category: null }),
    'createdAt',
    (id) => `/leads/${id}`
  ),
  leadGroup(
    { key: 'notAssigned', label: 'Lead not assigned', hint: 'Assign it to a Sales person.', roles: TL_ADMIN },
    () => ({ status: 'CATEGORIZED', assignedToId: null }),
    'updatedAt',
    (id) => `/leads/${id}`
  ),
  leadGroup(
    { key: 'quoteNotBuilt', label: 'Quote requested, not built', hint: 'Build the quote for Sales.', roles: TL_ADMIN },
    () => ({ status: { in: ['QUOTE_REQUESTED', 'QUOTE_REJECTED'] } }),
    'quoteRequestedAt',
    () => '/quotes?tab=pending'
  ),
  quoteGroup(
    { key: 'draftNotSubmitted', label: 'Draft quote not submitted', hint: 'Finish it and submit for approval.', roles: TL_ADMIN },
    () => ({ status: 'DRAFT' }),
    'createdAt'
  ),
  quoteGroup(
    { key: 'acceptedNoPo', label: 'Customer accepted, no PO', hint: 'Create the PO to the vendor.', roles: TL_ADMIN },
    () => ({ status: 'ACCEPTED', purchaseOrder: null }),
    'acceptedAt',
    { link: () => '/purchase-orders?tab=ready' }
  ),
  poGroup(
    { key: 'poNotFinished', label: 'PO in draft or sent back', hint: 'Fix it and send it to Accounts.', roles: TL_ADMIN },
    { status: { in: ['DRAFT', 'REJECTED'] } },
    'updatedAt'
  ),

  poGroup(
    { key: 'poToConfirm', label: 'PO waiting for confirmation', hint: 'Confirm or reject it.', roles: ACCOUNTS },
    { status: 'PENDING_ACCOUNTS' },
    'updatedAt'
  ),
  poGroup(
    { key: 'noVendorInvoice', label: 'PO sent, no vendor invoice', hint: "Chase the vendor and record their invoice.", roles: ACCOUNTS },
    { status: 'SENT_TO_VENDOR', purchaseInvoices: { none: {} } },
    'sentAt'
  ),
  quoteGroup(
    { key: 'notInvoiced', label: 'Ready to invoice, not invoiced', hint: 'Raise the customer invoice.', roles: ACCOUNTS },
    () => ({ status: 'ACCEPTED', salesInvoices: { none: {} }, lead: { status: 'PO_SENT' } }),
    'acceptedAt',
    { link: () => '/accounts?side=customers&view=ready' }
  ),
  {
    key: 'invoicesOverdue',
    label: 'Customer invoice overdue',
    hint: 'Ask the customer for payment, then log what they said.',
    roles: ACCOUNTS,
    count: (a) => prisma.salesInvoice.count({ where: invoiceWhere(a) }),
    rows: async (a, skip, take) => {
      const rows = await prisma.salesInvoice.findMany({
        where: invoiceWhere(a),
        select: {
          id: true, invoiceNumber: true, totalAmount: true, dueDate: true, lastFollowUpAt: true, lastFollowUpNote: true,
          lead: { select: leadBits },
        },
        orderBy: { dueDate: 'asc' },
        skip,
        take,
      });
      return rows.map((i) => ({
        id: i.id,
        ...fromLead(i.lead),
        reference: i.invoiceNumber,
        amount: i.totalAmount,
        since: i.dueDate,
        days: daysSince(i.dueDate),
        link: `/invoices/${i.id}`,
        canLog: 'INVOICE' as const,
        lastFollowUpAt: i.lastFollowUpAt,
        lastFollowUpNote: i.lastFollowUpNote,
      }));
    },
  },
  {
    key: 'billsOverdue',
    label: 'Vendor invoice overdue',
    hint: 'Pay it, or check why it is on hold.',
    roles: ACCOUNTS,
    count: () => prisma.purchaseInvoice.count({ where: billWhere() }),
    rows: async (_a, skip, take) => {
      const rows = await prisma.purchaseInvoice.findMany({
        where: billWhere(),
        select: { id: true, billNumber: true, totalAmount: true, dueDate: true, vendor: { select: { name: true } } },
        orderBy: { dueDate: 'asc' },
        skip,
        take,
      });
      return rows.map((b) => ({
        id: b.id,
        company: b.vendor.name,
        reference: b.billNumber,
        amount: b.totalAmount,
        since: b.dueDate,
        days: daysSince(b.dueDate),
        link: '/accounts?side=vendors&view=bills',
      }));
    },
  },
];

function invoiceWhere(a: Actor): Prisma.SalesInvoiceWhereInput {
  return {
    AND: [
      { lead: leadVisibility(a), paymentStatus: { not: 'PAID' }, dueDate: { lt: startOfTodayIST() } },
      notSnoozed(new Date()),
    ],
  };
}
const billWhere = (): Prisma.PurchaseInvoiceWhereInput => ({ paymentStatus: { not: 'PAID' }, dueDate: { lt: startOfTodayIST() } });

const groupsFor = (a: Actor) => GROUPS.filter((g) => g.roles.includes(a.role));

/** Every group this role has, with its count and how old the oldest item is */
export async function summary(actor: Actor) {
  return Promise.all(
    groupsFor(actor).map(async (g) => {
      const [count, first] = await Promise.all([g.count(actor), g.rows(actor, 0, 1)]);
      return { key: g.key, label: g.label, hint: g.hint, count, oldestDays: first[0]?.days ?? 0 };
    })
  );
}

export async function groupPage(actor: Actor, key: string, page: PageParams) {
  const g = groupsFor(actor).find((x) => x.key === key);
  if (!g) throw new AppError('Follow-up list not found.', 404);
  const [items, total] = await Promise.all([g.rows(actor, page.skip, page.limit), g.count(actor)]);
  return envelope(items, total, page);
}

/** Sent quotes that have waited 3+ days, plus overdue customer invoices — the sidebar badge */
export async function dueCount(actor: Actor) {
  const threeDaysAgo = new Date(startOfTodayIST().getTime() - 3 * 86_400_000 + 86_400_000);
  const [quotes, invoices] = await Promise.all([
    actor.role === 'SALES' || actor.role === 'MSP_TL' || actor.role === 'ADMIN'
      ? prisma.quote.count({
          where: { AND: [{ lead: open(actor, true) }, { status: 'SENT', sentAt: { lt: threeDaysAgo } }, notSnoozed(new Date())] },
        })
      : 0,
    actor.role === 'ACCOUNTS' || actor.role === 'ADMIN' ? prisma.salesInvoice.count({ where: invoiceWhere(actor) }) : 0,
  ]);
  return quotes + invoices;
}

// ── Logging a follow-up ─────────────────────────────────────────────────────

const when = (d?: string) => (d ? new Date(`${d}T00:00:00+05:30`) : null);

export async function logQuoteFollowUp(actor: Actor, id: string, input: { note: string; nextDate?: string }) {
  await assertQuoteAccess(actor, id, 'sales');
  const quote = await prisma.quote.findUniqueOrThrow({ where: { id }, select: { status: true, leadId: true, quoteNumber: true } });
  await assertLeadOpen(quote.leadId);
  if (quote.status !== 'SENT') throw new AppError('Only a quote waiting for the customer can have a follow-up.', 400);
  const updated = await prisma.quote.update({
    where: { id },
    data: { lastFollowUpAt: new Date(), lastFollowUpNote: input.note, nextFollowUpAt: when(input.nextDate) },
    select: { id: true, lastFollowUpAt: true, nextFollowUpAt: true },
  });
  await prisma.activityLog.create({
    data: { leadId: quote.leadId, userId: actor.id, action: `Followed up on quote ${quote.quoteNumber}`, details: input.note },
  });
  return updated;
}

export async function logInvoiceFollowUp(actor: Actor, id: string, input: { note: string; nextDate?: string }) {
  await assertSalesInvoiceAccess(actor, id);
  const inv = await prisma.salesInvoice.findUniqueOrThrow({ where: { id }, select: { paymentStatus: true, leadId: true, invoiceNumber: true } });
  if (inv.paymentStatus === 'PAID') throw new AppError('This invoice is already paid.', 400);
  const updated = await prisma.salesInvoice.update({
    where: { id },
    data: { lastFollowUpAt: new Date(), lastFollowUpNote: input.note, nextFollowUpAt: when(input.nextDate) },
    select: { id: true, lastFollowUpAt: true, nextFollowUpAt: true },
  });
  await prisma.activityLog.create({
    data: { leadId: inv.leadId, userId: actor.id, action: `Followed up on invoice ${inv.invoiceNumber}`, details: input.note },
  });
  return updated;
}

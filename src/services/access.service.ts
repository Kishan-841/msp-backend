import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import type { LeadStatus, UserRole } from '../generated/prisma/client.js';

// Who may SEE and who may WORK a lead — one place, used by every lead-linked route.
//
//  view:  ADMIN, MSP_TL → every lead
//         SALES         → leads assigned to them
//         ACCOUNTS      → deals from "customer accepted" onwards (they invoice them), and
//                         repeat customers (orderNo > 1) so earlier orders' invoices stay visible
//  sales: the Sales actions on a lead (calls, meetings, MOM, send for quote, mark sent /
//         accepted, send PO) → ADMIN, or the SALES user the lead is assigned to
//
// A lead the user can't see answers 404 (not 403) so its existence isn't leaked.

export interface Actor {
  id: string;
  role: UserRole;
}

export const ACCOUNTS_STAGES: LeadStatus[] = [
  'CUSTOMER_ACCEPTED',
  'PO_PENDING_ACCOUNTS',
  'PO_CONFIRMED',
  'PO_SENT',
  'INVOICED',
  'DEAL_REGISTERED',
];

/** Prisma `where` on Lead limiting rows to what the actor may see */
export function leadVisibility(actor: Actor): Record<string, unknown> {
  if (actor.role === 'SALES') return { assignedToId: actor.id };
  if (actor.role === 'ACCOUNTS') return { OR: [{ status: { in: ACCOUNTS_STAGES } }, { orderNo: { gt: 1 } }] };
  return {};
}

function canView(actor: Actor, lead: { assignedToId: string | null; status: LeadStatus; orderNo: number }) {
  if (actor.role === 'ADMIN' || actor.role === 'MSP_TL') return true;
  if (actor.role === 'SALES') return lead.assignedToId === actor.id;
  if (actor.role === 'ACCOUNTS') return ACCOUNTS_STAGES.includes(lead.status) || lead.orderNo > 1;
  return false;
}

export function canWorkAsSales(actor: Actor, lead: { assignedToId: string | null }) {
  return actor.role === 'ADMIN' || (actor.role === 'SALES' && lead.assignedToId === actor.id);
}

/**
 * Throws unless the actor may see the lead ('view') or do Sales work on it ('sales').
 * Returns the lead's access-relevant fields.
 */
export async function assertLeadAccess(actor: Actor, leadId: string, mode: 'view' | 'sales' = 'view') {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, assignedToId: true, status: true, orderNo: true },
  });
  if (!lead || !canView(actor, lead)) throw new AppError('Lead not found.', 404);
  if (mode === 'sales' && !canWorkAsSales(actor, lead)) {
    throw new AppError('Only the Sales person assigned to this lead can do this.', 403);
  }
  return lead;
}

// ---- resolve a record to its lead, then check ----

async function leadIdOf(kind: 'quote' | 'meeting' | 'purchaseOrder' | 'salesInvoice', id: string) {
  const row =
    kind === 'quote'
      ? await prisma.quote.findUnique({ where: { id }, select: { leadId: true } })
      : kind === 'meeting'
        ? await prisma.meeting.findUnique({ where: { id }, select: { leadId: true } })
        : kind === 'purchaseOrder'
          ? await prisma.purchaseOrder.findUnique({ where: { id }, select: { leadId: true } })
          : await prisma.salesInvoice.findUnique({ where: { id }, select: { leadId: true } });
  if (!row) throw new AppError('Not found.', 404);
  return row.leadId;
}

export const assertQuoteAccess = async (actor: Actor, id: string, mode: 'view' | 'sales' = 'view') =>
  assertLeadAccess(actor, await leadIdOf('quote', id), mode);
export const assertMeetingAccess = async (actor: Actor, id: string, mode: 'view' | 'sales' = 'view') =>
  assertLeadAccess(actor, await leadIdOf('meeting', id), mode);
export const assertPurchaseOrderAccess = async (actor: Actor, id: string, mode: 'view' | 'sales' = 'view') =>
  assertLeadAccess(actor, await leadIdOf('purchaseOrder', id), mode);
export const assertSalesInvoiceAccess = async (actor: Actor, id: string) =>
  assertLeadAccess(actor, await leadIdOf('salesInvoice', id));

/** Attachments inherit access from the record they're attached to */
export async function assertAttachmentEntityAccess(
  actor: Actor,
  entityType: 'QUOTE_ACCEPTANCE' | 'PURCHASE_ORDER' | 'PURCHASE_INVOICE',
  entityId: string,
  action: 'view' | 'upload'
) {
  if (entityType === 'QUOTE_ACCEPTANCE') {
    // proof of acceptance is uploaded by the Sales person who recorded it
    return assertQuoteAccess(actor, entityId, action === 'upload' ? 'sales' : 'view');
  }
  if (entityType === 'PURCHASE_ORDER') return assertPurchaseOrderAccess(actor, entityId);

  // vendor bills are an Accounts document
  const bill = await prisma.purchaseInvoice.findUnique({
    where: { id: entityId },
    select: { purchaseOrder: { select: { leadId: true } } },
  });
  if (!bill) throw new AppError('Not found.', 404);
  if (action === 'upload' && actor.role !== 'ACCOUNTS' && actor.role !== 'ADMIN') {
    throw new AppError('Only Accounts can attach vendor bills.', 403);
  }
  return assertLeadAccess(actor, bill.purchaseOrder.leadId);
}

// Sales-side detail Accounts must not see (calls, meetings, MOMs, requirement notes).
// Activity entries are kept when they're about money/documents (quote, PO, invoice, payment…).
const SALES_ONLY_ACTIVITY = /^(Call logged|Meeting scheduled|Minutes of Meeting|Lead sent to MSP TL|Lead pushed for quote)/i;

/** Trims a lead (as returned by getLeadById / quote.lead) for roles that may not see Sales detail */
export function redactLeadFor<T extends Record<string, unknown>>(actor: Actor, lead: T): T {
  // the duplicate check compares against all leads — only roles that see all leads get it
  if (actor.role === 'ADMIN' || actor.role === 'MSP_TL') return lead;
  const out: Record<string, unknown> = { ...lead };
  if ('possibleDuplicateIds' in out) out.possibleDuplicateIds = [];
  if (actor.role !== 'ACCOUNTS') return out as T;
  if ('meetings' in out) out.meetings = [];
  if (Array.isArray(out.activityLogs)) {
    out.activityLogs = (out.activityLogs as { action: string; details?: string | null }[])
      .filter((a) => !SALES_ONLY_ACTIVITY.test(a.action))
      .map((a) => ({ ...a, details: null }));
  }
  for (const k of ['finalRequirement', 'requirementItems', 'sourceRequirement', 'callbackAt', 'dropReason', 'notes']) if (k in out) out[k] = null;
  return out as T;
}

/** Dropped leads are frozen — no more work on them (start a New Order to reopen) */
export async function assertLeadOpen(leadId: string) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { droppedAt: true } });
  if (lead?.droppedAt) throw new AppError('This lead has been dropped — no further actions allowed.', 400);
}

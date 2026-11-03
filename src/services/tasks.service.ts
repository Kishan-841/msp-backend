import { prisma } from '../lib/prisma.js';
import type { UserRole } from '../generated/prisma/client.js';
import { leadVisibility, type Actor } from './access.service.js';
import { outstandingOf } from './balance.service.js';
import { listReadyToInvoice } from './sales.service.js';
import { listReadyToBill } from './purchaseOrder.service.js';
import { dueCount } from './followup.service.js';

// "What's waiting for me" — one count per kind of pending work, per role.
// Drives the dashboard "Your next steps" panel and the sidebar badges.
// Each count only includes records the user is allowed to act on.

export type TaskKey =
  | 'toCategorize' // MSP TL: leads without a category
  | 'toAssign' // MSP TL: categorized, not assigned
  | 'toCall' // Sales: assigned, never called
  | 'callbacksDue' // Sales: "call later" time has passed
  | 'momPending' // Sales: meeting held, MOM not added
  | 'finalRequirement' // Sales: MOM added, not sent for quote
  | 'quoteRequests' // MSP TL: build a quote
  | 'quoteDrafts' // MSP TL: saved but not submitted
  | 'quotesToApprove' // Admin
  | 'quotesToSend' // Sales: approved, not sent to customer
  | 'awaitingAcceptance' // Sales: sent, customer hasn't accepted yet
  | 'readyForPo' // MSP TL: customer accepted, no PO yet
  | 'posToFix' // MSP TL: draft or rejected by Accounts
  | 'posToConfirm' // Accounts
  | 'posToSend' // Sales: confirmed, not sent to vendor
  | 'posToBill' // Accounts: PO sent, vendor invoice not (fully) recorded
  | 'billsToPay' // Accounts: vendor bills with balance
  | 'dealsToInvoice' // Accounts: customer can be invoiced
  | 'invoicesUnpaid' // Accounts: customer invoices with balance
  | 'followUpsDue'; // quote sent 3+ days ago / customer invoice overdue, not snoozed // Accounts: customer invoices with balance

const ROLE_TASKS: Record<UserRole, TaskKey[]> = {
  ADMIN: [
    'quotesToApprove',
    'toCategorize',
    'toAssign',
    'quoteRequests',
    'readyForPo',
    'posToConfirm',
    'posToSend',
    'posToBill',
    'quotesToSend',
    'dealsToInvoice',
    'billsToPay',
    'invoicesUnpaid',
    'followUpsDue',
  ],
  MSP_TL: ['toCategorize', 'toAssign', 'quoteRequests', 'quoteDrafts', 'readyForPo', 'posToFix'],
  SALES: [
    'callbacksDue',
    'toCall',
    'momPending',
    'finalRequirement',
    'quotesToSend',
    'awaitingAcceptance',
    'posToSend',
    'followUpsDue',
  ],
  ACCOUNTS: ['posToConfirm', 'posToBill', 'billsToPay', 'dealsToInvoice', 'invoicesUnpaid', 'followUpsDue'],
};

export async function getTaskCounts(actor: Actor) {
  const lead = { ...leadVisibility(actor), droppedAt: null };
  const now = new Date();
  const want = new Set(ROLE_TASKS[actor.role]);
  const counts: Partial<Record<TaskKey, number>> = {};

  const count = async (key: TaskKey, fn: () => Promise<number>) => {
    if (want.has(key)) counts[key] = await fn();
  };

  await Promise.all([
    count('toCategorize', () => prisma.lead.count({ where: { ...lead, category: null } })),
    count('toAssign', () => prisma.lead.count({ where: { ...lead, status: 'CATEGORIZED', assignedToId: null } })),
    count('toCall', () => prisma.lead.count({ where: { ...lead, status: 'ASSIGNED', callbackAt: null } })),
    count('callbacksDue', () =>
      prisma.lead.count({ where: { ...lead, status: 'ASSIGNED', callbackAt: { lte: now } } })
    ),
    count('momPending', () =>
      prisma.meeting.count({ where: { momContent: null, meetingDate: { lte: now }, lead } })
    ),
    count('finalRequirement', () => prisma.lead.count({ where: { ...lead, status: 'MOM_ADDED' } })),
    count('quoteRequests', () =>
      prisma.lead.count({ where: { ...lead, status: { in: ['QUOTE_REQUESTED', 'QUOTE_REJECTED'] } } })
    ),
    count('quoteDrafts', () => prisma.quote.count({ where: { status: 'DRAFT', lead } })),
    count('quotesToApprove', () => prisma.quote.count({ where: { status: 'SUBMITTED', lead } })),
    count('quotesToSend', () => prisma.quote.count({ where: { status: 'APPROVED', lead } })),
    count('awaitingAcceptance', () => prisma.quote.count({ where: { status: 'SENT', lead } })),
    count('readyForPo', () => prisma.quote.count({ where: { status: 'ACCEPTED', purchaseOrder: null, lead } })),
    count('posToFix', () =>
      prisma.purchaseOrder.count({ where: { status: { in: ['DRAFT', 'REJECTED'] }, lead } })
    ),
    count('posToConfirm', () => prisma.purchaseOrder.count({ where: { status: 'PENDING_ACCOUNTS', lead } })),
    count('posToSend', () => prisma.purchaseOrder.count({ where: { status: 'CONFIRMED', lead } })),
    count('posToBill', async () => (await listReadyToBill()).length),
    count('billsToPay', async () => {
      const bills = await prisma.purchaseInvoice.findMany({
        where: { paymentStatus: { not: 'PAID' } },
        select: { totalAmount: true, adjustmentNotes: { select: { kind: true, totalAmount: true } }, allocations: { select: { amount: true } } },
      });
      return bills.filter((b) => outstandingOf(b.totalAmount, b.adjustmentNotes, b.allocations) > 0).length;
    }),
    count('dealsToInvoice', async () => (await listReadyToInvoice()).length),
    count('followUpsDue', () => dueCount(actor)),
    count('invoicesUnpaid', () =>
      prisma.salesInvoice.count({ where: { paymentStatus: { not: 'PAID' }, lead: leadVisibility(actor) } })
    ),
  ]);

  // keep the role's order (most urgent first) for the dashboard
  return ROLE_TASKS[actor.role].map((key) => ({ key, count: counts[key] ?? 0 }));
}

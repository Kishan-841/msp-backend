import { prisma } from '../lib/prisma.js';
import { activeUserIds, notifyUsers } from './notification.service.js';
import { quoteInvoiceLines, round2, type InvoiceLine } from '../utils/salesCalc.js';
import type { QuoteRequirement } from '../utils/quoteCalc.js';
import type { PaymentStatus } from '../generated/prisma/client.js';

/** Quantity already invoiced per quote line */
export function billedQuantities(lines: InvoiceLine[], invoices: { items: unknown }[]) {
  const billed = lines.map(() => 0);
  for (const inv of invoices) {
    for (const l of inv.items as unknown as InvoiceLine[]) billed[l.lineIndex] += l.quantity;
  }
  return billed.map(round2);
}

type Note = { kind: 'CREDIT' | 'DEBIT'; totalAmount: number };

/** What is still owed on an invoice: total + debit notes − credit notes − settled */
export function outstandingOf(
  totalAmount: number,
  notes: Note[],
  allocations: { amount: number }[]
) {
  const debit = notes.filter((n) => n.kind === 'DEBIT').reduce((a, n) => a + n.totalAmount, 0);
  const credit = notes.filter((n) => n.kind === 'CREDIT').reduce((a, n) => a + n.totalAmount, 0);
  const settled = allocations.reduce((a, x) => a + x.amount, 0);
  return round2(totalAmount + debit - credit - settled);
}

function statusFor(outstanding: number, settled: number): PaymentStatus {
  if (outstanding <= 0.005) return 'PAID';
  return settled > 0 ? 'PARTIALLY_PAID' : 'UNPAID';
}

export async function salesInvoiceBalance(id: string) {
  const inv = await prisma.salesInvoice.findUniqueOrThrow({
    where: { id },
    include: { adjustmentNotes: true, allocations: true },
  });
  return {
    invoice: inv,
    outstanding: outstandingOf(inv.totalAmount, inv.adjustmentNotes, inv.allocations),
    settled: round2(inv.allocations.reduce((a, x) => a + x.amount, 0)),
  };
}

export async function purchaseInvoiceBalance(id: string) {
  const inv = await prisma.purchaseInvoice.findUniqueOrThrow({
    where: { id },
    include: { adjustmentNotes: true, allocations: true },
  });
  return {
    invoice: inv,
    outstanding: outstandingOf(inv.totalAmount, inv.adjustmentNotes, inv.allocations),
    settled: round2(inv.allocations.reduce((a, x) => a + x.amount, 0)),
  };
}

export async function refreshSalesInvoiceStatus(id: string) {
  const { invoice, outstanding, settled } = await salesInvoiceBalance(id);
  await prisma.salesInvoice.update({
    where: { id },
    data: { paymentStatus: statusFor(outstanding, settled) },
  });
  await refreshDealClosure(invoice.leadId);
}

export async function refreshPurchaseInvoiceStatus(id: string) {
  const { outstanding, settled } = await purchaseInvoiceBalance(id);
  await prisma.purchaseInvoice.update({
    where: { id },
    data: { paymentStatus: statusFor(outstanding, settled) },
  });
}

/** A deal closes once its accepted quote is fully invoiced and every invoice is paid */
export async function refreshDealClosure(leadId: string) {
  // A lead can hold several orders (repeat orders) — one accepted quote each. The deal is
  // closed when every accepted quote is fully invoiced and every one of its invoices is paid.
  const quotes = await prisma.quote.findMany({
    where: { leadId, status: 'ACCEPTED' },
    include: { salesInvoices: { select: { items: true, paymentStatus: true } } },
  });
  if (quotes.length === 0 || quotes.every((q) => q.salesInvoices.length === 0)) return;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { status: true, companyName: true, assignedToId: true } });

  const closed = quotes.every((quote) => {
    const lines = quoteInvoiceLines(quote.items as unknown as QuoteRequirement[]);
    const billed = billedQuantities(lines, quote.salesInvoices);
    const fullyInvoiced = lines.every((l, i) => billed[i] >= l.quantity - 1e-9);
    return fullyInvoiced && quote.salesInvoices.every((i) => i.paymentStatus === 'PAID');
  });

  if (closed && lead?.status === 'INVOICED') {
    await prisma.lead.update({ where: { id: leadId }, data: { status: 'DEAL_REGISTERED' } });
    // the Sales person (and MSP TLs) hear their deal is fully paid
    await notifyUsers([lead.assignedToId, ...(await activeUserIds('MSP_TL'))], '', {
      title: 'Deal closed',
      message: `${lead.companyName} is fully invoiced and paid`,
      type: 'DEAL_CLOSED',
      link: `/leads/${leadId}/workspace`,
    });
  } else if (!closed && lead?.status === 'DEAL_REGISTERED') {
    // e.g. a debit note reopened an invoice
    await prisma.lead.update({ where: { id: leadId }, data: { status: 'INVOICED' } });
  }
}

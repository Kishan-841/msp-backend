import { prisma } from '../lib/prisma.js';
import { envelope, startOfTodayIST, type PageParams } from '../utils/paginate.js';
import { withLock } from '../lib/lock.js';
import { AppError } from '../middleware/errorHandler.js';
import { createNotification } from './notification.service.js';
import type { PaymentStatus, UserRole } from '../generated/prisma/client.js';
import type { QuoteRequirement } from '../utils/quoteCalc.js';
import { gstTypeFor } from '../utils/poCalc.js';
import { invoiceLines, quoteInvoiceLines, round2, type InvoiceLine } from '../utils/salesCalc.js';
import { createWithFyNumber } from '../utils/docNumber.js';
import { billedQuantities, outstandingOf, refreshDealClosure } from './balance.service.js';
import { leadVisibility } from './access.service.js';

// Customer side: invoices are raised straight from the accepted quote (customer prices).
// A deal can be invoiced once its PO has gone to the vendor — the same moment the
// vendor bill is created — and may be billed in parts.

const userSelect = { id: true, name: true, email: true, role: true } as const;

/** Lead statuses at which the customer can be invoiced */
const INVOICEABLE_STATUSES = ['PO_SENT', 'INVOICED', 'DEAL_REGISTERED'] as const;

/** Our state vs the customer's decides CGST+SGST vs IGST on customer invoices */
async function customerGstType(lead: { companyName: string; customerState: string | null }) {
  const company = await prisma.companySettings.findUnique({ where: { id: 1 } });
  if (!company?.state) {
    throw new AppError('Set your company state in Settings first (needed for GST).', 400);
  }
  // Our GSTIN is optional for now (the invoice prints "—" without it); the Accounts page
  // shows a reminder. Re-add a check here when it should block invoicing.
  if (!lead.customerState) {
    throw new AppError(
      `Add the customer's GSTIN or state on the lead "${lead.companyName}" first (needed for GST).`,
      400
    );
  }
  return gstTypeFor(company.state, lead.customerState);
}

// ---------------------------------------------------------------- Ready to invoice

/** Accepted quotes whose PO has gone to the vendor and still have something to bill */
export async function listReadyToInvoice() {
  const quotes = await prisma.quote.findMany({
    where: {
      status: 'ACCEPTED',
      lead: { status: { in: [...INVOICEABLE_STATUSES] }, droppedAt: null },
    },
    include: {
      lead: { select: { id: true, companyName: true, customerGstin: true, customerState: true } },
      purchaseOrder: { select: { id: true, poNumber: true } },
      salesInvoices: { select: { items: true } },
    },
    orderBy: { acceptedAt: 'asc' },
  });

  return quotes
    .map(({ salesInvoices, items, ...q }) => {
      const lines = quoteInvoiceLines(items as unknown as QuoteRequirement[]);
      const billed = billedQuantities(lines, salesInvoices);
      const remaining = lines.map((l, i) => round2(l.quantity - billed[i]));
      const remainingValue = round2(
        lines.reduce((a, l, i) => a + remaining[i] * l.rate * (1 + l.gstPercent / 100), 0)
      );
      return { ...q, lines, billed, remaining, remainingValue, invoiceCount: salesInvoices.length };
    })
    .filter((q) => q.remaining.some((r) => r > 0));
}

// ---------------------------------------------------------------- Customer invoices

export async function listSalesInvoices(
  userId: string,
  userRole: UserRole,
  filters: { paymentStatus?: PaymentStatus | 'OVERDUE'; leadId?: string; search?: string } = {},
  page?: PageParams
) {
  const where: Record<string, unknown> = {};
  if (filters.paymentStatus === 'OVERDUE') {
    where.paymentStatus = { not: 'PAID' };
    where.dueDate = { lt: startOfTodayIST() };
  } else if (filters.paymentStatus) where.paymentStatus = filters.paymentStatus;
  if (filters.leadId) where.leadId = filters.leadId;
  if (filters.search) {
    where.OR = [
      { invoiceNumber: { contains: filters.search, mode: 'insensitive' } },
      { customerName: { contains: filters.search, mode: 'insensitive' } },
    ];
  }
  const visible = { lead: leadVisibility({ id: userId, role: userRole }) };
  // visibility ANDed with the filters so ?search= can't replace it
  const scoped = { AND: [where, visible] };
  const invoices = await prisma.salesInvoice.findMany({
    where: scoped,
    include: {
      quote: { select: { id: true, quoteNumber: true } },
      adjustmentNotes: { select: { kind: true, totalAmount: true } },
      allocations: { select: { amount: true } },
    },
    orderBy: [{ invoiceDate: 'desc' }, { invoiceNumber: 'desc' }],
    ...(page ? { skip: page.skip, take: page.limit } : {}),
  });
  const rows = invoices.map(({ adjustmentNotes, allocations, ...inv }) => ({
    ...inv,
    outstanding: outstandingOf(inv.totalAmount, adjustmentNotes, allocations),
  }));
  if (!page) return rows;
  const [total, unpaid] = await Promise.all([
    prisma.salesInvoice.count({ where: scoped }),
    prisma.salesInvoice.count({ where: { AND: [visible, { paymentStatus: { not: 'PAID' } }] } }),
  ]);
  return envelope(rows, total, page, { unpaid });
}

export async function getSalesInvoice(id: string) {
  const inv = await prisma.salesInvoice.findUnique({
    where: { id },
    include: {
      lead: { select: { id: true, companyName: true, contactPerson: true, email: true, phone: true } },
      quote: { select: { id: true, quoteNumber: true, customerPoNumber: true, customerPoDate: true } },
      createdBy: { select: userSelect },
      adjustmentNotes: { orderBy: { noteDate: 'asc' }, include: { createdBy: { select: userSelect } } },
      allocations: {
        include: {
          payment: {
            select: {
              id: true,
              number: true,
              paymentDate: true,
              mode: true,
              reference: true,
              amount: true,
              tdsAmount: true,
              ourBankName: true,
              ourBankAccountNumber: true,
              partyBankName: true,
              partyBankAccountNumber: true,
              partyBankIfsc: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!inv) throw new AppError('Invoice not found.', 404);
  const company = await prisma.companySettings.findUnique({ where: { id: 1 } });
  return {
    ...inv,
    company,
    outstanding: outstandingOf(inv.totalAmount, inv.adjustmentNotes, inv.allocations),
  };
}

/** Locked per quote: two clicks can't both pass the "how much is left to bill" check */
export async function createSalesInvoice(
  quoteId: string,
  input: Parameters<typeof createSalesInvoiceLocked>[1],
  userId: string
) {
  return withLock(`bill:quote:${quoteId}`, () => createSalesInvoiceLocked(quoteId, input, userId));
}

async function createSalesInvoiceLocked(
  quoteId: string,
  input: {
    invoiceDate: string;
    dueDate?: string;
    lines: { lineIndex: number; quantity: number }[];
    notes?: string;
  },
  userId: string
) {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: { lead: true, salesInvoices: { select: { items: true } } },
  });
  if (!quote) throw new AppError('Quote not found.', 404);
  if (quote.status !== 'ACCEPTED') throw new AppError('Only accepted quotes can be invoiced.', 400);
  if (!(INVOICEABLE_STATUSES as readonly string[]).includes(quote.lead.status)) {
    throw new AppError('The customer can be invoiced once the PO has been sent to the vendor.', 400);
  }

  const allLines = quoteInvoiceLines(quote.items as unknown as QuoteRequirement[]);
  const billed = billedQuantities(allLines, quote.salesInvoices);
  const lines = input.lines.filter((l) => l.quantity > 0);
  if (lines.length === 0) throw new AppError('Bill at least one line.', 400);
  for (const l of lines) {
    const line = allLines[l.lineIndex];
    if (!line) throw new AppError(`Line ${l.lineIndex + 1} does not exist on the quote.`, 400);
    const remaining = round2(line.quantity - billed[l.lineIndex]);
    if (l.quantity > remaining + 1e-9) {
      throw new AppError(`"${line.description}": only ${remaining} ${line.unit} left to bill.`, 400);
    }
  }

  const gstType = await customerGstType(quote.lead);
  const calc = invoiceLines(allLines, lines, gstType);
  const invoiceDate = new Date(input.invoiceDate);

  const invoice = await createWithFyNumber(
    'INV',
    invoiceDate,
    async (startsWith) =>
      (
        await prisma.salesInvoice.findFirst({
          where: { invoiceNumber: { startsWith } },
          orderBy: { invoiceNumber: 'desc' },
          select: { invoiceNumber: true },
        })
      )?.invoiceNumber ?? null,
    (invoiceNumber) =>
      prisma.salesInvoice.create({
        data: {
          invoiceNumber,
          quoteId,
          leadId: quote.leadId,
          invoiceDate,
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          items: calc.items as unknown as object,
          gstType,
          placeOfSupply: quote.lead.customerState!,
          customerName: quote.lead.companyName,
          customerGstin: quote.lead.customerGstin,
          customerAddress: quote.lead.billingAddress,
          subtotal: calc.subtotal,
          cgstAmount: calc.cgstAmount,
          sgstAmount: calc.sgstAmount,
          igstAmount: calc.igstAmount,
          totalAmount: calc.totalAmount,
          notes: input.notes || null,
          createdById: userId,
        },
      }),
    'invoiceNumber'
  );

  if (quote.lead.status === 'PO_SENT') {
    await prisma.lead.update({ where: { id: quote.leadId }, data: { status: 'INVOICED' } });
  }
  await refreshDealClosure(quote.leadId);
  await prisma.activityLog.create({
    data: { leadId: quote.leadId, userId, action: `Invoice ${invoice.invoiceNumber} raised (${calc.totalAmount})` },
  });
  if (quote.lead.assignedToId && quote.lead.assignedToId !== userId) {
    await createNotification({
      userId: quote.lead.assignedToId,
      title: 'Invoice raised',
      message: `${invoice.invoiceNumber} raised for ${quote.lead.companyName}`,
      type: 'INVOICE_RAISED',
      link: `/invoices/${invoice.id}`,
    });
  }

  return invoice;
}

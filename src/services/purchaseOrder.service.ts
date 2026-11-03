import { prisma } from '../lib/prisma.js';
import { envelope, startOfTodayIST, type PageParams } from '../utils/paginate.js';
import { leadVisibility } from './access.service.js';
import { AppError } from '../middleware/errorHandler.js';
import { activeUserIds, notifyUsers } from './notification.service.js';
import { sendEmail } from './mailer.service.js';
import type { PurchaseOrderStatus, UserRole } from '../generated/prisma/client.js';
import type { QuoteRequirement } from '../utils/quoteCalc.js';
import { computePo, gstTypeFor, quoteLines, splitGst, type PoLine } from '../utils/poCalc.js';
import { renderPoDocument } from '../utils/poDocument.js';
import { billedQuantities, outstandingOf } from './balance.service.js';
import { invoiceLines, type InvoiceLine } from '../utils/salesCalc.js';
import { createWithDailyNumber, createWithFyNumber } from '../utils/docNumber.js';
import { withLock } from '../lib/lock.js';

const userSelect = { id: true, name: true, email: true, role: true } as const;

const poInclude = {
  vendor: true,
  quote: { select: { id: true, quoteNumber: true, totalAmount: true, customerPoNumber: true } },
  lead: {
    select: {
      id: true,
      companyName: true,
      contactPerson: true,
      status: true,
      assignedTo: { select: userSelect },
    },
  },
  createdBy: { select: userSelect },
  confirmedBy: { select: userSelect },
  sentBy: { select: userSelect },
  purchaseInvoices: {
    include: {
      createdBy: { select: userSelect },
      adjustmentNotes: { orderBy: { noteDate: 'asc' as const } },
      allocations: {
        include: { payment: { select: { id: true, number: true, paymentDate: true, mode: true, amount: true, tdsAmount: true, ourBankName: true, ourBankAccountNumber: true, partyBankName: true, partyBankAccountNumber: true, partyBankIfsc: true } } },
      },
    },
    orderBy: { invoiceDate: 'desc' as const },
  },
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface PoInput {
  vendorId: string;
  buyingRates?: number[]; // one per quote line; 0 until MSP TL enters them
  deliveryAddress?: string;
  expectedDeliveryDate?: string;
  notes?: string;
}

async function notifyRole(role: UserRole, excludeUserId: string, n: { title: string; message: string; type: string; link: string }) {
  await notifyUsers(await activeUserIds(role), excludeUserId, n);
}

/** Vendor + our company decide CGST/SGST vs IGST, so both need a GST state */
async function resolvePoParty(vendorId: string) {
  const [vendor, company] = await Promise.all([
    prisma.vendor.findUnique({ where: { id: vendorId } }),
    prisma.companySettings.findUnique({ where: { id: 1 } }),
  ]);
  if (!vendor) throw new AppError('Vendor not found.', 404);
  if (!vendor.isActive) throw new AppError(`Vendor "${vendor.name}" is inactive.`, 400);
  if (!company?.state) {
    throw new AppError('Set your company state in Settings first (needed for GST on the PO).', 400);
  }
  if (!vendor.state) {
    throw new AppError(`Add a GSTIN or state for vendor "${vendor.name}" first (needed for GST).`, 400);
  }
  return { vendor, company, gstType: gstTypeFor(company.state, vendor.state) };
}


// ---------------------------------------------------------------- reads

export async function listPurchaseOrders(
  userId: string,
  userRole: UserRole,
  filters: { status?: PurchaseOrderStatus; search?: string } = {},
  page?: PageParams
) {
  const where: Record<string, unknown> = {};
  if (filters.status) where.status = filters.status;
  if (filters.search) {
    where.OR = [
      { poNumber: { contains: filters.search, mode: 'insensitive' } },
      { vendor: { name: { contains: filters.search, mode: 'insensitive' } } },
      { lead: { companyName: { contains: filters.search, mode: 'insensitive' } } },
    ];
  }

  // lead visibility for every role, ANDed with the filters
  const scoped = { AND: [where, { lead: leadVisibility({ id: userId, role: userRole }) }] };
  const args = {
    where: scoped,
    include: {
      vendor: { select: { id: true, name: true } },
      lead: { select: { id: true, companyName: true } },
      quote: { select: { id: true, quoteNumber: true } },
      createdBy: { select: userSelect },
    },
    orderBy: { createdAt: 'desc' as const },
  };
  if (!page) return prisma.purchaseOrder.findMany(args);
  const [items, total] = await Promise.all([
    prisma.purchaseOrder.findMany({ ...args, skip: page.skip, take: page.limit }),
    prisma.purchaseOrder.count({ where: scoped }),
  ]);
  return envelope(items, total, page);
}

/** Accepted quotes that don't have a PO yet — MSP TL's "to create" list */
export async function listQuotesReadyForPo(userId: string, userRole: UserRole) {
  return prisma.quote.findMany({
    where: {
      status: 'ACCEPTED',
      purchaseOrder: null,
      lead: { droppedAt: null, ...(userRole === 'SALES' ? { assignedToId: userId } : {}) },
    },
    include: {
      lead: { select: { id: true, companyName: true, contactPerson: true, assignedTo: { select: userSelect } } },
    },
    orderBy: { acceptedAt: 'asc' },
  });
}

export async function getPurchaseOrder(id: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id }, include: poInclude });
  if (!po) throw new AppError('Purchase order not found.', 404);
  return {
    ...po,
    purchaseInvoices: po.purchaseInvoices.map((b) => ({
      ...b,
      outstanding: outstandingOf(b.totalAmount, b.adjustmentNotes, b.allocations),
    })),
  };
}

// ---------------------------------------------------------------- MSP TL: build & submit

export async function createPurchaseOrder(quoteId: string, input: PoInput, userId: string) {
  // one PO per quote — a double-click gets "already has PO" instead of a DB error
  return withLock(`quote:${quoteId}`, () => createPurchaseOrderLocked(quoteId, input, userId));
}

async function createPurchaseOrderLocked(quoteId: string, input: PoInput, userId: string) {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: { lead: true, purchaseOrder: { select: { poNumber: true } } },
  });
  if (!quote) throw new AppError('Quote not found.', 404);
  if (quote.lead.droppedAt) throw new AppError('This lead has been dropped — no further actions allowed.', 400);
  if (quote.status !== 'ACCEPTED') {
    throw new AppError('A PO can only be created after the customer accepts the quote.', 400);
  }
  if (quote.purchaseOrder) {
    throw new AppError(`This quote already has PO ${quote.purchaseOrder.poNumber}.`, 400);
  }

  const { gstType } = await resolvePoParty(input.vendorId);
  const lineCount = quoteLines(quote.items as unknown as QuoteRequirement[]).length;
  const totals = buildPo(quote.items, input.buyingRates ?? new Array(lineCount).fill(0), gstType);

  // PO-YYYYMMDD-NNNN (IST day), next after the highest existing — safe after deletes
  const po = await createWithDailyNumber(
    'PO',
    async (startsWith) =>
      (
        await prisma.purchaseOrder.findFirst({
          where: { poNumber: { startsWith } },
          orderBy: { poNumber: 'desc' },
          select: { poNumber: true },
        })
      )?.poNumber ?? null,
    (poNumber) =>
      prisma.purchaseOrder.create({
    data: {
      poNumber,
      quoteId,
      leadId: quote.leadId,
      vendorId: input.vendorId,
      ...totals,
      items: totals.items as unknown as object,
      deliveryAddress: input.deliveryAddress || null,
      expectedDeliveryDate: input.expectedDeliveryDate ? new Date(input.expectedDeliveryDate) : null,
      notes: input.notes || null,
      createdById: userId,
    },
    include: poInclude,
  }),
    'poNumber'
  );

  await prisma.activityLog.create({
    data: { leadId: quote.leadId, userId, action: `PO ${po.poNumber} drafted for ${po.vendor.name}` },
  });

  return po;
}


function buildPo(quoteItems: unknown, buyingRates: number[], gstType: 'INTRA' | 'INTER') {
  try {
    return computePo(quoteItems as QuoteRequirement[], buyingRates, gstType);
  } catch (err) {
    throw new AppError((err as Error).message, 400);
  }
}

export async function updatePurchaseOrder(id: string, input: Partial<PoInput>) {
  const existing = await prisma.purchaseOrder.findUnique({ where: { id }, include: { quote: true } });
  if (!existing) throw new AppError('Purchase order not found.', 404);
  if (existing.status !== 'DRAFT' && existing.status !== 'REJECTED') {
    throw new AppError('Only draft or rejected POs can be edited.', 400);
  }

  const data: Record<string, unknown> = {};
  if (input.deliveryAddress !== undefined) data.deliveryAddress = input.deliveryAddress || null;
  if (input.expectedDeliveryDate !== undefined)
    data.expectedDeliveryDate = input.expectedDeliveryDate ? new Date(input.expectedDeliveryDate) : null;
  if (input.notes !== undefined) data.notes = input.notes || null;

  // A vendor change can flip CGST/SGST ↔ IGST, so totals are recomputed on either change
  if (input.vendorId !== undefined || input.buyingRates !== undefined) {
    const vendorId = input.vendorId ?? existing.vendorId;
    const { gstType } = await resolvePoParty(vendorId);
    const rates = input.buyingRates ?? (existing.items as unknown as PoLine[]).map((l) => l.rate);
    const totals = buildPo(existing.quote.items, rates, gstType);
    Object.assign(data, totals, { items: totals.items as unknown as object, vendorId });
  }

  return prisma.purchaseOrder.update({ where: { id }, data, include: poInclude });
}

export async function submitPurchaseOrder(id: string, userId: string) {
  const existing = await prisma.purchaseOrder.findUnique({ where: { id }, include: { lead: true } });
  if (!existing) throw new AppError('Purchase order not found.', 404);
  if (existing.status !== 'DRAFT' && existing.status !== 'REJECTED') {
    throw new AppError('Only draft or rejected POs can be submitted to Accounts.', 400);
  }

  if ((existing.items as unknown as PoLine[]).some((l) => !(l.rate > 0))) {
    throw new AppError('Enter the buying price for every line before sending to Accounts.', 400);
  }

  const po = await prisma.purchaseOrder.update({
    where: { id },
    data: { status: 'PENDING_ACCOUNTS', submittedAt: new Date(), rejectionReason: null },
    include: poInclude,
  });
  await prisma.lead.update({ where: { id: existing.leadId }, data: { status: 'PO_PENDING_ACCOUNTS' } });
  await prisma.activityLog.create({
    data: { leadId: existing.leadId, userId, action: `PO ${existing.poNumber} sent to Accounts for confirmation` },
  });
  await notifyRole('ACCOUNTS', userId, {
    title: 'PO needs confirmation',
    message: `${existing.poNumber} for ${existing.lead.companyName} is waiting for Accounts`,
    type: 'PO_SUBMITTED',
    link: `/purchase-orders/${id}`,
  });

  return po;
}

// ---------------------------------------------------------------- Accounts: confirm / reject

export async function confirmPurchaseOrder(id: string, userId: string) {
  const existing = await prisma.purchaseOrder.findUnique({ where: { id }, include: { lead: true } });
  if (!existing) throw new AppError('Purchase order not found.', 404);
  if (existing.status !== 'PENDING_ACCOUNTS') {
    throw new AppError('Only POs pending Accounts can be confirmed.', 400);
  }

  const po = await prisma.purchaseOrder.update({
    where: { id },
    data: { status: 'CONFIRMED', confirmedById: userId, confirmedAt: new Date() },
    include: poInclude,
  });
  await prisma.lead.update({ where: { id: existing.leadId }, data: { status: 'PO_CONFIRMED' } });
  await prisma.activityLog.create({
    data: { leadId: existing.leadId, userId, action: `PO ${existing.poNumber} confirmed by Accounts` },
  });
  await notifyUsers([existing.lead.assignedToId, existing.createdById], userId, {
    title: 'PO confirmed',
    message: `${existing.poNumber} is confirmed — ready to send to the vendor`,
    type: 'PO_CONFIRMED',
    link: `/purchase-orders/${id}`,
  });

  return po;
}

export async function rejectPurchaseOrder(id: string, userId: string, reason: string) {
  const existing = await prisma.purchaseOrder.findUnique({ where: { id } });
  if (!existing) throw new AppError('Purchase order not found.', 404);
  if (existing.status !== 'PENDING_ACCOUNTS') {
    throw new AppError('Only POs pending Accounts can be rejected.', 400);
  }

  const po = await prisma.purchaseOrder.update({
    where: { id },
    data: { status: 'REJECTED', rejectionReason: reason, confirmedById: userId, confirmedAt: new Date() },
    include: poInclude,
  });
  // Back with MSP TL to fix and resubmit
  await prisma.lead.update({ where: { id: existing.leadId }, data: { status: 'CUSTOMER_ACCEPTED' } });
  await prisma.activityLog.create({
    data: { leadId: existing.leadId, userId, action: `PO ${existing.poNumber} rejected by Accounts`, details: reason },
  });
  // the PO's author, and every MSP TL (an Admin may have drafted it)
  await notifyUsers([existing.createdById, ...(await activeUserIds('MSP_TL'))], userId, {
    title: 'PO sent back by Accounts',
    message: `${existing.poNumber} needs changes: ${reason}`,
    type: 'PO_REJECTED',
    link: `/purchase-orders/${id}`,
  });

  return po;
}

// ---------------------------------------------------------------- Sales: send to vendor

export async function markPurchaseOrderSent(id: string, userId: string, note?: string) {
  const existing = await prisma.purchaseOrder.findUnique({ where: { id } });
  if (!existing) throw new AppError('Purchase order not found.', 404);
  if (existing.status !== 'CONFIRMED') {
    // The core rule of the flow: nothing goes to the vendor without Accounts
    throw new AppError('A PO can be sent to the vendor only after Accounts confirms it.', 400);
  }

  const po = await prisma.purchaseOrder.update({
    where: { id },
    data: { status: 'SENT_TO_VENDOR', sentById: userId, sentAt: new Date() },
    include: poInclude,
  });
  await prisma.lead.update({ where: { id: existing.leadId }, data: { status: 'PO_SENT' } });

  await prisma.activityLog.create({
    data: {
      leadId: existing.leadId,
      userId,
      action: note ? `PO ${existing.poNumber} sent to vendor (${note})` : `PO ${existing.poNumber} sent to vendor`,
    },
  });
  // Accounts records the vendor's invoice (our PINV number) when it arrives, then pays it
  await notifyRole('ACCOUNTS', userId, {
    title: 'PO sent to vendor',
    message: `${existing.poNumber} went to the vendor — record the vendor invoice when it arrives, and raise the customer invoice`,
    type: 'VENDOR_BILL',
    link: '/accounts?side=vendors&view=ready',
  });
  // the MSP TL who built the PO hears that it went out
  await notifyUsers([existing.createdById], userId, {
    title: 'PO sent to vendor',
    message: `${existing.poNumber} has gone to the vendor`,
    type: 'PO_SENT',
    link: `/purchase-orders/${id}`,
  });

  return prisma.purchaseOrder.findUniqueOrThrow({ where: { id }, include: poInclude });
}

/** The one PO document (HTML) — used by the print page and the vendor email */
async function buildPoDocument(id: string, intro?: string) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: { vendor: true },
  });
  if (!po) throw new AppError('Purchase order not found.', 404);
  const company = await prisma.companySettings.findUnique({ where: { id: 1 } });
  if (!company) throw new AppError('Set your company details in Settings first.', 400);

  const html = renderPoDocument({
    poNumber: po.poNumber,
    poDate: po.confirmedAt ?? po.createdAt,
    status: po.status,
    company,
    vendor: po.vendor,
    items: po.items as unknown as PoLine[],
    gstType: po.gstType,
    subtotal: po.subtotal,
    cgstAmount: po.cgstAmount,
    sgstAmount: po.sgstAmount,
    igstAmount: po.igstAmount,
    totalAmount: po.totalAmount,
    deliveryAddress: po.deliveryAddress,
    expectedDeliveryDate: po.expectedDeliveryDate,
    notes: po.notes,
    intro,
  });
  return { po, company, html };
}

export async function getPoDocument(id: string) {
  const { html } = await buildPoDocument(id);
  return { html };
}

export async function emailPurchaseOrder(
  id: string,
  userId: string,
  options: { recipient?: string; previewOnly?: boolean } = {}
) {
  const status = (await prisma.purchaseOrder.findUnique({ where: { id }, select: { status: true } }))?.status;
  if (!status) throw new AppError('Purchase order not found.', 404);
  if (status !== 'CONFIRMED' && status !== 'SENT_TO_VENDOR') {
    throw new AppError('A PO can be sent to the vendor only after Accounts confirms it.', 400);
  }
  const sender = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  if (!sender) throw new AppError('Sender not found.', 404);

  // Same document as the print page, with a short covering note on top
  const { po, company, html } = await buildPoDocument(
    id,
    `Dear Sir/Madam,\n\nPlease find below our Purchase Order. Kindly confirm receipt and share the dispatch date.\n\nRegards,\n${sender.name} (${sender.email})`
  );
  const recipient = options.recipient?.trim() || po.vendor.email;

  if (options.previewOnly) return { html, recipient, delivered: false, preview: true };

  const result = await sendEmail({
    to: recipient,
    subject: `Purchase Order ${po.poNumber} from ${company.name}`,
    html,
  });
  const how = `emailed to ${recipient}${result.delivered ? '' : ' — dev mode, not actually sent'}`;

  if (po.status === 'CONFIRMED') {
    await markPurchaseOrderSent(id, userId, how);
  } else {
    await prisma.activityLog.create({
      data: { leadId: po.leadId, userId, action: `PO ${po.poNumber} re-sent: ${how}` },
    });
  }

  return { html, recipient, delivered: result.delivered };
}

// ---------------------------------------------------------------- Accounts: vendor's bill

/**
 * Accounts records the vendor's invoice (PINV) after the PO goes out — see createPurchaseInvoice.
 * number/date when it arrives; amounts can be corrected until a payment is recorded.
 */
// ── Vendor bills (purchase invoices) ─────────────────────────────────────────
// Recorded by Accounts against a PO that went to the vendor — our own number
// (PINV/FY/NNNN), the lines/quantities the vendor billed at the PO buying rates,
// optionally the vendor's own invoice no. Partial billing allowed, over-billing blocked.

/** A PO's lines in bill form (buying rate; the customer rate never leaves the PO) */
function poBillLines(poItems: unknown): InvoiceLine[] {
  return (poItems as PoLine[]).map((l, lineIndex) => ({
    lineIndex,
    kind: l.kind,
    requirement: l.requirement,
    description: l.description,
    hsnCode: l.hsnCode,
    quantity: l.quantity,
    unit: l.unit,
    rate: l.rate,
    gstPercent: l.gstPercent,
    taxableAmount: l.taxableAmount,
    gstAmount: l.gstAmount,
    total: l.total,
  }));
}

/** POs sent to the vendor that still have quantities not billed */
export async function listReadyToBill() {
  const pos = await prisma.purchaseOrder.findMany({
    where: { status: 'SENT_TO_VENDOR' },
    include: {
      vendor: { select: { id: true, name: true, gstNumber: true } },
      lead: { select: { id: true, companyName: true } },
      purchaseInvoices: { select: { items: true } },
    },
    orderBy: { sentAt: 'asc' },
  });
  return pos
    .map(({ purchaseInvoices, items, lead, ...po }) => {
      const lines = poBillLines(items);
      const billed = billedQuantities(lines, purchaseInvoices);
      const remaining = lines.map((l, i) => round2(l.quantity - billed[i]));
      const remainingValue = round2(
        lines.reduce((a, l, i) => a + remaining[i] * l.rate * (1 + l.gstPercent / 100), 0)
      );
      return {
        id: po.id,
        poNumber: po.poNumber,
        sentAt: po.sentAt,
        gstType: po.gstType,
        vendor: po.vendor,
        lead, // internal reference only — never on anything sent to the vendor
        lines,
        billed,
        remaining,
        remainingValue,
        billCount: purchaseInvoices.length,
      };
    })
    .filter((p) => p.remaining.some((r) => r > 0));
}

/** Locked per PO: two clicks can't both pass the "how much is left to bill" check */
export async function createPurchaseInvoice(
  purchaseOrderId: string,
  input: Parameters<typeof createPurchaseInvoiceLocked>[1],
  userId: string
) {
  return withLock(`bill:po:${purchaseOrderId}`, () => createPurchaseInvoiceLocked(purchaseOrderId, input, userId));
}

async function createPurchaseInvoiceLocked(
  purchaseOrderId: string,
  input: {
    invoiceDate: string;
    dueDate?: string;
    vendorInvoiceNumber?: string;
    lines: { lineIndex: number; quantity: number }[];
    notes?: string;
  },
  userId: string
) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: { purchaseInvoices: { select: { items: true } } },
  });
  if (!po) throw new AppError('Purchase order not found.', 404);
  if (po.status !== 'SENT_TO_VENDOR') {
    throw new AppError('A vendor invoice can be recorded once the PO has been sent to the vendor.', 400);
  }

  const allLines = poBillLines(po.items);
  const billed = billedQuantities(allLines, po.purchaseInvoices);
  const lines = input.lines.filter((l) => l.quantity > 0);
  if (lines.length === 0) throw new AppError('Bill at least one line.', 400);
  for (const l of lines) {
    const line = allLines[l.lineIndex];
    if (!line) throw new AppError(`Line ${l.lineIndex + 1} does not exist on the PO.`, 400);
    const remaining = round2(line.quantity - billed[l.lineIndex]);
    if (l.quantity > remaining + 1e-9) {
      throw new AppError(`"${line.description}": only ${remaining} ${line.unit} left to bill.`, 400);
    }
  }

  const vendorInvoiceNumber = input.vendorInvoiceNumber?.trim() || null;
  if (vendorInvoiceNumber) {
    const duplicate = await prisma.purchaseInvoice.findFirst({ where: { vendorId: po.vendorId, vendorInvoiceNumber } });
    if (duplicate) throw new AppError(`Vendor invoice ${vendorInvoiceNumber} is already recorded as ${duplicate.billNumber}.`, 409);
  }

  const calc = invoiceLines(allLines, lines, po.gstType);
  const invoiceDate = new Date(input.invoiceDate);

  const bill = await createWithFyNumber(
    'PINV',
    invoiceDate,
    async (startsWith) =>
      (
        await prisma.purchaseInvoice.findFirst({
          where: { billNumber: { startsWith } },
          orderBy: { billNumber: 'desc' },
          select: { billNumber: true },
        })
      )?.billNumber ?? null,
    (billNumber) =>
      prisma.purchaseInvoice.create({
        data: {
          billNumber,
          purchaseOrderId,
          vendorId: po.vendorId,
          vendorInvoiceNumber,
          items: calc.items as unknown as object,
          invoiceDate,
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          taxableAmount: calc.subtotal,
          gstType: po.gstType,
          cgstAmount: calc.cgstAmount,
          sgstAmount: calc.sgstAmount,
          igstAmount: calc.igstAmount,
          totalAmount: calc.totalAmount,
          notes: input.notes || null,
          createdById: userId,
        },
      }),
    'billNumber'
  );

  await prisma.activityLog.create({
    data: {
      leadId: po.leadId,
      userId,
      action: `Vendor invoice ${bill.billNumber}${vendorInvoiceNumber ? ` (vendor no. ${vendorInvoiceNumber})` : ''} recorded for ${po.poNumber} (${calc.totalAmount})`,
    },
  });
  return bill;
}

/** Details only — amounts come from the billed lines (corrections: credit/debit note, or delete while unpaid) */
export async function updatePurchaseInvoice(
  id: string,
  input: {
    vendorInvoiceNumber?: string;
    invoiceDate?: string;
    dueDate?: string;
    notes?: string;
  },
  userId: string
) {
  const bill = await prisma.purchaseInvoice.findUnique({
    where: { id },
    include: { purchaseOrder: { select: { leadId: true, poNumber: true } } },
  });
  if (!bill) throw new AppError('Vendor bill not found.', 404);

  if (input.vendorInvoiceNumber) {
    const duplicate = await prisma.purchaseInvoice.findFirst({
      where: { vendorId: bill.vendorId, vendorInvoiceNumber: input.vendorInvoiceNumber, id: { not: id } },
    });
    if (duplicate) throw new AppError(`Vendor invoice ${input.vendorInvoiceNumber} is already recorded as ${duplicate.billNumber}.`, 409);
  }

  const data: Record<string, unknown> = {};
  if (input.vendorInvoiceNumber !== undefined) data.vendorInvoiceNumber = input.vendorInvoiceNumber || null;
  if (input.invoiceDate) data.invoiceDate = new Date(input.invoiceDate);
  if (input.dueDate !== undefined) data.dueDate = input.dueDate ? new Date(input.dueDate) : null;
  if (input.notes !== undefined) data.notes = input.notes || null;

  const updated = await prisma.purchaseInvoice.update({
    where: { id },
    data,
    include: { createdBy: { select: userSelect } },
  });
  await prisma.activityLog.create({
    data: {
      leadId: bill.purchaseOrder.leadId,
      userId,
      action: `Vendor invoice ${bill.billNumber} updated${input.vendorInvoiceNumber ? ` (vendor no. ${input.vendorInvoiceNumber})` : ''}`,
    },
  });
  return updated;
}

/** Undo a wrongly recorded bill — only while nothing is paid or noted against it */
export async function deletePurchaseInvoice(id: string, userId: string) {
  const bill = await prisma.purchaseInvoice.findUnique({
    where: { id },
    include: {
      allocations: { select: { id: true } },
      adjustmentNotes: { select: { id: true } },
      purchaseOrder: { select: { leadId: true } },
    },
  });
  if (!bill) throw new AppError('Vendor bill not found.', 404);
  if (bill.allocations.length || bill.adjustmentNotes.length) {
    throw new AppError('This bill has payments or notes against it and cannot be deleted — use a credit note.', 400);
  }
  await prisma.$transaction([
    prisma.attachment.deleteMany({ where: { entityType: 'PURCHASE_INVOICE', entityId: id } }),
    prisma.purchaseInvoice.delete({ where: { id } }),
  ]);
  await prisma.activityLog.create({
    data: { leadId: bill.purchaseOrder.leadId, userId, action: `Vendor invoice ${bill.billNumber} deleted` },
  });
}

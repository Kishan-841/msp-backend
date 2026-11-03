import { prisma } from '../lib/prisma.js';
import { envelope, startOfTodayIST, type PageParams } from '../utils/paginate.js';
import { withLock } from '../lib/lock.js';
import { AppError } from '../middleware/errorHandler.js';
import type { PaymentDirection, PaymentMode, NoteKind, NoteSide } from '../generated/prisma/client.js';
import { createWithFyNumber } from '../utils/docNumber.js';
import { round2, tdsOn } from '../utils/salesCalc.js';
import { splitGst } from '../utils/poCalc.js';
import {
  outstandingOf,
  purchaseInvoiceBalance,
  refreshPurchaseInvoiceStatus,
  refreshSalesInvoiceStatus,
  salesInvoiceBalance,
} from './balance.service.js';

const userSelect = { id: true, name: true } as const;

const latestPaymentNumber = async (startsWith: string) =>
  (
    await prisma.payment.findFirst({
      where: { number: { startsWith } },
      orderBy: { number: 'desc' },
      select: { number: true },
    })
  )?.number ?? null;

/** Unallocated part of a payment (cash + TDS − allocated) — i.e. the advance left */
export async function unallocatedOf(paymentId: string) {
  const p = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { allocations: true } });
  return { payment: p, unallocated: round2(p.amount + p.tdsAmount - p.allocations.reduce((a, x) => a + x.amount, 0)) };
}

/** Invoice the money goes against, checked to belong to the same party */
async function invoiceFor(direction: PaymentDirection, invoiceId: string, partyId: string) {
  if (direction === 'IN') {
    const b = await salesInvoiceBalance(invoiceId).catch(() => null);
    if (!b) throw new AppError('Invoice not found.', 404);
    if (b.invoice.leadId !== partyId) throw new AppError('That invoice belongs to a different customer.', 400);
    return { ...b, number: b.invoice.invoiceNumber, taxable: b.invoice.subtotal };
  }
  const b = await purchaseInvoiceBalance(invoiceId).catch(() => null);
  if (!b) throw new AppError('Vendor bill not found.', 404);
  if (b.invoice.vendorId !== partyId) throw new AppError('That bill belongs to a different vendor.', 400);
  return { ...b, number: b.invoice.billNumber, taxable: b.invoice.taxableAmount };
}

async function refreshInvoice(direction: PaymentDirection, invoiceId: string) {
  if (direction === 'IN') await refreshSalesInvoiceStatus(invoiceId);
  else await refreshPurchaseInvoiceStatus(invoiceId);
}

async function logOnLead(leadId: string | null, userId: string, action: string) {
  if (leadId) await prisma.activityLog.create({ data: { leadId, userId, action } });
}

export interface PaymentInput {
  direction: PaymentDirection;
  partyId: string; // leadId for IN, vendorId for OUT
  paymentDate: string;
  mode: PaymentMode;
  reference?: string;
  notes?: string;
  // Either settle an invoice (gross incl. TDS) …
  invoiceId?: string;
  settleAmount?: number;
  tdsPercent?: number;
  // … or record an advance (cash only, applied to invoices later)
  advanceAmount?: number;
  // The customer's / vendor's bank account (optional)
  partyBankName?: string;
  partyBankAccountName?: string;
  partyBankAccountNumber?: string;
  partyBankIfsc?: string;
}

/** Locked per invoice being settled: two receipts can't both pass the "≤ outstanding" check */
export async function createPayment(input: PaymentInput, userId: string) {
  return input.invoiceId
    ? withLock(`inv:${input.invoiceId}`, () => createPaymentLocked(input, userId))
    : createPaymentLocked(input, userId);
}

async function createPaymentLocked(input: PaymentInput, userId: string) {
  const isIn = input.direction === 'IN';
  const party = isIn
    ? await prisma.lead.findUnique({ where: { id: input.partyId }, select: { id: true } })
    : await prisma.vendor.findUnique({ where: { id: input.partyId }, select: { id: true } });
  if (!party) throw new AppError(isIn ? 'Customer not found.' : 'Vendor not found.', 404);

  let amount: number;
  let tdsPercent = 0;
  let tdsAmount = 0;
  let allocation: { invoiceId: string; gross: number; number: string; leadId: string | null } | null = null;

  if (input.invoiceId) {
    const gross = round2(input.settleAmount ?? 0);
    if (!(gross > 0)) throw new AppError('Enter the amount being settled.', 400);
    const inv = await invoiceFor(input.direction, input.invoiceId, input.partyId);
    if (gross > inv.outstanding + 0.005) {
      throw new AppError(`Only ${inv.outstanding} is outstanding on ${inv.number}.`, 400);
    }
    tdsPercent = input.tdsPercent ?? 0;
    tdsAmount = tdsOn(gross, inv.taxable, inv.invoice.totalAmount, tdsPercent);
    amount = round2(gross - tdsAmount);
    const leadId = isIn
      ? (inv.invoice as { leadId: string }).leadId
      : (
          await prisma.purchaseOrder.findUnique({
            where: { id: (inv.invoice as { purchaseOrderId: string }).purchaseOrderId },
            select: { leadId: true },
          })
        )?.leadId ?? null;
    allocation = { invoiceId: input.invoiceId, gross, number: inv.number, leadId };
  } else {
    amount = round2(input.advanceAmount ?? 0);
    if (!(amount > 0)) throw new AppError('Enter the advance amount.', 400);
  }

  // Our account the money moved through — snapshot, so later changes in Settings don't rewrite history
  const company = await prisma.companySettings.findUnique({ where: { id: 1 } });
  const bank = {
    ourBankName: company?.bankName ?? null,
    ourBankAccountNumber: company?.bankAccountNumber ?? null,
    ourBankIfsc: company?.bankIfsc ?? null,
    partyBankName: input.partyBankName || null,
    partyBankAccountName: input.partyBankAccountName || null,
    partyBankAccountNumber: input.partyBankAccountNumber || null,
    partyBankIfsc: input.partyBankIfsc || null,
  };

  const paymentDate = new Date(input.paymentDate);
  const payment = await createWithFyNumber(isIn ? 'RCPT' : 'PAY', paymentDate, latestPaymentNumber, (number) =>
    prisma.payment.create({
      data: {
        number,
        direction: input.direction,
        leadId: isIn ? input.partyId : null,
        vendorId: isIn ? null : input.partyId,
        paymentDate,
        mode: input.mode,
        reference: input.reference || null,
        amount,
        tdsPercent,
        tdsAmount,
        ...bank,
        notes: input.notes || null,
        createdById: userId,
        ...(allocation
          ? {
              allocations: {
                create: {
                  amount: allocation.gross,
                  ...(isIn
                    ? { salesInvoiceId: allocation.invoiceId }
                    : { purchaseInvoiceId: allocation.invoiceId }),
                },
              },
            }
          : {}),
      },
    })
  );

  if (allocation) {
    await refreshInvoice(input.direction, allocation.invoiceId);
    await logOnLead(
      allocation.leadId,
      userId,
      `${isIn ? 'Receipt' : 'Vendor payment'} ${payment.number}: ${amount}${tdsAmount ? ` + TDS ${tdsAmount}` : ''} against ${allocation.number}`
    );
  } else if (isIn) {
    await logOnLead(input.partyId, userId, `Advance ${payment.number} received: ${amount}`);
  }

  return payment;
}

/** Apply part of an advance to an invoice of the same party */
/** Locked on the advance and the invoice: an advance can't be applied twice over */
export async function allocatePayment(paymentId: string, invoiceId: string, amount: number, userId: string) {
  return withLock([`payment:${paymentId}`, `inv:${invoiceId}`], () =>
    allocatePaymentLocked(paymentId, invoiceId, amount, userId)
  );
}

async function allocatePaymentLocked(paymentId: string, invoiceId: string, amount: number, userId: string) {
  const { payment, unallocated } = await unallocatedOf(paymentId).catch(() => {
    throw new AppError('Payment not found.', 404);
  });
  const gross = round2(amount);
  if (!(gross > 0)) throw new AppError('Enter an amount to apply.', 400);
  if (gross > unallocated + 0.005) throw new AppError(`Only ${unallocated} of this payment is unapplied.`, 400);

  const partyId = (payment.direction === 'IN' ? payment.leadId : payment.vendorId)!;
  const inv = await invoiceFor(payment.direction, invoiceId, partyId);
  if (gross > inv.outstanding + 0.005) {
    throw new AppError(`Only ${inv.outstanding} is outstanding on ${inv.number}.`, 400);
  }

  await prisma.paymentAllocation.create({
    data: {
      paymentId,
      amount: gross,
      ...(payment.direction === 'IN' ? { salesInvoiceId: invoiceId } : { purchaseInvoiceId: invoiceId }),
    },
  });
  await refreshInvoice(payment.direction, invoiceId);
  if (payment.leadId) await logOnLead(payment.leadId, userId, `Advance ${payment.number}: ${gross} applied to ${inv.number}`);
  return unallocatedOf(paymentId);
}

export async function listPayments(
  filters: { direction?: PaymentDirection; partyId?: string; search?: string } = {},
  page?: PageParams
) {
  const and: Record<string, unknown>[] = [];
  if (filters.direction) and.push({ direction: filters.direction });
  if (filters.partyId) and.push({ OR: [{ leadId: filters.partyId }, { vendorId: filters.partyId }] });
  if (filters.search) {
    const q = { contains: filters.search, mode: 'insensitive' as const };
    and.push({ OR: [{ number: q }, { reference: q }, { lead: { companyName: q } }, { vendor: { name: q } }] });
  }
  const where = { AND: and };
  const payments = await prisma.payment.findMany({
    where,
    ...(page ? { skip: page.skip, take: page.limit } : {}),
    include: {
      lead: { select: { id: true, companyName: true } },
      vendor: { select: { id: true, name: true } },
      createdBy: { select: userSelect },
      allocations: {
        include: {
          salesInvoice: { select: { id: true, invoiceNumber: true } },
          purchaseInvoice: { select: { id: true, billNumber: true, vendorInvoiceNumber: true, purchaseOrderId: true } },
        },
      },
    },
    orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
  });
  const rows = payments.map((p) => ({
    ...p,
    unallocated: round2(p.amount + p.tdsAmount - p.allocations.reduce((a, x) => a + x.amount, 0)),
  }));
  if (!page) return rows;
  return envelope(rows, await prisma.payment.count({ where }), page);
}

/** Vendor bills with what's still owed — for picking a bill to pay */
export async function listPurchaseInvoices(
  filters: { vendorId?: string; search?: string; status?: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' } = {},
  page?: PageParams
) {
  const where: Record<string, unknown> = {};
  if (filters.vendorId) where.vendorId = filters.vendorId;
  if (filters.status === 'OVERDUE') {
    where.paymentStatus = { not: 'PAID' };
    where.dueDate = { lt: startOfTodayIST() };
  } else if (filters.status) where.paymentStatus = filters.status;
  if (filters.search) {
    const q = { contains: filters.search, mode: 'insensitive' as const };
    where.OR = [{ billNumber: q }, { vendorInvoiceNumber: q }, { vendor: { name: q } }, { purchaseOrder: { poNumber: q } }];
  }
  const bills = await prisma.purchaseInvoice.findMany({
    where,
    ...(page ? { skip: page.skip, take: page.limit } : {}),
    include: {
      vendor: { select: { id: true, name: true } },
      purchaseOrder: { select: { id: true, poNumber: true } },
      adjustmentNotes: { select: { kind: true, totalAmount: true } },
      allocations: { select: { amount: true } },
    },
    orderBy: [{ invoiceDate: 'desc' }, { billNumber: 'desc' }],
  });
  // allocations stay on the row: the bill form locks amounts once anything is paid
  const rows = bills.map(({ adjustmentNotes, ...b }) => ({
    ...b,
    outstanding: outstandingOf(b.totalAmount, adjustmentNotes, b.allocations),
  }));
  if (!page) return rows;
  const [total, unpaid] = await Promise.all([
    prisma.purchaseInvoice.count({ where }),
    prisma.purchaseInvoice.count({ where: { paymentStatus: { not: 'PAID' } } }),
  ]);
  return envelope(rows, total, page, { unpaid });
}

// ---------------------------------------------------------------- Credit / debit notes

/** Locked on the invoice (credit cap) and, for our own notes, the CN/DN series (numbers aren't a DB unique) */
export async function createNote(input: Parameters<typeof createNoteLocked>[0], userId: string) {
  const keys = [`inv:${input.invoiceId}`];
  if (input.side === 'SALES') keys.push(`series:${input.kind === 'CREDIT' ? 'CN' : 'DN'}`);
  return withLock(keys, () => createNoteLocked(input, userId));
}

async function createNoteLocked(
  input: {
    side: NoteSide;
    kind: NoteKind;
    invoiceId: string;
    noteDate: string;
    taxableAmount: number;
    gstAmount: number;
    reason: string;
    number?: string; // vendor's note number (purchase side)
  },
  userId: string
) {
  const isSales = input.side === 'SALES';
  const bal = isSales
    ? await salesInvoiceBalance(input.invoiceId).catch(() => null)
    : await purchaseInvoiceBalance(input.invoiceId).catch(() => null);
  if (!bal) throw new AppError('Invoice not found.', 404);

  const total = round2(input.taxableAmount + input.gstAmount);
  if (input.kind === 'CREDIT') {
    // Can't credit back more than was ever billed on the invoice
    const notes = bal.invoice.adjustmentNotes;
    const credited = notes.filter((n) => n.kind === 'CREDIT').reduce((a, n) => a + n.totalAmount, 0);
    const debited = notes.filter((n) => n.kind === 'DEBIT').reduce((a, n) => a + n.totalAmount, 0);
    const room = round2(bal.invoice.totalAmount + debited - credited);
    if (total > room + 0.005) throw new AppError(`Credit can be at most ${room} on this invoice.`, 400);
    // …nor more than is still unpaid: money already received would need a refund, which
    // the system doesn't record yet — the balance would go negative with nowhere to put it
    if (total > bal.outstanding + 0.005) {
      throw new AppError(
        `Only ${bal.outstanding} is still unpaid on this invoice, so the credit can be at most that. ` +
          'Money already received would have to be refunded, which isn\'t supported yet.',
        400
      );
    }
  }
  if (!isSales && !input.number?.trim()) throw new AppError("Enter the vendor's note number.", 400);

  const gstType = bal.invoice.gstType;
  const noteDate = new Date(input.noteDate);
  const data = {
    kind: input.kind,
    side: input.side,
    noteDate,
    taxableAmount: round2(input.taxableAmount),
    gstType,
    ...splitGst(input.gstAmount, gstType),
    totalAmount: total,
    reason: input.reason,
    createdById: userId,
    ...(isSales ? { salesInvoiceId: input.invoiceId } : { purchaseInvoiceId: input.invoiceId }),
  };

  const note = isSales
    ? await createWithFyNumber(
        input.kind === 'CREDIT' ? 'CN' : 'DN',
        noteDate,
        async (startsWith) =>
          (
            await prisma.adjustmentNote.findFirst({
              where: { side: 'SALES', number: { startsWith } },
              orderBy: { number: 'desc' },
              select: { number: true },
            })
          )?.number ?? null,
        (number) => prisma.adjustmentNote.create({ data: { ...data, number } })
      )
    : await prisma.adjustmentNote.create({ data: { ...data, number: input.number!.trim() } });

  if (isSales) await refreshSalesInvoiceStatus(input.invoiceId);
  else await refreshPurchaseInvoiceStatus(input.invoiceId);

  return note;
}

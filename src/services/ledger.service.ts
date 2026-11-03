import { prisma } from '../lib/prisma.js';
import { envelope, startOfTodayIST, type PageParams } from '../utils/paginate.js';
import { AppError } from '../middleware/errorHandler.js';
import { round2 } from '../utils/salesCalc.js';
import { GST_STATES } from '../utils/gst.js';

export interface LedgerEntry {
  date: Date;
  type: 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'RECEIPT' | 'PAYMENT' | 'TDS';
  number: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  link?: string;
}

const dateRange = (from?: string, to?: string) =>
  from || to
    ? { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}) }
    : undefined;

/** Sort by date and add a running balance. sign = +1 for receivables, −1 for payables */
function withBalance(entries: Omit<LedgerEntry, 'balance'>[], sign: 1 | -1): LedgerEntry[] {
  let balance = 0;
  return entries
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((e) => {
      balance = round2(balance + sign * (e.debit - e.credit));
      return { ...e, balance };
    });
}

// ---------------------------------------------------------------- Customers (receivable)

/** Customer ledger: invoices & debit notes are Dr; receipts, TDS & credit notes are Cr */
export async function customerLedger(leadId: string) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, companyName: true, customerGstin: true, customerState: true, billingAddress: true },
  });
  if (!lead) throw new AppError('Customer not found.', 404);

  const [invoices, payments] = await Promise.all([
    prisma.salesInvoice.findMany({ where: { leadId }, include: { adjustmentNotes: true } }),
    prisma.payment.findMany({ where: { leadId, direction: 'IN' } }),
  ]);

  const entries: Omit<LedgerEntry, 'balance'>[] = [];
  for (const inv of invoices) {
    entries.push({
      date: inv.invoiceDate,
      type: 'INVOICE',
      number: inv.invoiceNumber,
      description: 'Sales invoice',
      debit: inv.totalAmount,
      credit: 0,
      link: `/invoices/${inv.id}`,
    });
    for (const n of inv.adjustmentNotes) {
      entries.push({
        date: n.noteDate,
        type: n.kind === 'CREDIT' ? 'CREDIT_NOTE' : 'DEBIT_NOTE',
        number: n.number,
        description: `${n.kind === 'CREDIT' ? 'Credit' : 'Debit'} note on ${inv.invoiceNumber}: ${n.reason}`,
        debit: n.kind === 'DEBIT' ? n.totalAmount : 0,
        credit: n.kind === 'CREDIT' ? n.totalAmount : 0,
        link: `/invoices/${inv.id}`,
      });
    }
  }
  for (const p of payments) {
    entries.push({
      date: p.paymentDate,
      type: 'RECEIPT',
      number: p.number,
      description: `Receipt (${p.mode}${p.reference ? ` ${p.reference}` : ''})`,
      debit: 0,
      credit: p.amount,
    });
    if (p.tdsAmount > 0) {
      entries.push({
        date: p.paymentDate,
        type: 'TDS',
        number: p.number,
        description: `TDS deducted by customer @ ${p.tdsPercent}%`,
        debit: 0,
        credit: p.tdsAmount,
      });
    }
  }

  const rows = withBalance(entries, 1);
  return {
    party: { ...lead, stateName: lead.customerState ? GST_STATES[lead.customerState] : null },
    entries: rows,
    closingBalance: rows.at(-1)?.balance ?? 0,
  };
}

export async function customerSummaries(search?: string, page?: PageParams) {
  const where = {
    AND: [
      { OR: [{ salesInvoices: { some: {} } }, { payments: { some: {} } }] },
      search ? { companyName: { contains: search, mode: 'insensitive' as const } } : {},
    ],
  };
  const leads = await prisma.lead.findMany({
    where,
    select: { id: true, companyName: true, customerGstin: true },
    orderBy: { companyName: 'asc' },
    ...(page ? { skip: page.skip, take: page.limit } : {}),
  });
  const rows = await Promise.all(
    leads.map(async (l) => {
      const { entries, closingBalance } = await customerLedger(l.id);
      const invoiced = round2(entries.filter((e) => e.type === 'INVOICE').reduce((a, e) => a + e.debit, 0));
      const received = round2(
        entries.filter((e) => e.type === 'RECEIPT' || e.type === 'TDS').reduce((a, e) => a + e.credit, 0)
      );
      return { ...l, invoiced, received, outstanding: closingBalance };
    })
  );
  return page ? envelope(rows, await prisma.lead.count({ where }), page) : rows;
}

// ---------------------------------------------------------------- Vendors (payable)

/** Vendor ledger: bills & vendor debit notes are Cr; payments, TDS & vendor credit notes are Dr */
export async function vendorLedger(vendorId: string) {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, name: true, gstNumber: true, state: true, address: true },
  });
  if (!vendor) throw new AppError('Vendor not found.', 404);

  const [bills, payments] = await Promise.all([
    prisma.purchaseInvoice.findMany({
      where: { vendorId },
      include: { adjustmentNotes: true, purchaseOrder: { select: { poNumber: true } } },
    }),
    prisma.payment.findMany({ where: { vendorId, direction: 'OUT' } }),
  ]);

  const entries: Omit<LedgerEntry, 'balance'>[] = [];
  for (const b of bills) {
    entries.push({
      date: b.invoiceDate,
      type: 'INVOICE',
      // Until the vendor's invoice no. is entered, the PO number identifies the bill
      number: b.billNumber,
      description: `Vendor invoice for ${b.purchaseOrder.poNumber}${b.vendorInvoiceNumber ? ` (vendor no. ${b.vendorInvoiceNumber})` : ''}`,
      debit: 0,
      credit: b.totalAmount,
      link: `/purchase-orders/${b.purchaseOrderId}`,
    });
    for (const n of b.adjustmentNotes) {
      entries.push({
        date: n.noteDate,
        type: n.kind === 'CREDIT' ? 'CREDIT_NOTE' : 'DEBIT_NOTE',
        number: n.number,
        description: `Vendor ${n.kind === 'CREDIT' ? 'credit' : 'debit'} note on ${b.billNumber}: ${n.reason}`,
        debit: n.kind === 'CREDIT' ? n.totalAmount : 0,
        credit: n.kind === 'DEBIT' ? n.totalAmount : 0,
        link: `/purchase-orders/${b.purchaseOrderId}`,
      });
    }
  }
  for (const p of payments) {
    entries.push({
      date: p.paymentDate,
      type: 'PAYMENT',
      number: p.number,
      description: `Payment (${p.mode}${p.reference ? ` ${p.reference}` : ''})`,
      debit: p.amount,
      credit: 0,
    });
    if (p.tdsAmount > 0) {
      entries.push({
        date: p.paymentDate,
        type: 'TDS',
        number: p.number,
        description: `TDS deducted by us @ ${p.tdsPercent}%`,
        debit: p.tdsAmount,
        credit: 0,
      });
    }
  }

  const rows = withBalance(entries, -1);
  return {
    party: { ...vendor, stateName: vendor.state ? GST_STATES[vendor.state] : null },
    entries: rows,
    closingBalance: rows.at(-1)?.balance ?? 0,
  };
}

export async function vendorSummaries(search?: string, page?: PageParams) {
  const where = {
    AND: [
      { OR: [{ purchaseInvoices: { some: {} } }, { payments: { some: {} } }] },
      search ? { name: { contains: search, mode: 'insensitive' as const } } : {},
    ],
  };
  const vendors = await prisma.vendor.findMany({
    where,
    select: { id: true, name: true, gstNumber: true },
    orderBy: { name: 'asc' },
    ...(page ? { skip: page.skip, take: page.limit } : {}),
  });
  const rows = await Promise.all(
    vendors.map(async (v) => {
      const { entries, closingBalance } = await vendorLedger(v.id);
      const billed = round2(entries.filter((e) => e.type === 'INVOICE').reduce((a, e) => a + e.credit, 0));
      const paid = round2(
        entries.filter((e) => e.type === 'PAYMENT' || e.type === 'TDS').reduce((a, e) => a + e.debit, 0)
      );
      return { ...v, billed, paid, outstanding: closingBalance };
    })
  );
  return page ? envelope(rows, await prisma.vendor.count({ where }), page) : rows;
}

// ---------------------------------------------------------------- Registers (CSV for Excel / Tally)

export async function salesRegister(from?: string, to?: string) {
  const rows = await prisma.salesInvoice.findMany({
    where: { invoiceDate: dateRange(from, to) },
    orderBy: { invoiceNumber: 'asc' },
  });
  return rows.map((r) => ({
    'Invoice No': r.invoiceNumber,
    'Invoice Date': r.invoiceDate.toISOString().slice(0, 10),
    Customer: r.customerName,
    GSTIN: r.customerGstin ?? '',
    'Place of Supply': `${r.placeOfSupply}-${GST_STATES[r.placeOfSupply] ?? ''}`,
    Taxable: r.subtotal,
    CGST: r.cgstAmount,
    SGST: r.sgstAmount,
    IGST: r.igstAmount,
    Total: r.totalAmount,
    Status: r.paymentStatus,
  }));
}

export async function purchaseRegister(from?: string, to?: string) {
  const rows = await prisma.purchaseInvoice.findMany({
    where: { invoiceDate: dateRange(from, to) },
    include: { vendor: true, purchaseOrder: { select: { poNumber: true } } },
    orderBy: { invoiceDate: 'asc' },
  });
  return rows.map((r) => ({
    'Bill No': r.billNumber,
    'Vendor Invoice No': r.vendorInvoiceNumber ?? '',
    'Invoice Date': r.invoiceDate.toISOString().slice(0, 10),
    Vendor: r.vendor.name,
    GSTIN: r.vendor.gstNumber ?? '',
    'PO No': r.purchaseOrder.poNumber,
    Taxable: r.taxableAmount,
    CGST: r.cgstAmount,
    SGST: r.sgstAmount,
    IGST: r.igstAmount,
    Total: r.totalAmount,
    Status: r.paymentStatus,
  }));
}

export async function paymentsRegister(from?: string, to?: string) {
  const rows = await prisma.payment.findMany({
    where: { paymentDate: dateRange(from, to) },
    include: {
      lead: { select: { companyName: true } },
      vendor: { select: { name: true } },
      allocations: {
        include: {
          salesInvoice: { select: { invoiceNumber: true } },
          purchaseInvoice: { select: { billNumber: true } },
        },
      },
    },
    orderBy: { number: 'asc' },
  });
  return rows.map((r) => ({
    'Voucher No': r.number,
    Date: r.paymentDate.toISOString().slice(0, 10),
    Type: r.direction === 'IN' ? 'Receipt' : 'Payment',
    Party: r.lead?.companyName ?? r.vendor?.name ?? '',
    Mode: r.mode,
    Reference: r.reference ?? '',
    Amount: r.amount,
    'TDS %': r.tdsPercent,
    TDS: r.tdsAmount,
    'Our Bank': [r.ourBankName, r.ourBankAccountNumber, r.ourBankIfsc].filter(Boolean).join(' / '),
    'Party Bank': [r.partyBankName, r.partyBankAccountNumber, r.partyBankIfsc].filter(Boolean).join(' / '),
    'Against Invoices': r.allocations
      .map((a) => a.salesInvoice?.invoiceNumber ?? a.purchaseInvoice?.billNumber)
      .join(' '),
  }));
}

/** RFC 4180 CSV; a UTF-8 BOM so Excel shows ₹ and Indian names correctly */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '﻿';
  const headers = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '');
    // Leading = + - @ would be run as formulas by Excel — prefix to neutralise
    const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '﻿' + [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n');
}

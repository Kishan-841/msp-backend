import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pageArray, pageParams, searchParam } from '../utils/paginate.js';
import { sendSuccess, sendCreated } from '../utils/ApiResponse.js';
import * as salesService from '../services/sales.service.js';
import * as paymentService from '../services/payment.service.js';
import * as ledgerService from '../services/ledger.service.js';
import * as poService from '../services/purchaseOrder.service.js';
import { optionalAccountNumberField, optionalIfscField } from '../utils/gst.js';
import * as access from '../services/access.service.js';

const dateField = z
  .string()
  .trim()
  .min(1, 'Date is required')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Not a valid date');
const optionalText = z.string().trim().optional();
// optional dates (e.g. due date) — blank allowed, garbage rejected
const optionalDate = optionalText.refine((s) => !s || !Number.isNaN(Date.parse(s)), 'Not a valid date');

// ---------------------------------------------------------------- Customer invoices (from the accepted quote)

const invoiceSchema = z.object({
  quoteId: z.uuid('Pick the deal to invoice'),
  invoiceDate: dateField,
  dueDate: optionalDate,
  lines: z
    .array(z.object({ lineIndex: z.number().int().nonnegative(), quantity: z.number().nonnegative() }))
    .min(1, 'Bill at least one line'),
  notes: optionalText,
});

export const readyToInvoice = asyncHandler(async (req: Request, res: Response) => {
  // computed in memory ("what's left to bill"), then paged
  let deals = await salesService.listReadyToInvoice();
  const q = searchParam(req)?.toLowerCase();
  if (q) deals = deals.filter((d) => d.quoteNumber.toLowerCase().includes(q) || d.lead.companyName.toLowerCase().includes(q));
  const p = pageParams(req);
  sendSuccess(res, p ? pageArray(deals, p) : deals, 'Deals ready to invoice retrieved');
});

export const createSalesInvoice = asyncHandler(async (req: Request, res: Response) => {
  const { quoteId, ...input } = invoiceSchema.parse(req.body);
  const invoice = await salesService.createSalesInvoice(quoteId, input, req.user!.id);
  sendCreated(res, invoice, 'Invoice raised');
});

export const listSalesInvoices = asyncHandler(async (req: Request, res: Response) => {
  const paymentStatus = z.enum(['UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERDUE']).optional().parse(req.query.status || undefined);
  const invoices = await salesService.listSalesInvoices(
    req.user!.id,
    req.user!.role,
    { paymentStatus, leadId: (req.query.leadId as string) || undefined, search: searchParam(req) },
    pageParams(req) ?? undefined
  );
  sendSuccess(res, invoices, 'Invoices retrieved');
});

export const getSalesInvoice = asyncHandler(async (req: Request, res: Response) => {
  await access.assertSalesInvoiceAccess(req.user!, String(req.params.id));
  sendSuccess(res, await salesService.getSalesInvoice(String(req.params.id)), 'Invoice retrieved');
});

// ---------------------------------------------------------------- Payments & notes

const paymentSchema = z
  .object({
    direction: z.enum(['IN', 'OUT']),
    partyId: z.uuid('Pick the customer or vendor'),
    paymentDate: dateField,
    mode: z.enum(['NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'CASH', 'OTHER']),
    reference: optionalText,
    notes: optionalText,
    invoiceId: z.uuid().optional(),
    settleAmount: z.number().positive().optional(),
    tdsPercent: z.number().min(0).max(30).optional(),
    advanceAmount: z.number().positive().optional(),
    partyBankName: optionalText,
    partyBankAccountName: optionalText,
    partyBankAccountNumber: optionalAccountNumberField,
    partyBankIfsc: optionalIfscField,
  })
  .refine((p) => (p.invoiceId ? p.settleAmount !== undefined : p.advanceAmount !== undefined), {
    message: 'Give an amount to settle against the invoice, or an advance amount',
  })
  .refine((p) => p.invoiceId || !p.tdsPercent, { message: 'TDS applies only to a payment against an invoice' });

export const createPayment = asyncHandler(async (req: Request, res: Response) => {
  const payment = await paymentService.createPayment(paymentSchema.parse(req.body), req.user!.id);
  sendCreated(res, payment, 'Payment recorded');
});

export const allocatePayment = asyncHandler(async (req: Request, res: Response) => {
  const { invoiceId, amount } = z
    .object({ invoiceId: z.uuid('Pick an invoice'), amount: z.number().positive('Enter an amount') })
    .parse(req.body);
  const result = await paymentService.allocatePayment(String(req.params.id), invoiceId, amount, req.user!.id);
  sendSuccess(res, result, 'Advance applied');
});

export const listPayments = asyncHandler(async (req: Request, res: Response) => {
  const direction = z.enum(['IN', 'OUT']).optional().parse(req.query.direction || undefined);
  const payments = await paymentService.listPayments(
    { direction, partyId: (req.query.partyId as string) || undefined, search: searchParam(req) },
    pageParams(req) ?? undefined
  );
  sendSuccess(res, payments, 'Payments retrieved');
});

export const listPurchaseInvoices = asyncHandler(async (req: Request, res: Response) => {
  const status = z.enum(['UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERDUE']).optional().parse(req.query.status || undefined);
  const bills = await paymentService.listPurchaseInvoices(
    { vendorId: (req.query.vendorId as string) || undefined, search: searchParam(req), status },
    pageParams(req) ?? undefined
  );
  sendSuccess(res, bills, 'Vendor bills retrieved');
});

// Edit details of a recorded vendor bill (amounts come from its lines)
const billSchema = z.object({
  vendorInvoiceNumber: optionalText,
  invoiceDate: optionalText,
  dueDate: optionalDate,
  notes: optionalText,
});

const newBillSchema = z.object({
  purchaseOrderId: z.uuid('Pick the PO this invoice is for'),
  vendorInvoiceNumber: optionalText,
  invoiceDate: dateField,
  dueDate: optionalDate,
  lines: z
    .array(z.object({ lineIndex: z.number().int().nonnegative(), quantity: z.number().nonnegative() }))
    .min(1, 'Bill at least one line'),
  notes: optionalText,
});

export const readyToBill = asyncHandler(async (req: Request, res: Response) => {
  let pos = await poService.listReadyToBill();
  const q = searchParam(req)?.toLowerCase();
  if (q) pos = pos.filter((x) => x.poNumber.toLowerCase().includes(q) || x.vendor.name.toLowerCase().includes(q) || x.lead.companyName.toLowerCase().includes(q));
  const p = pageParams(req);
  sendSuccess(res, p ? pageArray(pos, p) : pos, 'POs ready for a vendor invoice retrieved');
});

export const createPurchaseInvoice = asyncHandler(async (req: Request, res: Response) => {
  const { purchaseOrderId, ...input } = newBillSchema.parse(req.body);
  const bill = await poService.createPurchaseInvoice(purchaseOrderId, input, req.user!.id);
  sendCreated(res, bill, `Vendor invoice ${bill.billNumber} recorded`);
});

export const deletePurchaseInvoice = asyncHandler(async (req: Request, res: Response) => {
  await poService.deletePurchaseInvoice(String(req.params.id), req.user!.id);
  sendSuccess(res, null, 'Vendor invoice deleted');
});

export const updatePurchaseInvoice = asyncHandler(async (req: Request, res: Response) => {
  const bill = await poService.updatePurchaseInvoice(String(req.params.id), billSchema.parse(req.body), req.user!.id);
  sendSuccess(res, bill, 'Vendor bill updated');
});

export const createNote = asyncHandler(async (req: Request, res: Response) => {
  const input = z
    .object({
      side: z.enum(['SALES', 'PURCHASE']),
      kind: z.enum(['CREDIT', 'DEBIT']),
      invoiceId: z.uuid('Pick an invoice'),
      noteDate: dateField,
      taxableAmount: z.number().positive('Taxable amount must be more than 0'),
      gstAmount: z.number().nonnegative(),
      reason: z.string().trim().min(1, 'Give a reason'),
      number: optionalText,
    })
    .parse(req.body);
  const note = await paymentService.createNote(input, req.user!.id);
  sendCreated(res, note, `${input.kind === 'CREDIT' ? 'Credit' : 'Debit'} note recorded`);
});

// ---------------------------------------------------------------- Ledgers & registers

const wantsCsv = (req: Request) => req.query.format === 'csv';

function sendCsv(res: Response, filename: string, rows: Record<string, unknown>[]) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(ledgerService.toCsv(rows));
}

const ledgerRows = (entries: ledgerService.LedgerEntry[]) =>
  entries.map((e) => ({
    Date: e.date,
    Type: e.type.replace('_', ' '),
    'Voucher / Doc No': e.number,
    Particulars: e.description,
    Debit: e.debit || '',
    Credit: e.credit || '',
    Balance: e.balance,
  }));

export const customerSummaries = asyncHandler(async (req: Request, res: Response) => {
  sendSuccess(res, await ledgerService.customerSummaries(searchParam(req), pageParams(req) ?? undefined), 'Customer balances retrieved');
});

export const customerLedger = asyncHandler(async (req: Request, res: Response) => {
  const ledger = await ledgerService.customerLedger(String(req.params.id));
  if (wantsCsv(req)) return sendCsv(res, `ledger-${ledger.party.companyName}.csv`, ledgerRows(ledger.entries));
  sendSuccess(res, ledger, 'Customer ledger retrieved');
});

export const vendorSummaries = asyncHandler(async (req: Request, res: Response) => {
  sendSuccess(res, await ledgerService.vendorSummaries(searchParam(req), pageParams(req) ?? undefined), 'Vendor balances retrieved');
});

export const vendorLedger = asyncHandler(async (req: Request, res: Response) => {
  const ledger = await ledgerService.vendorLedger(String(req.params.id));
  if (wantsCsv(req)) return sendCsv(res, `ledger-${ledger.party.name}.csv`, ledgerRows(ledger.entries));
  sendSuccess(res, ledger, 'Vendor ledger retrieved');
});

export const register = asyncHandler(async (req: Request, res: Response) => {
  const kind = z.enum(['sales', 'purchases', 'payments']).parse(req.params.kind);
  const from = (req.query.from as string) || undefined;
  const to = (req.query.to as string) || undefined;
  const rows =
    kind === 'sales'
      ? await ledgerService.salesRegister(from, to)
      : kind === 'purchases'
        ? await ledgerService.purchaseRegister(from, to)
        : await ledgerService.paymentsRegister(from, to);
  sendCsv(res, `${kind}-register${from ? `-${from}` : ''}${to ? `-to-${to}` : ''}.csv`, rows);
});

import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { pageArray, pageParams, searchParam } from '../utils/paginate.js';
import { sendSuccess, sendCreated } from '../utils/ApiResponse.js';
import * as poService from '../services/purchaseOrder.service.js';
import * as access from '../services/access.service.js';

const poFields = {
  vendorId: z.uuid('Pick a vendor'),
  buyingRates: z.array(z.number().nonnegative('Buying price must be 0 or more')).optional(),
  deliveryAddress: z.string().trim().optional(),
  expectedDeliveryDate: z.string().trim().optional(),
  notes: z.string().trim().optional(),
};

const createSchema = z.object({ quoteId: z.uuid('Invalid quote'), ...poFields });
const updateSchema = z.object(poFields).partial();

const rejectSchema = z.object({ reason: z.string().trim().min(1, 'Give a reason for rejecting') });
const markSentSchema = z.object({ note: z.string().trim().optional() });
const emailSchema = z.object({ recipient: z.email().optional(), previewOnly: z.boolean().optional() });


const STATUSES = ['DRAFT', 'PENDING_ACCOUNTS', 'CONFIRMED', 'REJECTED', 'SENT_TO_VENDOR'] as const;

export const list = asyncHandler(async (req: Request, res: Response) => {
  const status = z.enum(STATUSES).optional().parse(req.query.status || undefined);
  const pos = await poService.listPurchaseOrders(
    req.user!.id,
    req.user!.role,
    { status, search: searchParam(req) },
    pageParams(req) ?? undefined
  );
  sendSuccess(res, pos, 'Purchase orders retrieved');
});

export const ready = asyncHandler(async (req: Request, res: Response) => {
  let quotes = await poService.listQuotesReadyForPo(req.user!.id, req.user!.role);
  const q = searchParam(req)?.toLowerCase();
  if (q) quotes = quotes.filter((x) => x.quoteNumber.toLowerCase().includes(q) || x.lead.companyName.toLowerCase().includes(q));
  const p = pageParams(req);
  sendSuccess(res, p ? pageArray(quotes, p) : quotes, 'Accepted quotes awaiting a PO retrieved');
});

export const getById = asyncHandler(async (req: Request, res: Response) => {
  await access.assertPurchaseOrderAccess(req.user!, String(req.params.id));
  const po = await poService.getPurchaseOrder(String(req.params.id));
  // Bills, payments and bank accounts are Accounts' business — Sales only needs the PO itself
  if (req.user!.role === 'SALES') {
    const { bankName: _n, bankAccountName: _an, bankAccountNumber: _no, bankIfsc: _i, ...vendor } = po.vendor;
    sendSuccess(res, { ...po, vendor, purchaseInvoices: [] }, 'Purchase order retrieved');
    return;
  }
  sendSuccess(res, po, 'Purchase order retrieved');
});

export const document = asyncHandler(async (req: Request, res: Response) => {
  await access.assertPurchaseOrderAccess(req.user!, String(req.params.id));
  sendSuccess(res, await poService.getPoDocument(String(req.params.id)), 'PO document generated');
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const { quoteId, ...input } = createSchema.parse(req.body);
  const po = await poService.createPurchaseOrder(quoteId, input, req.user!.id);
  sendCreated(res, po, 'Purchase order created');
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const po = await poService.updatePurchaseOrder(String(req.params.id), updateSchema.parse(req.body));
  sendSuccess(res, po, 'Purchase order updated');
});

export const submit = asyncHandler(async (req: Request, res: Response) => {
  const po = await poService.submitPurchaseOrder(String(req.params.id), req.user!.id);
  sendSuccess(res, po, 'Purchase order sent to Accounts');
});

export const confirm = asyncHandler(async (req: Request, res: Response) => {
  const po = await poService.confirmPurchaseOrder(String(req.params.id), req.user!.id);
  sendSuccess(res, po, 'Purchase order confirmed');
});

export const reject = asyncHandler(async (req: Request, res: Response) => {
  const { reason } = rejectSchema.parse(req.body);
  const po = await poService.rejectPurchaseOrder(String(req.params.id), req.user!.id, reason);
  sendSuccess(res, po, 'Purchase order rejected');
});

export const markSent = asyncHandler(async (req: Request, res: Response) => {
  const { note } = markSentSchema.parse(req.body ?? {});
  await access.assertPurchaseOrderAccess(req.user!, String(req.params.id), 'sales');
  const po = await poService.markPurchaseOrderSent(String(req.params.id), req.user!.id, note);
  sendSuccess(res, po, 'Purchase order marked as sent');
});

export const email = asyncHandler(async (req: Request, res: Response) => {
  const options = emailSchema.parse(req.body ?? {});
  await access.assertPurchaseOrderAccess(req.user!, String(req.params.id), 'sales');
  const result = await poService.emailPurchaseOrder(String(req.params.id), req.user!.id, options);
  sendSuccess(
    res,
    result,
    options.previewOnly
      ? 'PO email preview generated'
      : result.delivered
        ? 'PO emailed to vendor'
        : 'PO email logged (dev mode — configure SMTP_* env to actually send)'
  );
});


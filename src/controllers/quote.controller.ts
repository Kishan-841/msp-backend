import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { clampLimit } from '../utils/paginate.js';
import { sendSuccess, sendCreated } from '../utils/ApiResponse.js';
import * as quoteService from '../services/quote.service.js';
import * as access from '../services/access.service.js';

const quoteItemSchema = z.object({
  make: z.string().trim().min(1, 'Make is required'),
  description: z.string().trim().optional(),
  hsnCode: z.string().trim().min(1, 'HSN code is required'),
  quantity: z.number().positive('Quantity must be positive'),
  unit: z.string().trim().min(1).default('Nos'),
  unitPrice: z.number().nonnegative('Price must be non-negative'),
  gstPercent: z.number().min(0).max(100),
});

const quoteServiceSchema = z.object({
  description: z.string().trim().min(1, 'Service description is required'),
  price: z.number().nonnegative('Price must be non-negative'),
  gstPercent: z.number().min(0).max(100),
});

const requirementSchema = z
  .object({
    name: z.string().trim().min(1, 'Requirement name is required'),
    items: z.array(quoteItemSchema).default([]),
    services: z.array(quoteServiceSchema).default([]),
  })
  .refine((r) => r.items.length + r.services.length > 0, {
    message: 'Each requirement needs at least one item or service',
  });

const createQuoteSchema = z.object({
  leadId: z.uuid('Invalid lead ID'),
  requirements: z.array(requirementSchema).min(1, 'At least one requirement is required'),
  notes: z.string().optional(),
});

const updateQuoteSchema = z.object({
  requirements: z.array(requirementSchema).min(1).optional(),
  notes: z.string().optional(),
});

const rejectQuoteSchema = z.object({
  reason: z.string().optional(),
});

const markSentSchema = z.object({
  note: z.string().trim().optional(),
});

const markAcceptedSchema = z.object({
  customerPoNumber: z.string().trim().optional(),
  customerPoDate: z.string().trim().optional(),
  note: z.string().trim().optional(),
});

const shareEmailSchema = z.object({
  recipient: z.email().optional(),
  previewOnly: z.boolean().optional(),
});

export const getAll = asyncHandler(async (req: Request, res: Response) => {
  const page = req.query.page ? Number(req.query.page) : undefined;
  const limit = req.query.limit ? clampLimit(req.query.limit) : undefined; // max 100 a page
  const leadId = req.query.leadId as string | undefined;
  const status = req.query.status as string | undefined;

  const result = await quoteService.getAllQuotes(req.user!.id, req.user!.role, {
    leadId,
    status: status as any,
    page,
    limit,
  });

  sendSuccess(res, result, 'Quotes retrieved');
});

export const getById = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  await access.assertQuoteAccess(req.user!, id);
  const quote = await quoteService.getQuoteById(id);
  sendSuccess(
    res,
    quote.lead ? { ...quote, lead: access.redactLeadFor(req.user!, quote.lead) } : quote,
    'Quote retrieved'
  );
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const data = createQuoteSchema.parse(req.body);
  const quote = await quoteService.createQuote(data, req.user!.id);
  sendCreated(res, quote, 'Quote created');
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const data = updateQuoteSchema.parse(req.body);
  const quote = await quoteService.updateQuote(id, data);
  sendSuccess(res, quote, 'Quote updated');
});

export const submit = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const quote = await quoteService.submitQuote(id, req.user!.id);
  sendSuccess(res, quote, 'Quote submitted for approval');
});

export const approve = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const quote = await quoteService.approveQuote(id, req.user!.id);
  sendSuccess(res, quote, 'Quote approved');
});

export const reject = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { reason } = rejectQuoteSchema.parse(req.body);
  const quote = await quoteService.rejectQuote(id, req.user!.id, reason);
  sendSuccess(res, quote, 'Quote rejected');
});

export const markSent = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { note } = markSentSchema.parse(req.body ?? {});
  await access.assertQuoteAccess(req.user!, id, 'sales');
  const quote = await quoteService.markQuoteSent(id, req.user!.id, note);
  sendSuccess(res, quote, 'Quote marked as sent');
});

export const markAccepted = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const data = markAcceptedSchema.parse(req.body ?? {});
  await access.assertQuoteAccess(req.user!, id, 'sales');
  const quote = await quoteService.markQuoteAccepted(id, req.user!.id, data);
  sendSuccess(res, quote, 'Quote marked as accepted');
});

export const shareEmail = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { recipient, previewOnly } = shareEmailSchema.parse(req.body ?? {});
  await access.assertQuoteAccess(req.user!, id, 'sales');
  const result = await quoteService.shareQuoteByEmail(id, req.user!.id, {
    recipient,
    previewOnly,
  });
  sendSuccess(
    res,
    result,
    previewOnly
      ? 'Quote email preview generated'
      : result.delivered
        ? 'Quote shared via email'
        : 'Quote email logged (dev mode — configure SMTP_* env to actually send)'
  );
});

export const getByLead = asyncHandler(async (req: Request, res: Response) => {
  const leadId = String(req.params.leadId);
  await access.assertLeadAccess(req.user!, leadId);
  const quotes = await quoteService.getQuotesByLeadId(leadId);
  sendSuccess(res, quotes, 'Quotes retrieved');
});

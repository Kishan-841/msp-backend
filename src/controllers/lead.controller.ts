import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { clampLimit } from '../utils/paginate.js';
import { sendSuccess, sendCreated } from '../utils/ApiResponse.js';
import * as leadService from '../services/lead.service.js';
import { optionalGstinField, optionalStateField } from '../utils/gst.js';
import * as access from '../services/access.service.js';

const LeadCategoryEnum = z.enum(['HARDWARE', 'SOFTWARE']);

const LeadStatusEnum = z.enum([
  'NEW',
  'CATEGORIZED',
  'ASSIGNED',
  'MEETING_SCHEDULED',
  'MEETING_DONE',
  'MOM_ADDED',
  'QUOTE_REQUESTED',
  'QUOTE_CREATED',
  'QUOTE_SUBMITTED',
  'QUOTE_APPROVED',
  'QUOTE_REJECTED',
  'QUOTE_SENT',
  'CUSTOMER_ACCEPTED',
  'PO_PENDING_ACCOUNTS',
  'PO_CONFIRMED',
  'PO_SENT',
  'INVOICED',
  'DEAL_REGISTERED',
]);

const subcategoriesField = z.array(z.string().min(1)).min(1, 'At least one subcategory');

const createLeadSchema = z.object({
  companyName: z.string().min(1, 'Company name is required'),
  contactPerson: z.string().min(1, 'Contact person is required'),
  phone: z.string().min(1, 'Phone is required'),
  email: z.email('Invalid email address'),
  notes: z.string().optional(),
  category: LeadCategoryEnum.optional(),
  subcategory: subcategoriesField.optional(),
  customerGstin: optionalGstinField,
  customerState: optionalStateField,
  billingAddress: z.string().trim().optional(),
});

const updateLeadSchema = z.object({
  companyName: z.string().min(1).optional(),
  contactPerson: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  email: z.email().optional(),
  notes: z.string().optional(),
  category: LeadCategoryEnum.optional(),
  subcategory: subcategoriesField.optional(),
  customerGstin: optionalGstinField,
  customerState: optionalStateField,
  billingAddress: z.string().trim().optional(),
});

const categorizeSchema = z.object({
  category: LeadCategoryEnum,
  subcategory: subcategoriesField,
});

const assignSchema = z.object({
  assignedToId: z.uuid('Invalid user ID'),
});

const statusSchema = z.object({
  status: LeadStatusEnum,
});

const requestQuoteSchema = z.object({
  items: z
    .array(
      z.object({
        category: LeadCategoryEnum,
        name: z.string().trim().min(1),
        details: z.string().trim().optional(),
        materials: z
          .array(
            z.object({
              materialId: z.uuid(),
              name: z.string().trim().min(1),
              brand: z.string().nullish(),
              quantity: z.number().positive('Quantity must be more than 0'),
            })
          )
          .optional(),
      })
    )
    .min(1, 'Pick at least one product the customer needs'),
  notes: z.string().trim().optional(),
});

const callLogSchema = z.object({
  duration: z.number().int().nonnegative(),
  outcome: z.enum(['MEETING_SCHEDULED', 'CALL_LATER', 'DROPPED']),
  details: z.string().optional(),
  callbackAt: z.iso.datetime({ offset: true }).optional(),
  meeting: z
    .object({
      meetingDate: z.iso.datetime({ offset: true }),
      location: z.string().trim().min(1, 'Meeting location is required'),
      agenda: z.string().optional(),
    })
    .optional(),
});

export const getAll = asyncHandler(async (req: Request, res: Response) => {
  const page = req.query.page ? Number(req.query.page) : undefined;
  const limit = req.query.limit ? clampLimit(req.query.limit) : undefined; // max 100 a page
  const status = req.query.status as string | undefined;
  const stage = req.query.stage as string | undefined;
  const category = req.query.category as string | undefined;
  const search = req.query.search as string | undefined;
  const assignedToId = req.query.assignedToId as string | undefined;

  const result = await leadService.getAllLeads(req.user!.id, req.user!.role, {
    status: status as any,
    stage,
    category: category as any,
    search,
    assignedToId,
    page,
    limit,
  });

  sendSuccess(
    res,
    { ...result, leads: result.leads.map((l) => access.redactLeadFor(req.user!, l)) },
    'Leads retrieved'
  );
});

export const getById = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  await access.assertLeadAccess(req.user!, id);
  const lead = await leadService.getLeadById(id);
  sendSuccess(res, access.redactLeadFor(req.user!, lead), 'Lead retrieved');
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const data = createLeadSchema.parse(req.body);
  const lead = await leadService.createLead(data, req.user!.id, req.user!.role);
  sendCreated(res, lead, 'Lead created');
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const data = updateLeadSchema.parse(req.body);
  await access.assertLeadAccess(req.user!, id, req.user!.role === 'SALES' ? 'sales' : 'view');
  const lead = await leadService.updateLead(id, data, req.user!.id, req.user!.role);
  sendSuccess(res, lead, 'Lead updated');
});

export const categorize = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const data = categorizeSchema.parse(req.body);
  const lead = await leadService.categorizeLead(
    id,
    data.category,
    data.subcategory,
    req.user!.id
  );
  sendSuccess(res, lead, 'Lead categorized');
});

export const assign = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const data = assignSchema.parse(req.body);
  const lead = await leadService.assignLead(id, data.assignedToId, req.user!.id);
  sendSuccess(res, lead, 'Lead assigned');
});

export const updateStatus = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const data = statusSchema.parse(req.body);
  const lead = await leadService.updateLeadStatus(id, data.status, req.user!.id);
  sendSuccess(res, lead, 'Lead status updated');
});

export const getStats = asyncHandler(async (req: Request, res: Response) => {
  const stats = await leadService.getLeadStats(req.user!.id, req.user!.role);
  sendSuccess(res, stats, 'Lead stats retrieved');
});

const newOrderSchema = z.object({
  assignedToId: z.uuid().optional(),
  notes: z.string().trim().max(2000).optional(),
});

// Repeat order on a closed lead — Admin, MSP TL or the lead's own Sales person
export const startNewOrder = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const data = newOrderSchema.parse(req.body ?? {});
  if (req.user!.role === 'SALES') await access.assertLeadAccess(req.user!, id, 'sales');
  else await access.assertLeadAccess(req.user!, id);
  const lead = await leadService.startNewOrder(id, req.user!, data);
  sendSuccess(res, lead, `Order #${lead.orderNo} started`);
});

export const requestQuote = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const data = requestQuoteSchema.parse(req.body);
  await access.assertLeadAccess(req.user!, id, 'sales');
  const lead = await leadService.requestQuote(id, data, req.user!.id);
  sendSuccess(res, lead, 'Lead sent to MSP TL for quote');
});

export const getPendingQuotes = asyncHandler(
  async (req: Request, res: Response) => {
    const leads = await leadService.getPendingQuoteLeads(
      req.user!.id,
      req.user!.role
    );
    sendSuccess(res, leads, 'Pending quote leads retrieved');
  }
);

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const result = await leadService.deleteLead(id);
  sendSuccess(res, result, 'Lead deleted');
});

export const logCall = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const data = callLogSchema.parse(req.body);
  await access.assertLeadAccess(req.user!, id, 'sales');
  const log = await leadService.logCall(id, req.user!.id, data);
  sendSuccess(res, log, 'Call logged');
});

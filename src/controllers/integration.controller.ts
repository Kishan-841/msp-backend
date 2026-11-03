import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendCreated, sendSuccess } from '../utils/ApiResponse.js';
import { clampLimit } from '../utils/paginate.js';
import * as integration from '../services/integration.service.js';

const leadSchema = z.object({
  externalRef: z.string().trim().min(1, 'externalRef is required').max(100),
  companyName: z.string().trim().min(1, 'Company name is required').max(200),
  contactPerson: z.string().trim().min(1, 'Contact person is required').max(200),
  phone: z.string().trim().min(1, 'Phone is required').max(30),
  email: z.email('Invalid email address'),
  notes: z.string().trim().max(5000).optional(),
  // optional tax details: a bad value must not lose the lead — the service keeps it in the notes
  customerGstin: z.string().trim().max(30).optional(),
  customerState: z.string().trim().max(60).optional(),
  billingAddress: z.string().trim().max(1000).optional(),
  requirement: z.string().trim().max(5000).optional(),
  classification: z.string().trim().max(20).optional(), // HARDWARE | SOFTWARE
  subcategories: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  submittedBy: z.object({ name: z.string().trim().min(1).max(200), email: z.email().optional() }).optional(),
});

// ── used by the other software ──
export const receiveLead = asyncHandler(async (req: Request, res: Response) => {
  const { lead, created } = await integration.receiveLead(req.integrationClient!, leadSchema.parse(req.body));
  if (created) sendCreated(res, lead, 'Lead received');
  else sendSuccess(res, lead, 'Lead already received');
});

export const leadStatus = asyncHandler(async (req: Request, res: Response) => {
  sendSuccess(res, await integration.leadStatus(req.integrationClient!, String(req.params.externalRef)), 'Lead status retrieved');
});

export const changedLeads = asyncHandler(async (req: Request, res: Response) => {
  const q = z.object({ updatedSince: z.iso.datetime({ offset: true }).optional() }).parse(req.query);
  const page = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
  const limit = clampLimit(req.query.limit, 50);
  const data = await integration.changedLeads(
    req.integrationClient!,
    q.updatedSince ? new Date(q.updatedSince) : undefined,
    { page, limit, skip: (page - 1) * limit }
  );
  sendSuccess(res, data, 'Leads retrieved');
});

// ── Admin: Settings → Integrations ──
export const listClients = asyncHandler(async (_req: Request, res: Response) => {
  sendSuccess(res, await integration.listClients(), 'Integrations retrieved');
});

export const createClient = asyncHandler(async (req: Request, res: Response) => {
  const { name } = z.object({ name: z.string().trim().min(2, 'Enter a name').max(60) }).parse(req.body);
  sendCreated(res, await integration.createClient(name), 'API key created');
});

export const setClientActive = asyncHandler(async (req: Request, res: Response) => {
  const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
  sendSuccess(res, await integration.setClientActive(String(req.params.id), isActive), 'Integration updated');
});

export const regenerateKey = asyncHandler(async (req: Request, res: Response) => {
  sendSuccess(res, await integration.regenerateKey(String(req.params.id)), 'New API key created');
});

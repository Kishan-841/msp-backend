import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { clampLimit, searchParam } from '../utils/paginate.js';
import { sendSuccess, sendCreated } from '../utils/ApiResponse.js';
import * as meetingService from '../services/meeting.service.js';
import * as access from '../services/access.service.js';

const createMeetingSchema = z.object({
  leadId: z.uuid('Invalid lead ID'),
  meetingDate: z.string().min(1, 'Meeting date is required'),
  location: z.string().min(1, 'Location is required'),
  attendees: z.array(z.string().min(1)),
  agenda: z.string().optional(),
});

const updateMeetingSchema = z.object({
  meetingDate: z.string().min(1).optional(),
  location: z.string().min(1).optional(),
  attendees: z.array(z.string().min(1)).optional(),
  agenda: z.string().optional(),
});

const addMOMSchema = z.object({
  momContent: z.string().min(1, 'MOM content is required'),
});

export const getAll = asyncHandler(async (req: Request, res: Response) => {
  const page = req.query.page ? Number(req.query.page) : undefined;
  const limit = req.query.limit ? clampLimit(req.query.limit) : undefined; // max 100 a page
  const leadId = req.query.leadId as string | undefined;
  const bucket = (['today', 'upcoming', 'overdue', 'all'] as const).find((b) => b === req.query.bucket);

  const result = await meetingService.getAllMeetings(req.user!.id, req.user!.role, {
    leadId,
    page,
    limit,
    bucket,
    search: searchParam(req),
  });

  sendSuccess(res, result, 'Meetings retrieved');
});

export const getById = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  await access.assertMeetingAccess(req.user!, id);
  const meeting = await meetingService.getMeetingById(id);
  sendSuccess(res, meeting, 'Meeting retrieved');
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const data = createMeetingSchema.parse(req.body);
  await access.assertLeadAccess(req.user!, data.leadId, 'sales');
  const meeting = await meetingService.createMeeting(data, req.user!.id);
  sendCreated(res, meeting, 'Meeting created');
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const data = updateMeetingSchema.parse(req.body);
  await access.assertMeetingAccess(req.user!, id, 'sales');
  const meeting = await meetingService.updateMeeting(id, data);
  sendSuccess(res, meeting, 'Meeting updated');
});

export const addMOM = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const data = addMOMSchema.parse(req.body);
  await access.assertMeetingAccess(req.user!, id, 'sales');
  const meeting = await meetingService.addMOM(id, data.momContent, req.user!.id);
  sendSuccess(res, meeting, 'Minutes of Meeting added');
});

export const getByLead = asyncHandler(async (req: Request, res: Response) => {
  const leadId = String(req.params.leadId);
  await access.assertLeadAccess(req.user!, leadId);
  const meetings = await meetingService.getMeetingsByLeadId(leadId);
  sendSuccess(res, meetings, 'Lead meetings retrieved');
});

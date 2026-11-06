import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { clampLimit } from '../utils/paginate.js';
import * as followUps from '../services/followup.service.js';

const logSchema = z.object({
  note: z.string().trim().min(1, 'Write what happened').max(2000),
  nextDate: z.iso.date().optional(), // YYYY-MM-DD, IST
});

const router = Router();
router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await followUps.summary(req.user!), 'Follow-ups retrieved');
  })
);
router.get(
  '/:key',
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
    const limit = clampLimit(req.query.limit);
    sendSuccess(res, await followUps.groupPage(req.user!, String(req.params.key), { page, limit, skip: (page - 1) * limit }), 'Follow-ups retrieved');
  })
);
router.post(
  '/quote/:id',
  authorize('SALES', 'MSP_TL'), // the lead must be assigned to them
  asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await followUps.logQuoteFollowUp(req.user!, String(req.params.id), logSchema.parse(req.body)), 'Follow-up logged');
  })
);
router.post(
  '/invoice/:id',
  authorize('ACCOUNTS'),
  asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await followUps.logInvoiceFollowUp(req.user!, String(req.params.id), logSchema.parse(req.body)), 'Follow-up logged');
  })
);
export default router;

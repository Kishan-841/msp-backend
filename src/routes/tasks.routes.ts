import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { getTaskCounts } from '../services/tasks.service.js';

const router = Router();

// "What's waiting for me" — dashboard panel + sidebar badges
router.get(
  '/counts',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await getTaskCounts(req.user!), 'Task counts retrieved');
  })
);

export default router;

import { Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { z } from 'zod';
import * as dashboard from '../services/dashboard.service.js';
import { getProfitInsights } from '../services/insights.service.js';

function parseRange(q: unknown): 7 | 14 | 30 | 90 {
  const n = Number(q);
  if (n === 7 || n === 14 || n === 30 || n === 90) return n;
  return 30;
}

export const overview = asyncHandler(async (req: Request, res: Response) => {
  const range = parseRange(req.query.range);
  const targetUserId = req.query.userId as string | undefined;
  const data = await dashboard.getOverview(
    req.user!.id,
    req.user!.role,
    range,
    targetUserId
  );
  sendSuccess(res, data, 'Overview retrieved');
});

export const funnel = asyncHandler(async (req: Request, res: Response) => {
  const targetUserId = req.query.userId as string | undefined;
  const data = await dashboard.getFunnel(
    req.user!.id,
    req.user!.role,
    targetUserId
  );
  sendSuccess(res, data, 'Funnel retrieved');
});

export const activity = asyncHandler(async (req: Request, res: Response) => {
  const range = parseRange(req.query.range);
  const targetUserId = req.query.userId as string | undefined;
  const data = await dashboard.getActivity(
    req.user!.id,
    req.user!.role,
    range,
    targetUserId
  );
  sendSuccess(res, data, 'Activity retrieved');
});

export const distribution = asyncHandler(
  async (req: Request, res: Response) => {
    const targetUserId = req.query.userId as string | undefined;
    const data = await dashboard.getDistribution(
      req.user!.id,
      req.user!.role,
      targetUserId
    );
    sendSuccess(res, data, 'Distribution retrieved');
  }
);

export const team = asyncHandler(async (req: Request, res: Response) => {
  const range = parseRange(req.query.range);
  const data = await dashboard.getTeamPerformance(range);
  sendSuccess(res, data, 'Team performance retrieved');
});

export const userDetail = asyncHandler(async (req: Request, res: Response) => {
  const range = parseRange(req.query.range);
  const userId = String(req.params.userId);
  const data = await dashboard.getUserDetail(
    req.user!.id,
    req.user!.role,
    userId,
    range
  );
  sendSuccess(res, data, 'User dashboard retrieved');
});

// Profit & insights — Admin / MSP TL. ?from=YYYY-MM-DD&to=YYYY-MM-DD (by quote acceptance, IST days)
const istDay = (s: string, end: boolean) => new Date(`${s}T${end ? '23:59:59.999' : '00:00:00.000'}+05:30`);
export const profit = asyncHandler(async (req: Request, res: Response) => {
  const q = z
    .object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .parse(req.query);
  const data = await getProfitInsights({
    from: q.from ? istDay(q.from, false) : undefined,
    to: q.to ? istDay(q.to, true) : undefined,
  });
  sendSuccess(res, data, 'Profit insights retrieved');
});

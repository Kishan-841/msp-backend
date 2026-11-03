import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { pageParams, searchParam } from '../utils/paginate.js';
import * as audit from '../services/audit.service.js';
import { toCsv } from '../services/ledger.service.js';

// System log — Admin only.
const router = Router();
router.use(authenticate, authorize('ADMIN'));

const filterSchema = z.object({
  category: z.string().max(40).optional(),
  action: z.string().max(40).optional(),
  actorId: z.string().max(64).optional(),
  leadId: z.string().max(64).optional(),
  entityType: z.string().max(40).optional(),
  entityId: z.string().max(64).optional(),
  // calendar days in IST: from = start of that day, to = end of that day
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const istDay = (d: string, plusDays = 0) => new Date(new Date(`${d}T00:00:00+05:30`).getTime() + plusDays * 86_400_000);

function filters(req: Parameters<typeof searchParam>[0]): audit.AuditFilters {
  const f = filterSchema.parse(req.query);
  return {
    ...f,
    search: searchParam(req),
    from: f.from ? istDay(f.from) : undefined,
    to: f.to ? istDay(f.to, 1) : undefined,
  };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const f = filters(req);
    if (req.query.format === 'csv') {
      const rows = await audit.exportLogs(f);
      const ist = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="system-log-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(
        toCsv(
          rows.map((r) => ({
            'Time (IST)': ist(r.createdAt),
            Category: r.category,
            Action: r.action,
            User: r.actorName ?? '',
            'User email': r.actorEmail ?? '',
            Role: r.actorRole ?? '',
            Record: r.entityType ?? '',
            Name: r.entityLabel ?? '',
            'Record ID': r.entityId ?? '',
            Changes: r.changes ? JSON.stringify(r.changes) : '',
            Details: r.meta ? JSON.stringify(r.meta) : '',
            IP: r.ip ?? '',
            Browser: r.userAgent ?? '',
          }))
        )
      );
      return;
    }
    const p = pageParams(req) ?? { page: 1, limit: 20, skip: 0 };
    sendSuccess(res, await audit.listLogs(f, p));
  })
);

router.get(
  '/actors',
  asyncHandler(async (_req, res) => sendSuccess(res, await audit.listActors()))
);

export default router;

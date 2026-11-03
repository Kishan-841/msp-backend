import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import type { LeadStatus, QuoteStatus, UserRole } from '../generated/prisma/client.js';

type Range = 7 | 14 | 30 | 90;

function rangeToDate(days: Range): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function ownerScopeFor(userId: string, role: UserRole, targetUserId?: string) {
  // MSP_TL / ADMIN can view any user; others are forced to their own id.
  const isManager = role === 'ADMIN' || role === 'MSP_TL';
  return isManager ? targetUserId ?? null : userId;
}

/* ------------------------------------------------------------------ */
/* Overview KPI card data                                              */
/* ------------------------------------------------------------------ */

export async function getOverview(
  userId: string,
  role: UserRole,
  rangeDays: Range,
  targetUserId?: string
) {
  const scoped = ownerScopeFor(userId, role, targetUserId);
  const since = rangeToDate(rangeDays);
  const priorSince = rangeToDate((rangeDays * 2) as Range);

  const leadWhere = scoped ? { assignedToId: scoped } : {};
  const quoteWhere = scoped ? { createdById: scoped } : {};
  const meetingWhere = scoped ? { conductedById: scoped } : {};

  const [
    activeLeads,
    pendingApproval,
    quotesApproved,
    quotesSubmittedRange,
    quotesApprovedRange,
    dealValueAgg,
    momsPendingCount,
    priorActiveLeads,
    priorQuotesApproved,
  ] = await Promise.all([
    prisma.lead.count({
      where: {
        ...leadWhere,
        status: { notIn: ['DEAL_REGISTERED'] },
      },
    }),
    prisma.quote.count({
      where: { ...quoteWhere, status: 'SUBMITTED' },
    }),
    prisma.quote.count({
      where: {
        ...quoteWhere,
        status: 'APPROVED',
        updatedAt: { gte: since },
      },
    }),
    prisma.quote.count({
      where: {
        ...quoteWhere,
        status: { in: ['SUBMITTED', 'APPROVED', 'REJECTED'] },
        updatedAt: { gte: since },
      },
    }),
    prisma.quote.count({
      where: {
        ...quoteWhere,
        status: 'APPROVED',
        updatedAt: { gte: since },
      },
    }),
    prisma.quote.aggregate({
      _sum: { totalAmount: true },
      where: {
        ...quoteWhere,
        status: 'APPROVED',
        updatedAt: { gte: since },
      },
    }),
    prisma.meeting.count({
      where: {
        ...meetingWhere,
        momContent: null,
        meetingDate: { lt: new Date() },
      },
    }),
    prisma.lead.count({
      where: {
        ...leadWhere,
        status: { notIn: ['DEAL_REGISTERED'] },
        createdAt: { gte: priorSince, lt: since },
      },
    }),
    prisma.quote.count({
      where: {
        ...quoteWhere,
        status: 'APPROVED',
        updatedAt: { gte: priorSince, lt: since },
      },
    }),
  ]);

  const winRate = quotesSubmittedRange
    ? Math.round((quotesApprovedRange / quotesSubmittedRange) * 100)
    : 0;

  const delta = (current: number, prior: number) => {
    if (prior === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - prior) / prior) * 100);
  };

  return {
    activeLeads: {
      value: activeLeads,
      delta: delta(activeLeads, priorActiveLeads),
    },
    pendingApproval: { value: pendingApproval },
    quotesApproved: {
      value: quotesApproved,
      delta: delta(quotesApproved, priorQuotesApproved),
    },
    winRate: { value: winRate },
    dealValue: {
      value: dealValueAgg._sum.totalAmount ?? 0,
    },
    momsPending: { value: momsPendingCount },
  };
}

/* ------------------------------------------------------------------ */
/* Pipeline funnel                                                     */
/* ------------------------------------------------------------------ */

const FUNNEL_STAGES: { key: string; label: string; matches: LeadStatus[] }[] = [
  {
    key: 'assigned',
    label: 'Assigned',
    matches: [
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
    ],
  },
  {
    key: 'meetingScheduled',
    label: 'Meeting Scheduled',
    matches: [
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
    ],
  },
  {
    key: 'momAdded',
    label: 'MOM Added',
    matches: [
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
    ],
  },
  {
    key: 'quoteCreated',
    label: 'Quote Created',
    matches: [
      'QUOTE_CREATED',
      'QUOTE_SUBMITTED',
      'QUOTE_APPROVED',
      'QUOTE_SENT',
      'CUSTOMER_ACCEPTED',
      'PO_PENDING_ACCOUNTS',
      'PO_CONFIRMED',
      'PO_SENT',
      'INVOICED',
      'DEAL_REGISTERED',
    ],
  },
  {
    key: 'quoteApproved',
    label: 'Quote Approved',
    matches: [
      'QUOTE_APPROVED',
      'QUOTE_SENT',
      'CUSTOMER_ACCEPTED',
      'PO_PENDING_ACCOUNTS',
      'PO_CONFIRMED',
      'PO_SENT',
      'INVOICED',
      'DEAL_REGISTERED',
    ],
  },
  {
    key: 'proposalShared',
    label: 'Quote Sent',
    matches: ['QUOTE_SENT',
      'CUSTOMER_ACCEPTED', 'PO_PENDING_ACCOUNTS', 'PO_CONFIRMED', 'PO_SENT',
      'INVOICED', 'DEAL_REGISTERED'],
  },
  {
    key: 'dealWon',
    label: 'Deal Won',
    matches: ['CUSTOMER_ACCEPTED', 'PO_PENDING_ACCOUNTS', 'PO_CONFIRMED', 'PO_SENT',
      'INVOICED', 'DEAL_REGISTERED'],
  },
];

export async function getFunnel(
  userId: string,
  role: UserRole,
  targetUserId?: string
) {
  const scoped = ownerScopeFor(userId, role, targetUserId);
  const leadWhere = scoped ? { assignedToId: scoped } : {};

  const grouped = await prisma.lead.groupBy({
    by: ['status'],
    where: leadWhere,
    _count: { _all: true },
  });

  const byStatus = new Map<LeadStatus, number>();
  for (const g of grouped) byStatus.set(g.status, g._count._all);

  return FUNNEL_STAGES.map((stage) => ({
    key: stage.key,
    label: stage.label,
    count: stage.matches.reduce((s, st) => s + (byStatus.get(st) ?? 0), 0),
  }));
}

/* ------------------------------------------------------------------ */
/* Activity timeline                                                   */
/* ------------------------------------------------------------------ */

function makeEmptyBuckets(days: number): Record<string, { calls: number; meetings: number; quotes: number }> {
  const buckets: Record<string, { calls: number; meetings: number; quotes: number }> = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    buckets[key] = { calls: 0, meetings: 0, quotes: 0 };
  }
  return buckets;
}

export async function getActivity(
  userId: string,
  role: UserRole,
  rangeDays: Range,
  targetUserId?: string
) {
  const scoped = ownerScopeFor(userId, role, targetUserId);
  const since = rangeToDate(rangeDays);

  const [calls, meetings, quotes] = await Promise.all([
    prisma.activityLog.findMany({
      where: {
        createdAt: { gte: since },
        action: { startsWith: 'Call logged' },
        ...(scoped ? { userId: scoped } : {}),
      },
      select: { createdAt: true },
    }),
    prisma.meeting.findMany({
      where: {
        createdAt: { gte: since },
        ...(scoped ? { conductedById: scoped } : {}),
      },
      select: { createdAt: true },
    }),
    prisma.quote.findMany({
      where: {
        createdAt: { gte: since },
        ...(scoped ? { createdById: scoped } : {}),
      },
      select: { createdAt: true },
    }),
  ]);

  const buckets = makeEmptyBuckets(rangeDays);
  for (const c of calls) {
    const k = c.createdAt.toISOString().slice(0, 10);
    if (buckets[k]) buckets[k].calls += 1;
  }
  for (const m of meetings) {
    const k = m.createdAt.toISOString().slice(0, 10);
    if (buckets[k]) buckets[k].meetings += 1;
  }
  for (const q of quotes) {
    const k = q.createdAt.toISOString().slice(0, 10);
    if (buckets[k]) buckets[k].quotes += 1;
  }

  return Object.entries(buckets).map(([date, counts]) => ({ date, ...counts }));
}

/* ------------------------------------------------------------------ */
/* Lead status distribution (for donut chart)                          */
/* ------------------------------------------------------------------ */

export async function getDistribution(
  userId: string,
  role: UserRole,
  targetUserId?: string
) {
  const scoped = ownerScopeFor(userId, role, targetUserId);
  const leadWhere = scoped ? { assignedToId: scoped } : {};

  const grouped = await prisma.lead.groupBy({
    by: ['status'],
    where: leadWhere,
    _count: { _all: true },
  });

  return grouped.map((g) => ({ status: g.status, count: g._count._all }));
}

/* ------------------------------------------------------------------ */
/* Team performance table (MSP_TL / ADMIN only)                        */
/* ------------------------------------------------------------------ */

export async function getTeamPerformance(rangeDays: Range) {
  const since = rangeToDate(rangeDays);

  const users = await prisma.user.findMany({
    where: {
      role: 'SALES',
      isActive: true,
    },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: 'asc' },
  });

  const results = await Promise.all(
    users.map(async (u) => {
      const [
        activeLeads,
        calls,
        momsDone,
        quotesSubmitted,
        quotesApproved,
        dealValueAgg,
        lastActivity,
      ] = await Promise.all([
        prisma.lead.count({
          where: {
            assignedToId: u.id,
            status: { notIn: ['DEAL_REGISTERED'] },
          },
        }),
        prisma.activityLog.count({
          where: {
            userId: u.id,
            action: { startsWith: 'Call logged' },
            createdAt: { gte: since },
          },
        }),
        prisma.meeting.count({
          where: {
            conductedById: u.id,
            momContent: { not: null },
            updatedAt: { gte: since },
          },
        }),
        prisma.quote.count({
          where: {
            createdById: u.id,
            status: { in: ['SUBMITTED', 'APPROVED', 'REJECTED'] },
            updatedAt: { gte: since },
          },
        }),
        prisma.quote.count({
          where: {
            createdById: u.id,
            status: 'APPROVED',
            updatedAt: { gte: since },
          },
        }),
        prisma.quote.aggregate({
          _sum: { totalAmount: true },
          where: {
            createdById: u.id,
            status: 'APPROVED',
            updatedAt: { gte: since },
          },
        }),
        prisma.activityLog.findFirst({
          where: { userId: u.id },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
      ]);

      const winRate = quotesSubmitted
        ? Math.round((quotesApproved / quotesSubmitted) * 100)
        : 0;

      // Health signal
      const daysSinceActivity = lastActivity
        ? Math.floor(
            (Date.now() - lastActivity.createdAt.getTime()) / (1000 * 60 * 60 * 24)
          )
        : 999;

      let health: 'on_track' | 'stalled' | 'silent' = 'on_track';
      if (daysSinceActivity > 7) health = 'silent';
      else if (quotesApproved === 0 && momsDone >= 3) health = 'stalled';

      return {
        user: u,
        activeLeads,
        calls,
        momsDone,
        quotesSubmitted,
        quotesApproved,
        winRate,
        dealValue: dealValueAgg._sum.totalAmount ?? 0,
        lastActivityAt: lastActivity?.createdAt ?? null,
        health,
      };
    })
  );

  return results;
}

/* ------------------------------------------------------------------ */
/* Per-user detail (drill-in)                                          */
/* ------------------------------------------------------------------ */

export async function getUserDetail(
  viewerUserId: string,
  viewerRole: UserRole,
  userId: string,
  rangeDays: Range
) {
  const isManager = viewerRole === 'ADMIN' || viewerRole === 'MSP_TL';
  const isSelf = viewerUserId === userId;
  if (!isManager && !isSelf) {
    throw new AppError("You can only view your own performance.", 403);
  }

  const [user, overview, funnel, activity, distribution, activeLeads, avgApprovalHours] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true, role: true },
      }),
      getOverview(viewerUserId, viewerRole, rangeDays, userId),
      getFunnel(viewerUserId, viewerRole, userId),
      getActivity(viewerUserId, viewerRole, rangeDays, userId),
      getDistribution(viewerUserId, viewerRole, userId),
      prisma.lead.findMany({
        where: {
          assignedToId: userId,
          status: { notIn: ['DEAL_REGISTERED'] },
        },
        select: {
          id: true,
          companyName: true,
          status: true,
          category: true,
          subcategory: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 20,
      }),
      (async () => {
        const since = rangeToDate(rangeDays);
        const approved = await prisma.quote.findMany({
          where: {
            createdById: userId,
            status: 'APPROVED',
            updatedAt: { gte: since },
          },
          select: { createdAt: true, updatedAt: true },
        });
        if (approved.length === 0) return null;
        const total = approved.reduce(
          (s, q) =>
            s + (q.updatedAt.getTime() - q.createdAt.getTime()),
          0
        );
        return Math.round(total / approved.length / (1000 * 60 * 60));
      })(),
    ]);

  return {
    user,
    overview,
    funnel,
    activity,
    distribution,
    activeLeads,
    avgApprovalHours,
  };
}

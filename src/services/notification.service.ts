import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { emitToUser } from '../lib/socket.js';
import { leadVisibility } from './access.service.js';

interface CreateNotificationData {
  userId: string;
  title: string;
  message: string;
  type: string;
  link?: string;
}

export async function createNotification(data: CreateNotificationData) {
  const notification = await prisma.notification.create({
    data: {
      userId: data.userId,
      title: data.title,
      message: data.message,
      type: data.type,
      link: data.link,
    },
  });

  emitToUser(data.userId, 'notification:new', notification);

  return notification;
}

interface NotificationFilters {
  unreadOnly?: boolean;
  page?: number;
  limit?: number;
  types?: string[];
}

type Note = { title: string; message: string; type: string; link: string };

/** Active users with a role — for "everyone in MSP TL" style notifications */
export async function activeUserIds(role: 'ADMIN' | 'MSP_TL' | 'SALES' | 'ACCOUNTS') {
  return (await prisma.user.findMany({ where: { role, isActive: true }, select: { id: true } })).map((u) => u.id);
}

/** Notify each of `ids` once — never the person who did the action, never a deactivated user */
export async function notifyUsers(ids: (string | null | undefined)[], excludeUserId: string, n: Note) {
  const wanted = [...new Set(ids)].filter((id): id is string => !!id && id !== excludeUserId);
  if (wanted.length === 0) return;
  const active = await prisma.user.findMany({ where: { id: { in: wanted }, isActive: true }, select: { id: true } });
  for (const u of active) await createNotification({ userId: u.id, ...n });
}

export async function getNotifications(userId: string, filters: NotificationFilters = {}) {
  const { unreadOnly = false, page = 1, limit = 20, types } = filters;

  const where: Record<string, unknown> = { userId };
  if (unreadOnly) where.isRead = false;
  if (types?.length) where.type = { in: types };

  const skip = (page - 1) * limit;

  const [notifications, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, isRead: false } }),
  ]);

  return {
    notifications: await withAvailability(userId, notifications),
    total,
    unreadCount,
    page,
    totalPages: Math.ceil(total / limit),
  };
}

export async function markAsRead(id: string, userId: string) {
  const notification = await prisma.notification.findUnique({ where: { id } });

  if (!notification) {
    throw new AppError('Notification not found.', 404);
  }

  if (notification.userId !== userId) {
    throw new AppError('Forbidden. Notification does not belong to you.', 403);
  }

  return prisma.notification.update({
    where: { id },
    data: { isRead: true },
  });
}

// Opening the page a notification points to means it has been seen — clear every
// unread one with that link (incl. the lead workspace for /leads/:id links).
export async function markReadByLink(userId: string, link: string) {
  const path = link.split('?')[0].replace(/\/workspace$/, '');
  const candidates = await prisma.notification.findMany({
    where: { userId, isRead: false, link: path === '/' ? '/' : { startsWith: path } },
    select: { id: true, link: true },
  });
  // same page = same path once the query (?tab=…) and a trailing /workspace are ignored
  const ids = candidates
    .filter((n) => (n.link ?? '').split('?')[0].replace(/\/workspace$/, '') === path)
    .map((n) => n.id);
  if (ids.length === 0) return 0;
  const { count } = await prisma.notification.updateMany({ where: { id: { in: ids } }, data: { isRead: true } });
  return count;
}

export async function markAllAsRead(userId: string) {
  await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true },
  });
}

export async function getUnreadCount(userId: string) {
  return prisma.notification.count({ where: { userId, isRead: false } });
}

const LINK_ID = /^\/(leads|quotes|purchase-orders|meetings|invoices)\/([0-9a-f-]{36})/;

/**
 * `available: false` when the record a notification points to was deleted or this user
 * can no longer see it (e.g. lead reassigned) — the UI shows it greyed out instead of
 * opening a "not found" page. One query per record type, scoped like the record's own list.
 */
async function withAvailability<T extends { link: string | null }>(userId: string, rows: T[]) {
  const wanted: Record<string, Set<string>> = {};
  for (const r of rows) {
    const m = r.link?.match(LINK_ID);
    if (m) (wanted[m[1]] ??= new Set()).add(m[2]);
  }
  if (Object.keys(wanted).length === 0) return rows.map((r) => ({ ...r, available: true }));

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
  if (!user) return rows.map((r) => ({ ...r, available: false }));
  const lead = leadVisibility(user);
  const ids = (k: string) => [...(wanted[k] ?? [])];
  const found = async (k: string, q: () => Promise<{ id: string }[]>) =>
    [k, new Set(wanted[k] ? (await q()).map((x) => x.id) : [])] as const;

  const seen = Object.fromEntries(
    await Promise.all([
      found('leads', () => prisma.lead.findMany({ where: { id: { in: ids('leads') }, ...lead }, select: { id: true } })),
      found('quotes', () => prisma.quote.findMany({ where: { id: { in: ids('quotes') }, lead }, select: { id: true } })),
      found('purchase-orders', () =>
        prisma.purchaseOrder.findMany({ where: { id: { in: ids('purchase-orders') }, lead }, select: { id: true } })
      ),
      found('meetings', () =>
        user.role === 'ACCOUNTS'
          ? Promise.resolve([]) // Accounts never sees meetings
          : prisma.meeting.findMany({ where: { id: { in: ids('meetings') }, lead }, select: { id: true } })
      ),
      found('invoices', () =>
        prisma.salesInvoice.findMany({ where: { id: { in: ids('invoices') }, lead }, select: { id: true } })
      ),
    ])
  ) as Record<string, Set<string>>;

  return rows.map((r) => {
    const m = r.link?.match(LINK_ID);
    return { ...r, available: !m || seen[m[1]].has(m[2]) };
  });
}

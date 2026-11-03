import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import * as notificationService from '../services/notification.service.js';

export const getAll = asyncHandler(async (req: Request, res: Response) => {
  const page = req.query.page ? Number(req.query.page) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const unreadOnly = req.query.unreadOnly === 'true';
  const types =
    typeof req.query.types === 'string' && req.query.types
      ? req.query.types.split(',').filter((t) => /^[A-Z_]{1,40}$/.test(t))
      : undefined;

  const result = await notificationService.getNotifications(req.user!.id, {
    unreadOnly,
    page,
    limit: limit ? Math.min(limit, 100) : undefined,
    types,
  });

  sendSuccess(res, result, 'Notifications retrieved');
});

export const markReadByLink = asyncHandler(async (req: Request, res: Response) => {
  const { link } = z.object({ link: z.string().startsWith('/').max(300) }).parse(req.body);
  const count = await notificationService.markReadByLink(req.user!.id, link);
  sendSuccess(res, { count }, 'Notifications marked as read');
});

export const markAsRead = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const notification = await notificationService.markAsRead(id, req.user!.id);
  sendSuccess(res, notification, 'Notification marked as read');
});

export const markAllAsRead = asyncHandler(async (req: Request, res: Response) => {
  await notificationService.markAllAsRead(req.user!.id);
  sendSuccess(res, null, 'All notifications marked as read');
});

export const getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
  const count = await notificationService.getUnreadCount(req.user!.id);
  sendSuccess(res, { count }, 'Unread count retrieved');
});

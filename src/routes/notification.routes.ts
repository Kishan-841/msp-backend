import { Router } from 'express';
import * as notificationController from '../controllers/notification.controller.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Static routes must be before /:id to avoid conflict
router.get('/unread-count', notificationController.getUnreadCount);
router.patch('/read-all', notificationController.markAllAsRead);
router.patch('/read-link', notificationController.markReadByLink);

router.get('/', notificationController.getAll);
router.patch('/:id/read', notificationController.markAsRead);

export default router;

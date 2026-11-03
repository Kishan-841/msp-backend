import { Router } from 'express';
import * as meetingController from '../controllers/meeting.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
// Meetings are Sales work; MSP TL can follow them. Accounts has no access.
router.use(authenticate, authorize('MSP_TL', 'SALES'));

// /lead/:leadId must be before /:id to avoid conflict
router.get('/lead/:leadId', meetingController.getByLead);

router.get('/', meetingController.getAll);
router.get('/:id', meetingController.getById);
router.post('/', authorize('SALES'), meetingController.create);
router.put('/:id', authorize('SALES'), meetingController.update);
router.patch('/:id/mom', authorize('SALES'), meetingController.addMOM);

export default router;

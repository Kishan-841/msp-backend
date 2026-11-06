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
// Sales work: the lead must be assigned to the user (checked in the controller)
router.post('/', authorize('SALES', 'MSP_TL'), meetingController.create);
router.put('/:id', authorize('SALES', 'MSP_TL'), meetingController.update);
router.patch('/:id/mom', authorize('SALES', 'MSP_TL'), meetingController.addMOM);

export default router;

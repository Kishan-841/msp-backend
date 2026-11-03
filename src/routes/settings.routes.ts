import { Router } from 'express';
import * as settingsController from '../controllers/settings.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

router.get('/company', settingsController.getCompany);
router.put('/company', authorize('ADMIN'), settingsController.saveCompany);

export default router;

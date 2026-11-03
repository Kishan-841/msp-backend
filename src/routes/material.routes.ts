import { Router } from 'express';
import * as materialController from '../controllers/material.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

// Any signed-in user can browse and add catalogue items (Sales adds them while picking a requirement)
router.use(authenticate, authorize('SALES', 'MSP_TL'));
router.get('/', materialController.list);
router.post('/', materialController.create);

export default router;

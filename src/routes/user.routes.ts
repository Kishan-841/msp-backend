import { Router } from 'express';
import * as userController from '../controllers/user.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Read endpoints: ADMIN + MSP_TL (MSP_TL needs this to pick assignees).
router.get('/', authorize('ADMIN', 'MSP_TL'), userController.getAll);
router.get('/:id', authorize('ADMIN', 'MSP_TL'), userController.getById);

// Mutating endpoints: ADMIN only.
router.post('/', authorize('ADMIN'), userController.create);
router.put('/:id', authorize('ADMIN'), userController.update);
router.delete('/:id', authorize('ADMIN'), userController.remove);

export default router;

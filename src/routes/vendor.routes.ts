import { Router } from 'express';
import * as vendorController from '../controllers/vendor.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

router.use(authenticate, authorize('MSP_TL', 'ACCOUNTS')); // Sales never deal with vendors

// MSP TL picks/adds vendors while creating a PO; Accounts maintains vendor details.
// Vendors are deactivated (PUT isActive: false), never deleted — POs reference them.
router.get('/', vendorController.getAll);
router.get('/:id', vendorController.getById);
router.post('/', authorize('ADMIN', 'MSP_TL', 'ACCOUNTS'), vendorController.create);
router.put('/:id', authorize('ADMIN', 'MSP_TL', 'ACCOUNTS'), vendorController.update);

export default router;

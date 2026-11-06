import { Router } from 'express';
import * as poController from '../controllers/purchaseOrder.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

// MSP TL builds the PO (buying prices) → Accounts confirms → Sales sends it to the vendor →
// Accounts then records the vendor's invoice (PINV) → pays it
router.get('/', poController.list);
router.get('/ready', poController.ready);
router.get('/:id', poController.getById);
router.get('/:id/document', poController.document); // print/PDF — same HTML as the vendor email

router.post('/', authorize('MSP_TL'), poController.create);
router.put('/:id', authorize('MSP_TL'), poController.update);
router.patch('/:id/submit', authorize('MSP_TL'), poController.submit);

router.patch('/:id/confirm', authorize('ACCOUNTS'), poController.confirm);
router.patch('/:id/reject', authorize('ACCOUNTS'), poController.reject);

router.patch('/:id/mark-sent', authorize('SALES', 'MSP_TL'), poController.markSent); // assigned person only
router.post('/:id/share-email', authorize('SALES', 'MSP_TL'), poController.email);

export default router;

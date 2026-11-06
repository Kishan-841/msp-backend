import { Router } from 'express';
import * as quoteController from '../controllers/quote.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// GET /lead/:leadId must be before /:id to avoid conflict
router.get('/lead/:leadId', quoteController.getByLead);

router.get('/', quoteController.getAll);
router.get('/:id', quoteController.getById);
// MSP TL builds the quote, Admin approves it, then anyone on the lead marks it as sent
router.post('/', authorize('ADMIN', 'MSP_TL'), quoteController.create);
router.put('/:id', authorize('ADMIN', 'MSP_TL'), quoteController.update);
router.patch('/:id/submit', authorize('ADMIN', 'MSP_TL'), quoteController.submit);
router.patch('/:id/approve', authorize('ADMIN'), quoteController.approve);
router.patch('/:id/reject', authorize('ADMIN'), quoteController.reject);
// Talking to the customer is Sales' job (the assigned Sales person — checked in the controller)
router.patch('/:id/mark-sent', authorize('SALES', 'MSP_TL'), quoteController.markSent); // assigned person only
router.patch('/:id/mark-accepted', authorize('SALES', 'MSP_TL'), quoteController.markAccepted);
router.post(
  '/:id/share-email',
  authorize('SALES', 'MSP_TL'),
  quoteController.shareEmail
);

export default router;

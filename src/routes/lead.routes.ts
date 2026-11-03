import { Router } from 'express';
import * as leadController from '../controllers/lead.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Stats route must be before /:id to avoid conflict
router.get('/stats/overview', leadController.getStats);
router.get('/pending-quotes', authorize('MSP_TL', 'SALES'), leadController.getPendingQuotes);

router.get('/', leadController.getAll);
router.get('/:id', leadController.getById);
router.post(
  '/:id/request-quote',
  authorize('SALES'),
  leadController.requestQuote
);
router.post('/', authorize('ADMIN', 'MSP_TL', 'SALES'), leadController.create);
// Accounts may only fix the customer's tax details (checked in the service)
router.put('/:id', authorize('MSP_TL', 'SALES', 'ACCOUNTS'), leadController.update);
router.delete('/:id', authorize('ADMIN'), leadController.remove);
router.patch('/:id/categorize', authorize('ADMIN', 'MSP_TL'), leadController.categorize);
router.patch('/:id/assign', authorize('ADMIN', 'MSP_TL'), leadController.assign);
// Manual status override — normal transitions happen through the dedicated
// actions (categorize, assign, meetings, pricing, quotes), which enforce ownership.
router.patch('/:id/status', authorize('ADMIN'), leadController.updateStatus);
// Repeat order: a closed lead starts order N+1 and runs the same process again
router.post('/:id/new-order', authorize('MSP_TL', 'SALES'), leadController.startNewOrder);
router.post(
  '/:id/call-log',
  authorize('SALES'),
  leadController.logCall
);

export default router;

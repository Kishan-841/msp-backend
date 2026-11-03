import { Router } from 'express';
import * as dashboardController from '../controllers/dashboard.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

router.get('/overview', dashboardController.overview);
router.get('/funnel', dashboardController.funnel);
router.get('/activity', dashboardController.activity);
router.get('/distribution', dashboardController.distribution);
router.get('/team', authorize('ADMIN', 'MSP_TL'), dashboardController.team);
// buying vs selling — never for Sales / Accounts
router.get('/profit', authorize('ADMIN', 'MSP_TL'), dashboardController.profit);
router.get('/user/:userId', dashboardController.userDetail);

export default router;

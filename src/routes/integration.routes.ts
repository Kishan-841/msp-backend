import { Router } from 'express';
import * as c from '../controllers/integration.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { authenticateIntegration } from '../middleware/integrationAuth.js';

// Called by our other software with X-API-Key — see docs/INTEGRATION_API.md
export const integrationRouter = Router()
  .use(authenticateIntegration)
  .post('/leads', c.receiveLead)
  .get('/leads', c.changedLeads)
  .get('/leads/:externalRef', c.leadStatus);

// Admin: manage the keys
export const integrationClientRouter = Router()
  .use(authenticate, authorize('ADMIN'))
  .get('/', c.listClients)
  .post('/', c.createClient)
  .patch('/:id', c.setClientActive)
  .post('/:id/regenerate-key', c.regenerateKey);

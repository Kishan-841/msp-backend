import { Router } from 'express';
import * as accounts from '../controllers/accounts.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';

// Accounts creates every financial document; MSP TL can view. (Admin passes everywhere.)
const view = authorize('ACCOUNTS', 'MSP_TL');
const write = authorize('ACCOUNTS');

// Customer invoices are raised from the accepted quote once the PO has gone to the vendor
export const salesInvoiceRouter = Router()
  .use(authenticate)
  .get('/', accounts.listSalesInvoices)
  .get('/ready', view, accounts.readyToInvoice)
  .get('/:id', accounts.getSalesInvoice)
  .post('/', write, accounts.createSalesInvoice);

export const paymentRouter = Router()
  .use(authenticate, view)
  .get('/', accounts.listPayments)
  .post('/', write, accounts.createPayment)
  .post('/:id/allocate', write, accounts.allocatePayment);

export const purchaseInvoiceRouter = Router()
  .use(authenticate, view)
  .get('/', accounts.listPurchaseInvoices)
  // POs sent to the vendor with lines not yet billed → Accounts records the vendor invoice (PINV/FY/NNNN)
  .get('/ready', accounts.readyToBill)
  .post('/', write, accounts.createPurchaseInvoice)
  .put('/:id', write, accounts.updatePurchaseInvoice)
  .delete('/:id', write, accounts.deletePurchaseInvoice);

export const noteRouter = Router().use(authenticate).post('/', write, accounts.createNote);

export const ledgerRouter = Router()
  .use(authenticate, view)
  .get('/customers', accounts.customerSummaries)
  .get('/customers/:id', accounts.customerLedger)
  .get('/vendors', accounts.vendorSummaries)
  .get('/vendors/:id', accounts.vendorLedger)
  .get('/registers/:kind', accounts.register);

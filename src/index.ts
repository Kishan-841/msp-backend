import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './config/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import { sendSuccess } from './utils/ApiResponse.js';
import { broadcastDataChanged, initSocket } from './lib/socket.js';
import tasksRoutes from './routes/tasks.routes.js';
import followUpRoutes from './routes/followup.routes.js';
import { integrationClientRouter, integrationRouter } from './routes/integration.routes.js';
import { startReminderJobs } from './services/reminder.service.js';
import { bootstrapAdmin } from './services/bootstrap.service.js';
import { startAuditJobs } from './services/audit.service.js';
import { auditContextMiddleware } from './lib/auditContext.js';
import auditRoutes from './routes/audit.routes.js';
import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/user.routes.js';
import leadRoutes from './routes/lead.routes.js';
import meetingRoutes from './routes/meeting.routes.js';
import quoteRoutes from './routes/quote.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import attachmentRoutes from './routes/attachment.routes.js';
import purchaseOrderRoutes from './routes/purchaseOrder.routes.js';
import {
  salesInvoiceRouter,
  paymentRouter,
  noteRouter,
  ledgerRouter,
  purchaseInvoiceRouter,
} from './routes/accounts.routes.js';
import materialRoutes from './routes/material.routes.js';
import vendorRoutes from './routes/vendor.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';

const app = express();
if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

// Middleware
app.use(helmet());
app.use(cors({
  origin: config.corsOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' })); // company logo is sent as a data URL
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// who/where for the system log — after the body parsers (their stream callbacks would lose it)
app.use(auditContextMiddleware);

// Health check
app.get('/api/v1/health', (_req, res) => {
  sendSuccess(res, {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }, 'Server is running');
});

// Routes
// Real-time: after any successful write, clients refresh their to-do counts
app.use((req, res, next) => {
  if (req.method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode < 400 && !/^\/api\/v1\/(auth|notifications)/.test(req.originalUrl)) broadcastDataChanged();
    });
  }
  next();
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/leads', leadRoutes);
app.use('/api/v1/meetings', meetingRoutes);
app.use('/api/v1/quotes', quoteRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/vendors', vendorRoutes);
app.use('/api/v1/materials', materialRoutes);
app.use('/api/v1/purchase-orders', purchaseOrderRoutes);
app.use('/api/v1/invoices', salesInvoiceRouter);
app.use('/api/v1/payments', paymentRouter);
app.use('/api/v1/notes', noteRouter);
app.use('/api/v1/purchase-invoices', purchaseInvoiceRouter);
app.use('/api/v1/ledgers', ledgerRouter);
app.use('/api/v1/attachments', attachmentRoutes);
app.use('/api/v1/settings', settingsRoutes);
app.use('/api/v1/tasks', tasksRoutes);
app.use('/api/v1/follow-ups', followUpRoutes);
app.use('/api/v1/integrations', integrationRouter);
app.use('/api/v1/integration-clients', integrationClientRouter);
app.use('/api/v1/audit-logs', auditRoutes);

// Error handler (must be last)
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`Server running on port ${config.port} in ${config.nodeEnv} mode`);
  initSocket(server);
  startReminderJobs();
  startAuditJobs();
  bootstrapAdmin().catch((err) => console.error('Admin bootstrap failed', err));
});

export { app, server };

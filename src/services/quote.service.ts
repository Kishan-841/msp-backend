import { prisma } from '../lib/prisma.js';
import { withLock } from '../lib/lock.js';
import { createWithDailyNumber } from '../utils/docNumber.js';
import { AppError } from '../middleware/errorHandler.js';
import { activeUserIds, createNotification, notifyUsers } from './notification.service.js';
import { sendEmail } from './mailer.service.js';
import { renderQuoteEmail } from '../utils/quoteEmailTemplate.js';
import type { QuoteStatus, UserRole } from '../generated/prisma/client.js';
import { assertLeadOpen, leadVisibility } from './access.service.js';
import { computeQuoteTotals, type QuoteRequirement, type QuoteRequirementInput } from '../utils/quoteCalc.js';

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
} as const;

interface QuoteFilters {
  leadId?: string;
  status?: QuoteStatus;
  page?: number;
  limit?: number;
}

export async function getAllQuotes(userId: string, userRole: UserRole, filters: QuoteFilters = {}) {
  const { leadId, status, page = 1, limit = 20 } = filters;

  const where: Record<string, unknown> = {};

  // Only quotes on leads the user may see (Sales: own · Accounts: accepted deals)
  where.lead = leadVisibility({ id: userId, role: userRole });

  if (leadId) where.leadId = leadId;
  if (status) where.status = status;

  const skip = (page - 1) * limit;

  const [quotes, total] = await Promise.all([
    prisma.quote.findMany({
      where,
      include: {
        lead: { select: { id: true, companyName: true, assignedToId: true } },
        createdBy: { select: userSelect },
        approvedBy: { select: userSelect },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.quote.count({ where }),
  ]);

  return {
    quotes,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}

export async function getQuoteById(id: string) {
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: {
      lead: true,
      createdBy: { select: userSelect },
      approvedBy: { select: userSelect },
      sentBy: { select: userSelect },
      acceptedBy: { select: userSelect },
      purchaseOrder: { select: { id: true, poNumber: true, status: true } },
    },
  });

  if (!quote) {
    throw new AppError('Quote not found.', 404);
  }

  return quote;
}

export async function createQuote(
  data: {
    leadId: string;
    requirements: QuoteRequirementInput[];
    notes?: string;
  },
  userId: string
) {
  // one quote build per lead at a time — a double-click can't create two drafts
  return withLock(`lead:${data.leadId}`, () => createQuoteLocked(data, userId));
}

async function createQuoteLocked(
  data: {
    leadId: string;
    requirements: QuoteRequirementInput[];
    notes?: string;
  },
  userId: string
) {
  // Verify lead exists
  const lead = await prisma.lead.findUnique({ where: { id: data.leadId } });
  if (!lead) {
    throw new AppError('Lead not found.', 404);
  }
  if (lead.droppedAt) {
    throw new AppError('This lead has been dropped — no further actions allowed.', 400);
  }

  // Quote can only be built once Sales has requested it (or on a rejected re-quote)
  const allowedStatuses = ['QUOTE_REQUESTED', 'QUOTE_REJECTED'] as const;
  if (!allowedStatuses.includes(lead.status as (typeof allowedStatuses)[number])) {
    throw new AppError('Sales must send this lead for a quote (with the final requirement) first.', 400);
  }

  const totals = computeQuoteTotals(data.requirements);

  // QT-YYYYMMDD-NNNN (IST day), next after the highest existing — safe after deletes
  const quote = await createWithDailyNumber(
    'QT',
    async (startsWith) =>
      (
        await prisma.quote.findFirst({
          where: { quoteNumber: { startsWith } },
          orderBy: { quoteNumber: 'desc' },
          select: { quoteNumber: true },
        })
      )?.quoteNumber ?? null,
    (quoteNumber) =>
      prisma.quote.create({
        data: {
          leadId: data.leadId,
          orderNo: lead.orderNo, // belongs to the lead's current order
          createdById: userId,
          quoteNumber,
          items: totals.requirements as unknown as object,
          subtotal: totals.subtotal,
          gstAmount: totals.gstAmount,
          totalAmount: totals.totalAmount,
          status: 'DRAFT',
          notes: data.notes,
        },
        include: {
          lead: { select: { id: true, companyName: true, assignedToId: true } },
          createdBy: { select: userSelect },
          approvedBy: { select: userSelect },
        },
      }),
    'quoteNumber'
  );

  // Update lead status to QUOTE_CREATED
  await prisma.lead.update({
    where: { id: data.leadId },
    data: { status: 'QUOTE_CREATED' },
  });

  // Activity log
  await prisma.activityLog.create({
    data: {
      leadId: data.leadId,
      userId,
      action: `Quote ${quote.quoteNumber} created`,
    },
  });

  return quote;
}

export async function updateQuote(
  id: string,
  data: {
    requirements?: QuoteRequirementInput[];
    notes?: string;
  }
) {
  const existing = await prisma.quote.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('Quote not found.', 404);
  }
  await assertLeadOpen(existing.leadId);

  if (existing.status !== 'DRAFT') {
    throw new AppError('Only DRAFT quotes can be updated.', 400);
  }

  const updateData: Record<string, unknown> = {};
  if (data.requirements !== undefined) {
    const totals = computeQuoteTotals(data.requirements);
    updateData.items = totals.requirements;
    updateData.subtotal = totals.subtotal;
    updateData.gstAmount = totals.gstAmount;
    updateData.totalAmount = totals.totalAmount;
  }
  if (data.notes !== undefined) updateData.notes = data.notes;

  return prisma.quote.update({
    where: { id },
    data: updateData,
    include: {
      lead: { select: { id: true, companyName: true, assignedToId: true } },
      createdBy: { select: userSelect },
      approvedBy: { select: userSelect },
    },
  });
}

export async function submitQuote(id: string, userId: string) {
  const existing = await prisma.quote.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('Quote not found.', 404);
  }
  await assertLeadOpen(existing.leadId);

  if (existing.status !== 'DRAFT') {
    throw new AppError('Only DRAFT quotes can be submitted.', 400);
  }

  const quote = await prisma.quote.update({
    where: { id },
    data: { status: 'SUBMITTED' },
    include: {
      lead: { select: { id: true, companyName: true, assignedToId: true } },
      createdBy: { select: userSelect },
      approvedBy: { select: userSelect },
    },
  });

  // Update lead status
  await prisma.lead.update({
    where: { id: existing.leadId },
    data: { status: 'QUOTE_SUBMITTED' },
  });

  // Activity log
  await prisma.activityLog.create({
    data: {
      leadId: existing.leadId,
      userId,
      action: `Quote ${existing.quoteNumber} submitted for approval`,
    },
  });

  // Admin approves quotes
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
  });
  for (const admin of admins) {
    if (admin.id === userId) continue; // Don't notify yourself
    await createNotification({
      userId: admin.id,
      title: 'Quote Submitted',
      message: `Quote ${existing.quoteNumber} submitted for approval`,
      type: 'QUOTE_SUBMITTED',
      link: `/quotes/${id}`,
    });
  }

  return quote;
}

export async function approveQuote(id: string, approvedById: string) {
  const existing = await prisma.quote.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('Quote not found.', 404);
  }
  await assertLeadOpen(existing.leadId);

  if (existing.status !== 'SUBMITTED') {
    throw new AppError('Only SUBMITTED quotes can be approved.', 400);
  }

  const quote = await prisma.quote.update({
    where: { id },
    data: { status: 'APPROVED', approvedById },
    include: {
      lead: { select: { id: true, companyName: true, assignedToId: true } },
      createdBy: { select: userSelect },
      approvedBy: { select: userSelect },
    },
  });

  // Update lead status
  await prisma.lead.update({
    where: { id: existing.leadId },
    data: { status: 'QUOTE_APPROVED' },
  });

  // Activity log
  await prisma.activityLog.create({
    data: {
      leadId: existing.leadId,
      userId: approvedById,
      action: `Quote ${existing.quoteNumber} approved`,
    },
  });

  // Notify the quote creator (MSP TL) and the lead's Sales person
  const lead = await prisma.lead.findUnique({ where: { id: existing.leadId } });
  const recipients = new Set([existing.createdById, lead?.assignedToId]);
  recipients.delete(approvedById);
  for (const recipientId of recipients) {
    if (!recipientId) continue;
    await createNotification({
      userId: recipientId,
      title: 'Quote Approved',
      message: `Quote ${existing.quoteNumber} for ${lead?.companyName ?? 'lead'} is approved — ready to send to the customer`,
      type: 'QUOTE_APPROVED',
      link: `/quotes/${id}`,
    });
  }

  return quote;
}

export async function rejectQuote(id: string, approvedById: string, reason?: string) {
  const existing = await prisma.quote.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('Quote not found.', 404);
  }
  await assertLeadOpen(existing.leadId);

  if (existing.status !== 'SUBMITTED') {
    throw new AppError('Only SUBMITTED quotes can be rejected.', 400);
  }

  const notesUpdate = reason
    ? existing.notes
      ? `${existing.notes}\n\nRejection reason: ${reason}`
      : `Rejection reason: ${reason}`
    : undefined;

  const updateData: Record<string, unknown> = {
    status: 'REJECTED',
    approvedById,
  };
  if (notesUpdate !== undefined) updateData.notes = notesUpdate;

  const quote = await prisma.quote.update({
    where: { id },
    data: updateData,
    include: {
      lead: { select: { id: true, companyName: true, assignedToId: true } },
      createdBy: { select: userSelect },
      approvedBy: { select: userSelect },
    },
  });

  // Update lead status
  await prisma.lead.update({
    where: { id: existing.leadId },
    data: { status: 'QUOTE_REJECTED' },
  });

  // Activity log
  const actionMsg = reason
    ? `Quote ${existing.quoteNumber} rejected: ${reason}`
    : `Quote ${existing.quoteNumber} rejected`;

  await prisma.activityLog.create({
    data: {
      leadId: existing.leadId,
      userId: approvedById,
      action: actionMsg,
    },
  });

  // Whoever builds the next quote (its author + every MSP TL) and the Sales person on the deal
  const rejectedLead = await prisma.lead.findUnique({ where: { id: existing.leadId }, select: { companyName: true, assignedToId: true } });
  await notifyUsers([existing.createdById, ...(await activeUserIds('MSP_TL')), rejectedLead?.assignedToId], approvedById, {
    title: 'Quote rejected',
    message: `${existing.quoteNumber} for ${rejectedLead?.companyName ?? 'the lead'} was rejected${reason ? `: ${reason}` : ''} — MSP TL will prepare a new quote`,
    type: 'QUOTE_REJECTED',
    link: `/quotes/${id}`,
  });

  return quote;
}

// "Mark as sent" — the approved quote has been shared with the customer
export async function markQuoteSent(id: string, userId: string, note?: string) {
  const existing = await prisma.quote.findUnique({ where: { id } });
  if (!existing) throw new AppError('Quote not found.', 404);
  await assertLeadOpen(existing.leadId);
  if (existing.status !== 'APPROVED') {
    throw new AppError('Only APPROVED quotes can be marked as sent.', 400);
  }

  const quote = await prisma.quote.update({
    where: { id },
    data: { status: 'SENT', sentAt: new Date(), sentById: userId },
    include: {
      lead: { select: { id: true, companyName: true, assignedToId: true } },
      createdBy: { select: userSelect },
      approvedBy: { select: userSelect },
      sentBy: { select: userSelect },
    },
  });

  await prisma.lead.update({
    where: { id: existing.leadId },
    data: { status: 'QUOTE_SENT' },
  });

  await prisma.activityLog.create({
    data: {
      leadId: existing.leadId,
      userId,
      action: note
        ? `Quote ${existing.quoteNumber} sent to customer (${note})`
        : `Quote ${existing.quoteNumber} marked as sent to customer`,
    },
  });

  return quote;
}

// Customer accepted the sent quote — unlocks our PO to the vendor
export async function markQuoteAccepted(
  id: string,
  userId: string,
  data: { customerPoNumber?: string; customerPoDate?: string; note?: string }
) {
  const existing = await prisma.quote.findUnique({
    where: { id },
    include: { lead: { select: { companyName: true } } },
  });
  if (!existing) throw new AppError('Quote not found.', 404);
  await assertLeadOpen(existing.leadId);
  if (existing.status !== 'SENT') {
    throw new AppError('Only quotes sent to the customer can be marked accepted.', 400);
  }

  const quote = await prisma.quote.update({
    where: { id },
    data: {
      status: 'ACCEPTED',
      acceptedAt: new Date(),
      acceptedById: userId,
      customerPoNumber: data.customerPoNumber || null,
      customerPoDate: data.customerPoDate ? new Date(data.customerPoDate) : null,
      acceptanceNote: data.note || null,
    },
    include: {
      lead: { select: { id: true, companyName: true, assignedToId: true } },
      createdBy: { select: userSelect },
      approvedBy: { select: userSelect },
      sentBy: { select: userSelect },
      acceptedBy: { select: userSelect },
    },
  });

  await prisma.lead.update({
    where: { id: existing.leadId },
    data: { status: 'CUSTOMER_ACCEPTED' },
  });

  await prisma.activityLog.create({
    data: {
      leadId: existing.leadId,
      userId,
      action: data.customerPoNumber
        ? `Customer accepted quote ${existing.quoteNumber} (customer PO ${data.customerPoNumber})`
        : `Customer accepted quote ${existing.quoteNumber}`,
      details: data.note,
    },
  });

  // MSP TL creates our PO to the vendor next
  const mspTls = await prisma.user.findMany({
    where: { role: 'MSP_TL', isActive: true },
  });
  for (const tl of mspTls) {
    if (tl.id === userId) continue;
    await createNotification({
      userId: tl.id,
      title: 'Customer accepted quote',
      message: `${existing.lead.companyName} accepted ${existing.quoteNumber} — ready for PO`,
      type: 'QUOTE_ACCEPTED',
      link: '/purchase-orders?tab=ready', // where Create PO is
    });
  }

  return quote;
}

export async function shareQuoteByEmail(
  quoteId: string,
  userId: string,
  options?: { recipient?: string; previewOnly?: boolean }
) {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: {
      lead: true,
      createdBy: { select: { id: true, name: true, email: true } },
    },
  });

  if (!quote) throw new AppError('Quote not found.', 404);
  await assertLeadOpen(quote.leadId);
  if (quote.status !== 'APPROVED' && quote.status !== 'SENT') {
    throw new AppError('Only APPROVED quotes can be shared with the customer.', 400);
  }

  const isCreator = quote.createdById === userId;
  const actingUser = isCreator
    ? quote.createdBy
    : await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true, role: true },
      });

  if (!actingUser) throw new AppError('Sender not found.', 404);

  const recipient = options?.recipient?.trim() || quote.lead.email;
  if (!recipient) throw new AppError('No recipient email available on the lead.', 400);

  const html = renderQuoteEmail({
    quoteNumber: quote.quoteNumber,
    companyName: quote.lead.companyName,
    contactPerson: quote.lead.contactPerson,
    requirements: (quote.items as unknown as QuoteRequirement[]) ?? [],
    subtotal: quote.subtotal,
    gstAmount: quote.gstAmount,
    totalAmount: quote.totalAmount,
    notes: quote.notes,
    senderName: actingUser.name,
    senderEmail: actingUser.email,
    category: quote.lead.category,
    subcategory: quote.lead.subcategory,
  });

  if (options?.previewOnly) {
    return { html, recipient, delivered: false, preview: true };
  }

  const result = await sendEmail({
    to: recipient,
    subject: `Quote ${quote.quoteNumber} from ${actingUser.name}`,
    html,
  });

  // Emailing it counts as sending it to the customer
  if (quote.status === 'APPROVED') {
    await markQuoteSent(
      quote.id,
      userId,
      `emailed to ${recipient}${result.delivered ? '' : ' — dev mode, not actually sent'}`
    );
  } else {
    await prisma.activityLog.create({
      data: {
        leadId: quote.leadId,
        userId,
        action: `Quote ${quote.quoteNumber} re-sent to ${recipient}${result.delivered ? '' : ' (dev mode — not actually sent)'}`,
      },
    });
  }

  return { html, recipient, delivered: result.delivered };
}

export async function getQuotesByLeadId(leadId: string) {
  return prisma.quote.findMany({
    where: { leadId },
    include: {
      createdBy: { select: userSelect },
      approvedBy: { select: userSelect },
    },
    orderBy: { createdAt: 'desc' },
  });
}

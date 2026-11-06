import { prisma } from '../lib/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { activeUserIds, createNotification, notifyUsers } from './notification.service.js';
import { resolveGstDetails } from '../utils/gst.js';
import { createMeeting } from './meeting.service.js';
import { leadVisibility } from './access.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { LeadCategory, LeadStatus, UserRole } from '../generated/prisma/client.js';

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
} as const;

interface LeadFilters {
  status?: LeadStatus;
  stage?: string;
  category?: LeadCategory;
  search?: string;
  assignedToId?: string;
  page?: number;
  limit?: number;
}

const STAGE_TO_STATUSES: Record<string, LeadStatus[]> = {
  categorize: ['NEW'],
  assign: ['CATEGORIZED'],
  call: ['ASSIGNED'],
  meeting: ['MEETING_SCHEDULED'],
  mom: ['MEETING_DONE'],
  request_quote: ['MOM_ADDED'],
  quote: ['QUOTE_REQUESTED'],
  approval: ['QUOTE_CREATED', 'QUOTE_SUBMITTED'],
  send: ['QUOTE_APPROVED'],
  requote: ['QUOTE_REJECTED'],
  awaiting_acceptance: ['QUOTE_SENT'],
  create_po: ['CUSTOMER_ACCEPTED'],
  po_accounts: ['PO_PENDING_ACCOUNTS'],
  po_send: ['PO_CONFIRMED'],
  invoicing: ['PO_SENT'],
  collection: ['INVOICED'],
  won: ['DEAL_REGISTERED'],
};

export async function getAllLeads(
  userId: string,
  userRole: UserRole,
  filters: LeadFilters = {}
) {
  const { status, stage, category, search, assignedToId, page = 1, limit = 20 } = filters;

  const where: Record<string, unknown> = {};


  // Optional filters
  if (stage === 'dropped') {
    where.droppedAt = { not: null };
  } else if (stage === 'to_call' || stage === 'call_later') {
    // Assigned Leads page: waiting for a first call, or for a scheduled callback
    where.status = 'ASSIGNED';
    where.droppedAt = null;
    where.callbackAt = stage === 'call_later' ? { not: null } : null;
  } else if (stage === 'categorize') {
    // Sales-created leads skip NEW (they're self-assigned) but still need a category
    where.category = null;
    where.droppedAt = null;
  } else if (stage && STAGE_TO_STATUSES[stage]) {
    where.status = { in: STAGE_TO_STATUSES[stage] };
    where.droppedAt = null;
  } else if (status) {
    where.status = status;
  }
  if (category) where.category = category;
  if (assignedToId) where.assignedToId = assignedToId;
  if (search) {
    where.OR = [
      { companyName: { contains: search, mode: 'insensitive' } },
      { contactPerson: { contains: search, mode: 'insensitive' } },
    ];
  }

  const skip = (page - 1) * limit;

  // Role-based visibility (Sales: own leads · Accounts: accepted deals onwards · Admin / MSP TL: all)
  // is ANDed with the filters — never merged into them, so a query filter (?assignedToId=, ?search=)
  // can't overwrite it.
  const scoped = { AND: [where, leadVisibility({ id: userId, role: userRole })] };

  const [leads, total] = await Promise.all([
    prisma.lead.findMany({
      where: scoped,
      include: {
        createdBy: { select: userSelect },
        assignedTo: { select: userSelect },
        mspTl: { select: userSelect },
        integrationClient: { select: { name: true } },
      },
      // Callbacks are worked soonest-first
      orderBy: stage === 'call_later' ? { callbackAt: 'asc' } : { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.lead.count({ where: scoped }),
  ]);

  return {
    leads,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}

export async function getLeadById(id: string) {
  const lead = await prisma.lead.findUnique({
    where: { id },
    include: {
      createdBy: { select: userSelect },
      assignedTo: { select: userSelect },
      mspTl: { select: userSelect },
      meetings: true,
      quoteRequestedBy: { select: userSelect },
      quotes: { orderBy: { createdAt: 'desc' } },
      integrationClient: { select: { name: true } },
      purchaseOrders: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          poNumber: true,
          status: true,
          totalAmount: true,
          rejectionReason: true,
          quoteId: true,
          vendor: { select: { id: true, name: true } },
        },
      },
      salesInvoices: {
        select: { id: true, quoteId: true, invoiceNumber: true, totalAmount: true, paymentStatus: true, invoiceDate: true },
        orderBy: { invoiceDate: 'asc' },
      },
      activityLogs: {
        include: {
          user: { select: userSelect },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!lead) {
    throw new AppError('Lead not found.', 404);
  }

  return lead;
}

export async function createLead(
  data: {
    companyName: string;
    contactPerson: string;
    phone: string;
    email: string;
    notes?: string;
    category?: LeadCategory;
    subcategory?: string[];
    customerGstin?: string;
    customerState?: string;
    billingAddress?: string;
  },
  userId: string,
  userRole: UserRole
) {
  const gst = resolveGstDetails(data.customerGstin, data.customerState);
  // If MSP_TL/ADMIN provides category + subcategory at creation time,
  // the lead starts in CATEGORIZED state with them as the MSP TL.
  const canCategorizeOnCreate = userRole === 'MSP_TL' || userRole === 'ADMIN';
  const hasCategoryInput = !!(data.category && data.subcategory && data.subcategory.length > 0);
  const applyCategorization = canCategorizeOnCreate && hasCategoryInput;

  // A Sales user owns the leads they create — no assignment step needed.
  // MSP TL still categorizes it later.
  const selfAssign = userRole === 'SALES';

  const lead = await prisma.lead.create({
    data: {
      companyName: data.companyName,
      contactPerson: data.contactPerson,
      phone: data.phone,
      email: data.email,
      notes: data.notes,
      customerGstin: gst.gstin,
      customerState: gst.state,
      billingAddress: data.billingAddress || null,
      source: 'MANUAL',
      status: selfAssign ? 'ASSIGNED' : applyCategorization ? 'CATEGORIZED' : 'NEW',
      createdById: userId,
      ...(selfAssign ? { assignedToId: userId } : {}),
      ...(applyCategorization
        ? {
            category: data.category,
            subcategory: data.subcategory,
            mspTlId: userId,
          }
        : {}),
    },
    include: {
      createdBy: { select: userSelect },
      assignedTo: { select: userSelect },
      mspTl: { select: userSelect },
    },
  });

  await prisma.activityLog.create({
    data: {
      leadId: lead.id,
      userId,
      action: applyCategorization
        ? `Lead created and categorized as ${data.category} - ${(data.subcategory ?? []).join(', ')}`
        : 'Lead created',
    },
  });

  // Notify MSP_TL users about new leads from Sales (they need categorizing)
  if (userRole === 'SALES') {
    const mspTlUsers = await prisma.user.findMany({
      where: { role: 'MSP_TL', isActive: true },
    });
    const creatorName = lead.createdBy?.name ?? 'Unknown';
    for (const tl of mspTlUsers) {
      if (tl.id === userId) continue; // Don't notify yourself
      await createNotification({
        userId: tl.id,
        title: 'New Lead Created',
        message: `New lead from ${creatorName}: ${data.companyName}`,
        type: 'LEAD_NEW',
        link: `/leads/${lead.id}/workspace`,
      });
    }
  }

  return lead;
}

export async function updateLead(
  id: string,
  data: {
    companyName?: string;
    contactPerson?: string;
    phone?: string;
    email?: string;
    notes?: string;
    category?: LeadCategory;
    subcategory?: string[];
    customerGstin?: string;
    customerState?: string;
    billingAddress?: string;
  },
  userId: string,
  userRole: UserRole
) {
  const existing = await prisma.lead.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('Lead not found.', 404);
  }

  // Accounts may only correct the customer's tax details (needed for invoicing)
  if (userRole === 'ACCOUNTS') {
    const changed = (['companyName', 'contactPerson', 'phone', 'email', 'notes'] as const).filter(
      (k) => data[k] !== undefined && (data[k] || null) !== (existing[k] || null)
    );
    if (changed.length || data.category !== undefined || data.subcategory !== undefined) {
      throw new AppError('Accounts can only update the customer GSTIN, state and billing address.', 403);
    }
  }

  const updateData: Record<string, unknown> = {};
  if (data.companyName !== undefined) updateData.companyName = data.companyName;
  if (data.contactPerson !== undefined) updateData.contactPerson = data.contactPerson;
  if (data.phone !== undefined) updateData.phone = data.phone;
  if (data.email !== undefined) updateData.email = data.email;
  if (data.notes !== undefined) updateData.notes = data.notes;
  if (data.billingAddress !== undefined) updateData.billingAddress = data.billingAddress || null;
  if (data.customerGstin !== undefined || data.customerState !== undefined) {
    const gst = resolveGstDetails(
      data.customerGstin ?? existing.customerGstin,
      data.customerState ?? existing.customerState
    );
    updateData.customerGstin = gst.gstin;
    updateData.customerState = gst.state;
  }

  // Category/subcategory edits are limited to MSP_TL/ADMIN.
  const canEditCategory = userRole === 'MSP_TL' || userRole === 'ADMIN';
  let categoryChanged = false;

  if (canEditCategory && (data.category !== undefined || data.subcategory !== undefined)) {
    if (data.category !== undefined) updateData.category = data.category;
    if (data.subcategory !== undefined) updateData.subcategory = data.subcategory;
    categoryChanged = true;

    // If the lead was NEW and now has a full category + subcategory, promote it.
    const finalCategory = data.category ?? existing.category;
    const finalSubcategory = data.subcategory ?? existing.subcategory;
    if (existing.status === 'NEW' && finalCategory && finalSubcategory && finalSubcategory.length > 0) {
      updateData.status = 'CATEGORIZED';
      if (!existing.mspTlId) updateData.mspTlId = userId;
    }
  }

  const lead = await prisma.lead.update({
    where: { id },
    data: updateData,
    include: {
      createdBy: { select: userSelect },
      assignedTo: { select: userSelect },
      mspTl: { select: userSelect },
    },
  });

  if (categoryChanged) {
    await prisma.activityLog.create({
      data: {
        leadId: id,
        userId,
        action: `Lead category updated to ${lead.category ?? '—'} - ${(lead.subcategory ?? []).join(', ') || '—'}`,
      },
    });
  }

  return lead;
}

export async function categorizeLead(
  id: string,
  category: LeadCategory,
  subcategory: string[],
  mspTlId: string
) {
  const existing = await prisma.lead.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('Lead not found.', 404);
  }
  if (existing.droppedAt) {
    throw new AppError('This lead has been dropped — no further actions allowed.', 400);
  }

  const lead = await prisma.lead.update({
    where: { id },
    data: {
      category,
      subcategory,
      // Sales-created leads are already ASSIGNED — don't move them backwards
      ...(existing.status === 'NEW' ? { status: 'CATEGORIZED' as const } : {}),
      mspTlId,
    },
    include: {
      createdBy: { select: userSelect },
      assignedTo: { select: userSelect },
      mspTl: { select: userSelect },
    },
  });

  await prisma.activityLog.create({
    data: {
      leadId: id,
      userId: mspTlId,
      action: `Lead categorized as ${category} - ${subcategory.join(', ')}`,
    },
  });

  return lead;
}

/**
 * Who a lead can be given to: an active Sales user or an MSP TL. An MSP TL may take a lead
 * themselves only if they created it; Admin may give it to anyone in those two roles.
 */
export async function assertAssignable(
  assignedToId: string,
  actor: { id: string; role: UserRole },
  lead: { createdById: string }
) {
  const assignee = await prisma.user.findUnique({
    where: { id: assignedToId },
    select: { id: true, name: true, role: true, isActive: true, isSystem: true },
  });
  if (!assignee || assignee.isSystem) throw new AppError('Assigned user not found.', 404);
  if (!assignee.isActive) throw new AppError('Cannot assign to an inactive user.', 400);
  if (assignee.role !== 'SALES' && assignee.role !== 'MSP_TL') {
    throw new AppError('Leads can only be assigned to Sales users or MSP TLs.', 400);
  }
  if (actor.role === 'MSP_TL' && assignee.id === actor.id && lead.createdById !== actor.id) {
    throw new AppError('You can assign a lead to yourself only if you created it.', 403);
  }
  return assignee;
}

export async function assignLead(
  id: string,
  assignedToId: string,
  actor: { id: string; role: UserRole }
) {
  const mspTlId = actor.id;
  const existing = await prisma.lead.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('Lead not found.', 404);
  }

  if (!existing.category) {
    throw new AppError('Lead must be categorized before assignment.', 400);
  }
  if (existing.droppedAt) {
    throw new AppError('This lead has been dropped — no further actions allowed.', 400);
  }
  if (existing.assignedToId === assignedToId) {
    throw new AppError('The lead is already assigned to this person.', 400);
  }

  const assignee = await assertAssignable(assignedToId, actor, existing);

  const lead = await prisma.lead.update({
    where: { id },
    data: {
      assignedToId,
      // First assignment moves the lead to Sales. Re-assigning later (e.g. someone leaves) only
      // changes the owner — the deal keeps its stage, quotes, PO and invoices.
      ...(existing.status === 'NEW' || existing.status === 'CATEGORIZED' ? { status: 'ASSIGNED' as const } : {}),
    },
    include: {
      createdBy: { select: userSelect },
      assignedTo: { select: userSelect },
      mspTl: { select: userSelect },
    },
  });

  await prisma.activityLog.create({
    data: {
      leadId: id,
      userId: mspTlId,
      action: `Lead assigned to ${assignee.name}`,
    },
  });

  // Notify the assigned user (don't notify yourself)
  if (assignedToId !== mspTlId) {
    await createNotification({
      userId: assignedToId,
      title: 'Lead Assigned',
      message: `You've been assigned a lead: ${existing.companyName}`,
      type: 'LEAD_ASSIGNED',
      link: `/leads/${id}/workspace`,
    });
  }

  return lead;
}

// Valid forward transitions
const STATUS_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  NEW: ['CATEGORIZED'],
  CATEGORIZED: ['ASSIGNED'],
  ASSIGNED: ['MEETING_SCHEDULED'],
  MEETING_SCHEDULED: ['MEETING_DONE'],
  MEETING_DONE: ['MOM_ADDED'],
  MOM_ADDED: ['QUOTE_REQUESTED'],
  QUOTE_REQUESTED: ['QUOTE_CREATED'],
  QUOTE_CREATED: ['QUOTE_SUBMITTED'],
  QUOTE_SUBMITTED: ['QUOTE_APPROVED', 'QUOTE_REJECTED'],
  QUOTE_APPROVED: ['QUOTE_SENT'],
  QUOTE_REJECTED: ['QUOTE_CREATED'], // allow re-quoting
  QUOTE_SENT: ['CUSTOMER_ACCEPTED'],
  CUSTOMER_ACCEPTED: ['PO_PENDING_ACCOUNTS'],
  PO_PENDING_ACCOUNTS: ['PO_CONFIRMED', 'CUSTOMER_ACCEPTED'], // rejected → back to MSP TL
  PO_CONFIRMED: ['PO_SENT'],
  PO_SENT: ['INVOICED'],
  INVOICED: ['DEAL_REGISTERED'],
  DEAL_REGISTERED: [],
};

async function assertOverrideBacked(
  lead: { id: string; category: string | null; assignedToId: string | null; orderStartedAt: Date | null; finalRequirement: string | null },
  status: LeadStatus
) {
  const currentOrder = lead.orderStartedAt ? { createdAt: { gte: lead.orderStartedAt } } : {};
  const need = (ok: unknown, msg: string) => {
    if (!ok) throw new AppError(msg, 400);
  };
  switch (status) {
    case 'CATEGORIZED':
      return need(lead.category, 'Categorize the lead instead — it has no category yet.');
    case 'ASSIGNED':
      return need(lead.assignedToId, 'Assign the lead to a Sales person instead.');
    case 'MEETING_SCHEDULED':
      return need(
        await prisma.meeting.count({ where: { leadId: lead.id, ...currentOrder } }),
        'There is no meeting on this order — Sales books one from the call outcome.'
      );
    case 'MEETING_DONE':
      return;
    case 'MOM_ADDED':
      return need(
        await prisma.meeting.count({ where: { leadId: lead.id, momContent: { not: null }, ...currentOrder } }),
        'No meeting on this order has its MOM yet — add the MOM instead.'
      );
    case 'QUOTE_REQUESTED':
      return need(lead.finalRequirement, 'Sales sends the final requirement first (Send for quote).');
    default:
      throw new AppError(
        'From the quote onwards the stage follows the documents — use the action on the quote, PO or invoice page instead.',
        400
      );
  }
}

export async function updateLeadStatus(
  id: string,
  status: LeadStatus,
  userId: string
) {
  const existing = await prisma.lead.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('Lead not found.', 404);
  }
  if (existing.droppedAt) {
    throw new AppError('This lead has been dropped — no further actions allowed.', 400);
  }

  const allowedNext = STATUS_TRANSITIONS[existing.status];
  if (!allowedNext.includes(status)) {
    throw new AppError(
      `Cannot transition from ${existing.status} to ${status}.`,
      400
    );
  }

  // The override only resyncs the early Sales steps (e.g. a meeting that happened offline) and
  // only when the record behind the stage exists. From the quote onwards every stage is the
  // state of a document (quote / PO / invoice); forcing it would leave the deal inconsistent,
  // and the next real action would move it backwards.
  await assertOverrideBacked(existing, status);

  const lead = await prisma.lead.update({
    where: { id },
    data: { status },
    include: {
      createdBy: { select: userSelect },
      assignedTo: { select: userSelect },
      mspTl: { select: userSelect },
    },
  });

  await prisma.activityLog.create({
    data: {
      leadId: id,
      userId,
      action: `Status changed to ${status}`,
    },
  });

  return lead;
}

export type CallOutcome = 'MEETING_SCHEDULED' | 'CALL_LATER' | 'DROPPED';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

export async function logCall(
  leadId: string,
  userId: string,
  data: {
    duration: number;
    outcome: CallOutcome;
    details?: string;
    callbackAt?: string; // CALL_LATER
    meeting?: { meetingDate: string; location: string; agenda?: string }; // MEETING_SCHEDULED
  }
) {
  const existing = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!existing) {
    throw new AppError('Lead not found.', 404);
  }
  if (existing.droppedAt) {
    throw new AppError('This lead has been dropped — no further actions allowed.', 400);
  }
  // Calls belong to the "waiting for a call" stage only — fresh or call-later.
  // Once a meeting is scheduled the lead has moved on.
  if (existing.status !== 'ASSIGNED') {
    throw new AppError('Calls can only be logged while the lead is waiting for a call.', 400);
  }
  if (data.outcome === 'CALL_LATER' && !data.callbackAt) {
    throw new AppError('Pick when to call back.', 400);
  }
  if (data.outcome === 'MEETING_SCHEDULED' && !data.meeting) {
    throw new AppError('Meeting date and location are required.', 400);
  }

  // Meeting first: if it fails, nothing is logged and the lead stays callable
  if (data.outcome === 'MEETING_SCHEDULED' && data.meeting) {
    await createMeeting(
      {
        leadId,
        meetingDate: data.meeting.meetingDate,
        location: data.meeting.location,
        attendees: [existing.contactPerson],
        agenda: data.meeting.agenda,
      },
      userId
    );
  }
  await prisma.lead.update({
    where: { id: leadId },
    data: { callbackAt: data.outcome === 'CALL_LATER' ? new Date(data.callbackAt!) : null },
  });

  const outcomeLabels: Record<CallOutcome, string> = {
    MEETING_SCHEDULED: 'Meeting scheduled',
    CALL_LATER: 'Call later',
    DROPPED: 'Dropped',
  };

  const baseAction = `Call logged (${formatDuration(data.duration)}) — Outcome: ${outcomeLabels[data.outcome]}`;
  const fullAction = data.details ? `${baseAction}. ${data.details}` : baseAction;

  const log = await prisma.activityLog.create({
    data: {
      leadId,
      userId,
      action: fullAction,
    },
    include: {
      user: { select: userSelect },
    },
  });

  // If the call outcome is Dropped, mark the lead as dropped
  if (data.outcome === 'DROPPED') {
    await prisma.lead.update({
      where: { id: leadId },
      data: {
        droppedAt: new Date(),
        dropReason: data.details ?? null,
      },
    });
  }

  return log;
}

export interface RequirementMaterial {
  materialId: string;
  name: string;
  brand?: string | null;
  quantity: number;
}

export interface RequirementItem {
  category: LeadCategory;
  name: string;
  details?: string;
  materials?: RequirementMaterial[];
}

/** Readable text of the picked products + notes, shown wherever the requirement is displayed */
function requirementText(items: RequirementItem[], notes?: string) {
  // e.g. "Firewall — Fortinet FortiGate 60F × 2; 50 users"
  const lines = items.map((i) => {
    const parts = [
      ...(i.materials ?? []).map((m) => `${m.name} × ${m.quantity}`),
      ...(i.details ? [i.details] : []),
    ];
    return parts.length ? `${i.name} — ${parts.join('; ')}` : i.name;
  });
  return [...lines, ...(notes ? ['', `Notes: ${notes}`] : [])].join('\n');
}

export async function requestQuote(
  leadId: string,
  input: { items: RequirementItem[]; notes?: string },
  userId: string
) {
  const finalRequirement = requirementText(input.items, input.notes);
  const existing = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!existing) throw new AppError('Lead not found.', 404);
  if (existing.droppedAt) {
    throw new AppError('This lead has been dropped — no further actions allowed.', 400);
  }
  if (existing.status !== 'MOM_ADDED') {
    throw new AppError(
      'A quote can only be requested after the MOM is added.',
      400
    );
  }

  const lead = await prisma.lead.update({
    where: { id: leadId },
    data: {
      finalRequirement,
      requirementItems: input.items as unknown as object,
      status: 'QUOTE_REQUESTED',
      quoteRequestedAt: new Date(),
      quoteRequestedById: userId,
    },
    include: {
      createdBy: { select: userSelect },
      assignedTo: { select: userSelect },
      mspTl: { select: userSelect },
    },
  });

  await prisma.activityLog.create({
    data: { leadId, userId, action: 'Lead sent to MSP TL for quote', details: finalRequirement },
  });

  const mspTls = await prisma.user.findMany({
    where: { role: 'MSP_TL', isActive: true },
  });
  for (const tl of mspTls) {
    if (tl.id === userId) continue;
    await createNotification({
      userId: tl.id,
      title: 'Quote requested',
      message: `${lead.companyName} is ready for a quote`,
      type: 'QUOTE_REQUESTED',
      link: '/quotes?tab=pending', // the Quote requests list, where Create Quote is
    });
  }

  return lead;
}

// Leads waiting for MSP TL to build a quote (new requests + rejected re-quotes)
export async function getPendingQuoteLeads(userId: string, userRole: UserRole) {
  const where: Record<string, unknown> = {
    status: { in: ['QUOTE_REQUESTED', 'QUOTE_REJECTED'] },
    droppedAt: null,
  };

  if (userRole === 'SALES') {
    where.assignedToId = userId;
  }

  return prisma.lead.findMany({
    where,
    include: {
      createdBy: { select: userSelect },
      assignedTo: { select: userSelect },
      mspTl: { select: userSelect },
      quoteRequestedBy: { select: userSelect },
    },
    orderBy: { quoteRequestedAt: 'asc' },
  });
}

export async function deleteLead(id: string) {
  const existing = await prisma.lead.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('Lead not found.', 404);
  }

  // Accounting records must never disappear with a lead
  const [invoiceCount, paymentCount, billCount] = await Promise.all([
    prisma.salesInvoice.count({ where: { leadId: id } }),
    prisma.payment.count({ where: { leadId: id } }),
    prisma.purchaseInvoice.count({ where: { purchaseOrder: { leadId: id } } }),
  ]);
  if (invoiceCount + paymentCount + billCount > 0) {
    throw new AppError(
      'This lead has invoices, vendor bills or payments and cannot be deleted. Use "Dropped" instead.',
      400
    );
  }

  // An API lead: remember the deletion so the software that sent it sees "REMOVED" when it polls
  const sourced = await prisma.lead.findUnique({ where: { id }, select: { integrationClientId: true, externalRef: true } });
  if (sourced?.integrationClientId && sourced.externalRef) {
    await prisma.integrationRemovedLead.upsert({
      where: { clientId_externalRef: { clientId: sourced.integrationClientId, externalRef: sourced.externalRef } },
      update: { removedAt: new Date() },
      create: { clientId: sourced.integrationClientId, externalRef: sourced.externalRef },
    });
  }

  const pos = await prisma.purchaseOrder.findMany({
    where: { leadId: id },
    select: { id: true, quoteId: true, purchaseInvoices: { select: { id: true } } },
  });
  const invoiceIds = pos.flatMap((po) => po.purchaseInvoices.map((i) => i.id));
  const quoteIds = (await prisma.quote.findMany({ where: { leadId: id }, select: { id: true } })).map(
    (q) => q.id
  );
  // Attachments link by id (no FK), so their rows are removed explicitly; files stay on disk
  const attachedTo = [...quoteIds, ...pos.map((p) => p.id), ...invoiceIds];
  const meetingIds = (await prisma.meeting.findMany({ where: { leadId: id }, select: { id: true } })).map((m) => m.id);
  // Notifications link by URL (no FK) — drop the ones about this lead so nobody clicks into a dead page
  const notificationLinks = [
    `/leads/${id}`,
    `/leads/${id}/workspace`,
    ...quoteIds.map((q) => `/quotes/${q}`),
    ...pos.map((p) => `/purchase-orders/${p.id}`),
    ...meetingIds.map((m) => `/meetings/${m}`),
  ];

  await prisma.$transaction([
    prisma.notification.deleteMany({ where: { link: { in: notificationLinks } } }),
    prisma.attachment.deleteMany({ where: { entityId: { in: attachedTo } } }),
    prisma.purchaseInvoice.deleteMany({ where: { id: { in: invoiceIds } } }),
    prisma.purchaseOrder.deleteMany({ where: { leadId: id } }),
    prisma.activityLog.deleteMany({ where: { leadId: id } }),
    prisma.quote.deleteMany({ where: { leadId: id } }),
    prisma.meeting.deleteMany({ where: { leadId: id } }),
    prisma.lead.delete({ where: { id } }),
  ]);

  return { id };
}

export async function getLeadStats(userId: string, userRole: UserRole) {
  const where: Record<string, unknown> = {};

  Object.assign(where, leadVisibility({ id: userId, role: userRole }));

  const [total, byStatus, byCategory] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    }),
    prisma.lead.groupBy({
      by: ['category'],
      where,
      _count: { _all: true },
    }),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const item of byStatus) {
    statusCounts[item.status] = item._count._all;
  }

  const categoryCounts: Record<string, number> = {};
  for (const item of byCategory) {
    const key = item.category ?? 'UNCATEGORIZED';
    categoryCounts[key] = item._count._all;
  }

  return {
    total,
    byStatus: statusCounts,
    byCategory: categoryCounts,
  };
}

/**
 * Repeat order: the same customer orders something new. Instead of a new lead, the closed
 * lead starts order N+1 — back to Sales (ASSIGNED, so it shows in their To Call list) and
 * through the same process. Earlier orders' quotes / POs / invoices / payments stay on the
 * lead as history; new quotes are stamped with the new orderNo.
 */
export async function startNewOrder(
  leadId: string,
  actor: { id: string; role: UserRole },
  input: { assignedToId?: string; notes?: string }
) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new AppError('Lead not found.', 404);
  // A new order can follow a closed deal, or reopen a dropped one (the customer came back).
  // Dropping only happens before a quote exists, so a dropped order leaves nothing half-billed.
  if (!lead.droppedAt && lead.status !== 'DEAL_REGISTERED') {
    throw new AppError('A new order can be started once the current one is closed (fully invoiced and paid).', 400);
  }

  // Sales keeps the customer; Admin / MSP TL may hand the new order to another Sales person
  let assignedToId = lead.assignedToId;
  if (input.assignedToId && input.assignedToId !== lead.assignedToId) {
    if (actor.role === 'SALES') throw new AppError('Only Admin or MSP TL can change the Sales person.', 403);
    assignedToId = (await assertAssignable(input.assignedToId, actor, lead)).id;
  }
  if (!assignedToId) throw new AppError('Pick the Sales person for the new order.', 400);

  const orderNo = lead.orderNo + 1;
  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: {
      status: 'ASSIGNED',
      orderNo,
      orderStartedAt: new Date(),
      assignedToId,
      // the previous order's requirement / call-back belong to that order
      callbackAt: null,
      finalRequirement: null,
      requirementItems: Prisma.DbNull,
      quoteRequestedAt: null,
      quoteRequestedById: null,
      droppedAt: null, // reopening a dropped lead
      dropReason: null,
      sourceRequirement: null, // sent with the earlier order
      possibleDuplicateIds: [],
    },
  });

  await prisma.activityLog.create({
    data: { leadId, userId: actor.id, action: `New order #${orderNo} started`, details: input.notes || null },
  });
  // MSP TLs see the customer is back (they'll build the quote)
  await notifyUsers(await activeUserIds('MSP_TL'), actor.id, {
    title: 'Repeat order',
    message: `${lead.companyName} is ordering again (order #${orderNo})`,
    type: 'REPEAT_ORDER',
    link: `/leads/${leadId}/workspace`,
  });
  if (assignedToId !== actor.id) {
    await createNotification({
      userId: assignedToId,
      title: 'Repeat order',
      message: `${lead.companyName} wants to order again (order #${orderNo}) — call them to understand the new requirement`,
      type: 'LEAD_ASSIGNED',
      link: `/leads/${leadId}/workspace`,
    });
  }
  return updated;
}

import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { LeadStatus } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';
import { withLock } from '../lib/lock.js';
import { AppError } from '../middleware/errorHandler.js';
import { isValidGstin, resolveGstDetails, stateCodeFrom } from '../utils/gst.js';
import { envelope, type PageParams } from '../utils/paginate.js';
import { activeUserIds, notifyUsers } from './notification.service.js';

// Our other software send leads here and read back a simple status. Each software has its own
// API key, which can only create leads and read its OWN leads' status — never prices, MOMs etc.

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

function newKey() {
  const key = `msp_${randomBytes(32).toString('base64url')}`;
  return { key, keyHash: hashKey(key), keyPrefix: key.slice(0, 10) };
}

const clientSelect = { id: true, name: true, keyPrefix: true, isActive: true, lastUsedAt: true, createdAt: true } as const;

// ── Admin: manage keys ───────────────────────────────────────────────────────

export async function listClients() {
  const clients = await prisma.integrationClient.findMany({
    select: { ...clientSelect, _count: { select: { leads: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return clients.map(({ _count, ...c }) => ({ ...c, leads: _count.leads }));
}

/** The key is returned only here (and on regenerate) — it can't be read back later */
export async function createClient(name: string) {
  if (await prisma.integrationClient.findUnique({ where: { name } })) {
    throw new AppError('A software with this name already exists.', 409);
  }
  const { key, keyHash, keyPrefix } = newKey();
  const id = randomBytes(8).toString('hex');
  const client = await prisma.$transaction(async (tx) => {
    // Non-login owner of this software's leads: inactive, unknowable password, hidden from lists
    const user = await tx.user.create({
      data: {
        name: `${name} (API)`,
        email: `integration-${id}@system.local`,
        password: await bcrypt.hash(randomBytes(32).toString('hex'), 12),
        role: 'MSP_TL',
        isActive: false,
        isSystem: true,
      },
    });
    return tx.integrationClient.create({ data: { name, keyHash, keyPrefix, systemUserId: user.id }, select: clientSelect });
  });
  return { ...client, leads: 0, apiKey: key };
}

export async function setClientActive(id: string, isActive: boolean) {
  await assertClient(id);
  return prisma.integrationClient.update({ where: { id }, data: { isActive }, select: clientSelect });
}

/** New key; the old one stops working immediately */
export async function regenerateKey(id: string) {
  await assertClient(id);
  const { key, keyHash, keyPrefix } = newKey();
  const client = await prisma.integrationClient.update({ where: { id }, data: { keyHash, keyPrefix }, select: clientSelect });
  return { ...client, apiKey: key };
}

async function assertClient(id: string) {
  const c = await prisma.integrationClient.findUnique({ where: { id }, select: { id: true } });
  if (!c) throw new AppError('Software not found.', 404);
}

// ── What the other software may see ──────────────────────────────────────────

/** 18 internal statuses → a stable, simple list, so our process can change without breaking them */
const PUBLIC_STATUS: Record<LeadStatus, { code: string; label: string }> = {
  NEW: { code: 'RECEIVED', label: 'Received' },
  CATEGORIZED: { code: 'RECEIVED', label: 'Received' },
  ASSIGNED: { code: 'ASSIGNED', label: 'Assigned to Sales' },
  MEETING_SCHEDULED: { code: 'IN_DISCUSSION', label: 'In discussion' },
  MEETING_DONE: { code: 'IN_DISCUSSION', label: 'In discussion' },
  MOM_ADDED: { code: 'IN_DISCUSSION', label: 'In discussion' },
  QUOTE_REQUESTED: { code: 'QUOTATION_IN_PROGRESS', label: 'Quotation in progress' },
  QUOTE_CREATED: { code: 'QUOTATION_IN_PROGRESS', label: 'Quotation in progress' },
  QUOTE_SUBMITTED: { code: 'QUOTATION_IN_PROGRESS', label: 'Quotation in progress' },
  QUOTE_APPROVED: { code: 'QUOTATION_IN_PROGRESS', label: 'Quotation in progress' },
  QUOTE_REJECTED: { code: 'QUOTATION_IN_PROGRESS', label: 'Quotation in progress' },
  QUOTE_SENT: { code: 'QUOTATION_SENT', label: 'Quotation sent' },
  CUSTOMER_ACCEPTED: { code: 'ORDER_IN_PROGRESS', label: 'Order in progress' },
  PO_PENDING_ACCOUNTS: { code: 'ORDER_IN_PROGRESS', label: 'Order in progress' },
  PO_CONFIRMED: { code: 'ORDER_IN_PROGRESS', label: 'Order in progress' },
  PO_SENT: { code: 'ORDER_IN_PROGRESS', label: 'Order in progress' },
  INVOICED: { code: 'INVOICED', label: 'Invoiced' },
  DEAL_REGISTERED: { code: 'CLOSED_WON', label: 'Closed won' },
};

// Selected field by field on purpose: nothing else can reach another system by accident
const publicSelect = {
  id: true,
  externalRef: true,
  companyName: true,
  status: true,
  droppedAt: true,
  dropReason: true,
  orderNo: true,
  createdAt: true,
  updatedAt: true,
  assignedTo: { select: { name: true } },
} as const;

type PublicRow = {
  id: string;
  externalRef: string | null;
  companyName: string;
  status: LeadStatus;
  droppedAt: Date | null;
  dropReason: string | null;
  orderNo: number;
  createdAt: Date;
  updatedAt: Date;
  assignedTo: { name: string } | null;
};

function publicLead(l: PublicRow) {
  const s = l.droppedAt ? { code: 'DROPPED', label: 'Dropped' } : PUBLIC_STATUS[l.status];
  return {
    leadId: l.id,
    externalRef: l.externalRef,
    companyName: l.companyName,
    status: s.code,
    statusLabel: s.label,
    orderNo: l.orderNo, // a repeat order starts again from ASSIGNED, with a higher orderNo
    assignedTo: l.assignedTo?.name ?? null,
    dropReason: l.droppedAt ? l.dropReason : null,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

// ── API used by the other software ───────────────────────────────────────────

export interface Client {
  id: string;
  name: string;
  systemUserId: string;
}

export interface IncomingLead {
  externalRef: string;
  companyName: string;
  contactPerson: string;
  phone: string;
  email: string;
  notes?: string;
  customerGstin?: string;
  customerState?: string;
  billingAddress?: string;
  requirement?: string;
  classification?: string;
  subcategories?: string[];
  submittedBy?: { name: string; email?: string };
}

/** Same phone (last 10 digits), email or GSTIN as an existing lead — MSP TL decides, nothing is merged */
async function findDuplicates(lead: { phone: string; email: string; gstin: string | null }) {
  const digits = lead.phone.replace(/\D/g, '').slice(-10);
  // digits only: "+91 98765 43210" and "98765-43210" are the same number
  const samePhone =
    digits.length >= 7
      ? await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Lead" WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ${digits} LIMIT 5`
      : [];
  const or: Record<string, unknown>[] = [
    { email: { equals: lead.email, mode: 'insensitive' } },
    { id: { in: samePhone.map((r) => r.id) } },
  ];
  if (lead.gstin) or.push({ customerGstin: lead.gstin });
  const rows = await prisma.lead.findMany({ where: { OR: or }, select: { id: true }, take: 5, orderBy: { createdAt: 'desc' } });
  return rows.map((r) => r.id);
}

/** Idempotent per (software, externalRef): a retry returns the existing lead instead of a duplicate */
export function receiveLead(client: Client, input: IncomingLead) {
  return withLock(`integration:${client.id}:${input.externalRef}`, async () => {
    const existing = await prisma.lead.findUnique({
      where: { integrationClientId_externalRef: { integrationClientId: client.id, externalRef: input.externalRef } },
      select: publicSelect,
    });
    if (existing) return { lead: publicLead(existing), created: false };

    // Tax details are optional: state may be a code or a name; anything unusable is left blank
    // for MSP TL / Accounts to fill in, and kept in the notes so it isn't lost.
    const rawGstin = input.customerGstin?.toUpperCase() || undefined;
    const gstin = rawGstin && isValidGstin(rawGstin) ? rawGstin : undefined;
    const stateCode = stateCodeFrom(input.customerState);
    const gst = resolveGstDetails(gstin, stateCode);
    const unusable = [
      rawGstin && !gstin ? `GSTIN sent but not valid: ${rawGstin}` : null,
      input.customerState && !stateCode && !gstin ? `State sent but not recognised: ${input.customerState}` : null,
    ].filter(Boolean);
    const notes = [input.notes, ...unusable].filter(Boolean).join('\n') || undefined;
    // Category + products both sent → already categorized, MSP TL only has to assign it.
    // Anything less: MSP TL categorizes as usual.
    const classification = input.classification?.toUpperCase();
    const category = classification === 'HARDWARE' || classification === 'SOFTWARE' ? classification : null;
    const subcategory = [...new Set(input.subcategories ?? [])];
    const categorized = !!category && subcategory.length > 0;

    const possibleDuplicateIds = await findDuplicates({ phone: input.phone, email: input.email, gstin: gst.gstin });

    const lead = await prisma.lead.create({
      data: {
        companyName: input.companyName,
        contactPerson: input.contactPerson,
        phone: input.phone,
        email: input.email,
        notes,
        customerGstin: gst.gstin,
        customerState: gst.state,
        billingAddress: input.billingAddress || null,
        source: 'API',
        status: categorized ? 'CATEGORIZED' : 'NEW',
        ...(categorized ? { category, subcategory } : {}),
        createdById: client.systemUserId,
        integrationClientId: client.id,
        externalRef: input.externalRef,
        submittedByName: input.submittedBy?.name,
        submittedByEmail: input.submittedBy?.email,
        sourceRequirement: input.requirement || null,
        possibleDuplicateIds,
      },
      select: publicSelect,
    });
    // the ref may have been deleted here before and is being sent again
    await prisma.integrationRemovedLead.deleteMany({ where: { clientId: client.id, externalRef: input.externalRef } });

    const by = input.submittedBy?.name ? ` by ${input.submittedBy.name}` : '';
    await prisma.activityLog.create({
      data: { leadId: lead.id, userId: client.systemUserId, action: `Lead received from ${client.name}${by}` },
    });
    const dup = possibleDuplicateIds.length ? ' — possible duplicate, please check' : '';
    await notifyUsers(await activeUserIds('MSP_TL'), client.systemUserId, {
      title: 'New lead from ' + client.name,
      message: `${input.companyName}${by}${dup}`,
      type: 'LEAD_NEW',
      link: `/leads/${lead.id}`,
    });
    return { lead: publicLead(lead), created: true };
  });
}

export async function leadStatus(client: Client, externalRef: string) {
  const lead = await prisma.lead.findUnique({
    where: { integrationClientId_externalRef: { integrationClientId: client.id, externalRef } },
    select: publicSelect,
  });
  if (lead) return publicLead(lead);
  const removed = await prisma.integrationRemovedLead.findUnique({
    where: { clientId_externalRef: { clientId: client.id, externalRef } },
  });
  if (removed) {
    return { externalRef, status: 'REMOVED', statusLabel: 'Removed', removedAt: removed.removedAt };
  }
  throw new AppError('Lead not found.', 404);
}

/**
 * Leads changed since a moment, oldest change first. Callers store `serverTime` from their first
 * page and send it as the next `updatedSince` (server clock, so clock differences can't lose updates).
 */
export async function changedLeads(client: Client, updatedSince: Date | undefined, page: PageParams) {
  const serverTime = new Date();
  const where = {
    integrationClientId: client.id,
    ...(updatedSince ? { updatedAt: { gte: updatedSince } } : {}),
  };
  const [rows, total, removed] = await Promise.all([
    prisma.lead.findMany({
      where,
      select: publicSelect,
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      skip: page.skip,
      take: page.limit,
    }),
    prisma.lead.count({ where }),
    page.page === 1
      ? prisma.integrationRemovedLead.findMany({
          where: { clientId: client.id, ...(updatedSince ? { removedAt: { gte: updatedSince } } : {}) },
          select: { externalRef: true, removedAt: true },
          orderBy: { removedAt: 'asc' },
        })
      : Promise.resolve([]),
  ]);
  return envelope(rows.map(publicLead), total, page, { removed, serverTime });
}

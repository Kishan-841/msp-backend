import { prisma } from '../lib/prisma.js';
import { startOfTodayIST } from '../utils/paginate.js';
import { assertLeadOpen } from './access.service.js';
import { AppError } from '../middleware/errorHandler.js';
import type { UserRole } from '../generated/prisma/client.js';

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
} as const;

interface MeetingFilters {
  leadId?: string;
  page?: number;
  limit?: number;
}

export type MeetingBucket = 'today' | 'upcoming' | 'overdue' | 'all';

/**
 * Meetings, one page at a time. Tabs (by IST calendar day):
 *  today / upcoming / overdue = MOM not added yet and the meeting is today / later / earlier;
 *  all = every meeting. `counts` gives each tab's total for the pills.
 */
export async function getAllMeetings(
  userId: string,
  userRole: UserRole,
  filters: MeetingFilters & { bucket?: MeetingBucket; search?: string } = {}
) {
  const { leadId, page = 1, limit = 20, bucket = 'all', search } = filters;

  const base: Record<string, unknown>[] = [];
  // Sales see meetings on their own leads; Admin and MSP TL see all (Accounts can't reach this route)
  if (userRole === 'SALES') base.push({ lead: { assignedToId: userId } });
  if (leadId) base.push({ leadId });
  if (search) {
    const q = { contains: search, mode: 'insensitive' as const };
    base.push({ OR: [{ lead: { companyName: q } }, { location: q }] });
  }

  const dayStart = startOfTodayIST();
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const noMom = { momContent: null };
  const bucketWhere: Record<MeetingBucket, Record<string, unknown>> = {
    today: { ...noMom, meetingDate: { gte: dayStart, lt: dayEnd } },
    upcoming: { ...noMom, meetingDate: { gte: dayEnd } },
    overdue: { ...noMom, meetingDate: { lt: dayStart } },
    all: {},
  };
  const whereFor = (b: MeetingBucket) => ({ AND: [...base, bucketWhere[b]] });
  const where = whereFor(bucket);
  const skip = (page - 1) * limit;

  const [meetings, total, today, upcoming, overdue, all] = await Promise.all([
    prisma.meeting.findMany({
      where,
      include: {
        lead: { select: { id: true, companyName: true, status: true, quoteRequestedAt: true } },
        conductedBy: { select: userSelect },
      },
      // what's next first for the open tabs; newest first for "all" / overdue
      orderBy: { meetingDate: bucket === 'today' || bucket === 'upcoming' ? 'asc' : 'desc' },
      skip,
      take: limit,
    }),
    prisma.meeting.count({ where }),
    prisma.meeting.count({ where: whereFor('today') }),
    prisma.meeting.count({ where: whereFor('upcoming') }),
    prisma.meeting.count({ where: whereFor('overdue') }),
    prisma.meeting.count({ where: whereFor('all') }),
  ]);

  return {
    meetings,
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    counts: { today, upcoming, overdue, all },
  };
}

export async function getMeetingById(id: string) {
  const meeting = await prisma.meeting.findUnique({
    where: { id },
    include: {
      lead: { select: { id: true, companyName: true, status: true, quoteRequestedAt: true } },
      conductedBy: { select: userSelect },
    },
  });

  if (!meeting) {
    throw new AppError('Meeting not found.', 404);
  }

  return meeting;
}

export async function createMeeting(
  data: {
    leadId: string;
    meetingDate: string;
    location: string;
    attendees: string[];
    agenda?: string;
  },
  userId: string
) {
  const lead = await prisma.lead.findUnique({ where: { id: data.leadId } });
  if (!lead) {
    throw new AppError('Lead not found.', 404);
  }
  if (lead.droppedAt) {
    throw new AppError('This lead has been dropped — no further actions allowed.', 400);
  }

  const meeting = await prisma.meeting.create({
    data: {
      leadId: data.leadId,
      meetingDate: new Date(data.meetingDate),
      location: data.location,
      attendees: data.attendees,
      agenda: data.agenda,
      conductedById: userId,
    },
    include: {
      lead: { select: { id: true, companyName: true, status: true, quoteRequestedAt: true } },
      conductedBy: { select: userSelect },
    },
  });

  // Update lead status to MEETING_SCHEDULED only if currently ASSIGNED
  if (lead.status === 'ASSIGNED') {
    await prisma.lead.update({
      where: { id: data.leadId },
      data: { status: 'MEETING_SCHEDULED' },
    });
  }

  const formattedDate = new Date(data.meetingDate).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
  await prisma.activityLog.create({
    data: {
      leadId: data.leadId,
      userId,
      action: `Meeting scheduled for ${formattedDate} at ${data.location}`,
    },
  });

  // (No notification: MSP TL is read-only on meetings — they hear from Sales via the quote request.)

  return meeting;
}

export async function updateMeeting(
  id: string,
  data: {
    meetingDate?: string;
    location?: string;
    attendees?: string[];
    agenda?: string;
  }
) {
  const existing = await prisma.meeting.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError('Meeting not found.', 404);
  }
  await assertLeadOpen(existing.leadId);

  const updateData: Record<string, unknown> = {};
  if (data.meetingDate !== undefined) updateData.meetingDate = new Date(data.meetingDate);
  if (data.location !== undefined) updateData.location = data.location;
  if (data.attendees !== undefined) updateData.attendees = data.attendees;
  if (data.agenda !== undefined) updateData.agenda = data.agenda;

  return prisma.meeting.update({
    where: { id },
    data: updateData,
    include: {
      lead: { select: { id: true, companyName: true, status: true, quoteRequestedAt: true } },
      conductedBy: { select: userSelect },
    },
  });
}

export async function addMOM(id: string, momContent: string, userId: string) {
  const meeting = await prisma.meeting.findUnique({
    where: { id },
    include: { lead: true },
  });

  if (!meeting) {
    throw new AppError('Meeting not found.', 404);
  }
  if (meeting.lead.droppedAt) {
    throw new AppError('This lead has been dropped — no further actions allowed.', 400);
  }

  const updatedMeeting = await prisma.meeting.update({
    where: { id },
    data: { momContent },
    include: {
      lead: { select: { id: true, companyName: true, status: true, quoteRequestedAt: true } },
      conductedBy: { select: userSelect },
    },
  });

  // Update lead status: MEETING_SCHEDULED -> MEETING_DONE -> MOM_ADDED
  if (meeting.lead.status === 'MEETING_SCHEDULED') {
    await prisma.lead.update({
      where: { id: meeting.leadId },
      data: { status: 'MEETING_DONE' },
    });
    await prisma.lead.update({
      where: { id: meeting.leadId },
      data: { status: 'MOM_ADDED' },
    });
  } else if (meeting.lead.status === 'MEETING_DONE') {
    await prisma.lead.update({
      where: { id: meeting.leadId },
      data: { status: 'MOM_ADDED' },
    });
  }

  await prisma.activityLog.create({
    data: {
      leadId: meeting.leadId,
      userId,
      action: 'Minutes of Meeting added',
    },
  });

  // (No notification: MSP TL hears about this lead when Sales sends it for a quote.)

  return updatedMeeting;
}

export async function getMeetingsByLeadId(leadId: string) {
  return prisma.meeting.findMany({
    where: { leadId },
    include: {
      conductedBy: { select: userSelect },
    },
    orderBy: { meetingDate: 'desc' },
  });
}

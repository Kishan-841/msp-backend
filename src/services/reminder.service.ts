import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { withLock } from '../lib/lock.js';
import { createNotification } from './notification.service.js';
import { getTaskCounts, type TaskKey } from './tasks.service.js';

// Morning digest: one notification per user summarising what's waiting on them,
// plus overdue customer invoices / vendor bills for Accounts. Process unchanged —
// this only reminds people of steps that already exist.

const LABEL: Partial<Record<TaskKey, (n: number) => string>> = {
  quotesToApprove: (n) => `${n} quote${n === 1 ? '' : 's'} to approve`,
  toCategorize: (n) => `${n} lead${n === 1 ? '' : 's'} to categorize`,
  toAssign: (n) => `${n} lead${n === 1 ? '' : 's'} to assign`,
  callbacksDue: (n) => `${n} callback${n === 1 ? '' : 's'} due`,
  toCall: (n) => `${n} new lead${n === 1 ? '' : 's'} to call`,
  momPending: (n) => `${n} MOM${n === 1 ? '' : 's'} pending`,
  finalRequirement: (n) => `${n} final requirement${n === 1 ? '' : 's'} to send`,
  quoteRequests: (n) => `${n} quote${n === 1 ? '' : 's'} to build`,
  quoteDrafts: (n) => `${n} draft quote${n === 1 ? '' : 's'}`,
  quotesToSend: (n) => `${n} approved quote${n === 1 ? '' : 's'} to send`,
  readyForPo: (n) => `${n} PO${n === 1 ? '' : 's'} to create`,
  posToFix: (n) => `${n} PO${n === 1 ? '' : 's'} to finish`,
  posToConfirm: (n) => `${n} PO${n === 1 ? '' : 's'} to confirm`,
  posToSend: (n) => `${n} PO${n === 1 ? '' : 's'} to send to vendors`,
  posToBill: (n) => `${n} PO${n === 1 ? '' : 's'} awaiting the vendor invoice`,
  billsToPay: (n) => `${n} vendor bill${n === 1 ? '' : 's'} to pay`,
  dealsToInvoice: (n) => `${n} deal${n === 1 ? '' : 's'} to invoice`,
  followUpsDue: (n) => `${n} customer follow-up${n === 1 ? '' : 's'} due`,
};

function startOfTodayIST(now = new Date()) {
  // IST = UTC+5:30, no DST
  const ist = new Date(now.getTime() + 330 * 60_000);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - 330 * 60_000);
}

/** Sends today's digest to everyone who hasn't had it — safe to call more than once a day */
export function sendDailyDigests() {
  // one sender at a time, even with several API instances (the per-user "already sent today"
  // check then makes a second run a no-op)
  return withLock('daily-digest', sendDailyDigestsLocked);
}

async function sendDailyDigestsLocked() {
  const today = startOfTodayIST();
  const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true, role: true } });

  // Overdue documents — only Accounts / Admin act on these
  const [overdueInvoices, overdueBills] = await Promise.all([
    prisma.salesInvoice.count({ where: { paymentStatus: { not: 'PAID' }, dueDate: { lt: today } } }),
    prisma.purchaseInvoice.count({ where: { paymentStatus: { not: 'PAID' }, dueDate: { lt: today } } }),
  ]);

  let sent = 0;
  for (const user of users) {
    // Already sent today (e.g. by the catch-up after a restart)? Skip.
    const already = await prisma.notification.count({
      where: { userId: user.id, type: 'DAILY_DIGEST', createdAt: { gte: today } },
    });
    if (already) continue;

    const parts = (await getTaskCounts(user))
      .filter((t) => t.count > 0 && LABEL[t.key])
      .map((t) => LABEL[t.key]!(t.count));
    if (user.role === 'ACCOUNTS' || user.role === 'ADMIN') {
      if (overdueInvoices) parts.push(`${overdueInvoices} customer invoice${overdueInvoices === 1 ? '' : 's'} overdue`);
      if (overdueBills) parts.push(`${overdueBills} vendor bill${overdueBills === 1 ? '' : 's'} overdue`);
    }
    if (parts.length === 0) continue; // nothing waiting — no noise

    await createNotification({
      userId: user.id,
      title: 'Good morning — your work for today',
      message: parts.join(' · '),
      type: 'DAILY_DIGEST',
      link: '/',
    });
    sent++;
  }
  return sent;
}

function runDigest(why: string) {
  sendDailyDigests()
    .then((n) => n && console.log(`Daily digest (${why}) sent to ${n} user(s)`))
    .catch((err) => console.error('Daily digest failed', err));
}

export function startReminderJobs() {
  // 9:00 every morning, India time
  cron.schedule('0 9 * * *', () => runDigest('9 am'), { timezone: 'Asia/Kolkata' });
  // Server (re)started after 9 am? Today's digest would otherwise be skipped — send it now
  // (users who already got it today are skipped).
  const istHour = new Date(Date.now() + 330 * 60_000).getUTCHours();
  if (istHour >= 9) setTimeout(() => runDigest('catch-up after restart'), 15_000);
}

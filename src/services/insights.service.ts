import { prisma } from '../lib/prisma.js';
import { customerSummaries, vendorSummaries } from './ledger.service.js';

// Profit & insights (Admin / MSP TL). Profit = selling − buying, both EXCLUDING GST (GST is
// collected and paid over, it isn't income). Per deal = an accepted quote and its PO.
//
//  booked    sell  = accepted quote's taxable value       buy = its PO's buying taxable value
//            (cost is "pending" until a PO exists — those deals are counted apart, not as 100% margin)
//  realised  sell  = customer invoices taxable ± notes    buy = vendor invoices taxable ± notes
//  cash      in    = receipts against invoices (incl. TDS deducted by the customer)
//            out   = payments against vendor invoices (incl. TDS we deducted)

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? round2((part / whole) * 100) : null);
type Note = { kind: 'CREDIT' | 'DEBIT'; taxableAmount: number };
const netTaxable = (taxable: number, notes: Note[]) =>
  taxable + notes.reduce((a, n) => a + (n.kind === 'DEBIT' ? n.taxableAmount : -n.taxableAmount), 0);
/** "2026-10" in IST */
const istMonth = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 7);

export async function getProfitInsights(range: { from?: Date; to?: Date } = {}) {
  const accepted =
    range.from || range.to
      ? { acceptedAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
      : {};

  const quotes = await prisma.quote.findMany({
    where: { status: 'ACCEPTED', ...accepted },
    select: {
      id: true,
      quoteNumber: true,
      orderNo: true,
      subtotal: true,
      acceptedAt: true,
      lead: { select: { id: true, companyName: true, category: true, status: true } },
      purchaseOrder: {
        select: {
          id: true,
          poNumber: true,
          status: true,
          subtotal: true,
          vendor: { select: { id: true, name: true } },
          purchaseInvoices: {
            select: {
              taxableAmount: true,
              adjustmentNotes: { select: { kind: true, taxableAmount: true } },
              allocations: { select: { amount: true } },
            },
          },
        },
      },
      salesInvoices: {
        select: {
          subtotal: true,
          adjustmentNotes: { select: { kind: true, taxableAmount: true } },
          allocations: { select: { amount: true } },
        },
      },
    },
    orderBy: { acceptedAt: 'desc' },
  });

  const deals = quotes.map((q) => {
    const po = q.purchaseOrder;
    const sell = round2(q.subtotal);
    const buy = po ? round2(po.subtotal) : null;
    const invoiced = round2(q.salesInvoices.reduce((a, i) => a + netTaxable(i.subtotal, i.adjustmentNotes), 0));
    const vendorBilled = round2(
      (po?.purchaseInvoices ?? []).reduce((a, b) => a + netTaxable(b.taxableAmount, b.adjustmentNotes), 0)
    );
    const cashIn = round2(q.salesInvoices.reduce((a, i) => a + i.allocations.reduce((s, x) => s + x.amount, 0), 0));
    const cashOut = round2(
      (po?.purchaseInvoices ?? []).reduce((a, b) => a + b.allocations.reduce((s, x) => s + x.amount, 0), 0)
    );
    const margin = buy === null ? null : round2(sell - buy);
    return {
      quoteId: q.id,
      quoteNumber: q.quoteNumber,
      orderNo: q.orderNo,
      acceptedAt: q.acceptedAt,
      customer: { id: q.lead.id, name: q.lead.companyName },
      category: q.lead.category,
      leadStatus: q.lead.status,
      po: po ? { id: po.id, poNumber: po.poNumber, status: po.status, vendor: po.vendor } : null,
      sell,
      buy,
      margin,
      marginPct: margin === null ? null : pct(margin, sell),
      invoiced,
      vendorBilled,
      realisedMargin: round2(invoiced - vendorBilled),
      cashIn,
      cashOut,
    };
  });

  const costed = deals.filter((d) => d.buy !== null);
  const sum = (xs: typeof deals, f: (d: (typeof deals)[number]) => number) => round2(xs.reduce((a, d) => a + f(d), 0));

  const totals = {
    deals: deals.length,
    dealsAwaitingPo: deals.length - costed.length,
    sellAwaitingPo: sum(deals.filter((d) => d.buy === null), (d) => d.sell),
    // booked profit only over deals whose cost is known
    sell: sum(costed, (d) => d.sell),
    buy: sum(costed, (d) => d.buy ?? 0),
    margin: sum(costed, (d) => d.margin ?? 0),
    marginPct: null as number | null,
    invoiced: sum(deals, (d) => d.invoiced),
    vendorBilled: sum(deals, (d) => d.vendorBilled),
    realisedMargin: sum(deals, (d) => d.realisedMargin),
    cashIn: sum(deals, (d) => d.cashIn),
    cashOut: sum(deals, (d) => d.cashOut),
  };
  totals.marginPct = pct(totals.margin, totals.sell);

  // Per customer (a repeat customer's orders add up)
  const byCustomer = new Map<string, { id: string; name: string; deals: number; sell: number; buy: number; margin: number; awaitingPo: number; invoiced: number; realisedMargin: number }>();
  for (const d of deals) {
    const c = byCustomer.get(d.customer.id) ?? { ...d.customer, deals: 0, sell: 0, buy: 0, margin: 0, awaitingPo: 0, invoiced: 0, realisedMargin: 0 };
    c.deals++;
    if (d.buy === null) c.awaitingPo++;
    else {
      c.sell += d.sell;
      c.buy += d.buy;
      c.margin += d.margin ?? 0;
    }
    c.invoiced += d.invoiced;
    c.realisedMargin += d.realisedMargin;
    byCustomer.set(d.customer.id, c);
  }
  const customers = [...byCustomer.values()]
    .map((c) => ({ ...c, sell: round2(c.sell), buy: round2(c.buy), margin: round2(c.margin), marginPct: pct(c.margin, c.sell), invoiced: round2(c.invoiced), realisedMargin: round2(c.realisedMargin) }))
    .sort((a, b) => b.margin - a.margin);

  // Monthly trend (by acceptance month, IST) — last 12 months that have deals
  const months = new Map<string, { month: string; sell: number; buy: number; margin: number; deals: number }>();
  for (const d of costed) {
    if (!d.acceptedAt) continue;
    const k = istMonth(d.acceptedAt);
    const m = months.get(k) ?? { month: k, sell: 0, buy: 0, margin: 0, deals: 0 };
    m.sell += d.sell;
    m.buy += d.buy ?? 0;
    m.margin += d.margin ?? 0;
    m.deals++;
    months.set(k, m);
  }
  const trend = [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-12)
    .map((m) => ({ ...m, sell: round2(m.sell), buy: round2(m.buy), margin: round2(m.margin), marginPct: pct(m.margin, m.sell) }));

  // By category (Hardware / Software)
  const cats = new Map<string, { category: string; sell: number; buy: number; margin: number; deals: number }>();
  for (const d of costed) {
    const k = d.category ?? 'UNCATEGORIZED';
    const c = cats.get(k) ?? { category: k, sell: 0, buy: 0, margin: 0, deals: 0 };
    c.sell += d.sell;
    c.buy += d.buy ?? 0;
    c.margin += d.margin ?? 0;
    c.deals++;
    cats.set(k, c);
  }
  const categories = [...cats.values()].map((c) => ({ ...c, sell: round2(c.sell), buy: round2(c.buy), margin: round2(c.margin), marginPct: pct(c.margin, c.sell) }));

  // Vendors by spend (buying value of POs in range)
  const vend = new Map<string, { id: string; name: string; pos: number; spend: number }>();
  for (const d of costed) {
    if (!d.po) continue;
    const v = vend.get(d.po.vendor.id) ?? { ...d.po.vendor, pos: 0, spend: 0 };
    v.pos++;
    v.spend += d.buy ?? 0;
    vend.set(d.po.vendor.id, v);
  }
  const vendors = [...vend.values()].map((v) => ({ ...v, spend: round2(v.spend) })).sort((a, b) => b.spend - a.spend);

  // Open pipeline: quotes in play (not range-filtered — it's "now")
  const open = await prisma.quote.groupBy({
    by: ['status'],
    where: { status: { in: ['DRAFT', 'SUBMITTED', 'APPROVED', 'SENT'] }, lead: { droppedAt: null } },
    _sum: { subtotal: true },
    _count: { _all: true },
  });
  const pipeline = ['DRAFT', 'SUBMITTED', 'APPROVED', 'SENT'].map((status) => {
    const g = open.find((o) => o.status === status);
    return { status, quotes: g?._count._all ?? 0, value: round2(g?._sum.subtotal ?? 0) };
  });

  // Money owed both ways right now (incl. GST)
  // no page → the full list (totals need every party)
  const [custRes, vendRes] = await Promise.all([customerSummaries(), vendorSummaries()]);
  const cust = Array.isArray(custRes) ? custRes : custRes.items;
  const vend2 = Array.isArray(vendRes) ? vendRes : vendRes.items;
  const balances = {
    receivable: round2(cust.reduce((a, c) => a + Math.max(0, c.outstanding), 0)),
    payable: round2(vend2.reduce((a, v) => a + Math.max(0, v.outstanding), 0)),
  };

  return { totals, deals, customers, trend, categories, vendors, pipeline, balances };
}

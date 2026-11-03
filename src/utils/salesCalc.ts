import type { GstType } from './poCalc.js';
import { quoteLines, sumGstSplit } from './poCalc.js';
import type { QuoteRequirement } from './quoteCalc.js';

// A customer invoice line: a quote line at the customer's price
export interface InvoiceLine {
  lineIndex: number; // position in the quote's flattened lines — invoices bill against it
  kind: 'ITEM' | 'SERVICE';
  requirement: string;
  description: string;
  hsnCode?: string;
  quantity: number;
  unit: string;
  rate: number; // selling rate, excl. GST
  gstPercent: number;
  taxableAmount: number;
  gstAmount: number;
  total: number;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function priced(line: Omit<InvoiceLine, 'taxableAmount' | 'gstAmount' | 'total'>): InvoiceLine {
  const taxableAmount = round2(line.quantity * line.rate);
  const gstAmount = round2((taxableAmount * line.gstPercent) / 100);
  return { ...line, taxableAmount, gstAmount, total: round2(taxableAmount + gstAmount) };
}

function totals(lines: InvoiceLine[], gstType: GstType) {
  const subtotal = round2(lines.reduce((a, l) => a + l.taxableAmount, 0));
  const gst = round2(lines.reduce((a, l) => a + l.gstAmount, 0));
  return { subtotal, ...sumGstSplit(lines, gstType), totalAmount: round2(subtotal + gst) };
}

/** Everything billable on an accepted quote, at the customer's price */
export function quoteInvoiceLines(requirements: QuoteRequirement[]): InvoiceLine[] {
  return quoteLines(requirements).map((l, lineIndex) =>
    priced({
      lineIndex,
      kind: l.kind,
      requirement: l.requirement,
      description: l.description,
      hsnCode: 'hsnCode' in l ? l.hsnCode : undefined, // services have no HSN
      quantity: l.quantity,
      unit: l.unit,
      rate: l.rate,
      gstPercent: l.gstPercent,
    })
  );
}

/** Invoice lines for the requested quantities of quote lines */
export function invoiceLines(
  allLines: InvoiceLine[],
  billed: { lineIndex: number; quantity: number }[],
  gstType: GstType
) {
  const items = billed.map(({ lineIndex, quantity }) => {
    const line = allLines[lineIndex];
    return priced({ ...line, quantity });
  });
  return { items, ...totals(items, gstType) };
}

/**
 * TDS is charged on the taxable value, not on GST. When settling `gross` of an
 * invoice, the taxable share of it is gross × taxable/total.
 */
export function tdsOn(gross: number, invoiceTaxable: number, invoiceTotal: number, tdsPercent: number) {
  if (!tdsPercent || invoiceTotal <= 0) return 0;
  return round2(((gross * invoiceTaxable) / invoiceTotal) * (tdsPercent / 100));
}

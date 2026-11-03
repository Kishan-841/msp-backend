import type { QuoteRequirement } from './quoteCalc.js';

// A PO line is a quote line with the vendor's buying rate. Lines are always rebuilt from
// the quote on the server; the client only sends buying rates. customerRate is the quote
// price, kept for internal reference — the vendor document never shows it.
export interface PoLine {
  kind: 'ITEM' | 'SERVICE';
  requirement: string;
  description: string;
  hsnCode?: string;
  quantity: number;
  unit: string;
  rate: number; // buying rate per unit, excl. GST — what we pay the vendor
  customerRate: number; // the customer's price on the quote (internal only)
  gstPercent: number;
  taxableAmount: number;
  gstAmount: number;
  total: number;
}

export type GstType = 'INTRA' | 'INTER';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Quote lines flattened in a fixed order: per requirement, items then services */
export function quoteLines(requirements: QuoteRequirement[]) {
  return requirements.flatMap((req) => [
    ...req.items.map((it) => ({
      kind: 'ITEM' as const,
      requirement: req.name,
      description: it.description ? `${it.make} — ${it.description}` : it.make,
      hsnCode: it.hsnCode,
      quantity: it.quantity,
      unit: it.unit,
      rate: it.unitPrice,
      gstPercent: it.gstPercent,
    })),
    ...req.services.map((sv) => ({
      kind: 'SERVICE' as const,
      requirement: req.name,
      description: sv.description,
      quantity: 1,
      unit: 'Service',
      rate: sv.price,
      gstPercent: sv.gstPercent,
    })),
  ]);
}

/** Same state → CGST + SGST; different (or unknown) → IGST */
export const gstTypeFor = (ourState: string, otherState: string): GstType =>
  ourState === otherState ? 'INTRA' : 'INTER';

/**
 * One line's GST as CGST + SGST: CGST = half rounded (an odd paisa rounds up, so it lands on
 * CGST), SGST = the rest — the two always add up to the line's GST. Documents print exactly this.
 */
export function lineGstSplit(gstAmount: number) {
  const cgst = round2(gstAmount / 2);
  return { cgst, sgst: round2(gstAmount - cgst) };
}

/** Splits a single GST amount by type (used for notes, which have one amount) */
export function splitGst(gstAmount: number, gstType: GstType) {
  if (gstType === 'INTER') return { cgstAmount: 0, sgstAmount: 0, igstAmount: round2(gstAmount) };
  const { cgst, sgst } = lineGstSplit(gstAmount);
  return { cgstAmount: cgst, sgstAmount: sgst, igstAmount: 0 };
}

/**
 * Document totals = the sum of each line's split, so the CGST/SGST totals match the per-line
 * figures printed above them (splitting the grand total once can be a paisa off).
 */
export function sumGstSplit(lines: { gstAmount: number }[], gstType: GstType) {
  if (gstType === 'INTER') {
    return { cgstAmount: 0, sgstAmount: 0, igstAmount: round2(lines.reduce((a, l) => a + l.gstAmount, 0)) };
  }
  let cgst = 0;
  let sgst = 0;
  for (const l of lines) {
    const s = lineGstSplit(l.gstAmount);
    cgst += s.cgst;
    sgst += s.sgst;
  }
  return { cgstAmount: round2(cgst), sgstAmount: round2(sgst), igstAmount: 0 };
}

export function computePo(
  requirements: QuoteRequirement[],
  buyingRates: number[], // one per quote line, in quoteLines() order
  gstType: GstType
) {
  const base = quoteLines(requirements);
  if (buyingRates.length !== base.length) {
    throw new Error(`Expected ${base.length} buying rates, got ${buyingRates.length}`);
  }
  const items: PoLine[] = base.map((line, i) => {
    const rate = round2(buyingRates[i] || 0);
    const taxableAmount = round2(line.quantity * rate);
    const gstAmount = round2((taxableAmount * line.gstPercent) / 100);
    return { ...line, rate, customerRate: line.rate, taxableAmount, gstAmount, total: round2(taxableAmount + gstAmount) };
  });

  const subtotal = round2(items.reduce((a, l) => a + l.taxableAmount, 0));
  const gstAmount = round2(items.reduce((a, l) => a + l.gstAmount, 0));

  return {
    items,
    gstType,
    subtotal,
    ...sumGstSplit(items, gstType),
    totalAmount: round2(subtotal + gstAmount),
  };
}

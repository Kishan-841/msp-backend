// Quote structure: Requirement (e.g. "Firewall") → items (products) + services.
// Prices are entered WITHOUT GST; GST is added per line from its GST %.

export interface QuoteItemInput {
  make: string; // e.g. Fortinet
  description?: string; // e.g. FortiGate 60F
  hsnCode: string;
  quantity: number;
  unit: string; // e.g. Nos
  unitPrice: number; // excl. GST
  gstPercent: number;
}

export interface QuoteServiceInput {
  description: string; // typed by user, e.g. "Installation by ABC Networks"
  price: number; // excl. GST
  gstPercent: number;
}

export interface QuoteRequirementInput {
  name: string;
  items: QuoteItemInput[];
  services: QuoteServiceInput[];
}

interface LineAmounts {
  taxableAmount: number;
  gstAmount: number;
  total: number;
}

export type QuoteItem = QuoteItemInput & LineAmounts;
export type QuoteService = QuoteServiceInput & LineAmounts;

export interface QuoteRequirement {
  name: string;
  items: QuoteItem[];
  services: QuoteService[];
  subtotal: number;
  gstAmount: number;
  total: number;
}

export interface QuoteTotals {
  requirements: QuoteRequirement[];
  subtotal: number;
  gstAmount: number;
  totalAmount: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// GST is rounded per line (as it prints on the invoice), totals are sums of rounded lines
function lineAmounts(taxable: number, gstPercent: number): LineAmounts {
  const taxableAmount = round2(taxable);
  const gstAmount = round2((taxableAmount * gstPercent) / 100);
  return { taxableAmount, gstAmount, total: round2(taxableAmount + gstAmount) };
}

const sum = (lines: LineAmounts[], key: keyof LineAmounts) =>
  round2(lines.reduce((acc, l) => acc + l[key], 0));

export function computeQuoteTotals(input: QuoteRequirementInput[]): QuoteTotals {
  const requirements = input.map((req) => {
    const items = req.items.map((it) => ({
      ...it,
      ...lineAmounts(it.quantity * it.unitPrice, it.gstPercent),
    }));
    const services = req.services.map((sv) => ({
      ...sv,
      ...lineAmounts(sv.price, sv.gstPercent),
    }));
    const lines = [...items, ...services];
    return {
      name: req.name,
      items,
      services,
      subtotal: sum(lines, 'taxableAmount'),
      gstAmount: sum(lines, 'gstAmount'),
      total: sum(lines, 'total'),
    };
  });

  return {
    requirements,
    subtotal: round2(requirements.reduce((a, r) => a + r.subtotal, 0)),
    gstAmount: round2(requirements.reduce((a, r) => a + r.gstAmount, 0)),
    totalAmount: round2(requirements.reduce((a, r) => a + r.total, 0)),
  };
}

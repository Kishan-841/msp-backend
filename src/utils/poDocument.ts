import type { PoLine, GstType } from './poCalc.js';
import { lineGstSplit } from './poCalc.js';
import { GST_STATES } from './gst.js';
import { amountInWords } from './amountInWords.js';

// THE purchase order format — the print/PDF page and the vendor email both render this,
// so what the vendor receives is exactly what was printed. Vendor-facing: buying rates only,
// nothing about the customer (no customer name, PO reference or customer prices). Table layout + inline styles
// so it survives email clients.

export const DEFAULT_PO_TERMS = [
  'Please quote our PO number on your invoice and all correspondence.',
  'Invoice must be raised on our company name and GSTIN as shown above.',
  'Goods / services must match the description, quantity and rates in this PO.',
  'Delivery to the address mentioned; delivery challan to accompany the goods.',
  'Payment as per agreed terms, after receipt of goods and a valid tax invoice.',
].join('\n');

export interface PoDocumentData {
  poNumber: string;
  poDate: Date;
  status: string;
  company: {
    name: string;
    gstin?: string | null;
    state?: string | null;
    address?: string | null;
    email?: string | null;
    phone?: string | null;
    pan?: string | null;
    cin?: string | null;
    logoDataUrl?: string | null;
    poTerms?: string | null;
  };
  vendor: {
    name: string;
    contactPerson: string;
    email: string;
    phone: string;
    gstNumber?: string | null;
    state?: string | null;
    address?: string | null;
  };
  items: PoLine[];
  gstType: GstType;
  subtotal: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalAmount: number;
  deliveryAddress?: string | null;
  expectedDeliveryDate?: Date | null;
  notes?: string | null;
  intro?: string | null; // email only: short note above the document
}

const num = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d: Date) =>
  d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const lines = (s?: string | null) => (s ? esc(s).replace(/\n/g, '<br>') : '');
const stateLabel = (code?: string | null) => (code ? `${esc(GST_STATES[code] ?? '')} (${esc(code)})` : '—');

const B = 'border: 1px solid #000;';
const CELL = `${B} padding: 5px 6px; vertical-align: top;`;
const TH = `${CELL} background: #f1f1f1; font-weight: bold; text-align: left;`;
const R = 'text-align: right; white-space: nowrap;';

export function renderPoDocument(d: PoDocumentData): string {
  const intra = d.gstType === 'INTRA';
  const draft = d.status !== 'CONFIRMED' && d.status !== 'SENT_TO_VENDOR';
  const terms = (d.company.poTerms?.trim() || DEFAULT_PO_TERMS).split('\n').filter((t) => t.trim());

  const taxHead = intra
    ? `<th style="${TH} ${R}">CGST</th><th style="${TH} ${R}">SGST</th>`
    : `<th style="${TH} ${R}">IGST</th>`;

  const rows = d.items
    .map((l, i) => {
      const { cgst, sgst } = lineGstSplit(l.gstAmount); // same rule as the stored totals
      const tax = intra
        ? `<td style="${CELL} ${R}">${num(cgst)}<br><span style="font-size:9px;color:#555">@${l.gstPercent / 2}%</span></td>
           <td style="${CELL} ${R}">${num(sgst)}<br><span style="font-size:9px;color:#555">@${l.gstPercent / 2}%</span></td>`
        : `<td style="${CELL} ${R}">${num(l.gstAmount)}<br><span style="font-size:9px;color:#555">@${l.gstPercent}%</span></td>`;
      return `<tr>
        <td style="${CELL} text-align:center;">${i + 1}</td>
        <td style="${CELL}">${esc(l.description)}</td>
        <td style="${CELL}">${esc(l.hsnCode ?? '')}</td>
        <td style="${CELL} ${R}">${l.quantity}</td>
        <td style="${CELL}">${esc(l.unit)}</td>
        <td style="${CELL} ${R}">${num(l.rate)}</td>
        <td style="${CELL} ${R}">${num(l.taxableAmount)}</td>
        ${tax}
        <td style="${CELL} ${R}">${num(l.total)}</td>
      </tr>`;
    })
    .join('');

  const cols = intra ? 10 : 9;
  const totalRow = (label: string, value: number, bold = false) =>
    `<tr><td colspan="${cols - 1}" style="${CELL} ${R} ${bold ? 'font-weight:bold;' : ''}">${label}</td>
     <td style="${CELL} ${R} ${bold ? 'font-weight:bold; font-size:13px;' : ''}">${bold ? '₹ ' : ''}${num(value)}</td></tr>`;

  const c = d.company;
  const companyIds = [
    c.gstin ? `GSTIN: <b>${esc(c.gstin)}</b>` : 'GSTIN: —',
    c.pan ? `PAN: ${esc(c.pan)}` : '',
    c.cin ? `CIN: ${esc(c.cin)}` : '',
  ]
    .filter(Boolean)
    .join(' &nbsp;|&nbsp; ');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Purchase Order ${esc(d.poNumber)}</title>
<style>@page { size: A4; margin: 10mm; } @media print { .no-print { display: none; } body { background: #fff !important; } }</style>
</head>
<body style="margin:0; padding:16px; background:#f4f4f4; font-family: Arial, Helvetica, sans-serif; font-size:11px; color:#000;">
${d.intro ? `<div class="no-print" style="max-width:780px; margin:0 auto 12px; font-size:14px; line-height:1.5;">${lines(d.intro)}</div>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:780px; width:100%; margin:0 auto; background:#fff; border-collapse:collapse; ${B}">
  <tr><td style="padding:12px; border-bottom:2px solid #000;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${c.logoDataUrl ? `<td style="width:90px; vertical-align:top;"><img src="${c.logoDataUrl}" alt="" style="max-width:80px; max-height:60px;"></td>` : ''}
      <td style="vertical-align:top;">
        <div style="font-size:18px; font-weight:bold;">${esc(c.name)}</div>
        <div>${lines(c.address)}</div>
        <div>${companyIds}</div>
        <div>State: ${stateLabel(c.state)}${c.email ? ` &nbsp;|&nbsp; ${esc(c.email)}` : ''}${c.phone ? ` &nbsp;|&nbsp; ${esc(c.phone)}` : ''}</div>
      </td>
      <td style="vertical-align:top; text-align:right; white-space:nowrap;">
        <div style="font-size:20px; font-weight:bold; letter-spacing:1px;">PURCHASE ORDER</div>
        ${draft ? '<div style="color:#b91c1c; font-weight:bold; margin-top:4px;">DRAFT — NOT CONFIRMED</div>' : ''}
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td style="${CELL} width:50%; border-left:0; border-top:0;">
          <b>Vendor</b><br>
          <span style="font-size:13px; font-weight:bold;">${esc(d.vendor.name)}</span><br>
          ${lines(d.vendor.address)}${d.vendor.address ? '<br>' : ''}
          GSTIN: ${esc(d.vendor.gstNumber ?? 'Unregistered')}<br>
          State: ${stateLabel(d.vendor.state)}<br>
          Attn: ${esc(d.vendor.contactPerson)} · ${esc(d.vendor.phone)} · ${esc(d.vendor.email)}
        </td>
        <td style="${CELL} width:50%; border-right:0; border-top:0;">
          <table role="presentation" width="100%" cellpadding="2" cellspacing="0">
            <tr><td>PO No.</td><td><b>${esc(d.poNumber)}</b></td></tr>
            <tr><td>PO Date</td><td>${fmtDate(d.poDate)}</td></tr>
            ${d.expectedDeliveryDate ? `<tr><td>Delivery by</td><td>${fmtDate(d.expectedDeliveryDate)}</td></tr>` : ''}
            <tr><td>Tax</td><td>${intra ? 'CGST + SGST (intra-state)' : 'IGST (inter-state)'}</td></tr>
          </table>
        </td>
      </tr>
      <tr>
        <td colspan="2" style="${CELL} border-left:0; border-right:0;">
          <b>Bill to:</b> ${esc(c.name)}, ${esc(c.gstin ?? 'GSTIN —')} &nbsp;&nbsp;
          <b>Ship to:</b> ${lines(d.deliveryAddress || c.address) || '—'}
        </td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <thead><tr>
        <th style="${TH} width:28px; text-align:center;">#</th>
        <th style="${TH}">Description</th>
        <th style="${TH}">HSN/SAC</th>
        <th style="${TH} ${R}">Qty</th>
        <th style="${TH}">Unit</th>
        <th style="${TH} ${R}">Rate</th>
        <th style="${TH} ${R}">Taxable</th>
        ${taxHead}
        <th style="${TH} ${R}">Amount</th>
      </tr></thead>
      <tbody>${rows}
        ${totalRow('Taxable value', d.subtotal)}
        ${intra ? totalRow('CGST', d.cgstAmount) + totalRow('SGST', d.sgstAmount) : totalRow('IGST', d.igstAmount)}
        ${totalRow('Total', d.totalAmount, true)}
        <tr><td colspan="${cols}" style="${CELL}"><b>Amount in words:</b> ${amountInWords(d.totalAmount)}</td></tr>
      </tbody>
    </table>
  </td></tr>

  <tr><td style="padding:8px 12px;">
    <b>Terms &amp; Conditions</b>
    <ol style="margin:4px 0 0 16px; padding:0;">${terms.map((t) => `<li>${esc(t.trim())}</li>`).join('')}</ol>
    ${d.notes ? `<div style="margin-top:6px;"><b>Notes:</b> ${lines(d.notes)}</div>` : ''}
  </td></tr>

  <tr><td style="padding:24px 12px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:bottom; font-size:9px; color:#555;">This is a computer-generated purchase order.</td>
      <td style="text-align:right; vertical-align:bottom;">
        For <b>${esc(c.name)}</b><br><br><br><br>
        <span style="display:inline-block; border-top:1px solid #000; padding-top:3px;">Authorised Signatory</span>
      </td>
    </tr></table>
  </td></tr>
</table>
</body></html>`;
}

import type { QuoteRequirement } from './quoteCalc.js';

export interface QuoteEmailData {
  quoteNumber: string;
  companyName: string;
  contactPerson: string;
  requirements: QuoteRequirement[];
  subtotal: number;
  gstAmount: number;
  totalAmount: number;
  notes?: string | null;
  senderName: string;
  senderEmail: string;
  category?: string | null;
  subcategory?: string[] | null;
}

const formatINR = (amount: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);

function formatDate(d: Date) {
  return d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderQuoteEmail(data: QuoteEmailData): string {
  const subcategoryText =
    data.subcategory && data.subcategory.length > 0
      ? data.subcategory.map(escape).join(', ')
      : '';
  const productLine =
    data.category && subcategoryText
      ? `${escape(data.category)} &rarr; ${subcategoryText}`
      : data.category
        ? escape(data.category)
        : '';

  const cell = 'padding: 10px 16px; border-bottom: 1px solid #e2e8f0; font-size: 14px;';
  const num = `${cell} color: #475569; text-align: right; font-variant-numeric: tabular-nums;`;
  const sub = 'display: block; margin-top: 2px; font-size: 12px; color: #94a3b8;';

  const itemsRows = data.requirements
    .map((req) => {
      const header = `
    <tr style="background: #eef2ff;">
      <td colspan="5" style="${cell} font-weight: 600; color: #3730a3;">${escape(req.name)}</td>
    </tr>`;
      const items = req.items
        .map(
          (it) => `
    <tr>
      <td style="${cell} color: #0f172a;">${escape(it.make)}${it.description ? ` &mdash; ${escape(it.description)}` : ''}<span style="${sub}">HSN ${escape(it.hsnCode)}</span></td>
      <td style="${num}">${it.quantity} ${escape(it.unit)}</td>
      <td style="${num}">${formatINR(it.unitPrice)}</td>
      <td style="${num}">${it.gstPercent}%</td>
      <td style="${num} color: #0f172a; font-weight: 600;">${formatINR(it.taxableAmount)}</td>
    </tr>`
        )
        .join('');
      const services = req.services
        .map(
          (sv) => `
    <tr>
      <td style="${cell} color: #0f172a;">${escape(sv.description)}<span style="${sub}">Service</span></td>
      <td style="${num}">&mdash;</td>
      <td style="${num}">${formatINR(sv.price)}</td>
      <td style="${num}">${sv.gstPercent}%</td>
      <td style="${num} color: #0f172a; font-weight: 600;">${formatINR(sv.taxableAmount)}</td>
    </tr>`
        )
        .join('');
      return header + items + services;
    })
    .join('');

  const totalRow = (label: string, value: number, strong = false) => `
                  <tr style="background: #f1f5f9;">
                    <td colspan="4" style="padding: ${strong ? '16px' : '10px 16px'}; text-align: right; font-size: 14px; font-weight: 600; color: #334155;">${label}</td>
                    <td style="padding: ${strong ? '16px' : '10px 16px'}; text-align: right; font-size: ${strong ? '18px' : '14px'}; font-weight: 700; color: #0f172a; font-variant-numeric: tabular-nums;">${formatINR(value)}</td>
                  </tr>`;

  const notesBlock = data.notes
    ? `
    <div style="margin-top: 24px; padding: 16px; background: #fef3c7; border-left: 3px solid #f59e0b; border-radius: 8px;">
      <p style="margin: 0 0 4px; font-size: 12px; font-weight: 600; color: #92400e; text-transform: uppercase; letter-spacing: 0.05em;">Notes</p>
      <p style="margin: 0; font-size: 14px; color: #78350f; white-space: pre-wrap; line-height: 1.5;">${escape(data.notes)}</p>
    </div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Quote ${escape(data.quoteNumber)}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f1f5f9; color: #0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #f1f5f9; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" style="max-width: 640px; width: 100%; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.06);">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #3B82F6 0%, #6366F1 100%); padding: 32px 32px 28px; color: #ffffff;">
              <p style="margin: 0; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.85;">Commercial Proposal</p>
              <h1 style="margin: 4px 0 0; font-size: 28px; font-weight: 700; letter-spacing: -0.01em;">Quote ${escape(data.quoteNumber)}</h1>
              ${productLine ? `<p style="margin: 12px 0 0; font-size: 14px; opacity: 0.9;">${productLine}</p>` : ''}
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding: 28px 32px 8px;">
              <p style="margin: 0 0 8px; font-size: 15px; line-height: 1.6; color: #334155;">Hi ${escape(data.contactPerson)},</p>
              <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #334155;">
                Thank you for your interest. Please find below our commercial proposal for <strong style="color: #0f172a;">${escape(data.companyName)}</strong>.
              </p>
            </td>
          </tr>

          <!-- Line items -->
          <tr>
            <td style="padding: 16px 32px 0;">
              <p style="margin: 0 0 10px; font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">Pricing</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
                <thead>
                  <tr style="background: #f8fafc;">
                    <th style="padding: 12px 16px; text-align: left; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e2e8f0;">Description</th>
                    <th style="padding: 12px 16px; text-align: right; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e2e8f0;">Qty</th>
                    <th style="padding: 12px 16px; text-align: right; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e2e8f0;">Rate</th>
                    <th style="padding: 12px 16px; text-align: right; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e2e8f0;">GST</th>
                    <th style="padding: 12px 16px; text-align: right; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e2e8f0;">Amount</th>
                  </tr>
                </thead>
                <tbody>${itemsRows}</tbody>
                <tfoot>${totalRow('Subtotal (excl. GST)', data.subtotal)}${totalRow('GST', data.gstAmount)}${totalRow('Grand total', data.totalAmount, true)}
                </tfoot>
              </table>
              ${notesBlock}
            </td>
          </tr>

          <!-- Signature -->
          <tr>
            <td style="padding: 28px 32px 32px;">
              <p style="margin: 0 0 6px; font-size: 15px; line-height: 1.6; color: #334155;">Please reply to this email with a Purchase Order to confirm this quote, or let us know if you have any questions.</p>
              <p style="margin: 24px 0 0; font-size: 14px; color: #334155; line-height: 1.5;">Best regards,</p>
              <p style="margin: 4px 0 0; font-size: 14px; font-weight: 600; color: #0f172a;">${escape(data.senderName)}</p>
              <p style="margin: 2px 0 0; font-size: 13px; color: #64748b;">${escape(data.senderEmail)}</p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 16px 32px; background: #f8fafc; border-top: 1px solid #e2e8f0;">
              <p style="margin: 0; font-size: 11px; color: #94a3b8; text-align: center;">
                This proposal was generated by MSP CRM. Quote ${escape(data.quoteNumber)}.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

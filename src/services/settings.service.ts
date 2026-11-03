import { prisma } from '../lib/prisma.js';
import { resolveGstDetails } from '../utils/gst.js';

const COMPANY_ID = 1;

// Returns null until an Admin fills in the company details
export async function getCompanySettings() {
  return prisma.companySettings.findUnique({ where: { id: COMPANY_ID } });
}

export async function saveCompanySettings(data: {
  name: string;
  gstin?: string;
  state?: string;
  address?: string;
  email?: string;
  phone?: string;
  pan?: string;
  cin?: string;
  tan?: string;
  bankName?: string;
  bankAccountName?: string;
  bankAccountNumber?: string;
  bankIfsc?: string;
  bankBranch?: string;
  logoDataUrl?: string;
  poTerms?: string;
}) {
  const { gstin, state } = resolveGstDetails(data.gstin, data.state);
  const values = {
    name: data.name,
    gstin,
    state,
    address: data.address || null,
    email: data.email || null,
    phone: data.phone || null,
    pan: data.pan?.toUpperCase() || null,
    cin: data.cin?.toUpperCase() || null,
    tan: data.tan?.toUpperCase() || null,
    bankName: data.bankName || null,
    bankAccountName: data.bankAccountName || null,
    bankAccountNumber: data.bankAccountNumber || null,
    bankIfsc: data.bankIfsc?.toUpperCase() || null,
    bankBranch: data.bankBranch || null,
    poTerms: data.poTerms?.trim() || null, // empty → default terms (utils/poDocument.ts)
    // undefined = keep the current logo, '' = remove it
    ...(data.logoDataUrl !== undefined ? { logoDataUrl: data.logoDataUrl || null } : {}),
  };

  return prisma.companySettings.upsert({
    where: { id: COMPANY_ID },
    create: { id: COMPANY_ID, ...values },
    update: values,
  });
}

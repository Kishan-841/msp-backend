import { z } from 'zod';

// GST state codes (first 2 digits of a GSTIN). Keep in sync with frontend/src/lib/gst.ts
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};

// 2-digit state code + 10-char PAN + entity no. + 'Z' + checksum char
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const isValidGstin = (gstin: string) =>
  GSTIN_PATTERN.test(gstin) && gstin.slice(0, 2) in GST_STATES;

export const isValidStateCode = (code: string) => code in GST_STATES;

/** GST state code from a code or a state name ("27", "Maharashtra", "maharashtra"); null if unknown */
export function stateCodeFrom(value?: string | null): string | null {
  const v = value?.trim().toLowerCase();
  if (!v) return null;
  if (isValidStateCode(v)) return v;
  return Object.entries(GST_STATES).find(([, name]) => name.toLowerCase() === v)?.[0] ?? null;
}

/**
 * Normalizes GSTIN/state input from a form. The state always follows the GSTIN
 * when one is given, so the two can never disagree.
 */
export function resolveGstDetails(gstin?: string | null, state?: string | null) {
  const g = gstin?.trim().toUpperCase() || null;
  return { gstin: g, state: g ? g.slice(0, 2) : state?.trim() || null };
}

export const optionalIfscField = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine((v) => v === '' || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v), 'Invalid IFSC (e.g. HDFC0000794)')
  .optional();

export const optionalAccountNumberField = z
  .string()
  .trim()
  .refine((v) => v === '' || /^[0-9]{9,18}$/.test(v), 'Account number should be 9–18 digits')
  .optional();

// Zod fields for forms: empty string means "clear the value"
export const optionalGstinField = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine((v) => v === '' || isValidGstin(v), 'Invalid GSTIN (e.g. 27ABCDE1234F1Z5)')
  .optional();

export const optionalStateField = z
  .string()
  .trim()
  .refine((v) => v === '' || isValidStateCode(v), 'Invalid GST state code')
  .optional();

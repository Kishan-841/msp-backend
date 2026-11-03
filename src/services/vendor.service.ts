import { prisma } from '../lib/prisma.js';
import { envelope, startOfTodayIST, type PageParams } from '../utils/paginate.js';
import { AppError } from '../middleware/errorHandler.js';
import { resolveGstDetails } from '../utils/gst.js';

export interface VendorInput {
  name: string;
  contactPerson: string;
  email: string;
  phone: string;
  address?: string;
  gstNumber?: string;
  state?: string;
  products?: string[];
  bankName?: string;
  bankAccountName?: string;
  bankAccountNumber?: string;
  bankIfsc?: string;
}

export async function getAllVendors(filters: { search?: string; includeInactive?: boolean } = {}, page?: PageParams) {
  const where: Record<string, unknown> = {};
  if (!filters.includeInactive) where.isActive = true;
  if (filters.search) {
    where.OR = [
      { name: { contains: filters.search, mode: 'insensitive' } },
      { contactPerson: { contains: filters.search, mode: 'insensitive' } },
      { gstNumber: { contains: filters.search, mode: 'insensitive' } },
    ];
  }

  if (!page) return prisma.vendor.findMany({ where, orderBy: { name: 'asc' } });
  const [items, total] = await Promise.all([
    prisma.vendor.findMany({ where, orderBy: { name: 'asc' }, skip: page.skip, take: page.limit }),
    prisma.vendor.count({ where }),
  ]);
  return envelope(items, total, page);
}

export async function getVendorById(id: string) {
  const vendor = await prisma.vendor.findUnique({ where: { id } });
  if (!vendor) throw new AppError('Vendor not found.', 404);
  return vendor;
}

async function assertGstinUnique(gstNumber: string | null, excludeId?: string) {
  if (!gstNumber) return;
  const clash = await prisma.vendor.findFirst({
    where: { gstNumber, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
  if (clash) {
    throw new AppError(`Vendor "${clash.name}" already has GSTIN ${gstNumber}.`, 409);
  }
}

export async function createVendor(data: VendorInput) {
  const { gstin, state } = resolveGstDetails(data.gstNumber, data.state);
  await assertGstinUnique(gstin);

  return prisma.vendor.create({
    data: {
      name: data.name,
      contactPerson: data.contactPerson,
      email: data.email,
      phone: data.phone,
      address: data.address || null,
      gstNumber: gstin,
      state,
      products: data.products ?? [],
      bankName: data.bankName || null,
      bankAccountName: data.bankAccountName || null,
      bankAccountNumber: data.bankAccountNumber || null,
      bankIfsc: data.bankIfsc || null,
    },
  });
}

export async function updateVendor(
  id: string,
  data: Partial<VendorInput> & { isActive?: boolean }
) {
  const existing = await getVendorById(id);

  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.contactPerson !== undefined) updateData.contactPerson = data.contactPerson;
  if (data.email !== undefined) updateData.email = data.email;
  if (data.phone !== undefined) updateData.phone = data.phone;
  if (data.address !== undefined) updateData.address = data.address || null;
  if (data.products !== undefined) updateData.products = data.products;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;
  for (const key of ['bankName', 'bankAccountName', 'bankAccountNumber', 'bankIfsc'] as const) {
    if (data[key] !== undefined) updateData[key] = data[key] || null;
  }

  if (data.gstNumber !== undefined || data.state !== undefined) {
    const { gstin, state } = resolveGstDetails(
      data.gstNumber ?? existing.gstNumber,
      data.state ?? existing.state
    );
    await assertGstinUnique(gstin, id);
    updateData.gstNumber = gstin;
    updateData.state = state;
  }

  return prisma.vendor.update({ where: { id }, data: updateData });
}

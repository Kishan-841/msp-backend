import { prisma } from '../lib/prisma.js';
import type { LeadCategory } from '../generated/prisma/client.js';

const creatorSelect = { id: true, name: true } as const;

export async function listMaterials(filters: { product?: string; category?: LeadCategory } = {}) {
  return prisma.material.findMany({
    where: {
      isActive: true,
      ...(filters.product ? { product: filters.product } : {}),
      ...(filters.category ? { category: filters.category } : {}),
    },
    include: { createdBy: { select: creatorSelect } },
    orderBy: [{ product: 'asc' }, { name: 'asc' }],
  });
}

/**
 * Adds an item under a product. If the same name already exists under that product
 * (ignoring case), the existing one is returned instead of a near-duplicate.
 */
export async function createMaterial(
  data: { category: LeadCategory; product: string; name: string; brand?: string },
  userId: string
) {
  const existing = await prisma.material.findFirst({
    where: { product: data.product, name: { equals: data.name, mode: 'insensitive' } },
    include: { createdBy: { select: creatorSelect } },
  });
  if (existing) {
    // Re-adding a deactivated item brings it back
    if (!existing.isActive) {
      return prisma.material.update({
        where: { id: existing.id },
        data: { isActive: true },
        include: { createdBy: { select: creatorSelect } },
      });
    }
    return existing;
  }

  return prisma.material.create({
    data: {
      category: data.category,
      product: data.product,
      name: data.name,
      brand: data.brand || null,
      createdById: userId,
    },
    include: { createdBy: { select: creatorSelect } },
  });
}

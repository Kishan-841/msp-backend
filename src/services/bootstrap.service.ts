import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';

/**
 * First start on an empty database: create one Admin from BOOTSTRAP_ADMIN_EMAIL /
 * BOOTSTRAP_ADMIN_PASSWORD so someone can log in (and create everyone else in Users).
 * Does nothing once any real user exists — remove the variables after the first login.
 */
export async function bootstrapAdmin() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) return;
  if ((await prisma.user.count({ where: { isSystem: false } })) > 0) return;
  if (password.length < 6) {
    console.error('BOOTSTRAP_ADMIN_PASSWORD must be at least 6 characters — no admin created.');
    return;
  }
  await prisma.user.create({
    data: {
      name: process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Admin',
      email,
      password: await bcrypt.hash(password, 12),
      role: 'ADMIN',
    },
  });
  console.log(`Created the first Admin: ${email}. Remove BOOTSTRAP_ADMIN_* from the environment now.`);
}

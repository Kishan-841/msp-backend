import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from '../config/index.js';
import { withAudit } from './auditCapture.js';

function createBaseClient() {
  const adapter = new PrismaPg({ connectionString: config.databaseUrl });
  return new PrismaClient({ adapter });
}

type Clients = { base: PrismaClient; prisma: ReturnType<typeof withAudit> };
const globalForPrisma = globalThis as unknown as { prismaClients?: Clients };

const base = globalForPrisma.prismaClients?.base ?? createBaseClient();

/** The plain client — writes through it are NOT in the system log. Only for the log itself. */
export const basePrisma = base;

/** The client for all app code: every create / update / delete is written to the system log */
export const prisma = globalForPrisma.prismaClients?.prisma ?? withAudit(base);

if (process.env.NODE_ENV !== 'production') globalForPrisma.prismaClients = { base, prisma };

export default prisma;

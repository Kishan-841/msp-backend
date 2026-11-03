import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const users = [
    { name: 'Super Admin', email: 'superadmin@email.com', password: 'admin123', role: 'ADMIN' as const },
    { name: 'Admin User', email: 'admin@email.com', password: 'admin123', role: 'ADMIN' as const },
    { name: 'Rajesh Kumar', email: 'msptl@email.com', password: '123456', role: 'MSP_TL' as const },
    { name: 'Amit Sharma', email: 'sales1@email.com', password: '123456', role: 'SALES' as const },
    { name: 'Neha Gupta', email: 'sales2@email.com', password: '123456', role: 'SALES' as const },
    { name: 'Pooja Mehta', email: 'acc@email.com', password: '123456', role: 'ACCOUNTS' as const },
  ];

  console.log('Seeding users...');

  for (const userData of users) {
    const hashedPassword = await bcrypt.hash(userData.password, 12); // same cost as login's dummy check
    const user = await prisma.user.upsert({
      where: { email: userData.email },
      update: {
        name: userData.name,
        password: hashedPassword,
        role: userData.role,
      },
      create: {
        name: userData.name,
        email: userData.email,
        password: hashedPassword,
        role: userData.role,
      },
    });
    console.log(`  ${user.role.padEnd(20)} ${user.name} (${user.email})`);
  }

  console.log('\nSeeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

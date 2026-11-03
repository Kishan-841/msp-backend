import type { User } from '../generated/prisma/client.js';

declare global {
  namespace Express {
    interface Request {
      user?: Omit<User, 'password'>;
    }
  }
}

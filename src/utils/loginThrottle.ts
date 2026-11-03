import { AppError } from '../middleware/errorHandler.js';

// Brute-force guard for /auth/login (in-memory — one API instance).
//  • per account+IP: 5 wrong passwords in 15 min → that pair is locked for 15 min
//  • per IP: 30 wrong passwords in 15 min, any accounts (stops spraying many emails from one machine;
//    only failures count, so an office sharing one IP isn't locked out by normal logins)
// A successful login clears the account+IP counter.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_ACCOUNT = 5;
const MAX_FAILS_PER_IP = 30;

type Bucket = { count: number; resetAt: number };
const failsByAccount = new Map<string, Bucket>();
const failsByIp = new Map<string, Bucket>();

function bump(map: Map<string, Bucket>, key: string) {
  const now = Date.now();
  const b = map.get(key);
  if (!b || b.resetAt <= now) map.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else b.count++;
}
const over = (map: Map<string, Bucket>, key: string, max: number) => {
  const b = map.get(key);
  return b && b.resetAt > Date.now() && b.count >= max ? Math.ceil((b.resetAt - Date.now()) / 60000) : 0;
};

const accountKey = (email: string, ip: string) => `${email.toLowerCase()}|${ip}`;

/** Call before checking the password; throws 429 when locked */
export function assertLoginAllowed(email: string, ip: string) {
  const mins = over(failsByAccount, accountKey(email, ip), MAX_FAILS_PER_ACCOUNT) || over(failsByIp, ip, MAX_FAILS_PER_IP);
  if (mins) throw new AppError(`Too many sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 429);
}

export const recordLoginFailure = (email: string, ip: string) => {
  bump(failsByAccount, accountKey(email, ip));
  bump(failsByIp, ip);
};
export const recordLoginSuccess = (email: string, ip: string) => failsByAccount.delete(accountKey(email, ip));

// keep the maps small
setInterval(() => {
  const now = Date.now();
  for (const m of [failsByAccount, failsByIp]) for (const [k, b] of m) if (b.resetAt <= now) m.delete(k);
}, WINDOW_MS).unref();

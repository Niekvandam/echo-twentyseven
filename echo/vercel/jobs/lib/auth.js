import { createHash, timingSafeEqual } from 'node:crypto';

export function authorized(value, secret) {
  if (!secret || typeof value !== 'string') return false;
  const digest = (input) => createHash('sha256').update(input).digest();
  return timingSafeEqual(digest(value), digest(`Bearer ${secret}`));
}

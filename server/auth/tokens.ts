import { createHash, randomBytes } from 'node:crypto'
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2'

export const SESSION_COOKIE_NAME = 'fourno_admin_session'
const SESSION_ABSOLUTE_TIMEOUT_MS = 1000 * 60 * 60 * 24 * 90

/**
 * Argon2id cost parameters, encoded into every PHC hash string
 * (`$argon2id$v=19$m=65536,t=2,p=1$…`). They match what the Bun runtime
 * produced before the move to Node, so hashes written by either runtime are
 * the same shape and cost; verification reads the parameters from the hash
 * itself, so changing these only affects newly written hashes.
 *
 * The algorithm is the library default, Argon2id (`Algorithm` is an ambient
 * const enum, which `isolatedModules` cannot reference); `tokens.test.ts`
 * pins the `$argon2id$` prefix.
 */
const ARGON2ID_OPTIONS = {
  memoryCost: 65_536,
  timeCost: 2,
  parallelism: 1,
} as const

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2ID_OPTIONS)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, password)
  } catch {
    // A malformed or non-argon2 stored hash never verifies.
    return false
  }
}

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export async function hashSessionToken(token: string): Promise<string> {
  return createHash('sha256').update(token).digest('hex')
}

export function sessionExpiry(now = Date.now()): Date {
  return new Date(now + SESSION_ABSOLUTE_TIMEOUT_MS)
}

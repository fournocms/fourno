import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './tokens'

// Written by `Bun.password.hash('correct horse battery staple', { algorithm: 'argon2id' })`
// on Bun 1.4.2 — the format every installation created before the move to Node.
const BUN_WRITTEN_HASH =
  '$argon2id$v=19$m=65536,t=2,p=1$TpNOwLR0CO+Fok4xz//lMDvF9bbaZ7Alb+68TElHk1w$0Ks/pdvTKtJlB5PH6eNz3VqP7haBj5oRkUsoz34DiN0'

describe('password hashing', () => {
  it('writes argon2id PHC hashes with the pre-Node cost parameters', async () => {
    const hash = await hashPassword('s3cret-passphrase')
    expect(hash.startsWith('$argon2id$v=19$m=65536,t=2,p=1$')).toBe(true)
    expect(await verifyPassword('s3cret-passphrase', hash)).toBe(true)
    expect(await verifyPassword('wrong-passphrase', hash)).toBe(false)
  })

  it('verifies hashes written by the Bun runtime', async () => {
    expect(await verifyPassword('correct horse battery staple', BUN_WRITTEN_HASH)).toBe(true)
    expect(await verifyPassword('correct horse battery stapler', BUN_WRITTEN_HASH)).toBe(false)
  })

  it('treats a malformed stored hash as a failed verification', async () => {
    expect(await verifyPassword('anything', 'not-a-phc-string')).toBe(false)
  })
})

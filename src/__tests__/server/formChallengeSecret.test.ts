import { describe, expect, it, vi } from 'vitest'

type ChallengeModule = typeof import('../../../server/forms/challenge')

async function importChallengeWithEnv(env: {
  formSecret?: string
  secretKey?: string
}): Promise<ChallengeModule> {
  const originalFormSecret = process.env.FOURNO_FORM_SECRET
  const originalSecretKey = process.env.FOURNO_SECRET_KEY

  if (env.formSecret === undefined) delete process.env.FOURNO_FORM_SECRET
  else process.env.FOURNO_FORM_SECRET = env.formSecret

  if (env.secretKey === undefined) delete process.env.FOURNO_SECRET_KEY
  else process.env.FOURNO_SECRET_KEY = env.secretKey

  try {
    // The secret is read when the module graph evaluates, so each call needs
    // a fresh evaluation under its own env.
    vi.resetModules()
    return await import('../../../server/forms/challenge')
  } finally {
    if (originalFormSecret === undefined) delete process.env.FOURNO_FORM_SECRET
    else process.env.FOURNO_FORM_SECRET = originalFormSecret

    if (originalSecretKey === undefined) delete process.env.FOURNO_SECRET_KEY
    else process.env.FOURNO_SECRET_KEY = originalSecretKey
  }
}

describe('public form challenge signing secret configuration', () => {
  it('uses FOURNO_FORM_SECRET ahead of FOURNO_SECRET_KEY', async () => {
    const issuer = await importChallengeWithEnv({
      formSecret: 'form-secret',
      secretKey: 'old-master-key',
    })
    const sameFormSecret = await importChallengeWithEnv({
      formSecret: 'form-secret',
      secretKey: 'new-master-key',
    })
    const changedFormSecret = await importChallengeWithEnv({
      formSecret: 'changed-form-secret',
      secretKey: 'old-master-key',
    })

    const pageToken = issuer.issuePublicFormPageToken({
      pageId: 'page-home',
      formId: 'newsletter',
    })

    expect(sameFormSecret.verifyPublicFormPageToken({
      pageId: 'page-home',
      formId: 'newsletter',
      pageToken,
    })).toBe(true)
    expect(changedFormSecret.verifyPublicFormPageToken({
      pageId: 'page-home',
      formId: 'newsletter',
      pageToken,
    })).toBe(false)
  })

  it('falls back to FOURNO_SECRET_KEY when no dedicated form secret is configured', async () => {
    const issuer = await importChallengeWithEnv({ secretKey: 'shared-master-key' })
    const verifier = await importChallengeWithEnv({ secretKey: 'shared-master-key' })
    const rotatedMasterKey = await importChallengeWithEnv({ secretKey: 'rotated-master-key' })

    const pageToken = issuer.issuePublicFormPageToken({
      pageId: 'page-home',
      formId: 'newsletter',
    })

    expect(verifier.verifyPublicFormPageToken({
      pageId: 'page-home',
      formId: 'newsletter',
      pageToken,
    })).toBe(true)
    expect(rotatedMasterKey.verifyPublicFormPageToken({
      pageId: 'page-home',
      formId: 'newsletter',
      pageToken,
    })).toBe(false)
  })

  it('uses a process-local fallback secret when neither env var is configured', async () => {
    const issuer = await importChallengeWithEnv({})
    const secondProcessSecret = await importChallengeWithEnv({})

    const pageToken = issuer.issuePublicFormPageToken({
      pageId: 'page-home',
      formId: 'newsletter',
    })

    expect(issuer.verifyPublicFormPageToken({
      pageId: 'page-home',
      formId: 'newsletter',
      pageToken,
    })).toBe(true)
    expect(secondProcessSecret.verifyPublicFormPageToken({
      pageId: 'page-home',
      formId: 'newsletter',
      pageToken,
    })).toBe(false)
  })
})

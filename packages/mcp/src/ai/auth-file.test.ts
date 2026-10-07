import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  activeCredential,
  credentialFor,
  loadAuthFile,
  removeProviderFromAuthFile,
  resolveAuthFilePath,
  saveAuthFile,
} from './auth-file'

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'pascal-auth-'))
}

describe('resolveAuthFilePath', () => {
  test('honors PASCAL_AUTH_FILE then PASCAL_HOME', () => {
    expect(resolveAuthFilePath({ PASCAL_AUTH_FILE: '/tmp/x/auth.json' })).toBe('/tmp/x/auth.json')
    expect(resolveAuthFilePath({ PASCAL_HOME: '/tmp/pascal' })).toBe(
      path.join('/tmp/pascal', 'auth.json'),
    )
    expect(resolveAuthFilePath({}).toString()).toContain(path.join('.pascal', 'auth.json'))
  })
})

describe('auth file IO', () => {
  test('saves with mode 0600 and round-trips', () => {
    const dir = tempDir()
    try {
      const filePath = path.join(dir, 'nested', 'auth.json')
      saveAuthFile(
        {
          selectedProvider: 'anthropic',
          providers: { anthropic: { apiKey: 'sk-test' } },
        },
        filePath,
      )
      expect(statSync(filePath).mode & 0o777).toBe(0o600)
      const loaded = loadAuthFile(filePath)
      expect(loaded?.selectedProvider).toBe('anthropic')
      expect(loaded?.providers?.anthropic?.apiKey).toBe('sk-test')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns null for a missing or corrupt file', () => {
    expect(loadAuthFile('/nonexistent/pascal-auth.json')).toBeNull()
  })

  test('removeProviderFromAuthFile drops the entry and clears the selection', () => {
    const dir = tempDir()
    try {
      const filePath = path.join(dir, 'auth.json')
      saveAuthFile(
        {
          selectedProvider: 'openai',
          providers: { openai: { apiKey: 'o' }, google: { apiKey: 'g' } },
        },
        filePath,
      )
      expect(removeProviderFromAuthFile('openai', filePath)).toBe(true)
      const file = loadAuthFile(filePath)
      expect(file?.providers?.openai).toBeUndefined()
      expect(file?.providers?.google?.apiKey).toBe('g')
      expect(file?.selectedProvider).toBeUndefined()
      expect(removeProviderFromAuthFile('openai', filePath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('credential resolution from the env override path', () => {
  test('credentialFor and activeCredential read the file the CLI would write', () => {
    const dir = tempDir()
    try {
      const filePath = path.join(dir, 'auth.json')
      saveAuthFile(
        {
          selectedProvider: 'google',
          providers: {
            anthropic: { apiKey: 'a' },
            google: { oauth: { accessToken: 'g-oat', expiresAt: 9e9 } },
          },
        },
        filePath,
      )
      const env = { PASCAL_AUTH_FILE: filePath } as NodeJS.ProcessEnv
      expect(credentialFor('google', env)?.token).toBe('g-oat')
      expect(credentialFor('anthropic', env)?.token).toBe('a')
      expect(activeCredential(env)).toMatchObject({ provider: 'google', kind: 'oauth' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('env var providers work with no file', () => {
    const env = {
      PASCAL_AUTH_FILE: '/nonexistent/auth.json',
      ANTHROPIC_API_KEY: 'sk-env',
    } as NodeJS.ProcessEnv
    expect(activeCredential(env)).toMatchObject({ provider: 'anthropic', kind: 'env' })
    expect(existsSync(env.PASCAL_AUTH_FILE!)).toBe(false)
  })
})

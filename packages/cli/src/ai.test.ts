import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  aiLogout,
  aiStatus,
  aiUse,
  buildAuthorizeUrl,
  exchangeCode,
  PROVIDERS,
  parsePastedCode,
  runAiLogin,
  startLoopbackListener,
} from './ai.js'
import { CliError } from './errors.js'

describe('parsePastedCode', () => {
  test('accepts code#state, a redirected URL, or a bare code', () => {
    expect(parsePastedCode('abc#state-1', 'state-1')).toBe('abc')
    expect(parsePastedCode('http://localhost:1455/auth/callback?code=c9&state=s9', 's9')).toBe('c9')
    expect(parsePastedCode('  bare-code  ', 'any')).toBe('bare-code')
  })

  test('rejects a state mismatch and an empty paste', () => {
    expect(() => parsePastedCode('abc#wrong', 'state-1')).toThrow(CliError)
    expect(() => parsePastedCode('   ', 'state-1')).toThrow(CliError)
    expect(() => parsePastedCode('http://localhost/cb?code=c&state=other', 's')).toThrow(CliError)
  })
})

describe('buildAuthorizeUrl', () => {
  test('carries PKCE and provider-specific extras', () => {
    const url = new URL(
      buildAuthorizeUrl('openai', 'http://localhost:1455/auth/callback', 'st', 'ch'),
    )
    expect(url.origin + url.pathname).toBe(PROVIDERS.openai.oauth!.authorizeUrl)
    expect(url.searchParams.get('client_id')).toBe(PROVIDERS.openai.oauth!.clientId)
    expect(url.searchParams.get('code_challenge')).toBe('ch')
    expect(url.searchParams.get('originator')).toBe('pascal')
    const google = new URL(
      buildAuthorizeUrl('google', 'http://localhost:8080/oauth2callback', 'st', 'ch'),
    )
    expect(google.searchParams.get('access_type')).toBe('offline')
  })
})

describe('startLoopbackListener', () => {
  test('returns the code for a matching state on the callback path', async () => {
    const listener = startLoopbackListener(0, '/cb', 'expected-state', 10_000)
    const port = await listener.port
    const code = await Promise.all([
      listener.promise,
      fetch(`http://127.0.0.1:${port}/cb?code=the-code&state=expected-state`).then((r) => r.text()),
    ])
    expect(code[0]).toBe('the-code')
    listener.close()
  })

  test('rejects on a state mismatch', async () => {
    const listener = startLoopbackListener(0, '/cb', 'expected-state', 10_000)
    const port = await listener.port
    const errorPromise = listener.promise.catch((e: unknown) => e)
    await fetch(`http://127.0.0.1:${port}/cb?code=x&state=WRONG`)
    const err = await errorPromise
    expect((err as CliError).code).toBe('oauth_state_mismatch')
    listener.close()
  })
})

describe('exchangeCode', () => {
  test('posts a form grant and maps the token response', async () => {
    const requests: Array<{ body: string }> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ body: String(init?.body ?? '') })
      expect(String(url)).toBe(PROVIDERS.anthropic.oauth!.tokenUrl)
      return new Response(
        JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 60 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    try {
      const tokens = await exchangeCode('anthropic', 'code-1', {
        redirectUri: 'https://console.anthropic.com/oauth/code/callback',
        verifier: 'v-1',
      })
      expect(tokens).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1' })
      expect(tokens.expiresAt).toBeGreaterThan(Date.now() / 1000)
      const body = new URLSearchParams(requests[0]!.body)
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('code')).toBe('code-1')
      expect(body.get('code_verifier')).toBe('v-1')
    } finally {
      globalThis.fetch = original
    }
  })

  test('surfaces a token-endpoint failure', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response('denied', { status: 400 })) as typeof fetch
    try {
      const err = await exchangeCode('openai', 'c', {
        redirectUri: 'http://localhost:1455/auth/callback',
        verifier: 'v',
      }).catch((e: unknown) => e)
      expect((err as CliError).code).toBe('oauth_exchange_failed')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('auth file commands', () => {
  test('login --api-key writes the file and selects the provider', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pascal-ai-'))
    try {
      const authFile = path.join(dir, 'auth.json')
      const result = await runAiLogin('openai', {
        paths: { authFile },
        apiKey: 'sk-saved',
      })
      expect(result.kind).toBe('api_key')
      const status = aiStatus({ authFile }, {})
      expect(status.selected).toBe('openai')
      expect(status.providers.find((p) => p.id === 'openai')).toMatchObject({
        configured: true,
        selected: true,
        kind: 'api_key',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('use selects an env-configured provider; logout removes a stored one', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pascal-ai-'))
    try {
      const authFile = path.join(dir, 'auth.json')
      await runAiLogin('google', { paths: { authFile }, apiKey: 'g' })
      aiUse('google', { authFile })
      expect(aiLogout('google', { authFile })).toBe(true)
      expect(aiStatus({ authFile }, {}).selected).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

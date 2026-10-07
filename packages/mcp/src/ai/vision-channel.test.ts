import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { saveAuthFile } from './auth-file'
import { visionComplete } from './vision-channel'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    calls.push({ url: u, init: init ?? {} })
    return handler(u, init ?? {})
  }) as typeof fetch
  return calls
}

function serverStub(sampling: boolean, text = 'sampled answer') {
  return {
    server: {
      getClientCapabilities: () => (sampling ? { sampling: {} } : {}),
      createMessage: async () => ({ content: { type: 'text', text } }),
    },
  }
}

const input = {
  systemPrompt: 'sys',
  prompt: 'look',
  images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }],
  maxTokens: 512,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('visionComplete', () => {
  test('calls the configured provider before sampling', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pascal-auth-'))
    try {
      const filePath = path.join(dir, 'auth.json')
      saveAuthFile({ providers: { anthropic: { apiKey: 'sk-live' } } }, filePath)
      const calls = stubFetch(() =>
        jsonResponse({ content: [{ type: 'text', text: 'provider answer' }] }),
      )
      const env = { PASCAL_AUTH_FILE: filePath } as NodeJS.ProcessEnv
      const result = await visionComplete(serverStub(true), input, env)
      expect(result.text).toBe('provider answer')
      expect(result.via).toBe('anthropic')
      expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages')
      expect((calls[0]?.init.headers as Record<string, string>)['x-api-key']).toBe('sk-live')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refreshes an expired oauth token, uses it, and writes it back', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pascal-auth-'))
    try {
      const filePath = path.join(dir, 'auth.json')
      saveAuthFile(
        {
          providers: {
            google: { oauth: { accessToken: 'stale', refreshToken: 'rt-1', expiresAt: 1 } },
          },
        },
        filePath,
      )
      const calls = stubFetch((url) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return jsonResponse({ access_token: 'fresh-oat', expires_in: 3600 })
        }
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: 'fresh answer' }] } }],
        })
      })
      const env = { PASCAL_AUTH_FILE: filePath } as NodeJS.ProcessEnv
      const result = await visionComplete(serverStub(false), input, env)
      expect(result.text).toBe('fresh answer')
      expect(result.via).toBe('google')
      expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token')
      expect(calls[1]?.url).toBe('https://cloudcode-pa.googleapis.com/v1internal:generateContent')
      const saved = JSON.parse(readFileSync(filePath, 'utf8'))
      expect(saved.providers.google.oauth.accessToken).toBe('fresh-oat')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('falls back to host sampling when no provider is configured', async () => {
    const env = { PASCAL_AUTH_FILE: '/nonexistent/auth.json' } as NodeJS.ProcessEnv
    const result = await visionComplete(serverStub(true, 'sampled'), input, env)
    expect(result).toEqual({ text: 'sampled', via: 'sampling' })
  })

  test('refuses sampling_unavailable with setup guidance when neither exists', async () => {
    const env = { PASCAL_AUTH_FILE: '/nonexistent/auth.json' } as NodeJS.ProcessEnv
    const err = await visionComplete(serverStub(false), input, env).catch((e) => e)
    expect(err).toBeInstanceOf(McpError)
    expect((err as McpError).message).toContain('sampling_unavailable')
    expect((err as McpError).message).toContain('pascal ai login')
  })

  test('provider HTTP failure surfaces as provider_request_failed', async () => {
    const env = {
      PASCAL_AUTH_FILE: '/nonexistent/auth.json',
      OPENAI_API_KEY: 'sk-x',
    } as NodeJS.ProcessEnv
    stubFetch(() => new Response('nope', { status: 429 }))
    const err = await visionComplete(serverStub(true), input, env).catch((e) => e)
    expect((err as McpError).message).toContain('provider_request_failed')
  })
})

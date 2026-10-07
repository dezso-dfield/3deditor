import { describe, expect, test } from 'bun:test'
import type { ResolvedCredential } from './providers'
import { buildVisionRequest, extractVisionText, type VisionInput } from './vision'

const input: VisionInput = {
  systemPrompt: 'Describe the room.',
  prompt: 'What do you see?',
  images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }],
  maxTokens: 1024,
}

const apiKey = (provider: ResolvedCredential['provider']): ResolvedCredential => ({
  provider,
  kind: 'api_key',
  token: 'test-key',
  expired: false,
})

const oauth = (provider: ResolvedCredential['provider']): ResolvedCredential => ({
  provider,
  kind: 'oauth',
  token: 'test-oauth-token',
  oauth: { accessToken: 'test-oauth-token', accountId: 'acct-42' },
  expired: false,
})

describe('buildVisionRequest', () => {
  test('anthropic api key: x-api-key header on /v1/messages', () => {
    const req = buildVisionRequest(apiKey('anthropic'), input)
    expect(req.url).toBe('https://api.anthropic.com/v1/messages')
    expect(req.headers['x-api-key']).toBe('test-key')
    expect(req.headers.authorization).toBeUndefined()
    const body = JSON.parse(req.body)
    expect(body.system).toBe('Describe the room.')
    expect(body.messages[0].content[0]).toMatchObject({ type: 'image' })
  })

  test('anthropic oauth: bearer + inference beta header', () => {
    const req = buildVisionRequest(oauth('anthropic'), input)
    expect(req.headers.authorization).toBe('Bearer test-oauth-token')
    expect(req.headers['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(req.headers['x-api-key']).toBeUndefined()
  })

  test('openai api key: api.openai.com responses endpoint', () => {
    const req = buildVisionRequest(apiKey('openai'), input)
    expect(req.url).toBe('https://api.openai.com/v1/responses')
    expect(req.headers.authorization).toBe('Bearer test-key')
    expect(req.headers['ChatGPT-Account-ID']).toBeUndefined()
  })

  test('openai oauth: ChatGPT subscription backend + account header', () => {
    const req = buildVisionRequest(oauth('openai'), input)
    expect(req.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(req.headers['ChatGPT-Account-ID']).toBe('acct-42')
    expect(req.headers.originator).toBe('pascal')
    const body = JSON.parse(req.body)
    expect(body.instructions).toBe('Describe the room.')
    expect(body.input[0].content[0].type).toBe('input_image')
  })

  test('google api key: key query param on generativelanguage', () => {
    const req = buildVisionRequest(apiKey('google'), input)
    expect(req.url).toContain('generativelanguage.googleapis.com')
    expect(req.url).toContain('key=test-key')
    expect(req.headers.authorization).toBeUndefined()
  })

  test('google oauth: Code Assist endpoint wraps the request body', () => {
    const req = buildVisionRequest(oauth('google'), input)
    expect(req.url).toBe('https://cloudcode-pa.googleapis.com/v1internal:generateContent')
    expect(req.headers.authorization).toBe('Bearer test-oauth-token')
    const body = JSON.parse(req.body)
    expect(body.model).toBeTruthy()
    expect(body.request.contents[0].parts[0].inline_data.data).toBe('aW1hZ2U=')
  })
})

describe('extractVisionText', () => {
  test('anthropic content blocks', () => {
    const text = extractVisionText('anthropic', {
      content: [
        { type: 'text', text: 'a ' },
        { type: 'text', text: 'room' },
      ],
    })
    expect(text).toBe('a room')
  })

  test('openai output_text then output parts', () => {
    expect(extractVisionText('openai', { output_text: 'direct' })).toBe('direct')
    const text = extractVisionText('openai', {
      output: [{ content: [{ type: 'output_text', text: 'nested' }] }],
    })
    expect(text).toBe('nested')
  })

  test('google candidates', () => {
    const text = extractVisionText('google', {
      candidates: [{ content: { parts: [{ text: 'gemini says' }] } }],
    })
    expect(text).toBe('gemini says')
  })

  test('unparseable bodies throw vision_unparseable', () => {
    for (const provider of ['anthropic', 'openai', 'google'] as const) {
      expect(() => extractVisionText(provider, {})).toThrow('vision_unparseable')
    }
  })
})

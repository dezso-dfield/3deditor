import { describe, expect, test } from 'bun:test'
import {
  AI_PROVIDERS,
  buildAuthorizeRequest,
  codeExchangeBody,
  decodeJwtPayload,
  openAiAccountId,
  type PascalAuthFile,
  parseTokenResponse,
  pkceChallenge,
  redirectUriFor,
  refreshBody,
  resolveActiveCredential,
  resolveProviderCredential,
} from './providers'

describe('resolveProviderCredential', () => {
  const file: PascalAuthFile = {
    providers: {
      anthropic: { apiKey: 'sk-ant-file' },
      openai: { oauth: { accessToken: 'oat', refreshToken: 'ort', expiresAt: 9e9 } },
    },
  }

  test('prefers the stored API key over oauth and env', () => {
    const cred = resolveProviderCredential(file, 'anthropic', {
      ANTHROPIC_API_KEY: 'sk-ant-env',
    })
    expect(cred).toMatchObject({ provider: 'anthropic', kind: 'api_key', token: 'sk-ant-file' })
  })

  test('uses the stored oauth token and marks expiry', () => {
    const fresh = resolveProviderCredential(file, 'openai', {})
    expect(fresh).toMatchObject({ kind: 'oauth', token: 'oat', expired: false })
    const stale = resolveProviderCredential(
      { providers: { openai: { oauth: { accessToken: 'old', expiresAt: 1 } } } },
      'openai',
      {},
    )
    expect(stale?.expired).toBe(true)
  })

  test('falls back to the environment as an env credential', () => {
    const cred = resolveProviderCredential(null, 'google', { GEMINI_API_KEY: 'gkey' })
    expect(cred).toMatchObject({ provider: 'google', kind: 'env', token: 'gkey' })
    const alt = resolveProviderCredential(null, 'google', { GOOGLE_API_KEY: 'galt' })
    expect(alt?.token).toBe('galt')
  })

  test('returns null when nothing is configured', () => {
    expect(resolveProviderCredential(null, 'anthropic', {})).toBeNull()
  })
})

describe('resolveActiveCredential', () => {
  test('honors the selected provider', () => {
    const file: PascalAuthFile = {
      selectedProvider: 'openai',
      providers: {
        anthropic: { apiKey: 'a' },
        openai: { apiKey: 'o' },
      },
    }
    expect(resolveActiveCredential(file, {})?.provider).toBe('openai')
  })

  test('uses the first configured provider when none is selected', () => {
    const file: PascalAuthFile = {
      providers: { google: { apiKey: 'g' } },
    }
    expect(resolveActiveCredential(file, {})?.provider).toBe('google')
  })

  test('falls through to an env provider last', () => {
    const cred = resolveActiveCredential(null, { OPENAI_API_KEY: 'okey' })
    expect(cred).toMatchObject({ provider: 'openai', kind: 'env' })
  })
})

describe('OAuth request builders', () => {
  // RFC 7636 appendix B test vector.
  test('pkceChallenge computes the S256 challenge', async () => {
    const challenge = await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  test('buildAuthorizeRequest carries PKCE, state and provider extras', async () => {
    const req = await buildAuthorizeRequest('openai', 'http://localhost:1455/auth/callback')
    const url = new URL(req.url)
    expect(url.origin + url.pathname).toBe(AI_PROVIDERS.openai.oauth!.authorizeUrl)
    expect(url.searchParams.get('client_id')).toBe(AI_PROVIDERS.openai.oauth!.clientId)
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    expect(url.searchParams.get('code_challenge')).toBe(await pkceChallenge(req.verifier))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(req.state)
    expect(url.searchParams.get('originator')).toBe('pascal')
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true')
  })

  test('google requests an offline refresh token with consent', async () => {
    const req = await buildAuthorizeRequest('google', 'http://localhost:9999/oauth2callback')
    const url = new URL(req.url)
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('scope')).toContain('cloud-platform')
  })

  test('anthropic uses the hosted console callback', () => {
    expect(redirectUriFor('anthropic')).toBe('https://console.anthropic.com/oauth/code/callback')
    expect(redirectUriFor('openai')).toBe('http://localhost:1455/auth/callback')
    expect(redirectUriFor('google', 4321)).toBe('http://localhost:4321/oauth2callback')
  })

  test('codeExchangeBody is a form-encoded authorization_code grant', () => {
    const body = codeExchangeBody('google', 'the-code', {
      redirectUri: 'http://localhost:4321/oauth2callback',
      verifier: 'the-verifier',
    })
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('code_verifier')).toBe('the-verifier')
    expect(body.get('client_secret')).toBe(AI_PROVIDERS.google.oauth!.clientSecret)
    const openaiBody = codeExchangeBody('openai', 'c', {
      redirectUri: 'http://localhost:1455/auth/callback',
      verifier: 'v',
    })
    expect(openaiBody.get('client_secret')).toBeNull()
  })

  test('refreshBody uses the refresh_token grant', () => {
    const body = refreshBody('anthropic', 'refresh-123')
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('refresh-123')
  })
})

describe('token responses', () => {
  test('parseTokenResponse maps the wire shape and keeps the old refresh token', () => {
    const tokens = parseTokenResponse(
      { access_token: 'new-access', expires_in: 3600 },
      { accessToken: 'old', refreshToken: 'keep-me', expiresAt: 5 },
    )
    expect(tokens.accessToken).toBe('new-access')
    expect(tokens.refreshToken).toBe('keep-me')
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() / 1000)
  })

  test('parseTokenResponse rejects a body without an access token', () => {
    expect(() => parseTokenResponse({ token_type: 'bearer' })).toThrow('access_token')
  })

  test('openAiAccountId reads the nested auth claim', () => {
    const payload = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } }),
    ).toString('base64url')
    const jwt = `hdr.${payload}.sig`
    expect(openAiAccountId(jwt)).toBe('acct-1')
    expect(decodeJwtPayload('not-a-jwt')).toBeNull()
    expect(openAiAccountId('hdr.e30.sig')).toBeUndefined()
  })
})

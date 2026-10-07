/**
 * AI provider registry — the providers a Pascal user can point the vision and
 * generation tools at, either with a plain API key or by signing in with their
 * AI subscription (OAuth/PKCE, same public-client flows the vendors' own CLIs
 * use). Pure data and pure request builders; no fs, no network — callers
 * (`@pascal-app/mcp`, `@pascal-app/cli`) supply fetch and storage.
 */

export const AI_PROVIDER_IDS = ['anthropic', 'openai', 'google'] as const
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number]

export interface OAuthSpec {
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  /** Public installed-app secret when the provider requires one (Google). */
  clientSecret?: string
  scopes: string[]
  /**
   * 'loopback': redirect is http://localhost:<fixedPort><loopbackPath> — the
   * CLI listens on that port, with paste-the-redirected-URL as fallback.
   * 'hosted': redirect is a vendor page that displays the code — the user pastes
   * the code (Anthropic's console callback prints `code#state`).
   */
  redirect: { kind: 'loopback'; fixedPort: number; path: string } | { kind: 'hosted'; uri: string }
}

export interface AiProviderSpec {
  id: AiProviderId
  displayName: string
  /** A human-facing description of what each sign-in route unlocks. */
  apiKeyHelp: string
  oauthHelp: string
  /** Environment variables read as API-key fallbacks (read-only). */
  envVars: string[]
  /** Default vision-capable model for this provider. */
  visionModel: string
  oauth: OAuthSpec | null
}

/**
 * OAuth parameters mirror the vendors' own public CLI clients — that is what
 * makes a subscription sign-in work: Anthropic = Claude Code, OpenAI = Codex
 * CLI, Google = Gemini CLI / Code Assist (Antigravity-tier projects ride on the
 * same cloudcode-pa surface).
 */
export const AI_PROVIDERS: Record<AiProviderId, AiProviderSpec> = {
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic (Claude)',
    apiKeyHelp: 'API key from console.anthropic.com (ANTHROPIC_API_KEY)',
    oauthHelp: 'Sign in with a Claude Pro/Max subscription via the Claude Code PKCE flow',
    envVars: ['ANTHROPIC_API_KEY'],
    visionModel: 'claude-haiku-4-5',
    oauth: {
      authorizeUrl: 'https://claude.ai/oauth/authorize',
      tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
      clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      scopes: ['user:profile', 'user:inference'],
      // Console prints the code on this page — the universal paste-code path.
      redirect: { kind: 'hosted', uri: 'https://console.anthropic.com/oauth/code/callback' },
    },
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI (ChatGPT)',
    apiKeyHelp: 'API key from platform.openai.com (OPENAI_API_KEY)',
    oauthHelp: 'Sign in with a ChatGPT subscription via the Codex CLI PKCE flow',
    envVars: ['OPENAI_API_KEY'],
    visionModel: 'gpt-5-mini',
    oauth: {
      authorizeUrl: 'https://auth.openai.com/oauth/authorize',
      tokenUrl: 'https://auth.openai.com/oauth/token',
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      // The Codex public client registers exactly this loopback callback.
      redirect: { kind: 'loopback', fixedPort: 1455, path: '/auth/callback' },
    },
  },
  google: {
    id: 'google',
    displayName: 'Google (Gemini / Antigravity)',
    apiKeyHelp: 'API key from aistudio.google.com (GEMINI_API_KEY)',
    oauthHelp: 'Sign in with a Google account for Code Assist — the subscription Antigravity uses',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    visionModel: 'gemini-2.5-flash',
    oauth: {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
      // Public installed-app secret shipped in gemini-cli; Google requires it
      // on the code exchange even alongside PKCE.
      clientSecret: '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',
      scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
      // Google installed-app clients accept any loopback port.
      redirect: { kind: 'loopback', fixedPort: 0, path: '/oauth2callback' },
    },
  },
}

// ---------- stored credentials ----------

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  /** Epoch seconds; absent means "does not expire / unknown". */
  expiresAt?: number
  /** Provider account id when the flow exposes one (OpenAI chatgpt_account_id). */
  accountId?: string
}

export interface ProviderAuth {
  apiKey?: string
  oauth?: OAuthTokens
}

export interface PascalAuthFile {
  selectedProvider?: AiProviderId
  providers?: Partial<Record<AiProviderId, ProviderAuth>>
}

export interface ResolvedCredential {
  provider: AiProviderId
  kind: 'api_key' | 'oauth' | 'env'
  token: string
  oauth?: OAuthTokens
  /** True when the token is past its stored expiry and should be refreshed. */
  expired: boolean
}

function authEntry(file: PascalAuthFile | null, provider: AiProviderId): ProviderAuth | undefined {
  return file?.providers?.[provider]
}

/**
 * Resolve the credential for one provider: stored api_key → stored oauth → env
 * var (env reads as 'env' kind so callers don't confuse it with a login).
 */
export function resolveProviderCredential(
  file: PascalAuthFile | null,
  provider: AiProviderId,
  env: Record<string, string | undefined>,
): ResolvedCredential | null {
  const entry = authEntry(file, provider)
  if (entry?.apiKey) {
    return { provider, kind: 'api_key', token: entry.apiKey, expired: false }
  }
  if (entry?.oauth?.accessToken) {
    return {
      provider,
      kind: 'oauth',
      token: entry.oauth.accessToken,
      oauth: entry.oauth,
      expired: entry.oauth.expiresAt !== undefined && entry.oauth.expiresAt <= Date.now() / 1000,
    }
  }
  for (const name of AI_PROVIDERS[provider].envVars) {
    const value = env[name]
    if (value) return { provider, kind: 'env', token: value, expired: false }
  }
  return null
}

/**
 * The provider the vision/generation tools use: the selected one when it has
 * a credential, else the first configured provider, else an env-var provider,
 * else null (caller falls back to host sampling).
 */
export function resolveActiveCredential(
  file: PascalAuthFile | null,
  env: Record<string, string | undefined>,
): ResolvedCredential | null {
  const selected = file?.selectedProvider
  if (selected) {
    const cred = resolveProviderCredential(file, selected, env)
    if (cred) return cred
  }
  for (const provider of AI_PROVIDER_IDS) {
    const entry = authEntry(file, provider)
    if (entry?.apiKey || entry?.oauth?.accessToken) {
      return resolveProviderCredential(file, provider, env)
    }
  }
  for (const provider of AI_PROVIDER_IDS) {
    const cred = resolveProviderCredential(file, provider, env)
    if (cred?.kind === 'env') return cred
  }
  return null
}

// ---------- PKCE (WebCrypto — works in Node, Bun and the browser) ----------

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of u8) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomUrlSafe(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(digest)
}

export interface OAuthRequest {
  url: string
  redirectUri: string
  state: string
  verifier: string
}

/** Build the authorize URL (and verifier/state) for a provider's OAuth flow. */
export async function buildAuthorizeRequest(
  provider: AiProviderId,
  redirectUri: string,
): Promise<OAuthRequest> {
  const spec = AI_PROVIDERS[provider]
  const oauth = spec.oauth
  if (!oauth) throw new Error(`provider ${provider} has no OAuth flow`)
  const verifier = randomUrlSafe()
  const state = randomUrlSafe()
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: oauth.clientId,
    redirect_uri: redirectUri,
    scope: oauth.scopes.join(' '),
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
  })
  if (provider === 'openai') {
    // Codex CLI flags the flow as its own to get the right consent copy.
    params.set('id_token_add_organizations', 'true')
    params.set('codex_cli_simplified_flow', 'true')
    params.set('originator', 'pascal')
  }
  if (provider === 'google') {
    params.set('access_type', 'offline')
    params.set('prompt', 'consent')
  }
  return { url: `${oauth.authorizeUrl}?${params.toString()}`, redirectUri, state, verifier }
}

/** The redirect URI a provider uses for a login attempt. */
export function redirectUriFor(provider: AiProviderId, loopbackPort?: number): string {
  const redirect = AI_PROVIDERS[provider].oauth?.redirect
  if (!redirect) throw new Error(`provider ${provider} has no OAuth flow`)
  if (redirect.kind === 'hosted') return redirect.uri
  return `http://localhost:${loopbackPort ?? redirect.fixedPort}${redirect.path}`
}

/** Form-encoded token exchange body (authorization_code grant). */
export function codeExchangeBody(
  provider: AiProviderId,
  code: string,
  request: Pick<OAuthRequest, 'redirectUri' | 'verifier'>,
): URLSearchParams {
  const oauth = AI_PROVIDERS[provider].oauth
  if (!oauth) throw new Error(`provider ${provider} has no OAuth flow`)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: oauth.clientId,
    code,
    redirect_uri: request.redirectUri,
    code_verifier: request.verifier,
  })
  if (oauth.clientSecret) body.set('client_secret', oauth.clientSecret)
  return body
}

/** Form-encoded token exchange body (refresh_token grant). */
export function refreshBody(provider: AiProviderId, refreshToken: string): URLSearchParams {
  const oauth = AI_PROVIDERS[provider].oauth
  if (!oauth) throw new Error(`provider ${provider} has no OAuth flow`)
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: oauth.clientId,
    refresh_token: refreshToken,
  })
  if (oauth.clientSecret) body.set('client_secret', oauth.clientSecret)
  return body
}

/** Parse a token-endpoint JSON response into stored tokens. */
export function parseTokenResponse(
  json: Record<string, unknown>,
  existing?: OAuthTokens,
): OAuthTokens {
  const accessToken = json.access_token
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('token response missing access_token')
  }
  const tokens: OAuthTokens = { accessToken }
  const refresh = json.refresh_token ?? existing?.refreshToken
  if (typeof refresh === 'string' && refresh) tokens.refreshToken = refresh
  const expiresIn = json.expires_in
  if (typeof expiresIn === 'number' && expiresIn > 0) {
    tokens.expiresAt = Math.floor(Date.now() / 1000) + expiresIn
  } else if (existing?.expiresAt) {
    tokens.expiresAt = existing.expiresAt
  }
  return tokens
}

/** Decode a JWT payload (id_token) without verifying — claim extraction only. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const base64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    return JSON.parse(atob(padded)) as Record<string, unknown>
  } catch {
    return null
  }
}

/** chatgpt_account_id lives nested in the OpenAI id_token's auth claim. */
export function openAiAccountId(idToken: string): string | undefined {
  const payload = decodeJwtPayload(idToken)
  const authClaim = payload?.['https://api.openai.com/auth']
  if (authClaim && typeof authClaim === 'object') {
    const id = (authClaim as Record<string, unknown>).chatgpt_account_id
    if (typeof id === 'string' && id) return id
  }
  const flat = payload?.chatgpt_account_id
  return typeof flat === 'string' && flat ? flat : undefined
}

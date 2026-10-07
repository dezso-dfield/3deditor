import { createServer, type Server } from 'node:http'
import { createInterface } from 'node:readline'
import { loadAuthFile, type PascalAuthFile, saveAuthFile } from './auth-file.js'
import { openBrowser } from './browser.js'
import { CliError } from './errors.js'

/**
 * `pascal ai` — connect an AI provider so Pascal's vision/generation tools run
 * on the user's own account. Two routes per provider: an API key, or signing in
 * with the AI subscription via the vendor's public PKCE flow (the same client
 * registrations their own CLIs use). Writes ~/.pascal/auth.json with mode
 * 0600; the MCP service reads it. Provider constants mirror
 * `packages/core/src/ai/providers.ts`; keep the two in sync.
 */

export type ProviderId = 'anthropic' | 'openai' | 'google'

export const PROVIDERS: Record<
  ProviderId,
  {
    displayName: string
    envVars: string[]
    oauth: {
      authorizeUrl: string
      tokenUrl: string
      clientId: string
      clientSecret?: string
      scopes: string[]
      redirect:
        | { kind: 'loopback'; fixedPort: number; path: string }
        | { kind: 'hosted'; uri: string }
    } | null
  }
> = {
  anthropic: {
    displayName: 'Anthropic (Claude)',
    envVars: ['ANTHROPIC_API_KEY'],
    oauth: {
      authorizeUrl: 'https://claude.ai/oauth/authorize',
      tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
      clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      scopes: ['user:profile', 'user:inference'],
      redirect: { kind: 'hosted', uri: 'https://console.anthropic.com/oauth/code/callback' },
    },
  },
  openai: {
    displayName: 'OpenAI (ChatGPT)',
    envVars: ['OPENAI_API_KEY'],
    oauth: {
      authorizeUrl: 'https://auth.openai.com/oauth/authorize',
      tokenUrl: 'https://auth.openai.com/oauth/token',
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      redirect: { kind: 'loopback', fixedPort: 1455, path: '/auth/callback' },
    },
  },
  google: {
    displayName: 'Google (Gemini / Antigravity)',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    oauth: {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
      clientSecret: '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',
      scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
      redirect: { kind: 'loopback', fixedPort: 0, path: '/oauth2callback' },
    },
  },
}

export const AI_PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[]

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  accountId?: string
}

export interface ProviderAuth {
  apiKey?: string
  oauth?: OAuthTokens
}

// ---------- PKCE ----------

function randomUrlSafe(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return Buffer.from(digest).toString('base64url')
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function openAiAccountId(idToken: string): string | undefined {
  const payload = decodeJwtPayload(idToken)
  const authClaim = payload?.['https://api.openai.com/auth']
  if (authClaim && typeof authClaim === 'object') {
    const id = (authClaim as Record<string, unknown>).chatgpt_account_id
    if (typeof id === 'string' && id) return id
  }
  const flat = payload?.chatgpt_account_id
  return typeof flat === 'string' && flat ? flat : undefined
}

// ---------- OAuth flow ----------

export interface OAuthRequest {
  url: string
  redirectUri: string
  state: string
  verifier: string
}

export function buildAuthorizeUrl(
  provider: ProviderId,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const oauth = PROVIDERS[provider].oauth!
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: oauth.clientId,
    redirect_uri: redirectUri,
    scope: oauth.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  if (provider === 'openai') {
    params.set('id_token_add_organizations', 'true')
    params.set('codex_cli_simplified_flow', 'true')
    params.set('originator', 'pascal')
  }
  if (provider === 'google') {
    params.set('access_type', 'offline')
    params.set('prompt', 'consent')
  }
  return `${oauth.authorizeUrl}?${params.toString()}`
}

function redirectUriFor(provider: ProviderId, loopbackPort?: number): string {
  const oauth = PROVIDERS[provider].oauth!
  return oauth.redirect.kind === 'hosted'
    ? oauth.redirect.uri
    : `http://localhost:${loopbackPort ?? oauth.redirect.fixedPort}${oauth.redirect.path}`
}

/** Bind a loopback listener; the port a provider forces (OpenAI) or any free one. */
export function startLoopbackListener(
  requestedPort: number,
  path: string,
  expectedState: string,
  timeoutMs = 5 * 60 * 1000,
): { promise: Promise<string>; port: Promise<number>; close: () => void } {
  let server: Server | null = null
  let timer: NodeJS.Timeout | null = null
  let portResolve: (port: number) => void = () => {}
  const port = new Promise<number>((res) => {
    portResolve = res
  })
  const promise = new Promise<string>((resolvePromise, rejectPromise) => {
    server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== path) {
          res.writeHead(404).end()
          return
        }
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const error = url.searchParams.get('error')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          '<html><body style="font-family:sans-serif;text-align:center;padding-top:3em">' +
            '<h2>Pascal sign-in complete</h2><p>You can close this tab and return to the terminal.</p>' +
            '</body></html>',
        )
        if (error) {
          rejectPromise(new CliError('oauth_denied', `Sign-in failed: ${error}`))
        } else if (state !== expectedState) {
          rejectPromise(new CliError('oauth_state_mismatch', 'State mismatch — try again.'))
        } else if (!code) {
          rejectPromise(new CliError('oauth_no_code', 'No authorization code received.'))
        } else {
          resolvePromise(code)
        }
      } catch (error) {
        rejectPromise(error)
      } finally {
        server?.close()
        server = null
      }
    })
    server.on('error', (error) => rejectPromise(error))
    // All interfaces: browsers resolve localhost to 127.0.0.1 or ::1
    // unpredictably; the callback is a one-shot, state-checked path.
    server.listen(requestedPort || 0, () => {
      const address = server?.address()
      portResolve(typeof address === 'object' && address ? address.port : requestedPort)
    })
    timer = setTimeout(() => {
      server?.close()
      server = null
      rejectPromise(new CliError('oauth_timeout', 'Timed out waiting for the sign-in to finish.'))
    }, timeoutMs)
    timer.unref?.()
  })
  return {
    promise,
    port,
    close: () => {
      if (timer) clearTimeout(timer)
      server?.close()
      server = null
    },
  }
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await new Promise<string>((resolvePromise) =>
      rl.question(`${question} `, (answer) => resolvePromise(answer.trim())),
    )
  } finally {
    rl.close()
  }
}

export function parsePastedCode(input: string, expectedState: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new CliError('oauth_no_code', 'No code pasted.', undefined, 2)
  }
  // Anthropic prints `code#state` on the console callback page.
  const hash = trimmed.split('#')
  if (hash.length === 2) {
    const [code, state] = hash as [string, string]
    if (state !== expectedState) {
      throw new CliError('oauth_state_mismatch', 'State mismatch — restart the login.')
    }
    return code
  }
  // A pasted redirect URL is fine too.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (code && state) {
        if (state !== expectedState) {
          throw new CliError('oauth_state_mismatch', 'State mismatch — restart the login.')
        }
        return code
      }
      if (code) return code
    } catch (error) {
      if (error instanceof CliError) throw error
      /* fall through */
    }
  }
  return trimmed
}

export async function exchangeCode(
  provider: ProviderId,
  code: string,
  request: Pick<OAuthRequest, 'redirectUri' | 'verifier'>,
): Promise<OAuthTokens> {
  const oauth = PROVIDERS[provider].oauth!
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: oauth.clientId,
    code,
    redirect_uri: request.redirectUri,
    code_verifier: request.verifier,
  })
  if (oauth.clientSecret) body.set('client_secret', oauth.clientSecret)
  const res = await fetch(oauth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    throw new CliError(
      'oauth_exchange_failed',
      `Token exchange failed (HTTP ${res.status}). Try the login again.`,
    )
  }
  const json = (await res.json()) as Record<string, unknown>
  const accessToken = json.access_token
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new CliError('oauth_exchange_failed', 'The provider returned no access token.')
  }
  const tokens: OAuthTokens = { accessToken }
  if (typeof json.refresh_token === 'string' && json.refresh_token) {
    tokens.refreshToken = json.refresh_token
  }
  if (typeof json.expires_in === 'number' && json.expires_in > 0) {
    tokens.expiresAt = Math.floor(Date.now() / 1000) + json.expires_in
  }
  if (provider === 'openai' && typeof json.id_token === 'string') {
    const accountId = openAiAccountId(json.id_token)
    if (accountId) tokens.accountId = accountId
  }
  return tokens
}

// ---------- command ----------

function requireProviderId(value: string | undefined): ProviderId {
  if (!value || !AI_PROVIDER_IDS.includes(value as ProviderId)) {
    throw new CliError(
      'invalid_provider',
      `Provider must be one of: ${AI_PROVIDER_IDS.join(', ')}.`,
      { value },
      2,
    )
  }
  return value as ProviderId
}

export interface AiRunOptions {
  paths: { authFile: string }
  open?: (url: string) => void
  env?: NodeJS.ProcessEnv
}

export async function runAiLogin(
  provider: ProviderId,
  opts: AiRunOptions & { apiKey?: string; noOpen?: boolean },
): Promise<{ provider: ProviderId; kind: 'api_key' | 'oauth' }> {
  const file = loadAuthFile(opts.paths.authFile) ?? {}
  file.providers = file.providers ?? {}
  if (opts.apiKey !== undefined) {
    const key = opts.apiKey.trim()
    if (!key) {
      throw new CliError('invalid_option', '--api-key must not be empty.', undefined, 2)
    }
    file.providers[provider] = { ...file.providers[provider], apiKey: key }
    file.selectedProvider = provider
    saveAuthFile(file, opts.paths.authFile)
    return { provider, kind: 'api_key' }
  }

  const oauth = PROVIDERS[provider].oauth
  if (!oauth) {
    throw new CliError('no_oauth', `${provider} has no subscription sign-in — use --api-key.`)
  }
  const verifier = randomUrlSafe()
  const state = randomUrlSafe()
  const challenge = await pkceChallenge(verifier)

  let code: string
  if (oauth.redirect.kind === 'loopback') {
    // Bind the listener before building the URL: Google's port is dynamic.
    const listener = startLoopbackListener(oauth.redirect.fixedPort, oauth.redirect.path, state)
    const port = await listener.port
    const redirectUri = `http://localhost:${port}${oauth.redirect.path}`
    const url = buildAuthorizeUrl(provider, redirectUri, state, challenge)
    const open = opts.open ?? openBrowser
    try {
      open(url)
    } catch {
      /* headless — the user opens it manually */
    }
    if (!opts.noOpen) {
      process.stderr.write(
        `\n  ${PROVIDERS[provider].displayName} sign-in opened in your browser.\n`,
      )
    }
    process.stderr.write(`  ${url}\n`)
    process.stderr.write(
      '  If the browser cannot reach this machine, paste the URL it lands on instead.\n',
    )
    code = await Promise.race([
      listener.promise,
      (async () => {
        const pasted = (
          await prompt('  Or paste the URL the browser lands on (empty = keep waiting):')
        ).trim()
        if (!pasted) return listener.promise
        return parsePastedCode(pasted, state)
      })(),
    ])
    listener.close()
    const tokens = await exchangeCode(provider, code, { redirectUri, verifier })
    file.providers[provider] = { ...file.providers[provider], oauth: tokens }
  } else {
    const redirectUri = oauth.redirect.uri
    const url = buildAuthorizeUrl(provider, redirectUri, state, challenge)
    const open = opts.open ?? openBrowser
    try {
      open(url)
    } catch {
      /* headless — paste-path below */
    }
    process.stderr.write(`\n  ${PROVIDERS[provider].displayName} sign-in:\n  ${url}\n`)
    process.stderr.write(
      '  Approve the sign-in, then paste the code the page shows (format: code#state).\n',
    )
    code = parsePastedCode(await prompt('  Code:'), state)
    const tokens = await exchangeCode(provider, code, { redirectUri, verifier })
    file.providers[provider] = { ...file.providers[provider], oauth: tokens }
  }
  file.selectedProvider = provider
  saveAuthFile(file, opts.paths.authFile)
  return { provider, kind: 'oauth' }
}

export function aiStatus(
  paths: { authFile: string },
  env: NodeJS.ProcessEnv = process.env,
): {
  selected: string | null
  providers: Array<{
    id: string
    displayName: string
    configured: boolean
    selected: boolean
    kind: 'api_key' | 'oauth' | 'env' | null
    expired: boolean
  }>
} {
  const file = loadAuthFile(paths.authFile)
  return {
    selected: file?.selectedProvider ?? null,
    providers: AI_PROVIDER_IDS.map((id) => {
      const entry = file?.providers?.[id]
      const envVar = PROVIDERS[id].envVars.find((name) => env[name])
      let kind: 'api_key' | 'oauth' | 'env' | null = null
      let expired = false
      if (entry?.apiKey) kind = 'api_key'
      else if (entry?.oauth?.accessToken) {
        kind = 'oauth'
        expired = entry.oauth.expiresAt !== undefined && entry.oauth.expiresAt <= Date.now() / 1000
      } else if (envVar) kind = 'env'
      return {
        id,
        displayName: PROVIDERS[id].displayName,
        configured: kind !== null,
        selected: file?.selectedProvider === id,
        kind,
        expired,
      }
    }),
  }
}

export function aiLogout(provider: ProviderId, paths: { authFile: string }): boolean {
  const file = loadAuthFile(paths.authFile)
  if (!file?.providers?.[provider]) return false
  delete file.providers[provider]
  if (file.selectedProvider === provider) delete file.selectedProvider
  saveAuthFile(file, paths.authFile)
  return true
}

export function aiUse(provider: ProviderId, paths: { authFile: string }): PascalAuthFile {
  const file = loadAuthFile(paths.authFile) ?? {}
  file.providers = file.providers ?? {}
  const envVar = PROVIDERS[provider].envVars.find((name) => process.env[name])
  if (!file.providers[provider] && !envVar) {
    throw new CliError(
      'provider_not_configured',
      `${provider} is not connected — run "pascal ai login ${provider}" first.`,
    )
  }
  file.selectedProvider = provider
  saveAuthFile(file, paths.authFile)
  return file
}

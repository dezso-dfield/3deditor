import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import {
  AI_PROVIDERS,
  buildVisionRequest,
  extractVisionText,
  parseTokenResponse,
  type ResolvedCredential,
  refreshBody,
  type VisionImage,
} from '@pascal-app/core/ai'
import { activeCredential, loadAuthFile, resolveAuthFilePath, saveAuthFile } from './auth-file'

/**
 * How the vision tools reach a model: the user's configured provider first
 * (`pascal ai login` / `--api-key` / env var), then MCP host sampling, else a
 * refusal pointing at the setup commands. Tokens never leave this process; the
 * auth file is updated on refresh.
 */

export interface VisionCall {
  systemPrompt: string
  prompt: string
  images: VisionImage[]
  maxTokens: number
  temperature?: number
}

interface SamplingServer {
  server: {
    getClientCapabilities(): { sampling?: unknown } | undefined
    createMessage(args: {
      systemPrompt: string
      temperature?: number
      maxTokens: number
      messages: Array<{
        role: 'user'
        content: Array<
          { type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }
        >
      }>
    }): Promise<{ content: unknown }>
  }
}

const SETUP_HINT =
  'no vision model: run `pascal ai login <anthropic|openai|google>` or set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY, or use an MCP host with sampling'

async function refreshOAuthToken(
  cred: ResolvedCredential,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedCredential> {
  const refreshToken = cred.oauth?.refreshToken
  if (!refreshToken) return cred
  const spec = AI_PROVIDERS[cred.provider]
  const res = await fetch(spec.oauth!.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: refreshBody(cred.provider, refreshToken),
  })
  if (!res.ok) return cred
  const tokens = parseTokenResponse((await res.json()) as Record<string, unknown>, cred.oauth)
  const filePath = resolveAuthFilePath(env)
  const file = loadAuthFile(filePath) ?? {}
  const entry = file.providers?.[cred.provider]
  if (entry) {
    entry.oauth = { ...entry.oauth, ...tokens }
    saveAuthFile(file, filePath)
  }
  return { ...cred, token: tokens.accessToken, oauth: tokens, expired: false }
}

/** Call the configured provider's vision API; the request builders live in core. */
export async function providerVisionText(
  cred: ResolvedCredential,
  input: VisionCall,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  let token = cred
  if (cred.expired) token = await refreshOAuthToken(cred, env)
  const request = buildVisionRequest(token, input)
  const res = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  })
  if (!res.ok) {
    throw new McpError(ErrorCode.InternalError, 'provider_request_failed', {
      provider: cred.provider,
      status: res.status,
    })
  }
  try {
    return extractVisionText(cred.provider, await res.json())
  } catch {
    throw new McpError(ErrorCode.InternalError, 'provider_response_unparseable', {
      provider: cred.provider,
    })
  }
}

function samplingAvailable(server: SamplingServer): boolean {
  return Boolean(server.server.getClientCapabilities()?.sampling)
}

/**
 * One call for every vision tool: returns the model's text answer. Order —
 * configured provider, host sampling, refusal with setup guidance.
 */
export async function visionComplete(
  server: SamplingServer,
  input: VisionCall,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ text: string; via: string }> {
  const cred = activeCredential(env)
  if (cred) {
    return { text: await providerVisionText(cred, input, env), via: cred.provider }
  }
  if (!samplingAvailable(server)) {
    throw new McpError(ErrorCode.InvalidRequest, `sampling_unavailable — ${SETUP_HINT}`, {
      hint: SETUP_HINT,
    })
  }
  const response = await server.server.createMessage({
    systemPrompt: input.systemPrompt,
    temperature: input.temperature ?? 0,
    maxTokens: input.maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          ...input.images.map((image) => ({
            type: 'image' as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
          { type: 'text' as const, text: input.prompt },
        ],
      },
    ],
  })
  const { extractText } = await import('../tools/vision/sampling')
  return {
    text: extractText(response.content as Parameters<typeof extractText>[0]),
    via: 'sampling',
  }
}

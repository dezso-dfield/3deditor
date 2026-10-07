import { AI_PROVIDERS, type AiProviderId, type ResolvedCredential } from './providers'

/**
 * Provider-agnostic vision call: turns Pascal's image blocks + a system prompt
 * into a concrete HTTP request per provider, and the provider's JSON back into
 * the plain text the vision tools parse. Pure request building — the caller
 * (MCP service) owns fetch, timeouts and auth refresh.
 */

export interface VisionImage {
  /** Base64 image bytes. */
  data: string
  mimeType: string
}

export interface VisionInput {
  systemPrompt: string
  prompt: string
  images: VisionImage[]
  maxTokens: number
  temperature?: number
}

export interface VisionRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
}

/** OpenAI OAuth tokens only work against the ChatGPT subscription backend. */
const OPENAI_CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses'
const OPENAI_API_URL = 'https://api.openai.com/v1/responses'

export function buildVisionRequest(cred: ResolvedCredential, input: VisionInput): VisionRequest {
  const spec = AI_PROVIDERS[cred.provider]
  const model = spec.visionModel
  switch (cred.provider) {
    case 'anthropic': {
      // OAuth tokens need the inference beta flag; API keys do not.
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      }
      if (cred.kind === 'oauth') {
        headers.authorization = `Bearer ${cred.token}`
        headers['anthropic-beta'] = 'oauth-2025-04-20'
      } else {
        headers['x-api-key'] = cred.token
      }
      return {
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          max_tokens: input.maxTokens,
          temperature: input.temperature ?? 0,
          system: input.systemPrompt,
          messages: [
            {
              role: 'user',
              content: [
                ...input.images.map((image) => ({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: image.mimeType,
                    data: image.data,
                  },
                })),
                { type: 'text', text: input.prompt },
              ],
            },
          ],
        }),
      }
    }
    case 'openai': {
      const isSubscription = cred.kind === 'oauth'
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${cred.token}`,
        'OpenAI-Beta': 'responses=v1',
      }
      if (isSubscription) {
        if (cred.oauth?.accountId) headers['ChatGPT-Account-ID'] = cred.oauth.accountId
        headers.originator = 'pascal'
      }
      return {
        url: isSubscription ? OPENAI_CODEX_URL : OPENAI_API_URL,
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          instructions: input.systemPrompt,
          temperature: input.temperature ?? 0,
          max_output_tokens: input.maxTokens,
          input: [
            {
              role: 'user',
              content: [
                ...input.images.map((image) => ({
                  type: 'input_image',
                  image_url: `data:${image.mimeType};base64,${image.data}`,
                })),
                { type: 'input_text', text: input.prompt },
              ],
            },
          ],
        }),
      }
    }
    case 'google': {
      const base =
        cred.kind === 'oauth'
          ? // Code Assist: the endpoint Antigravity/Gemini CLI ride on.
            'https://cloudcode-pa.googleapis.com/v1internal:generateContent'
          : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      let url = base
      if (cred.kind === 'oauth') {
        headers.authorization = `Bearer ${cred.token}`
      } else {
        url = `${base}?key=${encodeURIComponent(cred.token)}`
      }
      const generateBody = {
        system_instruction: { parts: [{ text: input.systemPrompt }] },
        contents: [
          {
            role: 'user',
            parts: [
              ...input.images.map((image) => ({
                inline_data: { mime_type: image.mimeType, data: image.data },
              })),
              { text: input.prompt },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: input.maxTokens,
          temperature: input.temperature ?? 0,
        },
      }
      return {
        url,
        method: 'POST',
        headers,
        body: JSON.stringify(
          cred.kind === 'oauth' ? { request: generateBody, model } : generateBody,
        ),
      }
    }
  }
}

/** Pull the plain answer text out of a provider response body. */
export function extractVisionText(provider: AiProviderId, json: unknown): string {
  const body = json as Record<string, unknown>
  switch (provider) {
    case 'anthropic': {
      const content = body.content as Array<{ type?: string; text?: string }> | undefined
      const text = content
        ?.filter((part) => part?.type === 'text')
        .map((part) => part.text ?? '')
        .join('')
      if (text) return text
      break
    }
    case 'openai': {
      // Responses API: prefer output_text, else walk output[].content[].
      if (typeof body.output_text === 'string' && body.output_text) return body.output_text
      const output = body.output as
        | Array<{ content?: Array<{ type?: string; text?: string }> }>
        | undefined
      const text = output
        ?.flatMap((item) => item.content ?? [])
        .filter((part) => part?.type === 'output_text' || part?.type === 'text')
        .map((part) => part.text ?? '')
        .join('')
      if (text) return text
      break
    }
    case 'google': {
      const candidates = body.candidates as
        | Array<{ content?: { parts?: Array<{ text?: string }> } }>
        | undefined
      const text = candidates
        ?.flatMap((candidate) => candidate.content?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('')
      if (text) return text
      break
    }
  }
  throw new Error(`vision_unparseable: ${provider} response carried no text`)
}

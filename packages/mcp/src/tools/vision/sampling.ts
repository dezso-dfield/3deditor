import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'

/**
 * Shared MCP-sampling helpers for the vision tools: image resolution, host
 * capability probing, message content assembly, and reply parsing. No vision
 * model is bundled — every caller defers to the host's `sampling` capability.
 */

const DATA_URI_RE = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i

export type ImageBlock = {
  type: 'image'
  data: string
  mimeType: string
}

/**
 * Resolve an `image` input into a sampling-ready image block: http(s) URL via
 * SSRF-safe fetch, a `data:` URI, or raw base64.
 */
export async function resolveImageBlock(image: string): Promise<ImageBlock> {
  if (/^https?:\/\//i.test(image)) {
    // SSRF-safe fetch (see packages/mcp/src/lib/safe-fetch.ts).
    const { safeFetch } = await import('../../lib/safe-fetch')
    const res = await safeFetch(image, { accept: 'image/*' })
    const data = res.buffer.toString('base64')
    const mimeType = res.contentType ?? 'image/jpeg'
    return { type: 'image', data, mimeType }
  }

  const dataUriMatch = image.match(DATA_URI_RE)
  if (dataUriMatch) {
    return {
      type: 'image',
      mimeType: dataUriMatch[1]!,
      data: dataUriMatch[2]!,
    }
  }

  return { type: 'image', mimeType: 'image/jpeg', data: image }
}

/** Collect all text content blocks returned by the sampling host into one string. */
export function extractText(
  content:
    | { type: 'text'; text: string }
    | { type: 'image' | 'audio'; data: string; mimeType: string }
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image' | 'audio'; data: string; mimeType: string }
        | { type: string; [k: string]: unknown }
      >,
): string {
  const blocks = Array.isArray(content) ? content : [content]
  const texts: string[] = []
  for (const block of blocks) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: unknown }).text
      if (typeof t === 'string') texts.push(t)
    }
  }
  return texts.join('\n').trim()
}

/** The host's sampling capability, or a refusal it does not have one. */
export function assertSampling(getClientCapabilities: () => unknown) {
  const caps = getClientCapabilities() as { sampling?: unknown } | undefined
  if (!caps?.sampling) {
    throw new McpError(ErrorCode.InvalidRequest, 'sampling_unavailable')
  }
}

/** Parse the host's text reply as JSON, with the standard failure codes. */
export function parseSamplingJson<T>(
  text: string,
  validate: (parsed: unknown) => { success: true; data: T } | { success: false; error: unknown },
): T {
  if (!text) {
    throw new McpError(ErrorCode.InternalError, 'sampling_response_unparseable', {
      reason: 'no text content returned by host',
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new McpError(ErrorCode.InternalError, 'sampling_response_unparseable', {
      raw: text,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
  const validation = validate(parsed)
  if (!validation.success) {
    throw new McpError(ErrorCode.InternalError, 'sampling_response_invalid', {
      raw: text,
      errors: validation.error,
    })
  }
  return validation.data
}

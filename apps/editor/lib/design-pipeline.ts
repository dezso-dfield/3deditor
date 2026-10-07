import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SceneBridge } from '@pascal-app/mcp/bridge'
import { createSceneOperations } from '@pascal-app/mcp/operations'
import { registerRoomTools } from '@pascal-app/mcp/tools/room-tools'
import { registerSharedTools } from '@pascal-app/mcp/tools/shared-tools'

/**
 * The in-app design pipeline: the same MCP tools an agent calls, driven against
 * the live scene store through an in-memory server+client pair. Nothing here
 * invents its own behaviour — furnish/style/decorate/fix/review are the real
 * registered tools, so what a user gets from the Design panel is exactly what
 * an agent gets from `furnish_room`, `apply_style`, `decorate_room`,
 * `improve_layout` and `review_layout`.
 */

export type DesignStep = {
  id: string
  label: string
  ok: boolean
  detail: string
  payload?: Record<string, unknown>
}

export type DesignOptions = {
  zoneId: string
  /** Omitted = infer from the zone's name/roomType. */
  roomType?: string
  style: string
  furnish: boolean
  decorate: boolean
  fix: boolean
}

export type DesignReport = {
  issueCount: number
  issues: { code?: string; severity?: string; message?: string }[]
  suggestions: { code?: string; message?: string }[]
} | null

export type DesignResult = {
  steps: DesignStep[]
  report: DesignReport
  error?: string
}

type ToolResultPayload = Record<string, unknown>
type CallToolResult = {
  isError?: boolean
  content?: Array<{ type: string; text: string }>
  structuredContent?: Record<string, unknown>
}

let cached: Promise<{ client: Client; bridge: SceneBridge }> | null = null

/** One in-memory MCP server+client pair for the app session. */
export function getDesignClient(): Promise<{ client: Client; bridge: SceneBridge }> {
  if (!cached) {
    cached = (async () => {
      const bridge = new SceneBridge()
      const operations = createSceneOperations({ bridge })
      const server = new McpServer({ name: 'pascal-design-panel', version: '0.0.0' })
      registerSharedTools(server, operations)
      registerRoomTools(server, operations)
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: 'design-panel', version: '0.0.0' })
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      return { client, bridge }
    })()
  }
  return cached
}

function payloadOf(result: CallToolResult): ToolResultPayload {
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent
  }
  const text = result.content?.[0]?.text
  if (text) {
    try {
      return JSON.parse(text) as ToolResultPayload
    } catch {
      return { raw: text }
    }
  }
  return {}
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; payload: ToolResultPayload }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  return { ok: !result.isError, payload: payloadOf(result) }
}

function refusalDetail(payload: ToolResultPayload, fallback: string): string {
  const code = payload.code ? ` (${String(payload.code)})` : ''
  return `${String(payload.error ?? payload.message ?? fallback)}${code}`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function reportOf(payload: ToolResultPayload | null): DesignReport {
  if (!payload) return null
  return {
    issueCount: typeof payload.issueCount === 'number' ? payload.issueCount : 0,
    issues: Array.isArray(payload.issues)
      ? (payload.issues as { code?: string; severity?: string; message?: string }[])
      : [],
    suggestions: Array.isArray(payload.suggestions)
      ? (payload.suggestions as { code?: string; message?: string }[])
      : [],
  }
}

/** Review a room without changing it. */
export async function reviewRoom(zoneId: string): Promise<DesignReport> {
  const { client } = await getDesignClient()
  const { ok, payload } = await callTool(client, 'review_layout', { zoneId })
  if (!ok) throw new Error(refusalDetail(payload, 'review_layout failed'))
  return reportOf(payload)
}

/**
 * The one-shot room design: name the room type, furnish it, paint it in the
 * chosen style, auto-fix layout defects, dress it with decor, then audit.
 * Stops at the first failing step — a refusal (e.g. unknown room type) is more
 * useful as an error than as a half-styled room.
 */
export async function designRoom(
  options: DesignOptions,
  onStep?: (step: DesignStep) => void,
): Promise<DesignResult> {
  const { client } = await getDesignClient()
  const steps: DesignStep[] = []
  const emit = (step: DesignStep) => {
    steps.push(step)
    onStep?.(step)
  }

  const run = async (
    tool: string,
    args: Record<string, unknown>,
    label: string,
    summarize: (payload: ToolResultPayload) => string,
  ): Promise<ToolResultPayload | null> => {
    const { ok, payload } = await callTool(client, tool, args)
    if (!ok) {
      emit({
        id: tool,
        label,
        ok: false,
        detail: refusalDetail(payload, `${tool} failed`),
        payload,
      })
      return null
    }
    emit({ id: tool, label, ok: true, detail: summarize(payload), payload })
    return payload
  }

  if (options.roomType) {
    const r = await run(
      'update_room',
      { zoneId: options.zoneId, roomType: options.roomType },
      'Room type set',
      () => `Type: ${options.roomType}`,
    )
    if (!r) return { steps, report: null, error: 'Could not set the room type' }
  }

  if (options.furnish) {
    const r = await run(
      'furnish_room',
      {
        zoneId: options.zoneId,
        ...(options.roomType ? { roomType: options.roomType } : {}),
      },
      'Furnished',
      (p) => {
        const skipped =
          Array.isArray(p.skipped) && p.skipped.length > 0 ? `, ${p.skipped.length} skipped` : ''
        return `${plural(Number(p.placed ?? 0), 'item')} placed${skipped}`
      },
    )
    if (!r) return { steps, report: null, error: 'Could not furnish the room' }
  }

  const styled = await run(
    'apply_style',
    { zoneId: options.zoneId, style: options.style },
    'Styled',
    (p) => {
      const applied = Array.isArray(p.applied) ? p.applied.join(' · ') : ''
      return `${String(p.style)}${applied ? ` — ${applied}` : ''}`
    },
  )
  if (!styled) return { steps, report: null, error: 'Could not apply the style' }

  if (options.fix) {
    await run('improve_layout', { zoneId: options.zoneId }, 'Layout fixed', (p) => {
      const fixed = Number(p.fixedCount ?? 0)
      const unfixed = Number(p.unfixed && Array.isArray(p.unfixed) ? p.unfixed.length : 0)
      return `${fixed} fix${fixed === 1 ? '' : 'es'} applied${unfixed ? `, ${unfixed} left` : ''}`
    })
  }

  if (options.decorate) {
    await run('decorate_room', { zoneId: options.zoneId }, 'Decorated', (p) => {
      const suggested =
        Array.isArray(p.suggested) && p.suggested.length > 0
          ? `, ${p.suggested.length} ideas left`
          : ''
      return `${plural(Number(p.placed ?? 0), 'piece')} placed${suggested}`
    })
  }

  const review = await run('review_layout', { zoneId: options.zoneId }, 'Reviewed', (p) => {
    const items = (p.stats as { items?: number } | undefined)?.items
    return `${plural(Number(p.issueCount ?? 0), 'issue')}${typeof items === 'number' ? ` across ${plural(items, 'item')}` : ''}`
  })

  return { steps, report: reportOf(review) }
}

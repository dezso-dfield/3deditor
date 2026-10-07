import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { AGENT_OPERATIONS, type AgentOperation } from '@pascal-app/core/agent-operations'
import { STYLE_PRESET_IDS } from '@pascal-app/core/agent-tools'
import type { AnyNode, AnyNodeId } from '@pascal-app/core/schema'
import { z } from 'zod'
import type { SceneOperations } from '../operations'
import { DESTRUCTIVE_TOOL_ANNOTATIONS } from './annotations'
import { decorateRoom } from './decorate-room'
import { toolError } from './errors'
import { liveSyncOutput, persistencePayload, publishLiveSceneSnapshot } from './live-sync'
import { furnishRoom } from './room-tools'
import { inferRoomType, ROOM_TYPES } from './room-types'
import { NodeIdSchema } from './schemas'
import { toPatches } from './shared-tools'

export const designRoomInput = {
  zoneId: NodeIdSchema.describe('The room (zone) to design, by an id get_zones returned.'),
  name: z.string().min(1).max(120).optional().describe('Rename the room while designing.'),
  roomType: z
    .enum(ROOM_TYPES)
    .optional()
    .describe(
      "The furniture layout and the roomType stored on the room. Default: inferred from the room's roomType (occupancy) or name.",
    ),
  style: z
    .enum(STYLE_PRESET_IDS)
    .optional()
    .describe('Paint the room into this interior style (apply_style). Omit for furnishing only.'),
  accentWallId: NodeIdSchema.optional().describe(
    'Boundary wall to paint with the style’s accent colour — e.g. the wall a bed or sofa backs onto.',
  ),
  furnish: z
    .boolean()
    .optional()
    .describe('Place the furniture set for the room type (default true).'),
  decorate: z
    .enum(['off', 'light', 'full'])
    .optional()
    .describe(
      "decorate_room depth: 'off' skips styling, 'light' hangs the headline pieces only, 'full' (default) also dresses surfaces.",
    ),
  fix: z
    .boolean()
    .optional()
    .describe('Run improve_layout after furnishing to auto-fix layout defects (default true).'),
}

export const designRoomOutput = {
  zoneId: z.string(),
  roomType: z.string().optional(),
  style: z.string().optional(),
  steps: z.array(
    z.object({
      step: z.string(),
      ok: z.boolean(),
      detail: z.string().optional(),
    }),
  ),
  furnished: z
    .object({
      placed: z.number(),
      itemIds: z.array(z.string()),
      skipped: z.array(z.string()),
    })
    .optional(),
  decorated: z
    .object({
      placed: z.number(),
      itemIds: z.array(z.string()),
      skipped: z.array(z.string()),
      suggested: z.array(z.string()),
    })
    .optional(),
  fixedCount: z.number().optional(),
  review: z.record(z.string(), z.unknown()),
  ...liveSyncOutput,
}

type Step = { step: string; ok: boolean; detail?: string }

function runOp(
  bridge: SceneOperations,
  op: AgentOperation,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const outcome = op(bridge.getNodes() as Record<string, AnyNode>, input as never, {
    activeLevelId: null,
  })
  const patches = outcome.changes ? toPatches(outcome.changes) : []
  if (patches.length) bridge.applyPatch(patches)
  return outcome.result as Record<string, unknown>
}

export function registerDesignRoom(server: McpServer, bridge: SceneOperations): void {
  server.registerTool(
    'design_room',
    {
      title: 'Design room',
      description:
        'One-shot interior design for a room: update_room (name/roomType) → furnish_room → apply_style → improve_layout → decorate_room → review_layout, all in a single call. Furnish skips and nudges poses that block doors or overlap; improve_layout re-validates every move; decorate_room styles to the room. Steps report individually, the run stops at the first hard refusal (a missing room, an unknown room type), and the result always ends with the layout review — issues under `review.issues`, styling ideas under `review.suggestions`. Pass only what changes: style-only runs furnish nothing.',
      inputSchema: designRoomInput,
      outputSchema: designRoomOutput,
      annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    },
    async ({ zoneId, name, roomType, style, accentWallId, furnish, decorate, fix }) => {
      const zone = bridge.getNode(zoneId as AnyNodeId)
      if (!zone) return toolError(`Zone not found: ${zoneId}`, { code: 'node_not_found' })
      if (zone.type !== 'zone')
        return toolError(`Node ${zoneId} is a ${zone.type}, expected zone`, {
          code: 'not_a_zone',
        })

      const steps: Step[] = []
      const doFurnish = furnish !== false
      const doDecorate = decorate !== 'off'
      const doFix = fix !== false

      const abort = (step: string, message: string, code?: string) =>
        toolError(`design_room stopped at ${step}: ${message}`, {
          code: code ?? 'step_failed',
          completed: steps,
        })

      if (name !== undefined || roomType !== undefined) {
        try {
          runOp(bridge, AGENT_OPERATIONS.update_room, {
            zoneId,
            ...(name !== undefined ? { name } : {}),
            ...(roomType !== undefined ? { roomType } : {}),
          })
          steps.push({ step: 'update_room', ok: true, detail: roomType ?? name })
        } catch (error) {
          return abort(
            'update_room',
            error instanceof Error ? error.message : String(error),
            'update_failed',
          )
        }
      }

      let furnished: { placed: number; itemIds: string[]; skipped: string[] } | undefined
      let resolvedRoomType: string | undefined = roomType
      if (doFurnish) {
        const out = await furnishRoom(bridge, { zoneId, roomType })
        const payload = ('structuredContent' in out ? out.structuredContent : undefined) as
          | { placed: number; itemIds: string[]; skipped: string[]; roomType?: string }
          | undefined
        if (('isError' in out && out.isError) || !payload) {
          const text = out.content?.[0]?.type === 'text' ? out.content[0].text : 'refused'
          let code: string | undefined
          try {
            code = JSON.parse(text)?.code
          } catch {
            /* plain-text refusal */
          }
          return abort('furnish_room', text, code)
        }
        resolvedRoomType = payload.roomType ?? resolvedRoomType
        furnished = { placed: payload.placed, itemIds: payload.itemIds, skipped: payload.skipped }
        steps.push({
          step: 'furnish_room',
          ok: true,
          detail: `${payload.placed} placed, ${payload.skipped.length} skipped`,
        })
      }

      if (style !== undefined) {
        try {
          runOp(bridge, AGENT_OPERATIONS.apply_style, {
            zoneId,
            style,
            ...(accentWallId !== undefined ? { accentWallId } : {}),
          })
          steps.push({ step: 'apply_style', ok: true, detail: style })
        } catch (error) {
          return abort(
            'apply_style',
            error instanceof Error ? error.message : String(error),
            'style_failed',
          )
        }
      }

      let fixedCount = 0
      if (doFix) {
        try {
          const result = runOp(bridge, AGENT_OPERATIONS.improve_layout, { zoneId })
          fixedCount = (result.fixedCount as number | undefined) ?? 0
          const unfixed = (result.unfixed as unknown[] | undefined) ?? []
          steps.push({
            step: 'improve_layout',
            ok: true,
            detail: `${fixedCount} ${fixedCount === 1 ? 'fix' : 'fixes'} applied${
              unfixed.length ? `, ${unfixed.length} unfixed` : ''
            }`,
          })
        } catch (error) {
          steps.push({
            step: 'improve_layout',
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          })
        }
      }

      let decorated:
        | { placed: number; itemIds: string[]; skipped: string[]; suggested: string[] }
        | undefined
      if (doDecorate) {
        try {
          const out = await decorateRoom(bridge, {
            zoneId,
            depth: decorate === 'light' ? 'light' : 'full',
          })
          const payload = ('structuredContent' in out ? out.structuredContent : undefined) as
            | {
                placed: number
                itemIds: string[]
                skipped: string[]
                suggested: string[]
              }
            | undefined
          if (('isError' in out && out.isError) || !payload) {
            const text = out.content?.[0]?.type === 'text' ? out.content[0].text : 'refused'
            steps.push({ step: 'decorate_room', ok: false, detail: text })
          } else {
            decorated = {
              placed: payload.placed,
              itemIds: payload.itemIds,
              skipped: payload.skipped,
              suggested: payload.suggested,
            }
            steps.push({
              step: 'decorate_room',
              ok: true,
              detail: `${payload.placed} placed`,
            })
          }
        } catch (error) {
          steps.push({
            step: 'decorate_room',
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          })
        }
      }

      let review: Record<string, unknown> = {}
      try {
        review = runOp(bridge, AGENT_OPERATIONS.review_layout, { zoneId })
        const issueCount = (review.issueCount as number | undefined) ?? 0
        steps.push({
          step: 'review_layout',
          ok: true,
          detail: `${issueCount} ${issueCount === 1 ? 'issue' : 'issues'}`,
        })
      } catch (error) {
        steps.push({
          step: 'review_layout',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        })
      }

      const persistence = await publishLiveSceneSnapshot(bridge, 'design_room')

      if (!resolvedRoomType) resolvedRoomType = inferRoomType(zone)

      const payload = {
        zoneId,
        ...(resolvedRoomType ? { roomType: resolvedRoomType } : {}),
        ...(style !== undefined ? { style } : {}),
        steps,
        ...(furnished ? { furnished } : {}),
        ...(decorated ? { decorated } : {}),
        ...(doFix ? { fixedCount } : {}),
        review,
        ...persistencePayload(persistence),
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      }
    },
  )
}

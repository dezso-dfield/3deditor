import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createZone, generateId } from '@pascal-app/core'
import {
  collectDoorKeepouts,
  collectOccupiedFootprints,
  findValidPlacement,
  itemPlanAabb,
  keepoutForPolygonEdge,
  type PlanAabb,
  polygonBounds,
  reviewLayout,
  type Vec2,
} from '@pascal-app/core/agent-operations'
import type { SceneGraph } from '@pascal-app/core/clone-scene-graph'
import type { AnyNode, AnyNodeId, WallNode as WallNodeType } from '@pascal-app/core/schema'
import { ItemNode } from '@pascal-app/core/schema'
import { z } from 'zod'
import type { SceneOperations } from '../../operations'
import { ADDITIVE_OPEN_WORLD_TOOL_ANNOTATIONS } from '../annotations'
import { findCatalogItem, searchCatalogItems, toItemAsset } from '../asset-catalog'
import { toolError } from '../errors'
import { publishLiveSceneSnapshot } from '../live-sync'
import { measurement } from '../measurement'
import { NodeIdSchema } from '../schemas'
import { assertSampling, extractText, parseSamplingJson, resolveImageBlock } from './sampling'

/**
 * `walkthrough_to_room`: interior photos — or frames of a walkthrough video —
 * become an editable room. The host's sampling vision estimates the room's
 * plan and what furniture sits where and facing which way; placements then go
 * through the same door-keepout/overlap machinery as furnish_room, so shaky
 * estimates get nudged instead of rejected. The result is audited with
 * review_layout and reported, issues and all.
 */

export const walkthroughToRoomInput = {
  images: z
    .array(z.string())
    .min(1)
    .max(16)
    .describe(
      'One or more photos of the same room — base64, data URIs or http(s) URLs. Frames extracted from a walkthrough video work: pass a handful covering the whole room.',
    ),
  scaleHint: z
    .string()
    .optional()
    .describe('Scale hint for the vision pass, e.g. "approx 14 m²" or "ceiling 2.7 m".'),
  roomName: z.string().optional().describe('Room name, e.g. "Primary Bedroom".'),
  roomType: z
    .string()
    .optional()
    .describe('Room use label stored as the zone occupancy, e.g. "bedroom".'),
  levelId: NodeIdSchema.optional().describe(
    'Level to build the room on (walls + zone). Required unless zoneId is given.',
  ),
  zoneId: NodeIdSchema.optional().describe(
    'Furnish an existing zone instead of creating a room: its polygon and level are reused.',
  ),
  doorWallIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Polygon edge the room door sits on (0-based); its keep-out is protected even when no door node exists yet.',
    ),
  defaultWallThickness: measurement('length', 'm', {
    positive: true,
    description: 'Default wall thickness.',
  }).default(0.2),
  defaultWallHeight: measurement('length', 'm', {
    positive: true,
    description: 'Default wall height.',
  }).default(2.6),
}

export const walkthroughToRoomOutput = {
  zoneId: z.string(),
  levelId: z.string(),
  wallIds: z.array(z.string().nullable()).optional(),
  placed: z.array(z.record(z.string(), z.unknown())),
  unmatched: z.array(z.string()),
  skipped: z.array(z.string()),
  confidence: z.number(),
  visionPolygon: z.boolean(),
  review: z.record(z.string(), z.unknown()),
  notes: z.string().optional(),
  warnings: z.array(z.string()).optional(),
}

const VisionResponseSchema = z.object({
  roomName: z.string().optional(),
  roomType: z.string().optional(),
  approximateDimensions: z.object({
    widthM: z.number(),
    depthM: z.number(),
  }),
  polygon: z
    .array(z.tuple([z.number(), z.number()]))
    .min(3)
    .optional(),
  doors: z
    .array(z.object({ edgeIndex: z.number().int().optional(), positionT: z.number().optional() }))
    .optional(),
  windows: z
    .array(z.object({ edgeIndex: z.number().int().optional(), widthM: z.number().optional() }))
    .optional(),
  items: z.array(
    z.object({
      label: z.string(),
      position: z.tuple([z.number(), z.number()]),
      facingDeg: z.number().optional(),
    }),
  ),
  confidence: z.number().min(0).max(1),
  notes: z.string().optional(),
})

type VisionResponse = z.infer<typeof VisionResponseSchema>

const SYSTEM_PROMPT = `You are a vision assistant that reconstructs a room's floor plan from interior photos or frames of a walkthrough video.
Your ONLY job: return a JSON object that exactly matches this schema — no prose, no markdown fences.

{
  "roomName": string?,      // e.g. "Bedroom", "Open-plan kitchen"
  "roomType": string?,      // "bedroom" | "kitchen" | "living" | "dining" | "bathroom" | "office" | "hallway" | "entry" | "laundry" | "storage"
  "approximateDimensions": { "widthM": number, "depthM": number },
  "polygon": [[x, z], ...]? // room outline in metres, clockwise or counter-clockwise, ≥3 points — only when the photos show the real shape; omit for a rectangle estimate
  "doors": [{ "edgeIndex": number?, "positionT": number? }]?,
  "windows": [{ "edgeIndex": number?, "widthM": number? }]?,
  "items": [{ "label": string, "position": [x, z], "facingDeg": number? }, ...],
  "confidence": number 0..1,
  "notes": string?
}

Coordinates are metres in the room's floor plan, origin at the room's centre: x is the horizontal plan axis, z the depth axis.
Reconcile ALL images into ONE consistent plan — frames are views of the same room from different angles.
position is the item's centre in plan. facingDeg is where its front points in degrees: 0 faces +z, 90 faces +x, 180 faces -z, 270 faces -x.
For furniture use plain labels a catalog search can match: "sofa", "dining table", "dining chair", "double bed", "desk", "office chair", "bookshelf", "tv stand", "television", "fridge", "stove", "toilet", "bathroom sink", "bathtub", "wardrobe", "dresser", "nightstand", "rug", "floor lamp", "plant", "washing machine".
Estimate positions honestly from parallax across frames; lower confidence when the geometry is unclear.
DO NOT wrap the JSON in markdown. DO NOT explain. Just output the raw JSON.`

/** A detected item's label → catalog id, exact words first then catalog search. */
const LABEL_TO_CATALOG: [RegExp, string][] = [
  [/^(double|king|queen)( bed)?|bed(?!side)/i, 'double-bed'],
  [/single bed|twin bed|day bed|daybed/i, 'single-bed'],
  [/nightstand|bedside|night table|bedside table/i, 'bedside-table'],
  [/dresser|chest of drawers|drawers|bureau|commode/i, 'dresser'],
  [/wardrobe|closet|armoire|cabinet(?!ry)/i, 'closet'],
  [/sofa|couch|settee|loveseat|sectional/i, 'sofa'],
  [/armchair|accent chair|living.*chair|recliner|club chair/i, 'livingroom-chair'],
  [/lounge chair|chaise|deck chair/i, 'lounge-chair'],
  [/bean.?bag/i, 'bean-bag'],
  [/stool|ottoman|footstool|bar stool/i, 'stool'],
  [/coffee table|center table|centre table/i, 'coffee-table'],
  [/tv( |-)?stand|media console|tv bench|entertainment/i, 'tv-stand'],
  [/television|\btv\b|flat.?screen/i, 'television'],
  [/bookcase|bookshelf|shelving unit/i, 'bookshelf'],
  [/shelf|wall shelf|floating shelf/i, 'shelf'],
  [/dining table|kitchen table|eat(ing)? table|dinner table/i, 'dining-table'],
  [/dining chair|kitchen chair|dinner chair/i, 'dining-chair'],
  [/desk|workstation|work table|writing desk|computer desk/i, 'desk'],
  [/office chair|desk chair|task chair|swivel chair|computer chair/i, 'office-chair'],
  [/kitchen island|kitchen unit|kitchen cab|counter-?top unit/i, 'kitchen'],
  [/kitchen counter|countertop|worktop/i, 'kitchen-counter'],
  [/stove|range|cooktop|cooker|hob|oven/i, 'stove'],
  [/fridge|refrigerator|freezer/i, 'fridge'],
  [/microwave/i, 'microwave'],
  [/toilet|\bwc\b|commode/i, 'toilet'],
  [/sink|vanity|wash ?basin|lavatory/i, 'bathroom-sink'],
  [/shower/i, 'shower-square'],
  [/bath ?tub|\btub\b|jacuzzi/i, 'bathtub'],
  [/washing machine|washer|laundry machine/i, 'washing-machine'],
  [/drying rack|airer|clothes horse/i, 'drying-rack'],
  [/coat (rack|stand|tree)|hall tree/i, 'coat-rack'],
  [/rug|carpet|mat/i, 'rectangular-carpet'],
  [/floor lamp|standing lamp|torchiere/i, 'floor-lamp'],
  [/table lamp|desk lamp|bedside lamp/i, 'table-lamp'],
  [/plant|greenery|potted|houseplant|flower pot/i, 'indoor-plant'],
  [/piano/i, 'piano'],
  [/easel/i, 'easel'],
]

function matchCatalogId(label: string) {
  const clean = label.trim()
  for (const [pattern, id] of LABEL_TO_CATALOG) {
    if (pattern.test(clean)) return id
  }
  const hits = searchCatalogItems({ query: clean })
  return hits[0]?.id
}

/** Openings the vision pass saw, mapped to polygon edges it gave them on. */
function doorKeepoutsFor(vision: VisionResponse, polygon: Vec2[]) {
  const keepouts: PlanAabb[] = []
  for (const door of vision.doors ?? []) {
    const edge = door.edgeIndex
    if (edge === undefined) continue
    const planned = keepoutForPolygonEdge(polygon, edge, {
      t: door.positionT ?? 0.5,
      width: 0.9,
    })
    if (planned) keepouts.push(planned)
  }
  return keepouts
}

export function registerWalkthroughToRoom(server: McpServer, bridge: SceneOperations): void {
  server.registerTool(
    'walkthrough_to_room',
    {
      title: 'Walkthrough to room',
      description:
        'Reconstruct an editable room from interior photos or frames of a walkthrough video: the host vision estimates the plan, furniture and facings; placements reuse the furnish_room door/overlap machinery so weak estimates nudge rather than fail; review_layout audits the result. Requires host sampling.',
      inputSchema: walkthroughToRoomInput,
      outputSchema: walkthroughToRoomOutput,
      annotations: ADDITIVE_OPEN_WORLD_TOOL_ANNOTATIONS,
    },
    async ({
      images,
      scaleHint,
      roomName,
      roomType,
      levelId,
      zoneId,
      doorWallIndex,
      defaultWallThickness,
      defaultWallHeight,
    }) => {
      assertSampling(() => server.server.getClientCapabilities())

      const imageBlocks = await Promise.all(images.map((image) => resolveImageBlock(image)))
      const instruction = scaleHint
        ? `Reconstruct this room's floor plan. Scale hint: ${scaleHint}. Return ONLY the JSON described by the system prompt.`
        : "Reconstruct this room's floor plan. Return ONLY the JSON described by the system prompt."

      const response = await server.server.createMessage({
        systemPrompt: SYSTEM_PROMPT,
        temperature: 0,
        maxTokens: 4000,
        messages: [
          {
            role: 'user',
            content: [...imageBlocks, { type: 'text' as const, text: instruction }],
          },
        ],
      })

      const text = extractText(response.content as Parameters<typeof extractText>[0])
      const vision = parseSamplingJson(text, (parsed) => VisionResponseSchema.safeParse(parsed))

      // The room plan: an existing zone's polygon, the vision's outline, or a
      // rectangle sized from its dimension estimate.
      const warnings: string[] = []
      let polygon: Vec2[]
      let roomLevelId = levelId
      let visionPolygon = false
      if (zoneId) {
        const zone = bridge.getNode(zoneId as AnyNodeId)
        if (!zone) return toolError(`Zone not found: ${zoneId}`, { code: 'zone_not_found' })
        if (zone.type !== 'zone')
          return toolError(`Node ${zoneId} is a ${zone.type}, not a zone.`, { code: 'not_a_zone' })
        polygon = zone.polygon as Vec2[]
        roomLevelId = roomLevelId ?? zone.parentId ?? undefined
      } else if (vision.polygon && vision.polygon.length >= 3) {
        polygon = vision.polygon as Vec2[]
        visionPolygon = true
      } else {
        const w = vision.approximateDimensions.widthM / 2
        const d = vision.approximateDimensions.depthM / 2
        polygon = [
          [-w, -d],
          [w, -d],
          [w, d],
          [-w, d],
        ]
        warnings.push('room outline estimated as a rectangle; pass a floor plan for exact walls')
      }
      if (!roomLevelId) {
        return toolError('Provide levelId to build the room on, or zoneId to furnish a zone.', {
          code: 'missing_level',
        })
      }
      const level = bridge.getNode(roomLevelId as AnyNodeId)
      if (!level) return toolError(`Level not found: ${roomLevelId}`, { code: 'level_not_found' })
      if (level.type !== 'level')
        return toolError(`Node ${roomLevelId} is a ${level.type}, not a level.`, {
          code: 'not_a_level',
        })

      // New rooms are built like create_room does: walls per edge plus the zone
      // so floors and ceilings derive; the vision polygon is only an estimate.
      let resolvedZoneId = zoneId
      let wallIds: (string | null)[] | undefined
      const before = bridge.getNodes()
      if (!resolvedZoneId) {
        const name = roomName ?? vision.roomName ?? 'Room from walkthrough'
        const plan = createZone(before, {
          levelId: roomLevelId,
          polygon,
          name,
          enclose: true,
          wall: {
            thickness: defaultWallThickness,
            height: defaultWallHeight,
          },
          mintId: generateId,
        })
        if (plan.conflicts?.length) {
          return toolError('The estimated room outline conflicts with existing geometry.', {
            code: 'room_conflict',
            conflicts: plan.conflicts,
          })
        }
        const occupancy = roomType ?? vision.roomType
        bridge.runAsSingleHistoryStep(() => {
          bridge.applyPatch(
            plan.changes.map((change) =>
              change.op === 'create' && change.node.type === 'zone'
                ? {
                    ...change,
                    node: {
                      ...change.node,
                      spaceRole: 'room',
                      ...(occupancy ? { occupancy } : {}),
                      metadata: { mcpTool: 'walkthrough_to_room' },
                    },
                    parentId: change.node.parentId as AnyNodeId,
                  }
                : change,
            ),
          )
          bridge.deriveStructure([roomLevelId as AnyNodeId])
        })
        resolvedZoneId = plan.zoneId
        wallIds = polygon.map(
          (start, i) =>
            Object.values(bridge.getNodes()).find(
              (node) =>
                node.type === 'wall' &&
                node.parentId === roomLevelId &&
                wallCoversEdge(node as WallNodeType, start, polygon[(i + 1) % polygon.length]!),
            )?.id ?? null,
        )
      }

      // Doors: real keep-outs from wall children plus the vision's edge guesses.
      const allNodes = Object.values(bridge.getNodes())
      const doorKeepoutAabbs: PlanAabb[] = collectDoorKeepouts(allNodes, {
        levelId: roomLevelId,
      }).map((k) => k.aabb)
      doorKeepoutAabbs.push(...doorKeepoutsFor(vision, polygon))
      if (doorWallIndex !== undefined) {
        const planned = keepoutForPolygonEdge(polygon, doorWallIndex, { t: 0.5, width: 0.9 })
        if (planned) doorKeepoutAabbs.push(planned)
      }

      const bounds = polygonBounds(polygon)
      const roomBounds = {
        minX: bounds.minX,
        maxX: bounds.maxX,
        minZ: bounds.minZ,
        maxZ: bounds.maxZ,
      }
      const occupied: PlanAabb[] = collectOccupiedFootprints(allNodes, {
        levelId: roomLevelId,
        floorOnly: true,
      }).map((f) => f.aabb)

      const placed: Record<string, unknown>[] = []
      const unmatched: string[] = []
      const skipped: string[] = []
      const items: AnyNode[] = []

      for (const visionItem of vision.items) {
        const assetId = matchCatalogId(visionItem.label)
        if (!assetId) {
          unmatched.push(visionItem.label)
          continue
        }
        const asset = findCatalogItem(assetId)
        if (!asset?.dimensions) {
          unmatched.push(visionItem.label)
          continue
        }
        const facingDeg = visionItem.facingDeg ?? 0
        const resolved = findValidPlacement({
          primary: { x: visionItem.position[0], z: visionItem.position[1], rotationDeg: facingDeg },
          dimensions: asset.dimensions,
          doorKeepouts: doorKeepoutAabbs,
          occupied,
          roomBounds,
        })
        if (!resolved.candidate) {
          skipped.push(`${visionItem.label} → ${assetId}: ${resolved.reason ?? 'no space'}`)
          continue
        }
        const { x, z, rotationDeg } = resolved.candidate
        const rotRad = (rotationDeg * Math.PI) / 180
        const item = ItemNode.parse({
          name: asset.name,
          position: [x, 0, z],
          rotation: [0, rotRad, 0],
          asset: toItemAsset(asset),
          metadata: {
            mcpTool: 'walkthrough_to_room',
            visionLabel: visionItem.label,
            visionConfidence: vision.confidence,
          },
        })
        items.push(item)
        occupied.push(itemPlanAabb([x, 0, z], asset.dimensions, rotRad))
        placed.push({
          itemId: item.id,
          assetId,
          label: visionItem.label,
          position: [x, z],
          facingDeg: rotationDeg,
          ...(x !== visionItem.position[0] || z !== visionItem.position[1]
            ? { placementAdjusted: true }
            : {}),
        })
      }

      if (items.length > 0) {
        bridge.applyPatch(
          items.map((item) => ({
            op: 'create' as const,
            node: item,
            parentId: roomLevelId as AnyNodeId,
          })),
        )
      }
      await publishLiveSceneSnapshot(bridge, 'walkthrough_to_room')

      // Design audit on the result — the tool returns what it saw and what the
      // layout still gets wrong, so the caller fixes or accepts the estimate.
      let review: Record<string, unknown> = { skipped: 'review failed' }
      try {
        const reviewed = reviewLayout(
          bridge.getNodes() as SceneGraph['nodes'],
          {
            levelId: roomLevelId,
          },
          { activeLevelId: null },
        )
        const outcome = reviewed.result as {
          ok: boolean
          issueCount: number
          errorCount: number
          issues: unknown[]
        }
        review = {
          ok: outcome.ok,
          issueCount: outcome.issueCount,
          errorCount: outcome.errorCount,
          issues: outcome.issues.slice(0, 15),
        }
      } catch (error) {
        warnings.push(
          `review_layout could not run: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      const notes = [...(vision.notes ? [vision.notes] : []), ...(warnings.length ? warnings : [])]
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              zoneId: resolvedZoneId,
              levelId: roomLevelId,
              ...(wallIds ? { wallIds } : {}),
              placed,
              unmatched,
              skipped,
              confidence: vision.confidence,
              visionPolygon,
              review,
              ...(notes.length ? { notes: notes.join('; ') } : {}),
              ...(warnings.length ? { warnings } : {}),
            }),
          },
        ],
        structuredContent: {
          zoneId: resolvedZoneId,
          levelId: roomLevelId,
          ...(wallIds ? { wallIds } : {}),
          placed,
          unmatched,
          skipped,
          confidence: vision.confidence,
          visionPolygon,
          review,
          ...(notes.length ? { notes: notes.join('; ') } : {}),
          ...(warnings.length ? { warnings } : {}),
        },
      }
    },
  )
}

const WALL_EDGE_TOLERANCE = 0.2

function pointToEdgeDistance(a: Vec2, b: Vec2, point: readonly [number, number]) {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const length = Math.hypot(dx, dz)
  if (length < 1e-9) return Math.hypot(point[0] - a[0], point[1] - a[1])
  return Math.abs((point[0] - a[0]) * dz - (point[1] - a[1]) * dx) / length
}

function wallCoversEdge(wall: WallNodeType, start: Vec2, end: Vec2) {
  const dx = end[0] - start[0]
  const dz = end[1] - start[1]
  const lengthSq = dx * dx + dz * dz
  const station = (p: Vec2) => ((p[0] - start[0]) * dx + (p[1] - start[1]) * dz) / lengthSq
  const a = station(wall.start)
  const b = station(wall.end)
  return (
    Math.min(1, Math.max(a, b)) - Math.max(0, Math.min(a, b)) > 1e-6 &&
    pointToEdgeDistance(start, end, wall.start) < WALL_EDGE_TOLERANCE &&
    pointToEdgeDistance(start, end, wall.end) < WALL_EDGE_TOLERANCE
  )
}

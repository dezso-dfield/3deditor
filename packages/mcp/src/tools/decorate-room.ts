import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  collectDoorKeepouts,
  collectOccupiedFootprints,
  findValidPlacement,
  itemPlanAabb,
  itemRole,
  itemWorldPlan,
  type PlanAabb,
  pointInPolygon,
  pointToSegmentDistance,
  polygonArea,
  polygonBounds,
  projectWorldPointToWallLocalX,
  type Vec2,
  wallLength,
  zoneSideFace,
} from '@pascal-app/core/agent-operations'
import type { AnyNode, AnyNodeId } from '@pascal-app/core/schema'
import { ItemNode } from '@pascal-app/core/schema'
import { z } from 'zod'
import type { SceneOperations } from '../operations'
import { ADDITIVE_TOOL_ANNOTATIONS } from './annotations'
import { findCatalogItem, toItemAsset } from './asset-catalog'
import { ErrorCode, throwMcpError } from './errors'
import {
  type LiveSyncStatus,
  liveSyncOutput,
  persistencePayload,
  publishLiveSceneSnapshot,
} from './live-sync'
import { inferRoomType } from './room-types'
import { NodeIdSchema } from './schemas'

// How far off a wall face a floor item's back may sit and still count as
// "backed by that wall" for hanging decor above it.
const BACK_WALL_MAX_DISTANCE = 1.0
// Padding against doors/windows and other mounted pieces on the same face.
const WALL_SPAN_PADDING = 0.12
// Wall art hangs at eye level; the catalog offsets make the item origin its
// bottom edge, so these are bottom heights.
const ART_BOTTOM_HEIGHT = 1.1
const MIRROR_BOTTOM_HEIGHT = 1.35
const TOILET_PAPER_HEIGHT = 0.68
const KITCHEN_SHELF_HEIGHT = 1.5

type WallSeg = { node: AnyNode & { type: 'wall' }; face: 'a' | 'b' }

type WantedItem =
  | {
      kind: 'wall'
      assetId: string
      wallId: string
      localX: number
      height: number
      face: 'a' | 'b'
      note: string
    }
  | { kind: 'ceiling'; assetId: string; x: number; z: number; note: string }
  | { kind: 'surface'; assetId: string; hostId: string; note: string }
  | {
      kind: 'floor'
      assetId: string
      x: number
      z: number
      rotationDeg?: number
      along?: { x: number; z: number }
      inward?: { x: number; z: number }
      note: string
    }

const FRONT_LOCAL: Record<'z+' | 'z-' | 'x+' | 'x-', Vec2> = {
  'z+': [0, 1],
  'z-': [0, -1],
  'x+': [1, 0],
  'x-': [-1, 0],
}

function frontDir(yaw: number, front: keyof typeof FRONT_LOCAL): Vec2 {
  const [fx, fz] = FRONT_LOCAL[front]
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  return [fx * cos + fz * sin, -fx * sin + fz * cos]
}

function textResult<T extends Record<string, unknown>>(payload: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
}

function itemName(item: AnyNode): string {
  return item.name ?? ('asset' in item ? item.asset?.name : undefined) ?? item.id
}

export const decorateRoomInput = {
  zoneId: NodeIdSchema.describe('The room (zone) to decorate, by an id get_zones returned.'),
  depth: z
    .enum(['light', 'full'])
    .optional()
    .describe(
      "'light' hangs the headline pieces only (art, pendant light, mirror). 'full' (default) also dresses surfaces — lamps, books, plants, countertop sets.",
    ),
}

export const decorateRoomOutput = {
  placed: z.number(),
  itemIds: z.array(z.string()),
  skipped: z.array(z.string()),
  suggested: z.array(z.string()),
  roomType: z.string(),
  ...liveSyncOutput,
}

/** The walls the zone borders + the face (`a`/`b`) turned toward the room. */
function zoneBoundaryWalls(
  onLevel: AnyNode[],
  levelId: string,
  zone: Extract<AnyNode, { type: 'zone' }>,
): WallSeg[] {
  const b = polygonBounds(zone.polygon as Vec2[])
  const centroid: Vec2 = [b.centerX, b.centerZ]
  const claimed = new Set(zone.boundaryWallIds)
  return onLevel
    .filter((n): n is AnyNode & { type: 'wall' } => n.type === 'wall')
    .filter((wall) => {
      if (claimed.has(wall.id)) return true
      // Drawn rooms carry no boundaryWallIds — a bordering wall's midpoint
      // lies on the polygon's edge band.
      const mid: Vec2 = [(wall.start[0] + wall.end[0]) / 2, (wall.start[1] + wall.end[1]) / 2]
      return zone.polygon.some((point, i) => {
        const next = zone.polygon[(i + 1) % zone.polygon.length]!
        return pointToSegmentDistance(mid, point as Vec2, next as Vec2) < 0.45
      })
    })
    .map((node) => ({ node, face: zoneSideFace(node, centroid) }))
}

/** Booked spans on a wall face, in wall-local metres. */
function collectWallSpans(nodes: AnyNode[], wallId: string, face: 'a' | 'b'): [number, number][] {
  const side = face === 'a' ? 'front' : 'back'
  const spans: [number, number][] = []
  for (const node of nodes) {
    if ((node as { wallId?: string }).wallId !== wallId) continue
    if (node.type === 'door' || node.type === 'window') {
      const w = (node as { width?: number }).width ?? 0.9
      spans.push([
        node.position[0] - w / 2 - WALL_SPAN_PADDING,
        node.position[0] + w / 2 + WALL_SPAN_PADDING,
      ])
      continue
    }
    if (node.type !== 'item') continue
    const attach = node.asset?.attachTo
    if (attach !== 'wall' && attach !== 'wall-side') continue
    // 'wall' items mount through the wall and occupy both faces.
    if (attach === 'wall-side' && (node.side ?? 'front') !== side) continue
    const w = (node.asset?.dimensions?.[0] ?? 0.5) * (node.scale?.[0] ?? 1)
    spans.push([
      node.position[0] - w / 2 - WALL_SPAN_PADDING,
      node.position[0] + w / 2 + WALL_SPAN_PADDING,
    ])
  }
  return spans
}

function spanFree(spans: [number, number][], centerX: number, width: number, wallLen: number) {
  const lo = centerX - width / 2
  const hi = centerX + width / 2
  if (lo < 0.08 || hi > wallLen - 0.08) return false
  return !spans.some(([a, b]) => lo < b && hi > a)
}

function bookSpan(spans: [number, number][], centerX: number, width: number) {
  spans.push([centerX - width / 2 - WALL_SPAN_PADDING, centerX + width / 2 + WALL_SPAN_PADDING])
}

/** The boundary wall behind an item's back edge, if it hugs one. */
function wallBehind(
  frame: { x: number; z: number; yaw: number },
  item: { asset?: { front?: 'z+' | 'z-' | 'x+' | 'x-'; dimensions?: number[] } },
  walls: WallSeg[],
): { wall: WallSeg; distance: number } | undefined {
  const front = item.asset?.front ?? 'z+'
  const dims = item.asset?.dimensions ?? [1, 1, 1]
  const along = front === 'z+' || front === 'z-' ? Math.abs(dims[2] ?? 1) : Math.abs(dims[0] ?? 1)
  const dir = frontDir(frame.yaw, front)
  const back: Vec2 = [frame.x - dir[0] * (along / 2), frame.z - dir[1] * (along / 2)]
  let best: { wall: WallSeg; distance: number } | undefined
  for (const wall of walls) {
    const d = pointToSegmentDistance(back, wall.node.start as Vec2, wall.node.end as Vec2)
    if (d <= BACK_WALL_MAX_DISTANCE && (!best || d < best.distance)) best = { wall, distance: d }
  }
  return best
}

export type DecorateRoomArgs = {
  zoneId: string
  depth?: 'light' | 'full'
}

export async function decorateRoom(bridge: SceneOperations, args: DecorateRoomArgs) {
  const { zoneId, depth } = args
  const zone = bridge.getNode(zoneId as AnyNodeId)
  if (!zone) throwMcpError(ErrorCode.InvalidParams, `Zone not found: ${zoneId}`)
  if (zone.type !== 'zone')
    throwMcpError(ErrorCode.InvalidParams, `Node ${zoneId} is a ${zone.type}, expected zone`)
  const levelId = zone.parentId
  if (!levelId) throwMcpError(ErrorCode.InvalidParams, `Zone ${zoneId} is missing a parent level`)

  const allNodes = Object.values(bridge.getNodes())
  const onLevel = allNodes.filter((n) => n.parentId === levelId)
  const nodeMap = bridge.getNodes() as Record<string, AnyNode>
  const polygon = zone.polygon as Vec2[]
  const bounds = polygonBounds(polygon)
  const area = polygonArea(polygon)
  const roomType = inferRoomType(zone) ?? 'living'

  const walls = zoneBoundaryWalls(onLevel, levelId, zone)
  const ceilings = onLevel.filter((n) => n.type === 'ceiling')

  // Zone contents: items whose world-plan centre falls inside the room.
  const zoneItems = onLevel.filter((n): n is AnyNode & { type: 'item' } => {
    if (n.type !== 'item') return false
    const frame = itemWorldPlan(nodeMap, n)
    return !!frame && pointInPolygon([frame.x, frame.z], polygon, true)
  })
  const byAssetId = (idPart: string | RegExp) =>
    zoneItems.filter((i) =>
      typeof idPart === 'string' ? i.asset?.id === idPart : idPart.test(i.asset?.id ?? ''),
    )
  const hasRug = zoneItems.some(
    (i) => i.asset?.id?.includes('carpet') || (i.asset?.tags ?? []).includes('rug'),
  )
  const hasPendant = zoneItems.some(
    (i) => i.asset?.attachTo === 'ceiling' && /lamp|light|fan|pendant/.test(i.asset?.id ?? ''),
  )

  const spansByWall = new Map<string, [number, number][]>()
  const spansFor = (wall: WallSeg) => {
    const key = `${wall.node.id}:${wall.face}`
    let spans = spansByWall.get(key)
    if (!spans) {
      spans = collectWallSpans(allNodes, wall.node.id, wall.face)
      spansByWall.set(key, spans)
    }
    return spans
  }

  const wanted: WantedItem[] = []
  const suggested: string[] = []

  const frameOf = (item: AnyNode & { type: 'item' }) => itemWorldPlan(nodeMap, item)

  const wallMount = (
    wall: WallSeg,
    localX: number,
    assetId: string,
    height: number,
    note: string,
  ) => {
    const asset = findCatalogItem(assetId)
    if (!asset) return
    const len = wallLength(wall.node)
    const spans = spansFor(wall)
    if (!spanFree(spans, localX, asset.dimensions![0], len)) {
      suggested.push(`${note} on wall ${wall.node.id} — no free span`)
      return
    }
    bookSpan(spans, localX, asset.dimensions![0])
    wanted.push({
      kind: 'wall',
      assetId,
      wallId: wall.node.id,
      localX,
      height,
      face: wall.face,
      note,
    })
  }

  const artAboveItem = (item: AnyNode & { type: 'item' }, what: string) => {
    const frame = frameOf(item)
    if (!frame) return
    const back = wallBehind(frame, item, walls)
    if (!back) {
      suggested.push(`hang art on the wall behind the ${what} once it backs a wall`)
      return
    }
    const localX = projectWorldPointToWallLocalX(back.wall.node, [frame.x, 0, frame.z])
    const artId = wallLength(back.wall.node) > 3.4 ? 'picture' : 'wall-art-06'
    wallMount(back.wall, localX, artId, ART_BOTTOM_HEIGHT, `art above the ${what}`)
  }

  const pendantOver = (item: AnyNode & { type: 'item' }, what: string) => {
    if (hasPendant) {
      suggested.push(`the room already has a ceiling light over the ${what}`)
      return
    }
    const frame = frameOf(item)
    if (!frame) return
    wanted.push({
      kind: 'ceiling',
      assetId: 'ceiling-lamp',
      x: frame.x,
      z: frame.z,
      note: `pendant over the ${what}`,
    })
  }

  const onSurface = (host: AnyNode & { type: 'item' }, assetId: string, note: string) => {
    if (!host.asset?.surface) return
    const asset = findCatalogItem(assetId)
    if (!asset) return
    const hostDims = host.asset?.dimensions ?? [1, 1, 1]
    if (asset.dimensions![0] > hostDims[0] * 0.9 || asset.dimensions![2] > hostDims[2] * 0.9) {
      suggested.push(`place ${asset.name} on ${itemName(host)} — its top is too small`)
      return
    }
    wanted.push({ kind: 'surface', assetId, hostId: host.id, note })
  }

  const floorDecor = (
    assetId: string,
    x: number,
    z: number,
    rotationDeg: number,
    note: string,
    axes?: { along: Vec2; inward: Vec2 },
  ) => {
    wanted.push({
      kind: 'floor',
      assetId,
      x,
      z,
      rotationDeg,
      ...(axes
        ? {
            along: { x: axes.along[0], z: axes.along[1] },
            inward: { x: axes.inward[0], z: axes.inward[1] },
          }
        : {}),
      note,
    })
  }

  /** Largest open span on a room-facing wall. */
  const freeWallCenter = (minWidth: number): { wall: WallSeg; localX: number } | undefined => {
    let best: { wall: WallSeg; localX: number; span: number } | undefined
    for (const wall of walls) {
      const len = wallLength(wall.node)
      const spans = spansFor(wall)
        .slice()
        .sort((a, b) => a[0] - b[0])
      let cursor = 0.1
      const gaps: [number, number][] = []
      for (const [lo, hi] of spans) {
        if (lo > cursor) gaps.push([cursor, lo])
        cursor = Math.max(cursor, hi)
      }
      if (len - 0.1 > cursor) gaps.push([cursor, len - 0.1])
      for (const [lo, hi] of gaps) {
        const span = hi - lo
        if (span >= minWidth && (!best || span > best.span))
          best = { wall, localX: (lo + hi) / 2, span }
      }
    }
    return best ? { wall: best.wall, localX: best.localX } : undefined
  }

  /** A floor item leaned against a wall face, facing into the room. */
  const leanAgainstWall = (assetId: string, minSpan: number, inset: number, note: string) => {
    const spot = freeWallCenter(minSpan)
    if (!spot) {
      suggested.push(`${note} — no free wall run`)
      return
    }
    const wall = spot.wall
    const dx = wall.node.end[0] - wall.node.start[0]
    const dz = wall.node.end[1] - wall.node.start[1]
    const len = Math.hypot(dx, dz) || 1
    const left: Vec2 = [-dz / len, dx / len]
    const sign = wall.face === 'a' ? 1 : -1
    const t = spot.localX / len
    floorDecor(
      assetId,
      wall.node.start[0] + dx * t + left[0] * sign * inset,
      wall.node.start[1] + dz * t + left[1] * sign * inset,
      (Math.atan2(left[0] * sign, left[1] * sign) * 180) / Math.PI,
      note,
      { along: [dx / len, dz / len], inward: [left[0] * sign, left[1] * sign] },
    )
  }

  const sofa = byAssetId('sofa')[0]
  const coffeeTable = byAssetId('coffee-table')[0]
  const diningTable = byAssetId(/^dining-table/)[0]
  const desk = byAssetId('desk')[0]
  const beds = zoneItems.filter((i) => itemRole(i) === 'bed' || i.asset?.role === 'bed')
  const sinks = byAssetId(/sink|bathroom-sink|sink-cabinet/)
  const toilet = byAssetId('toilet')[0]
  const counters = zoneItems.filter((i) =>
    /kitchen|kitchen-counter|kitchen-cabinet/.test(i.asset?.id ?? ''),
  )
  const showerOrTub = byAssetId(/shower|bathtub|shower-square|tub/)

  switch (roomType) {
    case 'kitchen': {
      const counter = counters[0]
      if (counter) {
        onSurface(counter, 'fruits', 'fruit bowl on the counter')
        onSurface(counter, 'kettle', 'kettle on the counter')
        onSurface(counter, 'coffee-machine', 'coffee machine on the counter')
        if (depth !== 'light') {
          onSurface(counter, 'toaster', 'toaster on the counter')
          onSurface(counter, 'microwave', 'microwave on the counter')
          onSurface(counter, 'kitchen-utensils', 'utensils on the counter')
          onSurface(counter, 'cutting-board', 'cutting board on the counter')
        }
        const frame = frameOf(counter)
        const back = frame ? wallBehind(frame, counter, walls) : undefined
        if (back) {
          const localX = projectWorldPointToWallLocalX(back.wall.node, [frame!.x, 0, frame!.z])
          wallMount(
            back.wall,
            localX,
            'kitchen-shelf',
            KITCHEN_SHELF_HEIGHT,
            'shelf above the counter',
          )
        }
      } else {
        suggested.push('dress the kitchen counters once a counter or kitchen unit exists')
      }
      const stove = byAssetId(/stove|oven|kitchen$/)[0]
      if (stove) {
        const sframe = frameOf(stove)
        const sback = sframe ? wallBehind(sframe, stove, walls) : undefined
        if (sback) {
          const localX = projectWorldPointToWallLocalX(sback.wall.node, [sframe!.x, 0, sframe!.z])
          wallMount(sback.wall, localX, 'hood', 1.6, 'extractor hood above the stove')
        }
      }
      break
    }
    case 'bedroom': {
      const bed = beds[0]
      if (bed) artAboveItem(bed, 'bed')
      for (const side of byAssetId('bedside-table').slice(0, 2)) {
        onSurface(side, 'table-lamp', 'lamp on the bedside table')
      }
      const dresser = byAssetId('dresser')[0]
      if (dresser) onSurface(dresser, 'small-indoor-plant', 'plant on the dresser')
      leanAgainstWall('rectangular-mirror', 1.0, 0.22, 'standing mirror on the free wall')
      break
    }
    case 'dining': {
      if (diningTable) {
        pendantOver(diningTable, 'dining table')
        onSurface(diningTable, 'wine-bottle', 'wine bottle on the dining table')
      }
      const spot = freeWallCenter(1.6)
      if (spot)
        wallMount(spot.wall, spot.localX, 'picture', ART_BOTTOM_HEIGHT, 'art on the dining wall')
      else suggested.push('hang a picture — every dining wall span is taken')
      break
    }
    case 'living': {
      if (sofa) artAboveItem(sofa, 'sofa')
      if (coffeeTable) {
        pendantOver(coffeeTable, 'coffee table')
        onSurface(coffeeTable, 'books', 'books on the coffee table')
        if (!hasRug && area >= 6) {
          const frame = frameOf(coffeeTable)
          if (frame) floorDecor('round-carpet', frame.x, frame.z, 0, 'rug under the seating')
        }
      }
      const tvStand = byAssetId('tv-stand')[0]
      if (tvStand) {
        onSurface(tvStand, 'small-indoor-plant', 'plant on the TV stand')
        const frame = frameOf(tvStand)
        if (frame) {
          const dir = frontDir(frame.yaw, tvStand.asset?.front ?? 'z+')
          const px: Vec2 = [-dir[1], dir[0]]
          const w = (tvStand.asset?.dimensions?.[0] ?? 1.2) / 2 + 0.3
          floorDecor(
            'stereo-speaker',
            frame.x + px[0] * w,
            frame.z + px[1] * w,
            (frame.yaw * 180) / Math.PI,
            'speaker beside the TV stand',
          )
          floorDecor(
            'stereo-speaker',
            frame.x - px[0] * w,
            frame.z - px[1] * w,
            (frame.yaw * 180) / Math.PI,
            'speaker beside the TV stand',
          )
        }
      }
      break
    }
    case 'bathroom': {
      const sink = sinks[0]
      if (sink) {
        const frame = frameOf(sink)
        const back = frame ? wallBehind(frame, sink, walls) : undefined
        if (back) {
          const localX = projectWorldPointToWallLocalX(back.wall.node, [frame!.x, 0, frame!.z])
          wallMount(
            back.wall,
            localX,
            'round-mirror',
            MIRROR_BOTTOM_HEIGHT,
            'mirror above the sink',
          )
        } else {
          suggested.push('mount a mirror above the sink once the sink backs a wall')
        }
      }
      if (toilet) {
        const frame = frameOf(toilet)
        const back = frame ? wallBehind(frame, toilet, walls) : undefined
        if (back) {
          const len = wallLength(back.wall.node)
          const localX = Math.min(
            Math.max(
              projectWorldPointToWallLocalX(back.wall.node, [frame!.x, 0, frame!.z]) + 0.35,
              0.2,
            ),
            len - 0.2,
          )
          wallMount(
            back.wall,
            localX,
            'toilet-paper',
            TOILET_PAPER_HEIGHT,
            'toilet paper beside the toilet',
          )
        }
      }
      const fixture = showerOrTub[0]
      if (fixture) {
        const frame = frameOf(fixture)
        if (frame) {
          const dir = frontDir(frame.yaw, fixture.asset?.front ?? 'z+')
          const d = (fixture.asset?.dimensions?.[2] ?? 0.9) / 2 + 0.25
          floorDecor(
            'shower-rug',
            frame.x + dir[0] * d,
            frame.z + dir[1] * d,
            (frame.yaw * 180) / Math.PI,
            'bath mat in front of the shower',
          )
        }
      }
      if (depth !== 'light' && sink) {
        const frame = frameOf(sink)
        if (frame) floorDecor('trash-bin', frame.x + 0.5, frame.z, 0, 'bin beside the sink')
      }
      break
    }
    case 'office': {
      if (desk) {
        artAboveItem(desk, 'desk')
        onSurface(desk, 'computer', 'computer on the desk')
        onSurface(desk, 'books', 'books on the desk')
        if (depth !== 'light') onSurface(desk, 'cactus', 'plant on the desk')
      }
      const shelf = byAssetId('bookshelf')[0]
      if (shelf) onSurface(shelf, 'small-indoor-plant', 'plant on the bookshelf')
      break
    }
    case 'entry':
    case 'hallway': {
      const spot = freeWallCenter(0.7)
      if (spot)
        wallMount(
          spot.wall,
          spot.localX,
          'round-mirror',
          MIRROR_BOTTOM_HEIGHT,
          'mirror in the hallway',
        )
      else suggested.push('hang a hallway mirror — no wall span is free')
      break
    }
    case 'laundry': {
      if (depth !== 'light') {
        leanAgainstWall('laundry-bag', 0.6, 0.45, 'laundry bag by the wall')
        const board = byAssetId('ironing-board')[0]
        if (board) onSurface(board, 'iron', 'iron on the ironing board')
      }
      break
    }
    case 'kids': {
      const bunk = byAssetId(/bunkbed|bed/)[0]
      if (bunk) artAboveItem(bunk, 'bed')
      if (depth !== 'light') {
        const spot = freeWallCenter(0.7)
        if (spot)
          wallMount(
            spot.wall,
            spot.localX,
            'wall-art-06',
            ART_BOTTOM_HEIGHT,
            'playful art on the wall',
          )
        floorDecor('toy', bounds.centerX + 0.4, bounds.centerZ, 30, 'toy on the floor')
      }
      break
    }
    case 'gym': {
      leanAgainstWall('rectangular-mirror', 1.2, 0.2, 'mirror panel on the free wall')
      break
    }
    case 'game': {
      const pool = byAssetId('pool-table')[0]
      if (pool) pendantOver(pool, 'pool table')
      const spot = freeWallCenter(1.4)
      if (spot)
        wallMount(spot.wall, spot.localX, 'picture', ART_BOTTOM_HEIGHT, 'art on the game-room wall')
      break
    }
  }

  if (wanted.length === 0 && suggested.length === 0) {
    suggested.push(
      `nothing to add for a ${roomType} — furnish_room first, or set roomType/name with update_room so decor rules apply`,
    )
  }

  // --- Place ---
  const skipped: string[] = []
  const items: AnyNode[] = []
  const doorKeepouts = collectDoorKeepouts(allNodes, { levelId }).map((k) => k.aabb)
  const occupied: PlanAabb[] = collectOccupiedFootprints(allNodes, {
    levelId,
    floorOnly: true,
  }).map((f) => f.aabb)
  const roomBounds = {
    minX: bounds.minX,
    maxX: bounds.maxX,
    minZ: bounds.minZ,
    maxZ: bounds.maxZ,
  }

  for (const w of wanted) {
    const asset = findCatalogItem(w.assetId)
    if (!asset) {
      skipped.push(`${w.assetId}: asset not found`)
      continue
    }
    const itemAsset = toItemAsset(asset)

    if (w.kind === 'wall') {
      items.push(
        ItemNode.parse({
          name: asset.name,
          parentId: w.wallId,
          wallId: w.wallId,
          wallT:
            wallLength(allNodes.find((n) => n.id === w.wallId) as { start: Vec2; end: Vec2 }) > 1e-6
              ? w.localX /
                wallLength(allNodes.find((n) => n.id === w.wallId) as { start: Vec2; end: Vec2 })
              : 0,
          side: w.face === 'a' ? 'front' : 'back',
          position: [w.localX, w.height, 0],
          asset: itemAsset,
          metadata: { mcpTool: 'decorate_room', note: w.note },
        }),
      )
      continue
    }

    if (w.kind === 'ceiling') {
      const ceiling = ceilings.find((c) =>
        Array.isArray(c.polygon) && (c.polygon as Vec2[]).length >= 3
          ? pointInPolygon([w.x, w.z], c.polygon as Vec2[], true)
          : true,
      )
      if (!ceiling) {
        skipped.push(`${w.assetId}: no ceiling on this level`)
        continue
      }
      items.push(
        ItemNode.parse({
          name: asset.name,
          parentId: ceiling.id,
          position: [w.x, 0, w.z],
          asset: itemAsset,
          metadata: { mcpTool: 'decorate_room', note: w.note },
        }),
      )
      continue
    }

    if (w.kind === 'surface') {
      const host = nodeMap[w.hostId]
      const surfaceH = host?.type === 'item' ? host.asset?.surface?.height : undefined
      if (host?.type !== 'item' || surfaceH === undefined) {
        skipped.push(`${w.assetId}: surface host gone`)
        continue
      }
      const childSpots = (host.children ?? [])
        .map((id) => nodeMap[id])
        .filter((n): n is AnyNode & { type: 'item' } => n?.type === 'item')
        .map((n) => n.position)
      const hostDims = host.asset?.dimensions ?? [1, 1, 1]
      const offsetCandidates: Vec2[] = [
        [0, 0],
        [-hostDims[0] * 0.28, 0],
        [hostDims[0] * 0.28, 0],
        [0, -hostDims[2] * 0.28],
        [0, hostDims[2] * 0.28],
        [-hostDims[0] * 0.28, -hostDims[2] * 0.2],
        [hostDims[0] * 0.28, -hostDims[2] * 0.2],
      ]
      const free = offsetCandidates.find(
        ([dx, dz]) =>
          !childSpots.some((p) => Math.abs(p[0] - dx) < 0.22 && Math.abs(p[2] - dz) < 0.22),
      )
      if (!free) {
        skipped.push(`${w.assetId}: ${itemName(host)}'s surface is full`)
        continue
      }
      const scaleY = host.scale?.[1] ?? 1
      items.push(
        ItemNode.parse({
          name: asset.name,
          parentId: host.id,
          position: [free[0], surfaceH * scaleY, free[1]],
          asset: itemAsset,
          metadata: { mcpTool: 'decorate_room', note: w.note },
        }),
      )
      continue
    }

    const resolved = findValidPlacement({
      primary: { x: w.x, z: w.z, rotationDeg: w.rotationDeg ?? 0 },
      dimensions: asset.dimensions,
      doorKeepouts,
      occupied,
      roomBounds,
      ...(w.along ? { along: w.along } : {}),
      ...(w.inward ? { inward: w.inward } : {}),
    })
    if (!resolved.candidate) {
      skipped.push(`${w.assetId}: ${resolved.reason ?? 'no free spot'}`)
      suggested.push(`${w.note} — no free floor spot in the room`)
      continue
    }
    const { x, z, rotationDeg } = resolved.candidate
    const rotRad = (rotationDeg * Math.PI) / 180
    occupied.push(itemPlanAabb([x, 0, z], asset.dimensions, rotRad))
    items.push(
      ItemNode.parse({
        name: asset.name,
        position: [x, 0, z],
        rotation: [0, rotRad, 0],
        asset: itemAsset,
        metadata: { mcpTool: 'decorate_room', note: w.note },
      }),
    )
  }

  let persistence: LiveSyncStatus = 'published'
  if (items.length > 0) {
    bridge.applyPatch(
      items.map((item) => ({
        op: 'create' as const,
        node: item,
        parentId: (item.parentId ?? levelId) as AnyNodeId,
      })),
    )
    persistence = await publishLiveSceneSnapshot(bridge, 'decorate_room')
  }

  return textResult({
    placed: items.length,
    roomType,
    itemIds: items.map((item) => item.id),
    skipped,
    suggested,
    ...persistencePayload(persistence),
  })
}
export function registerDecorateRoom(server: McpServer, bridge: SceneOperations): void {
  server.registerTool(
    'decorate_room',
    {
      title: 'Decorate room',
      description:
        "The interior-design pass after furnish_room: hangs wall art above a bed or sofa's backing wall, mounts a pendant over the dining or coffee table, drops a rug under the seating, and dresses surfaces — bedside-table lamps, books and plants, the countertop set, a mirror over the bathroom sink, the bath mat and toilet roll. Wall-mounted pieces take the face the room sees and skip spans already taken by doors, windows or mounted items; what cannot be placed comes back under `skipped` with the reason and under `suggested` as a plain-language idea.",
      inputSchema: decorateRoomInput,
      outputSchema: decorateRoomOutput,
      annotations: ADDITIVE_TOOL_ANNOTATIONS,
    },
    async (args: DecorateRoomArgs) => decorateRoom(bridge, args),
  )
}

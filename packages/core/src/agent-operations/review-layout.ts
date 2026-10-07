import type { z } from 'zod'
import type { reviewLayoutTool } from '../agent-tools/items'
import { refuse } from '../agent-tools/refusal'
import type { AnyNode } from '../schema'
import { isLowProfileItemSurface } from '../schema/nodes/item'
import { collectDoorKeepouts, findBlockedDoors } from './door-clearance'
import {
  aabbOfPoints,
  angleBetweenDirections,
  frontDirection,
  type ItemFront,
  type ItemRole,
  itemFootprintCorners,
  itemRole,
  itemSideClearanceCorners,
  itemWorldPlan,
  pointToSegmentDistance,
  raySegmentDistance,
} from './item-facing'
import { findItemItemCollisions } from './layout-clearance'
import { pointInPolygon, polygonBounds, type Vec2 } from './plan-geometry'
import { levelIdOf, levelRole, levelsOf, nodesOnLevel } from './scene-queries'
import type { AgentOperation } from './types'

export type ReviewLayoutInput = z.infer<z.ZodObject<typeof reviewLayoutTool.input>>

export type LayoutIssue = {
  code: string
  severity: 'error' | 'warn'
  nodeIds: string[]
  message: string
  suggestion?: string
}

/** A styling idea, not a defect — missing decor the layout would take. */
export type LayoutSuggestion = {
  code: string
  nodeIds: string[]
  message: string
  suggestion?: string
}

type ScopedItem = {
  node: Extract<AnyNode, { type: 'item' }>
  frame: { x: number; z: number; yaw: number }
  front: ItemFront
  role?: ItemRole
}

/** A seat's front should point at its table within this cone. */
const SEAT_FACE_TOLERANCE = (65 * Math.PI) / 180
/** A seat counts as "at" a table when centers sit within this range (m). */
const SEAT_NEAR_TABLE = 3.0
/** A front aimed at a wall this close (m) reads as "faces a wall". */
const FACES_WALL_DISTANCE = 0.45
/** Headboards / storage backs should sit within this of a wall (m). */
const BACK_TO_WALL_DISTANCE = 0.4
/** Free corridor from a doorway into the room: start offset, depth and half-width (m). */
const WALKWAY_START = 0.7
const WALKWAY_DEPTH = 1.2
const WALKWAY_HALF_WIDTH = 0.45
/** Wall-mounted decor counts as covering a focal item within this wall-local range (m). */
const DECOR_WALL_RANGE = 1.3
/** A table counts as lit when a ceiling light sits this close in plan (m). */
const LIGHT_NEAR_TABLE = 1.5

type WallSeg = { id: string; start: Vec2; end: Vec2 }

function nearestWallHit(origin: Vec2, dir: Vec2, walls: WallSeg[]) {
  let best = Number.POSITIVE_INFINITY
  let wall: WallSeg | undefined
  for (const w of walls) {
    const t = raySegmentDistance(origin, dir, w.start, w.end)
    if (t < best) {
      best = t
      wall = w
    }
  }
  return wall ? { distance: best, wall } : undefined
}

function nearestWallDistance(point: Vec2, walls: WallSeg[]) {
  let best = Number.POSITIVE_INFINITY
  let wall: WallSeg | undefined
  for (const w of walls) {
    const d = pointToSegmentDistance(point, w.start, w.end)
    if (d < best) {
      best = d
      wall = w
    }
  }
  return wall ? { distance: best, wall } : undefined
}

/** A point inside the polygon, as close to its middle as the shape allows. */
function interiorPoint(polygon: Vec2[]): Vec2 | null {
  const bounds = polygonBounds(polygon)
  const candidates: Vec2[] = [[bounds.centerX, bounds.centerZ]]
  for (const p of polygon) {
    candidates.push([p[0] + (bounds.centerX - p[0]) * 0.2, p[1] + (bounds.centerZ - p[1]) * 0.2])
  }
  return candidates.find((p) => pointInPolygon(p, polygon, false)) ?? null
}

function itemName(item: AnyNode): string {
  return item.name ?? ('asset' in item ? item.asset?.name : undefined) ?? item.id
}

function overlaps(
  a: { minX: number; maxX: number; minZ: number; maxZ: number },
  b: { minX: number; maxX: number; minZ: number; maxZ: number },
) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ
}

/**
 * `review_layout`: interior-design checks over a room or level — collision and
 * door rules (shared with verify_scene), then placement quality: functional
 * clearance, seating orientation, wall-hugging for beds and storage, fronts
 * aimed at walls, and door-to-room walkways.
 */
export const reviewLayout: AgentOperation<ReviewLayoutInput> = (nodes, input) => {
  const zoneNode = input.zoneId ? nodes[input.zoneId] : undefined
  if (input.zoneId) {
    if (!zoneNode) refuse('node_not_found', `Node not found: ${input.zoneId}.`)
    if (zoneNode.type !== 'zone')
      refuse('not_a_zone', `${input.zoneId} is a ${zoneNode.type}, not a zone.`)
  }
  const levelNode = input.levelId ? nodes[input.levelId] : undefined
  if (input.levelId) {
    if (!levelNode) refuse('node_not_found', `Node not found: ${input.levelId}.`)
    if (levelNode.type !== 'level')
      refuse('not_a_level', `${input.levelId} is a ${levelNode.type}, not a level.`)
  }
  const scopeLevelId =
    input.levelId ?? (zoneNode ? (levelIdOf(nodes, zoneNode.id) ?? undefined) : undefined)
  const levelIds = scopeLevelId
    ? [scopeLevelId]
    : levelsOf(nodes)
        .filter((level) => levelRole(nodes, level).role === 'occupied')
        .map((level) => level.id)
  if (levelIds.length === 0)
    refuse('no_levels', 'No occupied level to review; create rooms before reviewing a layout.')

  const issues: LayoutIssue[] = []
  const suggestions: LayoutSuggestion[] = []
  const skippedItems: { id: string; name: string; reason: string }[] = []
  const checksRun = new Set<string>()
  const stats = { items: 0, seats: 0, tables: 0, zones: 0 }

  for (const levelId of levelIds) {
    // The level node itself must be in the list: door/overlap checks resolve a
    // node's level through parent links and silently drop nodes they cannot place.
    const levelNodeForChecks = nodes[levelId]
    const onLevel = levelNodeForChecks
      ? [levelNodeForChecks, ...nodesOnLevel(nodes, levelId)]
      : nodesOnLevel(nodes, levelId)
    const walls: WallSeg[] = onLevel
      .filter((n): n is AnyNode & { type: 'wall' } => n.type === 'wall')
      .map((w) => ({ id: w.id, start: w.start, end: w.end }))
    const zones = onLevel
      .filter((n): n is AnyNode & { type: 'zone' } => n.type === 'zone')
      .filter((z) => !input.zoneId || z.id === input.zoneId)
    stats.zones += zones.length

    // --- shared integrity checks ---
    checksRun.add('door_blocked')
    for (const b of findBlockedDoors({ nodes: onLevel, levelId })) {
      issues.push({
        code: 'door_blocked',
        severity: 'error',
        nodeIds: [b.itemId, b.doorId],
        message: `${b.itemName ?? b.itemId} blocks the clear zone of door ${b.doorId}`,
        suggestion: 'Move or rotate the item out of the door keep-out (~0.65 m each side).',
      })
    }
    checksRun.add('item_overlap')
    for (const c of findItemItemCollisions({ nodes: onLevel, levelId })) {
      issues.push({
        code: c.violation === 'overlap' ? 'item_overlap' : 'item_too_close',
        severity: c.violation === 'overlap' ? 'error' : 'warn',
        nodeIds: [c.aId, c.bId],
        message: c.message,
      })
    }

    // --- decor reads: mounted pieces per wall and ceiling lights ---
    // Ceiling items hang under a ceiling parent in level XZ; wall-mounted
    // pieces carry wall-local X on their host (same span space decorate_room
    // books when it hangs art).
    const ceilingLights: Vec2[] = []
    const mountedByWall = new Map<string, [number, number][]>()
    for (const node of onLevel) {
      if (node.type !== 'item') continue
      const attach = node.asset?.attachTo
      if (attach === 'ceiling') {
        ceilingLights.push([node.position[0] ?? 0, node.position[2] ?? 0])
        continue
      }
      if ((attach === 'wall' || attach === 'wall-side') && node.wallId) {
        const w = (node.asset?.dimensions?.[0] ?? 0.5) * (node.scale?.[0] ?? 1)
        const list = mountedByWall.get(node.wallId) ?? []
        list.push([node.position[0] - w / 2, node.position[0] + w / 2])
        mountedByWall.set(node.wallId, list)
      }
    }

    // --- collect checkable floor items ---
    const scoped: ScopedItem[] = []
    for (const node of onLevel) {
      if (node.type !== 'item') continue
      const name = itemName(node)
      if (node.asset?.attachTo || node.wallId || node.roofSegmentId || node.blockFaceId) {
        skippedItems.push({ id: node.id, name, reason: 'attached_to_host' })
        continue
      }
      if (isLowProfileItemSurface(node)) {
        // Rugs and mats receive furniture visually; they never block.
        skippedItems.push({ id: node.id, name, reason: 'low_profile_surface' })
        continue
      }
      const rot = node.rotation ?? [0, 0, 0]
      if (Math.abs(rot[0] ?? 0) > 1e-6 || Math.abs(rot[2] ?? 0) > 1e-6) {
        skippedItems.push({ id: node.id, name, reason: 'non_planar_rotation' })
        continue
      }
      const frame = itemWorldPlan(nodes, node)
      if (!frame) {
        skippedItems.push({ id: node.id, name, reason: 'non_finite_pose' })
        continue
      }
      const dims = node.asset?.dimensions
      if (!Array.isArray(dims) || dims.some((d) => !(d > 0))) {
        skippedItems.push({ id: node.id, name, reason: 'missing_dimensions' })
        continue
      }
      scoped.push({ node, frame, front: node.asset?.front ?? 'z+', role: itemRole(node) })
    }
    stats.items += scoped.length

    const others = (self: ScopedItem) => scoped.filter((o) => o.node.id !== self.node.id)
    const aabbOf = (item: ScopedItem) =>
      aabbOfPoints(
        itemFootprintCorners(
          [item.frame.x, item.frame.z],
          item.node.asset.dimensions,
          item.frame.yaw,
        ),
      )

    // --- functional clearance ---
    checksRun.add('clearance')
    for (const item of scoped) {
      const clearance = item.node.asset?.clearance
      if (!clearance) continue
      for (const which of ['front', 'back'] as const) {
        const need = clearance[which]
        if (!need || need <= 0) continue
        const rect = aabbOfPoints(
          itemSideClearanceCorners(
            [item.frame.x, item.frame.z],
            item.node.asset.dimensions,
            item.frame.yaw,
            item.front,
            which,
            need,
          ),
        )
        const blocker = others(item).find((o) => overlaps(rect, aabbOf(o)))
        if (!blocker) continue
        issues.push({
          code: `${which}_clearance`,
          severity: 'warn',
          nodeIds: [item.node.id, blocker.node.id],
          message: `${itemName(item.node)} needs ${need.toFixed(2)} m clear ${
            which === 'front' ? 'in front' : 'behind'
          }; ${itemName(blocker.node)} is inside it`,
          suggestion:
            which === 'back'
              ? 'Leave pull-out space behind the item (e.g. behind a chair).'
              : 'Move the blocker or turn the item so its front opens to the room.',
        })
      }
    }

    // --- seating orientation ---
    checksRun.add('seat_facing')
    const tables = scoped.filter((i) => i.role === 'table' || i.role === 'desk')
    const seats = scoped.filter((i) => i.role === 'seat')
    stats.seats += seats.length
    stats.tables += tables.length
    const zoneOf = (x: number, z: number) =>
      zones.find((zone) => pointInPolygon([x, z], zone.polygon as Vec2[], false))
    for (const seat of seats) {
      const seatZone = zoneOf(seat.frame.x, seat.frame.z)
      const pool = seatZone
        ? tables.filter((t) => zoneOf(t.frame.x, t.frame.z) === seatZone)
        : tables
      let nearest: { table: ScopedItem; distance: number } | undefined
      for (const table of pool) {
        const d = Math.hypot(table.frame.x - seat.frame.x, table.frame.z - seat.frame.z)
        if (d <= SEAT_NEAR_TABLE && (!nearest || d < nearest.distance)) {
          nearest = { table, distance: d }
        }
      }
      if (!nearest) continue
      const toTable: Vec2 = [
        nearest.table.frame.x - seat.frame.x,
        nearest.table.frame.z - seat.frame.z,
      ]
      const facing = frontDirection(seat.frame.yaw, seat.front)
      const angle = angleBetweenDirections(facing, toTable)
      if (angle <= SEAT_FACE_TOLERANCE) continue
      issues.push({
        code: 'seat_facing',
        severity: 'warn',
        nodeIds: [seat.node.id, nearest.table.node.id],
        message: `${itemName(seat.node)} does not face ${itemName(nearest.table.node)} (${Math.round(
          (angle * 180) / Math.PI,
        )}° off)`,
        suggestion: `orient_item ${seat.node.id} facing { mode: 'node', nodeId: '${nearest.table.node.id}' }`,
      })
    }

    // --- fronts aimed at walls ---
    checksRun.add('faces_wall')
    for (const item of scoped) {
      if (item.role === 'decor' || item.role === 'media') continue
      const dims = item.node.asset.dimensions
      const along =
        item.front === 'z+' || item.front === 'z-' ? Math.abs(dims[2]) : Math.abs(dims[0])
      const dir = frontDirection(item.frame.yaw, item.front)
      const origin: Vec2 = [
        item.frame.x + dir[0] * (along / 2),
        item.frame.z + dir[1] * (along / 2),
      ]
      const hit = nearestWallHit(origin, dir, walls)
      if (!hit || hit.distance >= FACES_WALL_DISTANCE) continue
      issues.push({
        code: 'faces_wall',
        severity: 'warn',
        nodeIds: [item.node.id, hit.wall.id],
        message: `${itemName(item.node)}'s front faces wall ${hit.wall.id} ${hit.distance.toFixed(
          2,
        )} m away`,
        suggestion: 'Turn the item so its front opens to the room, or move it off the wall.',
      })
    }

    // --- backs that belong against a wall ---
    checksRun.add('back_to_wall')
    for (const item of scoped) {
      const wantsWall = item.role === 'bed' || item.role === 'storage' || item.role === 'appliance'
      if (!wantsWall) continue
      const dims = item.node.asset.dimensions
      const along =
        item.front === 'z+' || item.front === 'z-' ? Math.abs(dims[2]) : Math.abs(dims[0])
      const dir = frontDirection(item.frame.yaw, item.front)
      const back: Vec2 = [item.frame.x - dir[0] * (along / 2), item.frame.z - dir[1] * (along / 2)]
      const near = nearestWallDistance(back, walls)
      if (near && near.distance <= BACK_TO_WALL_DISTANCE) continue
      issues.push({
        code: item.role === 'bed' ? 'headboard_off_wall' : 'storage_off_wall',
        severity: 'warn',
        nodeIds: [item.node.id],
        message:
          item.role === 'bed'
            ? `${itemName(item.node)}'s headboard sits ${
                near ? `${near.distance.toFixed(2)} m` : 'far'
              } off the nearest wall`
            : `${itemName(item.node)}'s back sits ${
                near ? `${near.distance.toFixed(2)} m` : 'far'
              } off the nearest wall`,
        suggestion:
          item.role === 'bed' ? 'Push the headboard to a wall.' : 'Push it against a wall.',
      })
    }

    // --- interior-design suggestions: focal walls and table lighting ---
    checksRun.add('decor_focal_wall')
    for (const item of scoped) {
      const focal =
        item.role === 'bed' || (item.role === 'seat' && /sofa|couch/i.test(itemName(item.node)))
      if (!focal) continue
      const dims = item.node.asset.dimensions
      const along =
        item.front === 'z+' || item.front === 'z-' ? Math.abs(dims[2]) : Math.abs(dims[0])
      const dir = frontDirection(item.frame.yaw, item.front)
      const back: Vec2 = [item.frame.x - dir[0] * (along / 2), item.frame.z - dir[1] * (along / 2)]
      const near = nearestWallDistance(back, walls)
      if (!near || near.distance > BACK_TO_WALL_DISTANCE) continue
      const wall = near.wall
      const wdx = wall.end[0] - wall.start[0]
      const wdz = wall.end[1] - wall.start[1]
      const wlen = Math.hypot(wdx, wdz) || 1
      const localX =
        ((item.frame.x - wall.start[0]) * wdx + (item.frame.z - wall.start[1]) * wdz) / wlen
      const mounted = mountedByWall.get(wall.id) ?? []
      const covered = mounted.some(
        ([lo, hi]) => localX >= lo - DECOR_WALL_RANGE && localX <= hi + DECOR_WALL_RANGE,
      )
      if (covered) continue
      suggestions.push({
        code: 'bare_focal_wall',
        nodeIds: [item.node.id, wall.id],
        message: `the wall behind ${itemName(item.node)} is bare`,
        suggestion:
          'Hang wall art or a mirror centred on the item — decorate_room mounts it on the room-facing side.',
      })
    }
    checksRun.add('decor_lighting')
    for (const item of scoped) {
      const litTable =
        item.role === 'table' || item.role === 'desk' || /coffee/i.test(itemName(item.node))
      if (!litTable) continue
      const lit = ceilingLights.some(
        ([lx, lz]) => Math.hypot(lx - item.frame.x, lz - item.frame.z) <= LIGHT_NEAR_TABLE,
      )
      if (lit) continue
      suggestions.push({
        code: 'unlit_table',
        nodeIds: [item.node.id],
        message: `${itemName(item.node)} has no light overhead`,
        suggestion: 'Mount a pendant or ceiling light over it — decorate_room places one.',
      })
    }

    // --- door walkway into each room ---
    checksRun.add('walkway')
    const keepouts = collectDoorKeepouts(onLevel, { levelId })
    for (const zone of zones) {
      const polygon = zone.polygon as Vec2[]
      const inside = interiorPoint(polygon)
      if (!inside) continue
      for (const keepout of keepouts) {
        const kcx = (keepout.aabb.minX + keepout.aabb.maxX) / 2
        const kcz = (keepout.aabb.minZ + keepout.aabb.maxZ) / 2
        const dx = inside[0] - kcx
        const dz = inside[1] - kcz
        const len = Math.hypot(dx, dz)
        if (len < 1e-6) continue
        const dir: Vec2 = [dx / len, dz / len]
        const start: Vec2 = [kcx + dir[0] * WALKWAY_START, kcz + dir[1] * WALKWAY_START]
        if (!pointInPolygon(start, polygon, true)) continue
        const px = -dir[1]
        const pz = dir[0]
        const corners: Vec2[] = []
        for (const t of [0, WALKWAY_DEPTH]) {
          for (const s of [-WALKWAY_HALF_WIDTH, WALKWAY_HALF_WIDTH]) {
            corners.push([start[0] + dir[0] * t + px * s, start[1] + dir[1] * t + pz * s])
          }
        }
        const corridor = aabbOfPoints(corners)
        for (const item of scoped) {
          if (!overlaps(corridor, aabbOf(item))) continue
          issues.push({
            code: 'walkway_blocked',
            severity: 'warn',
            nodeIds: [item.node.id, keepout.doorId],
            message: `${itemName(item.node)} stands in the walkway from door ${keepout.doorId} into ${
              zone.name ?? zone.id
            }`,
            suggestion: `Keep ~${(WALKWAY_HALF_WIDTH * 2).toFixed(1)} m free from the doorway into the room.`,
          })
        }
      }
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length
  return {
    result: {
      ok: errorCount === 0,
      scope: { levelIds, ...(input.zoneId ? { zoneId: input.zoneId } : {}) },
      checksRun: [...checksRun],
      issueCount: issues.length,
      errorCount,
      issues,
      stats,
      skippedItems,
      suggestions,
    },
  }
}

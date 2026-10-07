import type { z } from 'zod'
import type { improveLayoutTool } from '../agent-tools/items'
import { refuse } from '../agent-tools/refusal'
import type { AnyNode } from '../schema'
import { isLowProfileItemSurface } from '../schema/nodes/item'
import { collectDoorKeepouts } from './door-clearance'
import {
  aabbOfPoints,
  frontDirection,
  itemFootprintCorners,
  itemFront,
  itemRole,
  itemWorldPlan,
  resolveFacingYaw,
} from './item-facing'
import { aabbsOverlap, type PlanAabb } from './layout-clearance'
import { pointInPolygon, polygonBounds, type Vec2 } from './plan-geometry'
import { type LayoutIssue, reviewLayout } from './review-layout'
import { levelIdOf, levelRole, levelsOf, nodesOnLevel } from './scene-queries'
import type { AgentContext, AgentOperation } from './types'

export type ImproveLayoutInput = z.infer<z.ZodObject<typeof improveLayoutTool.input>>

type Fix = 'rotated' | 'moved'
type FixResult = { fix: Fix; detail: string } | { reason: string }

type ScopedItem = {
  node: Extract<AnyNode, { type: 'item' }>
  dims: [number, number, number]
  frame: { x: number; z: number; yaw: number }
  aabb: PlanAabb
}

/** How far a back edge sits from its wall once pushed flush (m). */
const FLUSH_GAP = 0.05
/** Nudge attempts walk this far (m) in each direction before giving up. */
const MAX_NUDGE = 2.0
const NUDGE_STEP = 0.1

const HEAVY_ROLES = new Set(['bed', 'storage', 'appliance', 'fixture', 'table'])

const aabbOf = (x: number, z: number, dims: [number, number, number], yaw: number): PlanAabb =>
  aabbOfPoints(itemFootprintCorners([x, z], dims, yaw))

const itemName = (item: AnyNode) =>
  item.name ?? ('asset' in item ? item.asset?.name : undefined) ?? item.id

function pointSegmentDistance(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const l2 = dx * dx + dz * dz
  if (l2 < 1e-9) return Math.hypot(point[0] - a[0], point[1] - a[1])
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / l2))
  return Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dz * t))
}

/**
 * `improve_layout`: act on `review_layout` findings instead of only listing
 * them. Per finding it applies the obvious interior-design fix — seats turned
 * to face their table, fronts turned off walls, beds and storage pushed flush
 * to a wall, door and walkway blockers slid into the room — and reports what it
 * changed (`fixed`) and what still needs a human call (`unfixed`), so the next
 * step is re-running review_layout, not guessing.
 */
export const improveLayout: AgentOperation<ImproveLayoutInput> = (
  nodes,
  input,
  context: AgentContext,
) => {
  const zoneNode = input.zoneId ? nodes[input.zoneId] : undefined
  if (input.zoneId) {
    if (!zoneNode) refuse('node_not_found', `Node not found: ${input.zoneId}.`)
    if (zoneNode.type !== 'zone')
      refuse('not_a_zone', `${input.zoneId} is a ${zoneNode.type}, not a zone.`)
  }

  const scopeLevelId =
    input.levelId ?? (zoneNode ? (levelIdOf(nodes, zoneNode.id) ?? undefined) : undefined)
  const levelIds = scopeLevelId
    ? [scopeLevelId]
    : levelsOf(nodes)
        .filter((level) => levelRole(nodes, level).role === 'occupied')
        .map((level) => level.id)
  if (levelIds.length === 0)
    refuse('no_levels', 'No occupied level to improve; create rooms first.')

  const review = reviewLayout(nodes, { zoneId: input.zoneId, levelId: input.levelId }, context)
  const issues = (review.result as { issues: LayoutIssue[] }).issues
  if (issues.length === 0) {
    return {
      result: {
        ok: true,
        scope: review.result.scope,
        fixed: [],
        unfixed: [],
        fixedCount: 0,
        issueCount: 0,
      },
    }
  }

  // Movable floor items: level-parented, unrotated in x/z, with real dims.
  const scoped = new Map<string, ScopedItem>()
  const zonePolygons = new Map<string, { id: string; polygon: Vec2[]; center: Vec2 }>()
  const keepouts: PlanAabb[] = []
  for (const levelId of levelIds) {
    const levelNodeForChecks = nodes[levelId]
    const onLevel = levelNodeForChecks
      ? [levelNodeForChecks, ...nodesOnLevel(nodes, levelId)]
      : nodesOnLevel(nodes, levelId)
    for (const k of collectDoorKeepouts(onLevel, { levelId })) keepouts.push(k.aabb)
    for (const node of onLevel) {
      if (node.type === 'zone') {
        const b = polygonBounds(node.polygon as Vec2[])
        zonePolygons.set(node.id, {
          id: node.id,
          polygon: node.polygon as Vec2[],
          center: [b.centerX, b.centerZ],
        })
      }
      if (node.type !== 'item') continue
      if (node.asset?.attachTo || node.wallId || node.roofSegmentId || node.blockFaceId) continue
      if (isLowProfileItemSurface(node)) continue
      if (node.parentId && nodes[node.parentId]?.type !== 'level') continue
      const rot = node.rotation ?? [0, 0, 0]
      if (Math.abs(rot[0] ?? 0) > 1e-6 || Math.abs(rot[2] ?? 0) > 1e-6) continue
      const frame = itemWorldPlan(nodes, node)
      const dims = node.asset?.dimensions
      if (!frame || !Array.isArray(dims) || dims.some((d) => !(d > 0))) continue
      scoped.set(node.id, {
        node,
        dims: dims as [number, number, number],
        frame,
        aabb: aabbOf(frame.x, frame.z, dims as [number, number, number], frame.yaw),
      })
    }
  }

  const zoneOfPoint = (x: number, z: number) => {
    for (const zone of zonePolygons.values()) {
      if (pointInPolygon([x, z], zone.polygon, true)) return zone
    }
    return undefined
  }

  const pending = new Map<
    string,
    { rotation?: [number, number, number]; position?: [number, number, number] }
  >()
  const pend = (id: string) => {
    const p = pending.get(id) ?? {}
    pending.set(id, p)
    return p
  }

  const setYaw = (item: ScopedItem, worldYaw: number) => {
    pend(item.node.id).rotation = [
      item.node.rotation?.[0] ?? 0,
      worldYaw,
      item.node.rotation?.[2] ?? 0,
    ]
    item.frame = { ...item.frame, yaw: worldYaw }
    item.aabb = aabbOf(item.frame.x, item.frame.z, item.dims, worldYaw)
  }

  const overlapsAnything = (self: ScopedItem, aabb: PlanAabb) => {
    for (const other of scoped.values()) {
      if (other.node.id === self.node.id) continue
      if (aabbsOverlap(aabb, other.aabb)) return true
    }
    return keepouts.some((k) => aabbsOverlap(aabb, k))
  }

  /** Try candidate positions along `dirs` (unit vectors) until one validates. */
  const tryMove = (
    item: ScopedItem,
    dirs: Vec2[],
    accept: (aabb: PlanAabb, x: number, z: number) => boolean,
  ): { x: number; z: number } | undefined => {
    const dims = item.dims
    const homeZone = zoneOfPoint(item.frame.x, item.frame.z)
    for (const dir of dirs) {
      for (let step = NUDGE_STEP; step <= MAX_NUDGE + 1e-9; step += NUDGE_STEP) {
        const x = item.frame.x + dir[0] * step
        const z = item.frame.z + dir[1] * step
        if (homeZone && !pointInPolygon([x, z], homeZone.polygon, false)) break
        const candidate = aabbOf(x, z, dims, item.frame.yaw)
        if (overlapsAnything(item, candidate)) continue
        if (!accept(candidate, x, z)) continue
        return { x, z }
      }
    }
    return undefined
  }

  const commitMove = (item: ScopedItem, x: number, z: number) => {
    const dx = x - item.frame.x
    const dz = z - item.frame.z
    pend(item.node.id).position = [
      (item.node.position?.[0] ?? 0) + dx,
      item.node.position?.[1] ?? 0,
      (item.node.position?.[2] ?? 0) + dz,
    ]
    item.frame = { ...item.frame, x, z }
    item.aabb = aabbOf(x, z, item.dims, item.frame.yaw)
  }

  const towardInterior = (item: ScopedItem, from: Vec2): Vec2[] => {
    const zone = zoneOfPoint(item.frame.x, item.frame.z)
    const out: Vec2[] = []
    const away: Vec2 = [item.frame.x - from[0], item.frame.z - from[1]]
    const al = Math.hypot(away[0], away[1])
    if (al > 1e-6) out.push([away[0] / al, away[1] / al])
    if (zone) {
      const d: Vec2 = [zone.center[0] - item.frame.x, zone.center[1] - item.frame.z]
      const l = Math.hypot(d[0], d[1])
      if (l > 1e-6) out.push([d[0] / l, d[1] / l])
    }
    if (al > 1e-6) out.push([-away[1] / al, away[0] / al], [away[1] / al, -away[0] / al])
    return out
  }

  const nearestWallTo = (levelId: string | undefined, point: Vec2) => {
    const onLevel = levelId ? nodesOnLevel(nodes, levelId) : []
    const walls = onLevel.filter((n): n is AnyNode & { type: 'wall' } => n.type === 'wall')
    let nearest: { wall: (typeof walls)[number]; distance: number } | undefined
    for (const wall of walls) {
      const d = pointSegmentDistance(point, wall.start as Vec2, wall.end as Vec2)
      if (!nearest || d < nearest.distance) nearest = { wall, distance: d }
    }
    return nearest
  }

  const fixIssue = (issue: (typeof issues)[number]): FixResult => {
    const [aId, bId] = issue.nodeIds
    switch (issue.code) {
      case 'seat_facing': {
        const seat = aId ? scoped.get(aId) : undefined
        const table = bId ? nodes[bId] : undefined
        if (!seat || !table) return { reason: 'seat or table is not a movable floor item' }
        const { yaw } = resolveFacingYaw(
          nodes,
          [seat.frame.x, seat.frame.z],
          itemFront(seat.node),
          { mode: 'node', nodeId: bId as string },
        )
        setYaw(seat, yaw)
        return { fix: 'rotated', detail: `rotated to face ${itemName(table)}` }
      }
      case 'faces_wall': {
        const item = aId ? scoped.get(aId) : undefined
        if (!item) return { reason: 'item is not a movable floor item' }
        setYaw(item, item.frame.yaw + Math.PI)
        return { fix: 'rotated', detail: 'turned its front away from the wall' }
      }
      case 'headboard_off_wall':
      case 'storage_off_wall': {
        const item = aId ? scoped.get(aId) : undefined
        if (!item) return { reason: 'item is not a movable floor item' }
        const dims = item.dims
        const front = itemFront(item.node)
        const along =
          front === 'z+' || front === 'z-' ? Math.abs(dims[2] ?? 1) : Math.abs(dims[0] ?? 1)
        const dir = frontDirection(item.frame.yaw, front)
        const back: Vec2 = [
          item.frame.x - dir[0] * (along / 2),
          item.frame.z - dir[1] * (along / 2),
        ]
        const levelId = levelIds.find((lid) =>
          nodesOnLevel(nodes, lid).some((n) => n.id === item.node.id),
        )
        const nearest = nearestWallTo(levelId, back)
        if (!nearest || nearest.distance <= FLUSH_GAP + 0.01)
          return { reason: 'no wall to push against' }
        const wall = nearest.wall
        const wx = wall.end[0] - wall.start[0]
        const wz = wall.end[1] - wall.start[1]
        const wl2 = wx * wx + wz * wz || 1
        const t = Math.max(
          0,
          Math.min(1, ((back[0] - wall.start[0]) * wx + (back[1] - wall.start[1]) * wz) / wl2),
        )
        const moveDir: Vec2 = [wall.start[0] + wx * t - back[0], wall.start[1] + wz * t - back[1]]
        const ml = Math.hypot(moveDir[0], moveDir[1])
        if (ml < 1e-6) return { reason: 'already touching the wall' }
        moveDir[0] /= ml
        moveDir[1] /= ml
        const step = Math.min(Math.max(0, nearest.distance - FLUSH_GAP), MAX_NUDGE)
        const x = item.frame.x + moveDir[0] * step
        const z = item.frame.z + moveDir[1] * step
        const candidate = aabbOf(x, z, dims, item.frame.yaw)
        if (overlapsAnything(item, candidate))
          return { reason: 'the space by the wall is already occupied' }
        commitMove(item, x, z)
        return { fix: 'moved', detail: `pushed flush to wall ${wall.id}` }
      }
      case 'front_clearance':
      case 'back_clearance': {
        const victim = aId ? scoped.get(aId) : undefined
        const blocker = bId ? scoped.get(bId) : undefined
        if (!victim || !blocker) return { reason: 'items involved are not movable floor items' }
        const dir = frontDirection(victim.frame.yaw, itemFront(victim.node))
        const retreat: Vec2 = issue.code === 'front_clearance' ? [-dir[0], -dir[1]] : dir
        // First slide the victim straight back out of the blocked zone.
        const slide = tryMove(
          victim,
          [retreat, [-retreat[1], retreat[0]], [retreat[1], -retreat[0]]],
          (cand) => !aabbsOverlap(cand, blocker.aabb, 0.1),
        )
        if (slide) {
          commitMove(victim, slide.x, slide.z)
          return {
            fix: 'moved',
            detail: `slid ${itemName(victim.node)} clear of ${itemName(blocker.node)}`,
          }
        }
        // Then push the blocker away from the victim.
        const push = tryMove(
          blocker,
          towardInterior(blocker, [victim.frame.x, victim.frame.z]),
          (cand) => !aabbsOverlap(cand, victim.aabb, 0.1),
        )
        if (push) {
          commitMove(blocker, push.x, push.z)
          return { fix: 'moved', detail: `moved ${itemName(blocker.node)} out of the clearance` }
        }
        return { reason: 'no free spot for either item' }
      }
      case 'door_blocked':
      case 'walkway_blocked': {
        const item = aId ? scoped.get(aId) : undefined
        if (!item) return { reason: 'item is not a movable floor item' }
        const hit = keepouts.find((k) => aabbsOverlap(k, item.aabb))
        const from: Vec2 = hit
          ? [(hit.minX + hit.maxX) / 2, (hit.minZ + hit.maxZ) / 2]
          : [item.frame.x + 1, item.frame.z]
        const moved = tryMove(item, towardInterior(item, from), (cand) =>
          keepouts.every((k) => !aabbsOverlap(cand, k)),
        )
        if (!moved) return { reason: 'no free spot clear of the door zone' }
        commitMove(item, moved.x, moved.z)
        return { fix: 'moved', detail: 'moved out of the door clear zone' }
      }
      case 'item_overlap':
      case 'item_too_close': {
        const a = aId ? scoped.get(aId) : undefined
        const b = bId ? scoped.get(bId) : undefined
        if (!a || !b) return { reason: 'items involved are not movable floor items' }
        const roleA = itemRole(a.node)
        const roleB = itemRole(b.node)
        const mover = HEAVY_ROLES.has(roleA ?? '') && !HEAVY_ROLES.has(roleB ?? '') ? b : a
        const other = mover === a ? b : a
        const gap = issue.code === 'item_overlap' ? -0.02 : 0.1
        const moved = tryMove(
          mover,
          towardInterior(mover, [other.frame.x, other.frame.z]),
          (cand) => !aabbsOverlap(cand, other.aabb, gap),
        )
        if (!moved) return { reason: 'no free spot to separate the pair' }
        commitMove(mover, moved.x, moved.z)
        return {
          fix: 'moved',
          detail: `moved ${itemName(mover.node)} away from ${itemName(other.node)}`,
        }
      }
      default:
        return { reason: 'no automatic fix for this finding' }
    }
  }

  const fixed: { code: string; itemId?: string; fix: Fix; detail: string }[] = []
  const unfixed: { code: string; itemId?: string; reason: string }[] = []
  for (const issue of issues) {
    const result = fixIssue(issue)
    if ('fix' in result)
      fixed.push({
        code: issue.code,
        itemId: issue.nodeIds[0],
        fix: result.fix,
        detail: result.detail,
      })
    else unfixed.push({ code: issue.code, itemId: issue.nodeIds[0], reason: result.reason })
  }

  return {
    result: {
      ok: unfixed.length === 0,
      scope: review.result.scope,
      fixed,
      unfixed,
      fixedCount: fixed.length,
      issueCount: issues.length,
      hint: 'Re-run review_layout to confirm the fixes landed.',
    },
    changes: {
      update: [...pending.entries()].map(([id, data]) => ({ id, data })),
    },
  }
}

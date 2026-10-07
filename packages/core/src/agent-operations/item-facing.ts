/**
 * Item facing math for agent tools.
 *
 * An item's FRONT is the side a person interacts with — the seat edge of a
 * chair, the screen of a TV, the doors of a wardrobe — and points along local
 * +Z at yaw 0 (the plan symbols draw backs at -depth/2). `asset.front`
 * declares a different axis for assets authored another way, so the same
 * "face toward" request maps to the right yaw for every catalog shape.
 */

import type { FacingSpec } from '../agent-tools/items'
import { refuse } from '../agent-tools/refusal'
import type { AnyNode } from '../schema'
import { type Vec2, wallLength } from './plan-geometry'
import type { SceneNodes } from './types'

export type ItemFront = 'z+' | 'z-' | 'x+' | 'x-'

/** The declared facing axis, defaulting to the +Z convention. */
export function itemFront(item: { asset?: { front?: ItemFront } }): ItemFront {
  return item.asset?.front ?? 'z+'
}

const FRONT_LOCAL: Record<ItemFront, Vec2> = {
  'z+': [0, 1],
  'z-': [0, -1],
  'x+': [1, 0],
  'x-': [-1, 0],
}

const ROTATE_XZ = (x: number, z: number, yaw: number): Vec2 => [
  x * Math.cos(yaw) + z * Math.sin(yaw),
  -x * Math.sin(yaw) + z * Math.cos(yaw),
]

/** Unit direction the item's front points along, in its parent's plan frame. */
export function frontDirection(yaw: number, front: ItemFront = 'z+'): Vec2 {
  const [fx, fz] = FRONT_LOCAL[front]
  return ROTATE_XZ(fx, fz, yaw)
}

/** Yaw that points the item's front along `dir` (does not need to be a unit vector). */
export function yawToFaceDirection(dir: Vec2, front: ItemFront = 'z+'): number {
  const [fx, fz] = FRONT_LOCAL[front]
  // R(yaw) maps the front axis onto dir; expressed in atan2-space it is a shift.
  return Math.atan2(dir[0], dir[1]) - Math.atan2(fx, fz)
}

export type ItemPlanFrame = { x: number; z: number; yaw: number }

/**
 * World-plan pose of an item: level-parented items use their own transform;
 * item-hosted children are positioned and turned in the host's frame, so the
 * host's position and yaw carry through (host scale stretches the offset).
 */
export function itemWorldPlan(
  nodes: SceneNodes | ReadonlyMap<string, AnyNode>,
  item: AnyNode,
): ItemPlanFrame | null {
  if (item.type !== 'item') return null
  const isMap = typeof (nodes as ReadonlyMap<string, AnyNode>).get === 'function'
  const get = (id: string | null | undefined) =>
    id == null
      ? undefined
      : isMap
        ? (nodes as ReadonlyMap<string, AnyNode>).get(id)
        : (nodes as SceneNodes)[id]
  let x = item.position[0] ?? 0
  let z = item.position[2] ?? 0
  let yaw = item.rotation?.[1] ?? 0
  let parent = get(item.parentId)
  let hops = 0
  while (parent?.type === 'item' && hops < 4) {
    const hostYaw = parent.rotation?.[1] ?? 0
    const sx = parent.scale?.[0] ?? 1
    const sz = parent.scale?.[2] ?? 1
    const [wx, wz] = ROTATE_XZ(x * sx, z * sz, hostYaw)
    x = (parent.position[0] ?? 0) + wx
    z = (parent.position[2] ?? 0) + wz
    yaw += hostYaw
    parent = get(parent.parentId ?? null)
    hops++
  }
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) return null
  return { x, z, yaw }
}

function nodePlanPoint(nodes: SceneNodes, node: AnyNode): Vec2 | null {
  if (node.type === 'item') {
    const frame = itemWorldPlan(nodes, node)
    return frame ? [frame.x, frame.z] : null
  }
  if (node.type === 'wall') {
    return [(node.start[0] + node.end[0]) / 2, (node.start[1] + node.end[1]) / 2]
  }
  const position = (node as { position?: readonly number[] }).position
  if (Array.isArray(position) && position.length >= 3) return [position[0] ?? 0, position[2] ?? 0]
  return null
}

/**
 * Resolve a `facing` spec into the yaw (radians) that aims the item's front —
 * in the frame the caller's position is given in (level frame for floor items,
 * host frame for hosted ones when the origin is already host-local).
 */
export function resolveFacingYaw(
  nodes: SceneNodes,
  origin: Vec2,
  front: ItemFront,
  facing: FacingSpec,
): { yaw: number; target: Vec2 } {
  let target: Vec2
  if (facing.mode === 'point') {
    target = [facing.point[0] ?? 0, facing.point[1] ?? 0]
  } else {
    const node = nodes[facing.nodeId]
    if (!node) refuse('target_not_found', `Facing target node not found: ${facing.nodeId}.`)
    const point = nodePlanPoint(nodes, node)
    if (!point)
      refuse(
        'target_no_position',
        `Node ${facing.nodeId} (${node.type}) has no plan position to face.`,
      )
    target = point
  }
  const dir: Vec2 = [target[0] - origin[0], target[1] - origin[1]]
  if (Math.hypot(dir[0], dir[1]) < 1e-6)
    refuse(
      'no_direction',
      `Facing target sits at the item's own position; give it somewhere to look.`,
    )
  const yaw = yawToFaceDirection(dir, front)
  return { yaw: facing.mode === 'away' ? yaw + Math.PI : yaw, target }
}

/** Angle (radians, 0..π) between two plan directions. */
export function angleBetweenDirections(a: Vec2, b: Vec2): number {
  const la = Math.hypot(a[0], a[1])
  const lb = Math.hypot(b[0], b[1])
  if (la < 1e-9 || lb < 1e-9) return 0
  const cos = (a[0] * b[0] + a[1] * b[1]) / (la * lb)
  return Math.acos(Math.max(-1, Math.min(1, cos)))
}

export type ItemRole =
  | 'seat'
  | 'table'
  | 'desk'
  | 'bed'
  | 'storage'
  | 'fixture'
  | 'appliance'
  | 'media'
  | 'decor'

const ROLE_TAGS: [ItemRole, RegExp][] = [
  ['seat', /chair|sofa|seat|seating|stool|armchair|lounge|bean.?bag|bench/],
  ['table', /table|coffee/],
  ['desk', /desk|office/],
  ['bed', /bed|bunk/],
  [
    'storage',
    /closet|dresser|shelf|shelving|cabinet|storage|wardrobe|bookcase|bookshelf|stand|rack|drawer/,
  ],
  ['fixture', /toilet|sink|basin|bath|shower|faucet|vanity/],
  [
    'appliance',
    /fridge|stove|oven|washer|washing|dishwasher|microwave|kettle|toaster|coffee.?machine|dryer/,
  ],
  ['media', /tv|television|screen|monitor|computer|speaker|stereo/],
]

/**
 * What an item is for layout reasoning: the declared `asset.role`, else a
 * tag/name guess. Returns undefined when nothing matches — checks then skip
 * the item instead of guessing wrong.
 */
export function itemRole(item: AnyNode): ItemRole | undefined {
  if (item.type !== 'item') return undefined
  const declared = item.asset?.role
  if (declared) return declared as ItemRole
  const haystack = [item.asset?.id, item.asset?.name, item.name, ...(item.asset?.tags ?? [])]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ')
    .toLowerCase()
  for (const [role, pattern] of ROLE_TAGS) if (pattern.test(haystack)) return role
  return undefined
}

/** Distance from a point to a wall segment in plan. */
export function pointToSegmentDistance(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const lenSq = dx * dx + dz * dz
  if (lenSq < 1e-12) return Math.hypot(point[0] - a[0], point[1] - a[1])
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / lenSq))
  return Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dz * t))
}

/**
 * Distance along `dir` from `origin` until the ray hits the segment
 * ([0, +∞) — Infinity when the ray misses the segment span.
 */
export function raySegmentDistance(origin: Vec2, dir: Vec2, a: Vec2, b: Vec2): number {
  const sx = b[0] - a[0]
  const sz = b[1] - a[1]
  const denom = dir[0] * sz - dir[1] * sx
  if (Math.abs(denom) < 1e-12) return Number.POSITIVE_INFINITY
  const qx = a[0] - origin[0]
  const qz = a[1] - origin[1]
  const t = (qx * sz - qz * sx) / denom
  const s = (qx * dir[1] - qz * dir[0]) / denom
  return t >= 0 && s >= -1e-9 && s <= 1 + 1e-9 ? t : Number.POSITIVE_INFINITY
}

/** Corner points (plan) of an item's yaw-aware footprint. */
export function itemFootprintCorners(
  center: Vec2,
  dimensions: [number, number, number],
  yaw: number,
): Vec2[] {
  const [w, , d] = dimensions
  const hw = Math.abs(w) / 2
  const hd = Math.abs(d) / 2
  const local: Vec2[] = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ]
  return local.map(([x, z]) => {
    const [rx, rz] = ROTATE_XZ(x, z, yaw)
    return [center[0] + rx, center[1] + rz]
  })
}

/**
 * Corners of the free space an item needs on one of its sides: `which` 'front'
 * extrudes past the front edge, 'back' past the back edge (a chair's pull-out).
 */
export function itemSideClearanceCorners(
  center: Vec2,
  dimensions: [number, number, number],
  yaw: number,
  front: ItemFront,
  which: 'front' | 'back',
  clearance: number,
): Vec2[] {
  const [w, , d] = dimensions
  const along = front === 'z+' || front === 'z-' ? Math.abs(d) : Math.abs(w)
  const across = front === 'z+' || front === 'z-' ? Math.abs(w) : Math.abs(d)
  const out = which === 'front' ? 1 : -1
  const nearEdge = (along / 2) * out
  const farEdge = (along / 2 + clearance) * out
  const acrossHalf = across / 2
  // Rect in a frame whose "v" axis is the local front direction.
  const [fx, fz] = FRONT_LOCAL[front]
  // lateral unit: rotate the front axis by -90° in local plan
  const lx = fz
  const lz = -fx
  const local: Vec2[] = [
    [fx * nearEdge + lx * -acrossHalf, fz * nearEdge + lz * -acrossHalf],
    [fx * nearEdge + lx * acrossHalf, fz * nearEdge + lz * acrossHalf],
    [fx * farEdge + lx * acrossHalf, fz * farEdge + lz * acrossHalf],
    [fx * farEdge + lx * -acrossHalf, fz * farEdge + lz * -acrossHalf],
  ]
  return local.map(([x, z]) => {
    const [rx, rz] = ROTATE_XZ(x, z, yaw)
    return [center[0] + rx, center[1] + rz]
  })
}

export function aabbOfPoints(points: Vec2[]): {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
} {
  const xs = points.map((p) => p[0])
  const zs = points.map((p) => p[1])
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
  }
}

export { wallLength }

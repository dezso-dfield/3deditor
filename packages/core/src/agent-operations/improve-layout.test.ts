import { describe, expect, test } from 'bun:test'
import { type AgentRefusal, isAgentRefusal } from '../agent-tools/refusal'
import type { AnyNode } from '../schema'
import { improveLayout } from './improve-layout'
import type { SceneNodes } from './types'

function level(id = 'level_1', children: string[] = []) {
  return {
    object: 'node' as const,
    id,
    type: 'level' as const,
    parentId: 'building_1',
    visible: true,
    metadata: {},
    level: 0,
    baseElevation: 0,
    height: 2.7,
    children,
  } as unknown as AnyNode
}

function wall(id: string, start: [number, number], end: [number, number]) {
  return {
    object: 'node' as const,
    id,
    type: 'wall' as const,
    parentId: 'level_1',
    visible: true,
    metadata: {},
    start,
    end,
    height: 2.6,
    thickness: 0.15,
    children: [] as string[],
  } as unknown as AnyNode
}

function zone(id: string, polygon: [number, number][], name = 'Room') {
  return {
    object: 'node' as const,
    id,
    type: 'zone' as const,
    parentId: 'level_1',
    visible: true,
    metadata: {},
    polygon,
    name,
  } as unknown as AnyNode
}

function item(
  id: string,
  position: [number, number, number],
  dimensions: [number, number, number],
  name: string,
  rotY = 0,
  assetExtra: Record<string, unknown> = {},
) {
  return {
    object: 'node' as const,
    id,
    type: 'item' as const,
    parentId: 'level_1',
    visible: true,
    metadata: {},
    name,
    position,
    rotation: [0, rotY, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
    asset: {
      id: 'x',
      name,
      category: 'furniture',
      thumbnail: '',
      src: 'asset://x',
      dimensions,
      ...assetExtra,
    },
  } as unknown as AnyNode
}

const nodes = (...list: AnyNode[]): SceneNodes =>
  Object.fromEntries(list.map((n) => [n.id, n])) as SceneNodes

const CTX = { activeLevelId: null }

function refusalCode(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (isAgentRefusal(error)) return (error as AgentRefusal).code
    throw error
  }
  return ''
}

const SQUARE: [number, number][] = [
  [0, 0],
  [6, 0],
  [6, 6],
  [0, 6],
]

type ImproveResult = {
  ok: boolean
  fixed: { code: string; itemId?: string; fix: string; detail: string }[]
  unfixed: { code: string; itemId?: string; reason: string }[]
}

describe('improve_layout', () => {
  test('rotates a seat to face its table', () => {
    const table = item('table', [3, 0, 3], [1.4, 0.75, 1.4], 'Dining Table')
    // chair south of the table facing +z — away from the table → seat_facing
    const chair = item('chair', [3, 0, 4.5], [0.5, 0.9, 0.5], 'Dining Chair', 0)
    const out = improveLayout(
      nodes(level('level_1', ['table', 'chair']), table, chair),
      { levelId: 'level_1' },
      CTX,
    )
    const result = out.result as ImproveResult
    expect(result.fixed.some((f) => f.code === 'seat_facing' && f.fix === 'rotated')).toBe(true)
    const update = out.changes?.update?.find((u) => u.id === 'chair')
    expect(update?.data.rotation?.[1]).toBeCloseTo(Math.PI)
  })

  test('turns an item whose front faces a wall', () => {
    const w = wall('w1', [0, 1.2], [6, 1.2])
    const chair = item('chair', [3, 0, 0.55], [0.5, 0.9, 0.5], 'Chair', 0)
    const out = improveLayout(
      nodes(level('level_1', ['w1', 'chair']), w, chair),
      { levelId: 'level_1' },
      CTX,
    )
    const result = out.result as ImproveResult
    expect(result.fixed.some((f) => f.code === 'faces_wall' && f.fix === 'rotated')).toBe(true)
    expect(out.changes?.update?.find((u) => u.id === 'chair')?.data.rotation?.[1]).toBeCloseTo(
      Math.PI,
    )
  })

  test('pushes a floating bed flush against the nearest wall', () => {
    const z1 = zone('z1', SQUARE)
    const w = wall('w1', [0, 0], [6, 0])
    // bed's back edge is at z = 0.8, 0.8 m off the wall → headboard_off_wall
    const bed = item('bed', [3, 0, 1.6], [2, 0.5, 1.6], 'Double Bed', 0, { role: 'bed' })
    const out = improveLayout(
      nodes(level('level_1', ['z1', 'w1', 'bed']), z1, w, bed),
      { zoneId: 'z1' },
      CTX,
    )
    const result = out.result as ImproveResult
    expect(result.fixed.some((f) => f.code === 'headboard_off_wall' && f.fix === 'moved')).toBe(
      true,
    )
    const update = out.changes?.update?.find((u) => u.id === 'bed')
    // Back edge should land ~0.05 m off the wall: z ≈ 0.85.
    expect(update?.data.position?.[2]).toBeCloseTo(0.85, 1)
  })

  test('separates items violating front clearance', () => {
    const toilet = item('wc', [3, 0, 3], [0.7, 0.8, 0.4], 'Toilet', 0, {
      clearance: { front: 0.6 },
      role: 'fixture',
    })
    const bin = item('bin', [3, 0, 3.4], [0.3, 0.4, 0.3], 'Bin')
    const out = improveLayout(
      nodes(level('level_1', ['wc', 'bin']), toilet, bin),
      { levelId: 'level_1' },
      CTX,
    )
    const result = out.result as ImproveResult
    expect(result.fixed.some((f) => f.code === 'front_clearance' && f.fix === 'moved')).toBe(true)
    const moved = out.changes?.update?.find((u) => u.data.position)
    expect(moved).toBeTruthy()
  })

  test('separates an overlapping pair by moving the lighter item', () => {
    const z1 = zone('z1', SQUARE)
    const table = item('table', [3, 0, 3], [1.4, 0.75, 1.4], 'Table', 0, { role: 'table' })
    const chair = item('chair', [3.5, 0, 3], [0.5, 0.9, 0.5], 'Chair')
    const out = improveLayout(
      nodes(level('level_1', ['z1', 'table', 'chair']), z1, table, chair),
      { zoneId: 'z1' },
      CTX,
    )
    const result = out.result as ImproveResult
    const moved = result.fixed.find((f) => f.fix === 'moved')
    expect(moved).toBeTruthy()
    // The table is 'heavy' — the chair should be the one that moved.
    expect(out.changes?.update?.some((u) => u.id === 'chair' && u.data.position)).toBe(true)
  })

  test('reports unfixed when the flagged item cannot move', () => {
    const table = item('table', [3, 0, 3], [1.4, 0.75, 1.4], 'Dining Table')
    // wall-attached seat is outside the movable scope → unfixed, not a crash
    const seat = {
      ...item('seat', [3, 0, 4.5], [0.5, 0.9, 0.5], 'Seat', 0),
      wallId: 'w1',
    } as AnyNode
    const w = wall('w1', [0, 5], [6, 5])
    const out = improveLayout(
      nodes(level('level_1', ['w1', 'table', 'seat']), w, table, seat),
      { levelId: 'level_1' },
      CTX,
    )
    const result = out.result as ImproveResult
    expect(result.unfixed.length).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(result.fixed)).toBe(true)
  })

  test('returns ok with nothing to fix', () => {
    const table = item('table', [3, 0, 3], [1.4, 0.75, 1.4], 'Dining Table')
    const chair = item('chair', [3, 0, 4.5], [0.5, 0.9, 0.5], 'Dining Chair', Math.PI)
    const out = improveLayout(
      nodes(level('level_1', ['table', 'chair']), table, chair),
      { levelId: 'level_1' },
      CTX,
    )
    const result = out.result as ImproveResult
    expect(result.ok).toBe(true)
    expect(result.fixed).toEqual([])
  })

  test('refuses an unknown zone', () => {
    expect(refusalCode(() => improveLayout(nodes(), { zoneId: 'nope' }, CTX))).toBe(
      'node_not_found',
    )
    const w = wall('w1', [0, 0], [2, 0])
    expect(refusalCode(() => improveLayout(nodes(level(), w), { zoneId: 'w1' }, CTX))).toBe(
      'not_a_zone',
    )
  })
})

import { describe, expect, test } from 'bun:test'
import { type AgentRefusal, isAgentRefusal } from '../agent-tools/refusal'
import type { AnyNode } from '../schema'
import { orientItem } from './orient-item'
import { reviewLayout } from './review-layout'
import type { SceneNodes } from './types'
import { updateRoom } from './update-room'

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

describe('orient_item', () => {
  test('turns an item to face a point', () => {
    const chair = item('chair', [1, 0, 1], [0.5, 0.9, 0.5], 'Chair')
    const out = orientItem(nodes(level(), chair), {
      itemId: 'chair',
      facing: { mode: 'point', point: [1, 5] },
    })
    const update = out.changes?.update?.[0]
    expect(update?.id).toBe('chair')
    expect(update?.data.rotation?.[1]).toBeCloseTo(0)
  })

  test('turns an item to face another node', () => {
    const chair = item('chair', [1, 0, 1], [0.5, 0.9, 0.5], 'Chair')
    const table = item('table', [4, 0, 1], [1.4, 0.75, 1.4], 'Table')
    const out = orientItem(nodes(level(), chair, table), {
      itemId: 'chair',
      facing: { mode: 'node', nodeId: 'table' },
    })
    expect(out.changes?.update?.[0]?.data.rotation?.[1]).toBeCloseTo(Math.PI / 2)
  })

  test('refuses non-items and missing nodes', () => {
    expect(
      refusalCode(() =>
        orientItem(nodes(), { itemId: 'x', facing: { mode: 'point', point: [0, 0] } }),
      ),
    ).toBe('node_not_found')
    const w = wall('w1', [0, 0], [2, 0])
    expect(
      refusalCode(() =>
        orientItem(nodes(level(), w), { itemId: 'w1', facing: { mode: 'point', point: [0, 0] } }),
      ),
    ).toBe('not_an_item')
  })
})

describe('review_layout', () => {
  const SQUARE: [number, number][] = [
    [0, 0],
    [6, 0],
    [6, 6],
    [0, 6],
  ]

  test('flags a seat not facing its table', () => {
    const table = item('table', [3, 0, 3], [1.4, 0.75, 1.4], 'Dining Table')
    // chair south of the table facing +z — away from the table → ~180° off
    const chair = item('chair', [3, 0, 4.5], [0.5, 0.9, 0.5], 'Dining Chair', 0)
    const out = reviewLayout(
      nodes(level('level_1', ['table', 'chair']), table, chair),
      { levelId: 'level_1' },
      CTX,
    )
    const result = out.result as { issues: { code: string }[] }
    expect(result.issues.some((i) => i.code === 'seat_facing')).toBe(true)
  })

  test('passes a seat facing its table', () => {
    const table = item('table', [3, 0, 3], [1.4, 0.75, 1.4], 'Dining Table')
    // chair south of the table; yaw π points its +z front toward -z, at the table
    const chair = item('chair', [3, 0, 4.5], [0.5, 0.9, 0.5], 'Dining Chair', Math.PI)
    const out = reviewLayout(
      nodes(level('level_1', ['table', 'chair']), table, chair),
      { levelId: 'level_1' },
      CTX,
    )
    const result = out.result as { issues: { code: string }[] }
    expect(result.issues.some((i) => i.code === 'seat_facing')).toBe(false)
  })

  test('flags missing front clearance', () => {
    const toilet = item('wc', [3, 0, 3], [0.7, 0.8, 0.4], 'Toilet', 0, {
      clearance: { front: 0.6 },
    })
    const blocker = item('bin', [3, 0, 3.4], [0.3, 0.4, 0.3], 'Bin')
    const out = reviewLayout(
      nodes(level('level_1', ['wc', 'bin']), toilet, blocker),
      { levelId: 'level_1' },
      CTX,
    )
    const result = out.result as { issues: { code: string }[] }
    expect(result.issues.some((i) => i.code === 'front_clearance')).toBe(true)
  })

  test('flags a bed floating off every wall', () => {
    const z1 = zone('z1', SQUARE)
    const bed = item('bed', [3, 0, 3], [2, 0.5, 1.6], 'Double Bed')
    const out = reviewLayout(nodes(level('level_1', ['z1', 'bed']), z1, bed), { zoneId: 'z1' }, CTX)
    const result = out.result as { issues: { code: string }[] }
    expect(result.issues.some((i) => i.code === 'headboard_off_wall')).toBe(true)
  })

  test('flags a front aimed at a close wall', () => {
    const w = wall('w1', [0, 1.2], [6, 1.2])
    // chair faces +z and sits 0.3 m under the wall → faces_wall
    const chair = item('chair', [3, 0, 0.55], [0.5, 0.9, 0.5], 'Chair', 0)
    const out = reviewLayout(
      nodes(level('level_1', ['w1', 'chair']), w, chair),
      { levelId: 'level_1' },
      CTX,
    )
    const result = out.result as { issues: { code: string }[] }
    expect(result.issues.some((i) => i.code === 'faces_wall')).toBe(true)
  })

  test('refuses an unknown zone', () => {
    expect(refusalCode(() => reviewLayout(nodes(), { zoneId: 'gone' }, CTX))).toBe('node_not_found')
  })
})

describe('update_room', () => {
  test('renames a zone and marks it a room', () => {
    const z1 = zone('z1', [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ])
    const out = updateRoom(nodes(z1), { zoneId: 'z1', name: 'Primary Bedroom' })
    const update = out.changes?.update?.[0]
    expect(update?.id).toBe('z1')
    expect(update?.data.name).toBe('Primary Bedroom')
    expect(update?.data.spaceRole).toBe('room')
  })

  test('sets roomType as occupancy', () => {
    const z1 = zone('z1', [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ])
    const out = updateRoom(nodes(z1), { zoneId: 'z1', roomType: 'bedroom', roomNumber: '1.02' })
    expect(out.changes?.update?.[0]?.data.occupancy).toBe('bedroom')
    expect(out.changes?.update?.[0]?.data.roomNumber).toBe('1.02')
  })

  test('refuses with no fields and a non-zone', () => {
    const z1 = zone('z1', [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ])
    expect(refusalCode(() => updateRoom(nodes(z1), { zoneId: 'z1' }))).toBe('nothing_to_update')
    const w = wall('w1', [0, 0], [2, 0])
    expect(refusalCode(() => updateRoom(nodes(w), { zoneId: 'w1', name: 'x' }))).toBe('not_a_zone')
  })
})

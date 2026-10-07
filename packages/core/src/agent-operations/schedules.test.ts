import { describe, expect, test } from 'bun:test'
import type { AnyNode } from '../schema'
import { generateSchedule, materialsTakeoff } from './schedules'
import type { SceneNodes } from './types'

function level(id = 'level_1', children: string[] = [], floorIndex = 0) {
  return {
    object: 'node' as const,
    id,
    type: 'level' as const,
    parentId: 'building_1',
    visible: true,
    metadata: {},
    level: floorIndex,
    baseElevation: 0,
    height: 2.7,
    children,
  } as unknown as AnyNode
}

function wall(id: string, start: [number, number], end: [number, number], children: string[] = []) {
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
    children,
  } as unknown as AnyNode
}

function door(id: string, wallId: string) {
  return {
    object: 'node' as const,
    id,
    type: 'door' as const,
    parentId: wallId,
    visible: true,
    metadata: {},
    position: [1, 1.05, 0],
    width: 0.9,
    height: 2.1,
    doorCategory: 'interior',
    doorType: 'hinged',
    openingKind: 'door',
  } as unknown as AnyNode
}

function window_(id: string, wallId: string) {
  return {
    object: 'node' as const,
    id,
    type: 'window' as const,
    parentId: wallId,
    visible: true,
    metadata: {},
    position: [2, 1.45, 0],
    width: 1.5,
    height: 1.5,
    windowType: 'fixed',
  } as unknown as AnyNode
}

function zone(id: string, polygon: [number, number][], extra: Record<string, unknown> = {}) {
  return {
    object: 'node' as const,
    id,
    type: 'zone' as const,
    parentId: 'level_1',
    visible: true,
    metadata: {},
    polygon,
    name: 'Bedroom',
    ...extra,
  } as unknown as AnyNode
}

function slab(id: string, polygon: [number, number][], thickness = 0.2) {
  return {
    object: 'node' as const,
    id,
    type: 'slab' as const,
    parentId: 'level_1',
    visible: true,
    metadata: {},
    polygon,
    thickness,
    elevation: 0,
  } as unknown as AnyNode
}

function item(id: string, position: [number, number, number], catalogId: string) {
  return {
    object: 'node' as const,
    id,
    type: 'item' as const,
    parentId: 'level_1',
    visible: true,
    metadata: {},
    position,
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    asset: {
      id: catalogId,
      name: catalogId,
      category: 'furniture',
      thumbnail: '',
      src: `asset://${catalogId}`,
      dimensions: [0.9, 0.75, 0.9],
    },
  } as unknown as AnyNode
}

const nodes = (...list: AnyNode[]): SceneNodes =>
  Object.fromEntries(list.map((n) => [n.id, n])) as SceneNodes

const CTX = { activeLevelId: null }

const SQUARE: [number, number][] = [
  [0, 0],
  [4, 0],
  [4, 4],
  [0, 4],
]

function fixture() {
  const w1 = wall('w1', [0, 0], [4, 0], ['d1', 'win1'])
  const d1 = door('d1', 'w1')
  const win1 = window_('win1', 'w1')
  const z1 = zone('z1', SQUARE, {
    occupancy: 'bedroom',
    roomNumber: '101',
    ceilingHeight: 2.6,
    floorFinish: 'oak parquet',
    boundaryWallIds: ['w1'],
  })
  const s1 = slab('s1', SQUARE, 0.2)
  const bed = item('bed', [2, 0, 2], 'bed-double')
  const chair = item('chair', [3, 0, 3], 'chair-dining')
  const lvl = level('level_1', ['w1', 'd1', 'win1', 'z1', 's1', 'bed', 'chair'])
  return nodes(lvl, w1, d1, win1, z1, s1, bed, chair)
}

describe('generate_schedule', () => {
  test('prints room, door, window and item tables', () => {
    const out = generateSchedule(fixture(), { levelId: 'level_1' }, CTX)
    const r = out.result as {
      rooms: Record<string, unknown>[]
      doors: Record<string, unknown>[]
      windows: Record<string, unknown>[]
      items: Record<string, unknown>[]
    }
    expect(r.rooms).toHaveLength(1)
    const room = r.rooms[0]!
    expect(room.name).toBe('Bedroom')
    expect(room.roomType).toBe('bedroom')
    expect(room.roomNumber).toBe('101')
    expect(room.areaSqM).toBeCloseTo(16)
    expect(room.doors).toBe(1)
    expect(room.windows).toBe(1)
    expect(room.floorFinish).toBe('oak parquet')

    expect(r.doors).toHaveLength(1)
    expect(r.doors[0]!.widthM).toBe(0.9)
    expect(r.doors[0]!.category).toBe('interior')

    expect(r.windows).toHaveLength(1)
    expect(r.windows[0]!.sillHeightM).toBeCloseTo(0.7)

    expect(r.items).toHaveLength(2)
    expect(r.items.map((i) => i.catalogId)).toEqual(['bed-double', 'chair-dining'])
  })

  test('kind filter returns one table', () => {
    const out = generateSchedule(fixture(), { kind: 'doors' }, CTX)
    const r = out.result as Record<string, unknown>
    expect(r.doors).toHaveLength(1)
    expect(r.rooms).toBeUndefined()
    expect(r.items).toBeUndefined()
  })

  test('covers every level when levelId is omitted', () => {
    const s = fixture()
    const lvl2 = level('level_2', ['z2'], 1)
    const z2 = zone('z2', SQUARE, { name: 'Attic' })
    const scene = { ...s, [lvl2.id]: lvl2, [z2.id]: z2 } as SceneNodes
    const out = generateSchedule(scene, { kind: 'rooms' }, CTX)
    const r = out.result as { rooms: Record<string, unknown>[]; levelCount: number }
    expect(r.levelCount).toBe(2)
    expect(r.rooms.map((rm) => rm.name)).toEqual(['Bedroom', 'Attic'])
  })
})

describe('materials_takeoff', () => {
  test('totals floor, wall, opening and item quantities', () => {
    const out = materialsTakeoff(fixture(), {}, CTX)
    const r = out.result as {
      scope: string
      totals: Record<string, number>
      openings: { doorsByCategory: Record<string, number>; windowsByType: Record<string, number> }
      items: { byCatalogId: Record<string, number> }
      finishes: string[]
    }
    expect(r.scope).toBe('scene')
    expect(r.totals.floorAreaSqM).toBeCloseTo(16)
    expect(r.totals.slabVolumeM3).toBeCloseTo(3.2)
    expect(r.totals.wallLengthM).toBeCloseTo(4)
    // 4 m x resolved wall height (~2.6), minus 0.9*2.1 + 1.5*1.5
    expect(r.totals.grossWallAreaSqM).toBeGreaterThan(10)
    expect(r.totals.openingAreaSqM).toBeCloseTo(0.9 * 2.1 + 1.5 * 1.5)
    expect(r.totals.netWallAreaSqM).toBeCloseTo(r.totals.grossWallAreaSqM - r.totals.openingAreaSqM)
    expect(r.totals.doorCount).toBe(1)
    expect(r.totals.windowCount).toBe(1)
    expect(r.totals.itemCount).toBe(2)
    expect(r.openings.doorsByCategory.interior).toBe(1)
    expect(r.openings.windowsByType.fixed).toBe(1)
    expect(r.items.byCatalogId['bed-double']).toBe(1)
    expect(r.finishes).toContain('oak parquet')
    expect(r.totals.documentedRoomCount).toBe(1)
  })

  test('level scope restricts the totals', () => {
    const out = materialsTakeoff(fixture(), { levelId: 'level_1' }, CTX)
    const r = out.result as { scope: string; levelCount: number }
    expect(r.scope).toBe('level')
    expect(r.levelCount).toBe(1)
  })

  test('empty scene reports zeros without failing', () => {
    const out = materialsTakeoff(nodes(), {}, CTX)
    const r = out.result as { totals: Record<string, number>; levelCount: number }
    expect(r.levelCount).toBe(0)
    expect(r.totals.floorAreaSqM).toBe(0)
    expect(r.totals.wallCount).toBe(0)
  })
})

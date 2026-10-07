import { area } from '../lib/polygon-boolean'
import type {
  AnyNode,
  AnyNodeId,
  DoorNode,
  LevelNode,
  WallNode,
  WindowNode,
  ZoneNode,
} from '../schema'
import { itemWorldPlan } from './item-facing'
import { wallResolvedHeight } from './level-reads'
import { pointInPolygon, type Vec2 } from './plan-geometry'
import { nodesOnLevel } from './scene-queries'
import type { AgentOperation, SceneNodes } from './types'

const round2 = (value: number) => Math.round(value * 100) / 100

function ofType<T extends AnyNode['type']>(content: readonly AnyNode[], type: T) {
  return content.filter((node): node is Extract<AnyNode, { type: T }> => node.type === type)
}

function orderedLevels(nodes: SceneNodes): LevelNode[] {
  return Object.values(nodes)
    .filter((node): node is LevelNode => node.type === 'level')
    .sort((a, b) => a.level - b.level)
}

/** Levels a documentation read covers: the requested one, else every level in floor order. */
function documentationLevels(nodes: SceneNodes, input: { levelId?: string | undefined }) {
  if (input.levelId) {
    const level = nodes[input.levelId as AnyNodeId]
    if (level?.type === 'level') return [level]
    return []
  }
  return orderedLevels(nodes)
}

function polygonPerimeter(polygon: Vec2[]) {
  let total = 0
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!
    const b = polygon[(i + 1) % polygon.length]!
    total += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return total
}

function polygonArea(polygon: Vec2[], holes: Vec2[][] | undefined) {
  return area([{ outer: polygon, holes: holes ?? [] }])
}

/** Which room (zone) contains a plan point, if one does. */
function roomAt(zones: ZoneNode[], point: Vec2) {
  return zones.find((zone) => pointInPolygon(point, zone.polygon as Vec2[], true))
}

/**
 * Openings and items grouped per level: the raw material of schedules and
 * takeoffs. Door/window children hang off their host wall.
 */
function levelDocs(
  nodes: SceneNodes,
  level: LevelNode,
): {
  zones: ZoneNode[]
  walls: WallNode[]
  openings: { node: DoorNode | WindowNode; wall: WallNode }[]
  items: AnyNode[]
} {
  const content = nodesOnLevel(nodes, level.id)
  const zones = ofType(content, 'zone')
  const walls = ofType(content, 'wall')
  const openings: { node: DoorNode | WindowNode; wall: WallNode }[] = []
  for (const wall of walls) {
    for (const childId of wall.children) {
      const child = nodes[childId]
      if (child?.type === 'door' || child?.type === 'window') {
        openings.push({ node: child, wall })
      }
    }
  }
  return { zones, walls, openings, items: ofType(content, 'item') }
}

export const SCHEDULE_KINDS = ['rooms', 'doors', 'windows', 'items', 'all'] as const
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]

export type ScheduleInput = {
  levelId?: string | undefined
  kind?: ScheduleKind | undefined
}

/** `generate_schedule`: room/door/window/item documentation rows. */
export const generateSchedule: AgentOperation<ScheduleInput> = (nodes, input, _context) => {
  const kind = input.kind ?? 'all'
  const rooms: Record<string, unknown>[] = []
  const doors: Record<string, unknown>[] = []
  const windows: Record<string, unknown>[] = []
  const items: Record<string, unknown>[] = []

  for (const level of documentationLevels(nodes, input)) {
    const docs = levelDocs(nodes, level)
    if (kind === 'rooms' || kind === 'all') {
      for (const zone of docs.zones) {
        const openings = docs.openings.filter(({ wall }) => zone.boundaryWallIds?.includes(wall.id))
        rooms.push({
          level: level.name ?? level.id,
          name: zone.name ?? '',
          roomType: zone.occupancy || null,
          roomNumber: zone.roomNumber || null,
          areaSqM: round2(polygonArea(zone.polygon as Vec2[], zone.holes as Vec2[][] | undefined)),
          perimeterM: round2(polygonPerimeter(zone.polygon as Vec2[])),
          ceilingHeightM: zone.ceilingHeight ?? null,
          floorFinish: zone.floorFinish || null,
          wallFinish: zone.wallFinish || null,
          ceilingFinish: zone.ceilingFinish || null,
          doors: openings.filter((o) => o.node.type === 'door').length,
          windows: openings.filter((o) => o.node.type === 'window').length,
        })
      }
    }
    if (kind === 'doors' || kind === 'windows' || kind === 'all') {
      for (const { node, wall } of docs.openings) {
        const room = roomAt(docs.zones, [
          (wall.start[0] + wall.end[0]) / 2,
          (wall.start[1] + wall.end[1]) / 2,
        ])
        if (node.type === 'door' && (kind === 'doors' || kind === 'all')) {
          doors.push({
            level: level.name ?? level.id,
            room: room?.name ?? null,
            hostWallId: wall.id,
            category: node.doorCategory,
            doorType: node.doorType,
            widthM: node.width,
            heightM: node.height,
            onWallM: round2(node.position[0]),
          })
        }
        if (node.type === 'window' && (kind === 'windows' || kind === 'all')) {
          windows.push({
            level: level.name ?? level.id,
            room: room?.name ?? null,
            hostWallId: wall.id,
            windowType: node.windowType,
            widthM: node.width,
            heightM: node.height,
            sillHeightM: round2(node.position[1] - node.height / 2),
            onWallM: round2(node.position[0]),
          })
        }
      }
    }
    if (kind === 'items' || kind === 'all') {
      for (const item of docs.items) {
        const frame = itemWorldPlan(nodes, item)
        const room = frame ? roomAt(docs.zones, [frame.x, frame.z]) : undefined
        items.push({
          level: level.name ?? level.id,
          room: room?.name ?? null,
          name: item.name ?? ('asset' in item ? (item.asset?.name ?? null) : null),
          catalogId: 'asset' in item ? (item.asset?.id ?? null) : null,
          category: 'asset' in item ? (item.asset?.category ?? null) : null,
          count: 1,
        })
      }
    }
  }

  return {
    result: {
      kind,
      levelCount: documentationLevels(nodes, input).length,
      ...(kind === 'rooms' || kind === 'all' ? { rooms, roomCount: rooms.length } : {}),
      ...(kind === 'doors' || kind === 'all' ? { doors, doorCount: doors.length } : {}),
      ...(kind === 'windows' || kind === 'all' ? { windows, windowCount: windows.length } : {}),
      ...(kind === 'items' || kind === 'all' ? { items, itemCount: items.length } : {}),
    },
  }
}

export type TakeoffInput = { levelId?: string | undefined }

/** `materials_takeoff`: areas, volumes and counts the documentation set reads from. */
export const materialsTakeoff: AgentOperation<TakeoffInput> = (nodes, input, _context) => {
  const totals = {
    floorAreaSqM: 0,
    roomCount: 0,
    documentedRoomCount: 0,
    wallCount: 0,
    wallLengthM: 0,
    grossWallAreaSqM: 0,
    openingAreaSqM: 0,
    netWallAreaSqM: 0,
    slabCount: 0,
    slabAreaSqM: 0,
    slabVolumeM3: 0,
    roofCount: 0,
    roofSegmentCount: 0,
    roofFootprintAreaSqM: 0,
    doorCount: 0,
    windowCount: 0,
    itemCount: 0,
  }
  const doorsByCategory: Record<string, number> = {}
  const windowsByType: Record<string, number> = {}
  const itemsByCategory: Record<string, number> = {}
  const itemsByCatalogId: Record<string, number> = {}
  const finishes = new Set<string>()
  const levels: Record<string, unknown>[] = []

  for (const level of documentationLevels(nodes, input)) {
    const docs = levelDocs(nodes, level)
    const content = nodesOnLevel(nodes, level.id)
    const slabs = ofType(content, 'slab')
    const roofs = ofType(content, 'roof')
    const roofSegments = ofType(content, 'roof-segment')

    let levelFloorArea = 0
    for (const slab of slabs) {
      const slabArea = polygonArea(slab.polygon as Vec2[], slab.holes as Vec2[][] | undefined)
      totals.slabAreaSqM += slabArea
      totals.slabVolumeM3 += slabArea * (slab.thickness ?? 0.05)
      levelFloorArea += slabArea
      if (slab.materialPreset) finishes.add(slab.materialPreset)
    }
    totals.slabCount += slabs.length
    totals.floorAreaSqM += levelFloorArea

    let gross = 0
    let openingArea = 0
    for (const wall of docs.walls) {
      const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1])
      gross += length * wallResolvedHeight(nodes, wall)
      totals.wallLengthM += length
      if (wall.materialPreset) finishes.add(wall.materialPreset)
    }
    totals.wallCount += docs.walls.length
    totals.grossWallAreaSqM += gross

    for (const { node } of docs.openings) {
      openingArea += node.width * node.height
      if (node.type === 'door') {
        totals.doorCount++
        doorsByCategory[node.doorCategory] = (doorsByCategory[node.doorCategory] ?? 0) + 1
      } else {
        totals.windowCount++
        windowsByType[node.windowType] = (windowsByType[node.windowType] ?? 0) + 1
      }
    }
    totals.openingAreaSqM += openingArea
    totals.netWallAreaSqM += gross - openingArea

    for (const zone of docs.zones) {
      totals.roomCount++
      if (zone.roomNumber || zone.floorFinish || zone.wallFinish || zone.ceilingFinish) {
        totals.documentedRoomCount++
      }
      for (const finish of [zone.floorFinish, zone.wallFinish, zone.ceilingFinish]) {
        if (finish) finishes.add(finish)
      }
    }

    totals.roofCount += roofs.length
    totals.roofSegmentCount += roofSegments.length
    for (const segment of roofSegments) {
      totals.roofFootprintAreaSqM += segment.width * segment.depth
    }

    for (const item of docs.items) {
      totals.itemCount++
      if ('asset' in item && item.asset) {
        const category = item.asset.category ?? 'unknown'
        itemsByCategory[category] = (itemsByCategory[category] ?? 0) + 1
        itemsByCatalogId[item.asset.id] = (itemsByCatalogId[item.asset.id] ?? 0) + 1
      }
    }

    levels.push({
      levelId: level.id,
      name: level.name ?? level.id,
      floorIndex: level.level,
      floorAreaSqM: round2(levelFloorArea),
      rooms: docs.zones.length,
      walls: docs.walls.length,
      slabs: slabs.length,
      openings: docs.openings.length,
      items: docs.items.length,
    })
  }

  const r = (value: number) => round2(value)
  return {
    result: {
      scope: input.levelId ? 'level' : 'scene',
      levelCount: levels.length,
      levels,
      totals: {
        floorAreaSqM: r(totals.floorAreaSqM),
        roomCount: totals.roomCount,
        documentedRoomCount: totals.documentedRoomCount,
        wallCount: totals.wallCount,
        wallLengthM: r(totals.wallLengthM),
        grossWallAreaSqM: r(totals.grossWallAreaSqM),
        openingAreaSqM: r(totals.openingAreaSqM),
        netWallAreaSqM: r(totals.netWallAreaSqM),
        slabCount: totals.slabCount,
        slabAreaSqM: r(totals.slabAreaSqM),
        slabVolumeM3: r(totals.slabVolumeM3),
        roofCount: totals.roofCount,
        roofSegmentCount: totals.roofSegmentCount,
        roofFootprintAreaSqM: r(totals.roofFootprintAreaSqM),
        doorCount: totals.doorCount,
        windowCount: totals.windowCount,
        itemCount: totals.itemCount,
      },
      openings: {
        doorsByCategory,
        windowsByType,
      },
      items: {
        byCategory: itemsByCategory,
        byCatalogId: itemsByCatalogId,
      },
      finishes: [...finishes].sort(),
    },
  }
}

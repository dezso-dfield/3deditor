import type { z } from 'zod'
import type { applyStyleTool } from '../agent-tools/levels'
import { refuse } from '../agent-tools/refusal'
import { getCatalogMaterialById, parseMaterialRef } from '../material-library'
import { polygonBounds, type Vec2 } from './plan-geometry'
import { levelIdOf } from './scene-queries'
import type { AgentOperation } from './types'

export type ApplyStyleInput = z.infer<z.ZodObject<typeof applyStyleTool.input>>
export type StylePresetId = typeof import('../agent-tools/levels').STYLE_PRESET_IDS[number]

type StylePreset = {
  label: string
  floor: { ref: string; label: string }
  walls: { ref: string; label: string }
  ceiling: { ref: string; label: string }
  accent: { ref: string; label: string }
}

/**
 * Named interior styles as real finishes: every ref is a `library:` entry of
 * the material catalog (flat paints and flooring surfaces). The accent colour
 * lands on one wall face via the zone's `wallOverrides`.
 */
export const STYLE_PRESETS: Record<StylePresetId, StylePreset> = {
  modern: {
    label: 'Modern',
    floor: { ref: 'library:wood-floorplank1', label: 'light wood planks' },
    walls: { ref: 'library:preset-softwhite', label: 'soft white paint' },
    ceiling: { ref: 'library:preset-white', label: 'white paint' },
    accent: { ref: 'library:preset-charcoal', label: 'charcoal paint' },
  },
  scandinavian: {
    label: 'Scandinavian',
    floor: { ref: 'library:wood-woodfine11', label: 'pale oak floor' },
    walls: { ref: 'library:preset-white', label: 'white paint' },
    ceiling: { ref: 'library:preset-white', label: 'white paint' },
    accent: { ref: 'library:preset-powderblue', label: 'powder blue paint' },
  },
  japandi: {
    label: 'Japandi',
    floor: { ref: 'library:wood-woodfine2', label: 'warm oak floor' },
    walls: { ref: 'library:preset-cream', label: 'cream paint' },
    ceiling: { ref: 'library:preset-softwhite', label: 'soft white paint' },
    accent: { ref: 'library:preset-sage', label: 'sage green paint' },
  },
  industrial: {
    label: 'Industrial',
    floor: { ref: 'library:concrete-polished', label: 'polished concrete' },
    walls: { ref: 'library:concrete-plaster', label: 'plastered concrete' },
    ceiling: { ref: 'library:preset-charcoal', label: 'charcoal paint' },
    accent: { ref: 'library:flooring-agedbrick', label: 'aged brick' },
  },
  midcentury: {
    label: 'Midcentury',
    floor: { ref: 'library:wood-hungarianparquet10', label: 'herringbone parquet' },
    walls: { ref: 'library:preset-beige', label: 'warm beige paint' },
    ceiling: { ref: 'library:preset-white', label: 'white paint' },
    accent: { ref: 'library:preset-teal', label: 'teal paint' },
  },
  cozy: {
    label: 'Cozy',
    floor: { ref: 'library:wood-woodparquet65', label: 'honey parquet' },
    walls: { ref: 'library:preset-cream', label: 'cream paint' },
    ceiling: { ref: 'library:preset-softwhite', label: 'soft white paint' },
    accent: { ref: 'library:preset-terracotta', label: 'terracotta paint' },
  },
  coastal: {
    label: 'Coastal',
    floor: { ref: 'library:wood-woodfine13', label: 'bleached oak floor' },
    walls: { ref: 'library:preset-white', label: 'white paint' },
    ceiling: { ref: 'library:preset-white', label: 'white paint' },
    accent: { ref: 'library:preset-paleteal', label: 'pale teal paint' },
  },
  farmhouse: {
    label: 'Farmhouse',
    floor: { ref: 'library:wood-woodplank19', label: 'rustic plank floor' },
    walls: { ref: 'library:preset-cream', label: 'cream paint' },
    ceiling: { ref: 'library:preset-white', label: 'white paint' },
    accent: { ref: 'library:preset-olive', label: 'olive green paint' },
  },
  bohemian: {
    label: 'Bohemian',
    floor: { ref: 'library:wood-woodparquet56', label: 'aged parquet' },
    walls: { ref: 'library:preset-sand', label: 'sand paint' },
    ceiling: { ref: 'library:preset-softwhite', label: 'soft white paint' },
    accent: { ref: 'library:preset-burntorange', label: 'burnt orange paint' },
  },
  minimal: {
    label: 'Minimal',
    floor: { ref: 'library:flooring-lightceramic24', label: 'light ceramic tile' },
    walls: { ref: 'library:preset-white', label: 'white paint' },
    ceiling: { ref: 'library:preset-white', label: 'white paint' },
    accent: { ref: 'library:preset-lightgrey', label: 'light grey paint' },
  },
  artdeco: {
    label: 'Art Deco',
    floor: { ref: 'library:wood-hungarianparquet2', label: 'dark herringbone parquet' },
    walls: { ref: 'library:preset-greige', label: 'greige paint' },
    ceiling: { ref: 'library:preset-softwhite', label: 'soft white paint' },
    accent: { ref: 'library:preset-deepteal', label: 'deep teal paint' },
  },
  mediterranean: {
    label: 'Mediterranean',
    floor: { ref: 'library:flooring-tile79', label: 'terracotta tile' },
    walls: { ref: 'library:preset-sand', label: 'sand paint' },
    ceiling: { ref: 'library:preset-white', label: 'white paint' },
    accent: { ref: 'library:preset-sky', label: 'sky blue paint' },
  },
}

const STYLE_CEILING_REGION_PREFIX = 'style-ceiling-'

function knownRef(ref: string): boolean {
  const parsed = parseMaterialRef(ref)
  if (!parsed) return false
  if (parsed.kind === 'scene') return true
  return !!getCatalogMaterialById(parsed.id)
}

/**
 * Which face of a wall the room sees: face 'a' sits left of the wall's
 * start→end direction, 'b' right — the face on the zone centroid's side.
 */
export function zoneSideFace(
  wall: { start: readonly [number, number]; end: readonly [number, number] },
  centroid: Vec2,
): 'a' | 'b' {
  const dx = wall.end[0] - wall.start[0]
  const dz = wall.end[1] - wall.start[1]
  const midX = (wall.start[0] + wall.end[0]) / 2
  const midZ = (wall.start[1] + wall.end[1]) / 2
  const leftDot = -dz * (centroid[0] - midX) + dx * (centroid[1] - midZ)
  return leftDot >= 0 ? 'a' : 'b'
}

/**
 * `apply_style`: write a named interior style onto a room — floor finish,
 * interior wall paint, ceiling paint and the schedule finish notes, plus one
 * accent wall face when `accentWallId` names a boundary wall.
 */
export const applyStyle: AgentOperation<ApplyStyleInput> = (nodes, input) => {
  const zone = nodes[input.zoneId]
  if (!zone) refuse('node_not_found', `Node not found: ${input.zoneId}.`)
  if (zone.type !== 'zone') refuse('not_a_zone', `${input.zoneId} is a ${zone.type}, not a zone.`)
  const preset = STYLE_PRESETS[input.style]
  if (!preset) refuse('unknown_style', `No style named '${input.style}'.`)
  for (const [what, { ref }] of [
    ['floor', preset.floor],
    ['walls', preset.walls],
    ['ceiling', preset.ceiling],
    ['accent', preset.accent],
  ] as const) {
    if (!knownRef(ref))
      refuse(
        'material_not_found',
        `Style '${input.style}' refers to an unknown ${what} material: ${ref}.`,
      )
  }

  const levelId = levelIdOf(nodes, zone.id)
  const centroid: Vec2 = (() => {
    const b = polygonBounds(zone.polygon as Vec2[])
    return [b.centerX, b.centerZ]
  })()

  const data: Record<string, unknown> = {
    spaceRole: 'room',
    wallMaterial: preset.walls.ref,
    floorFinish: preset.floor.label,
    wallFinish: preset.walls.label,
    ceilingFinish: preset.ceiling.label,
    floor: { ...(zone.floor ?? {}), finish: preset.floor.ref },
  }
  const applied: string[] = ['floor', 'walls', 'ceiling', 'finishes']

  // Whole-ceiling paint via one covering region; regions we wrote before are
  // replaced, hand-painted regions stay (ours lands last and wins).
  const ceilingRegionId = `${STYLE_CEILING_REGION_PREFIX}${zone.id}`
  const keptRegions = (zone.ceiling?.regions ?? []).filter(
    (region) => region.id !== ceilingRegionId,
  )
  data.ceiling = {
    ...(zone.ceiling ?? {}),
    regions: [
      ...keptRegions,
      { id: ceilingRegionId, polygon: zone.polygon, finish: preset.ceiling.ref },
    ],
  }

  let accentFace: 'a' | 'b' | undefined
  if (input.accentWallId !== undefined) {
    const wall = nodes[input.accentWallId]
    if (!wall) refuse('node_not_found', `Node not found: ${input.accentWallId}.`)
    if (wall.type !== 'wall')
      refuse('not_a_wall', `${input.accentWallId} is a ${wall.type}, not a wall.`)
    if (levelId && wall.parentId !== levelId)
      refuse(
        'wall_not_in_room',
        `Wall ${input.accentWallId} is on a different level than ${zone.id}; the accent wall must bound the room.`,
      )
    const isBoundary =
      zone.boundaryWallIds.length > 0
        ? zone.boundaryWallIds.includes(wall.id)
        : wall.parentId === levelId
    if (!isBoundary)
      refuse('wall_not_in_room', `Wall ${input.accentWallId} does not bound room ${zone.id}.`)
    accentFace = zoneSideFace(wall, centroid)
    const kept = (zone.wallOverrides ?? []).filter(
      (entry) => !(entry.wallId === wall.id && entry.face === accentFace),
    )
    data.wallOverrides = [...kept, { wallId: wall.id, face: accentFace, finish: preset.accent.ref }]
    applied.push('accent_wall')
  }

  return {
    result: {
      zoneId: zone.id,
      style: input.style,
      styleLabel: preset.label,
      applied,
      finishes: {
        floor: preset.floor,
        walls: preset.walls,
        ceiling: preset.ceiling,
        ...(accentFace ? { accentWall: preset.accent } : {}),
      },
      ...(input.accentWallId
        ? { accentWall: { wallId: input.accentWallId, face: accentFace } }
        : {}),
      changedFields: Object.keys(data),
    },
    changes: { update: [{ id: zone.id, data }] },
  }
}

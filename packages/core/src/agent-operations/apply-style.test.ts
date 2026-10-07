import { describe, expect, test } from 'bun:test'
import { STYLE_PRESET_IDS } from '../agent-tools/levels'
import { type AgentRefusal, isAgentRefusal } from '../agent-tools/refusal'
import type { AnyNode } from '../schema'
import { applyStyle, STYLE_PRESETS } from './apply-style'
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

function zone(id: string, polygon: [number, number][], extra: Record<string, unknown> = {}) {
  return {
    object: 'node' as const,
    id,
    type: 'zone' as const,
    parentId: 'level_1',
    visible: true,
    metadata: {},
    polygon,
    name: 'Room',
    ...extra,
  } as unknown as AnyNode
}

const nodes = (...list: AnyNode[]): SceneNodes =>
  Object.fromEntries(list.map((n) => [n.id, n])) as SceneNodes

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
  [4, 0],
  [4, 4],
  [0, 4],
]

describe('apply_style', () => {
  test('writes floor, wall and ceiling finishes plus the schedule notes', () => {
    const z = zone('zone_1', SQUARE)
    const out = applyStyle(nodes(level(), z), { zoneId: 'zone_1', style: 'scandinavian' })
    const data = out.changes?.update?.[0]?.data as Record<string, unknown>
    const preset = STYLE_PRESETS.scandinavian
    expect(data.wallMaterial).toBe(preset.walls.ref)
    expect((data.floor as { finish: string }).finish).toBe(preset.floor.ref)
    const regions = (data.ceiling as { regions: { finish: string }[] }).regions
    expect(regions.some((r) => r.finish === preset.ceiling.ref)).toBe(true)
    expect(data.floorFinish).toBe(preset.floor.label)
    expect(data.wallFinish).toBe(preset.walls.label)
    expect(data.ceilingFinish).toBe(preset.ceiling.label)
    expect(data.spaceRole).toBe('room')
    expect(out.result.applied).toContain('floor')
    expect(out.result.applied).toContain('walls')
    expect(out.result.applied).toContain('ceiling')
  })

  test('keeps earlier ceiling regions and adds the style region after them', () => {
    const z = zone('zone_1', SQUARE, {
      ceiling: { regions: [{ id: 'paint-1', polygon: SQUARE, finish: 'library:preset-mint' }] },
    })
    const out = applyStyle(nodes(level(), z), { zoneId: 'zone_1', style: 'japandi' })
    const regions = (out.changes?.update?.[0]?.data as { ceiling: { regions: { id: string }[] } })
      .ceiling.regions
    expect(regions.map((r) => r.id)).toContain('paint-1')
    expect(regions[regions.length - 1]?.finish).toBe(STYLE_PRESETS.japandi.ceiling.ref)
  })

  test('every preset resolves real finishes and applies them', () => {
    for (const style of STYLE_PRESET_IDS) {
      const out = applyStyle(nodes(level(), zone('zone_1', SQUARE)), {
        zoneId: 'zone_1',
        style,
      })
      expect(out.result.style).toBe(style)
      expect(out.result.applied).toContain('floor')
      expect(out.result.applied).toContain('walls')
      expect(out.result.applied).toContain('ceiling')
      const preset = STYLE_PRESETS[style]
      expect(preset.floor.ref).toStartWith('library:')
      expect(preset.walls.ref).toStartWith('library:')
      expect(preset.ceiling.ref).toStartWith('library:')
      expect(preset.accent.ref).toStartWith('library:')
    }
  })

  test('replaces a prior style region instead of stacking them', () => {
    const z = zone('zone_1', SQUARE)
    const scene = nodes(level(), z)
    const first = applyStyle(scene, { zoneId: 'zone_1', style: 'modern' })
    const styledZone = { ...z, ...first.changes?.update?.[0]?.data } as AnyNode
    const scene2 = nodes(level(), styledZone)
    const second = applyStyle(scene2, { zoneId: 'zone_1', style: 'cozy' })
    const regions = (
      second.changes?.update?.[0]?.data as { ceiling: { regions: { id: string }[] } }
    ).ceiling.regions
    expect(regions.filter((r) => r.id.startsWith('style-ceiling-')).length).toBe(1)
    expect(regions[regions.length - 1]?.finish).toBe(STYLE_PRESETS.cozy.ceiling.ref)
  })

  test('accentWallId paints the zone-facing side of that wall', () => {
    const z = zone('zone_1', SQUARE, { boundaryWallIds: ['wall_1'] })
    const w = wall('wall_1', [0, 0], [4, 0])
    const out = applyStyle(nodes(level(), z, w), {
      zoneId: 'zone_1',
      style: 'midcentury',
      accentWallId: 'wall_1',
    })
    const overrides = (
      out.changes?.update?.[0]?.data as {
        wallOverrides: { wallId: string; face: string; finish: string }[]
      }
    ).wallOverrides
    expect(overrides).toHaveLength(1)
    expect(overrides[0]?.wallId).toBe('wall_1')
    expect(overrides[0]?.finish).toBe(STYLE_PRESETS.midcentury.accent.ref)
    // The zone centroid (2,2) sits on the +Z side of this wall run: face 'a'.
    expect(overrides[0]?.face).toBe('a')
    expect(out.result.accentWall?.wallId).toBe('wall_1')
  })

  test('replaces the accent on a wall the style already painted', () => {
    const z = zone('zone_1', SQUARE, {
      boundaryWallIds: ['wall_1'],
      wallOverrides: [
        { wallId: 'wall_1', face: 'a', finish: 'library:preset-navy' },
        { wallId: 'wall_1', face: 'b', finish: 'library:preset-forest' },
      ],
    })
    const w = wall('wall_1', [0, 0], [4, 0])
    const out = applyStyle(nodes(level(), z, w), {
      zoneId: 'zone_1',
      style: 'modern',
      accentWallId: 'wall_1',
    })
    const overrides = (
      out.changes?.update?.[0]?.data as {
        wallOverrides: { wallId: string; face: string; finish: string }[]
      }
    ).wallOverrides
    // The style rewrote face 'a' (the side the room sees); face 'b' is untouched.
    expect(overrides).toHaveLength(2)
    expect(overrides.find((o) => o.face === 'a')?.finish).toBe(STYLE_PRESETS.modern.accent.ref)
    expect(overrides.find((o) => o.face === 'b')?.finish).toBe('library:preset-forest')
  })

  test('refuses walls that do not border the zone', () => {
    const z = zone('zone_1', SQUARE, { boundaryWallIds: ['wall_1'] })
    const near = wall('wall_1', [0, 0], [4, 0])
    const far = wall('wall_2', [10, 10], [14, 10])
    const code = refusalCode(() =>
      applyStyle(nodes(level(), z, near, far), {
        zoneId: 'zone_1',
        style: 'modern',
        accentWallId: 'wall_2',
      }),
    )
    expect(code).toBe('wall_not_in_room')
  })

  test('refuses unknown nodes, non-zones, unknown styles and non-wall accents', () => {
    const z = zone('zone_1', SQUARE)
    const scene = nodes(level(), z)
    expect(refusalCode(() => applyStyle(scene, { zoneId: 'nope', style: 'modern' }))).toBe(
      'node_not_found',
    )
    expect(refusalCode(() => applyStyle(scene, { zoneId: 'level_1', style: 'modern' }))).toBe(
      'not_a_zone',
    )
    expect(
      refusalCode(() => applyStyle(scene, { zoneId: 'zone_1', style: 'baroque' as 'modern' })),
    ).toBe('unknown_style')
    expect(
      refusalCode(() =>
        applyStyle(scene, { zoneId: 'zone_1', style: 'modern', accentWallId: 'level_1' }),
      ),
    ).toBe('not_a_wall')
  })

  test('every preset material resolves against the catalog', () => {
    for (const [id, preset] of Object.entries(STYLE_PRESETS)) {
      const z = zone('zone_1', SQUARE)
      const out = applyStyle(nodes(level(), z), {
        zoneId: 'zone_1',
        style: id as keyof typeof STYLE_PRESETS,
      })
      expect(out.result.style).toBe(id)
      expect(out.result.finishes.floor.ref).toBe(preset.floor.ref)
    }
  })
})

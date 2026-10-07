import { describe, expect, test } from 'bun:test'
import { type AgentRefusal, isAgentRefusal } from '../agent-tools/refusal'
import type { AnyNode } from '../schema'
import {
  angleBetweenDirections,
  frontDirection,
  itemRole,
  itemSideClearanceCorners,
  itemWorldPlan,
  resolveFacingYaw,
  yawToFaceDirection,
} from './item-facing'
import type { SceneNodes } from './types'

function item(
  id: string,
  position: [number, number, number],
  rotY = 0,
  name = 'Item',
  parentId = 'level_1',
  extra: Record<string, unknown> = {},
) {
  return {
    object: 'node' as const,
    id,
    type: 'item' as const,
    parentId,
    visible: true,
    metadata: {},
    name,
    position,
    rotation: [0, rotY, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
    asset: { id: 'x', name, category: 'furniture', thumbnail: '', src: 'asset://x' },
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

describe('item-facing math', () => {
  test('yawToFaceDirection aims +Z front along dir', () => {
    expect(yawToFaceDirection([0, 1], 'z+')).toBeCloseTo(0)
    expect(yawToFaceDirection([1, 0], 'z+')).toBeCloseTo(Math.PI / 2)
    expect(yawToFaceDirection([0, -1], 'z+')).toBeCloseTo(Math.PI)
  })

  test('yawToFaceDirection shifts for a non-+Z declared front', () => {
    // Front declared on local +X: yaw 0 already faces +X, so facing +X needs yaw 0
    expect(yawToFaceDirection([1, 0], 'x+')).toBeCloseTo(0)
    expect(yawToFaceDirection([0, 1], 'x+')).toBeCloseTo(-Math.PI / 2)
  })

  test('frontDirection rotates the front axis by yaw', () => {
    const [x, z] = frontDirection(Math.PI / 2, 'z+')
    expect(x).toBeCloseTo(1)
    expect(z).toBeCloseTo(0)
  })

  test('resolveFacingYaw point mode aims the front at the point', () => {
    const { yaw } = resolveFacingYaw({}, [0, 0], 'z+', {
      mode: 'point',
      point: [0, 2],
    })
    expect(yaw).toBeCloseTo(0)
    const toTable = resolveFacingYaw({}, [0, 0], 'z+', { mode: 'point', point: [2, 0] })
    expect(toTable.yaw).toBeCloseTo(Math.PI / 2)
  })

  test('resolveFacingYaw node mode aims at another item; away flips it', () => {
    const target = item('t', [0, 0, 3])
    const scene = nodes(target)
    const toward = resolveFacingYaw(scene, [0, 0], 'z+', { mode: 'node', nodeId: 't' })
    expect(toward.yaw).toBeCloseTo(0)
    const away = resolveFacingYaw(scene, [0, 0], 'z+', { mode: 'away', nodeId: 't' })
    expect(away.yaw).toBeCloseTo(Math.PI)
  })

  test('resolveFacingYaw refuses a missing target and a self-target', () => {
    expect(
      refusalCode(() => resolveFacingYaw({}, [0, 0], 'z+', { mode: 'node', nodeId: 'gone' })),
    ).toBe('target_not_found')
    const self = item('me', [0, 0, 0])
    expect(
      refusalCode(() =>
        resolveFacingYaw(nodes(self), [0, 0], 'z+', { mode: 'node', nodeId: 'me' }),
      ),
    ).toBe('no_direction')
  })

  test('itemWorldPlan carries the host yaw and offset through', () => {
    const host = item('host', [5, 0, 5], Math.PI / 2)
    const child = item('child', [0.5, 0, 0], 0, 'Child', 'host')
    const scene = nodes(host, child)
    const frame = itemWorldPlan(scene, child)
    // child sits 0.5 along host-local +x; host yaw π/2 turns +x into -z in plan
    expect(frame).not.toBeNull()
    expect(frame!.x).toBeCloseTo(5)
    expect(frame!.z).toBeCloseTo(4.5)
    expect(frame!.yaw).toBeCloseTo(Math.PI / 2)
  })

  test('itemRole uses declared role, then name heuristics', () => {
    const declared = item('a', [0, 0, 0], 0, 'Thing', 'level_1', {
      asset: { id: 'x', name: 'Thing', category: 'x', thumbnail: '', src: 'x', role: 'seat' },
    })
    expect(itemRole(declared)).toBe('seat')
    expect(itemRole(item('b', [0, 0, 0], 0, 'Dining Chair'))).toBe('seat')
    expect(itemRole(item('c', [0, 0, 0], 0, 'Double Bed'))).toBe('bed')
    expect(itemRole(item('d', [0, 0, 0], 0, 'TV stand shelf'))).toBe('storage')
  })

  test('side clearance rect extrudes past the front edge', () => {
    const corners = itemSideClearanceCorners([0, 0], [1, 1, 1], 0, 'z+', 'front', 0.5)
    const zs = corners.map((c) => c[1])
    expect(Math.min(...zs)).toBeCloseTo(0.5)
    expect(Math.max(...zs)).toBeCloseTo(1)
  })

  test('angleBetweenDirections is yaw-independent', () => {
    expect(angleBetweenDirections([0, 1], [1, 0])).toBeCloseTo(Math.PI / 2)
    expect(angleBetweenDirections([0, 1], [0, -1])).toBeCloseTo(Math.PI)
  })
})

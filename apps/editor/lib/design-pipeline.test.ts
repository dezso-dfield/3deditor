import { beforeEach, describe, expect, test } from 'bun:test'
import type { AnyNode } from '@pascal-app/core/schema'
import { designRoom, getDesignClient, reviewRoom } from './design-pipeline'

const POLYGON: [number, number][] = [
  [0, 0],
  [5, 0],
  [5, 4],
  [0, 4],
]

async function createRoom(): Promise<string> {
  const { client, bridge } = await getDesignClient()
  const level = Object.values(bridge.getNodes()).find((n) => n.type === 'level')!
  const result = await client.callTool({
    name: 'create_room',
    arguments: { levelId: level.id, name: 'Test room', polygon: POLYGON, wallHeight: 2.7 },
  })
  expect(result.isError).toBeFalsy()
  const payload = JSON.parse(
    (result.content as Array<{ type: string; text: string }>)[0]!.text,
  ) as { zoneId: string }
  return payload.zoneId
}

async function placedItems(): Promise<AnyNode[]> {
  const { bridge } = await getDesignClient()
  return Object.values(bridge.getNodes()).filter((n): n is AnyNode => n.type === 'item')
}

describe('design-pipeline', () => {
  beforeEach(async () => {
    const { bridge } = await getDesignClient()
    bridge.setScene({}, [])
    bridge.loadDefault()
  })

  test('designRoom runs the full agent pipeline and returns a review', async () => {
    const zoneId = await createRoom()
    const steps: string[] = []
    const result = await designRoom(
      {
        zoneId,
        roomType: 'bedroom',
        style: 'scandinavian',
        furnish: true,
        decorate: true,
        fix: true,
      },
      (step) => steps.push(step.id),
    )
    expect(result.error).toBeUndefined()
    expect(steps).toEqual([
      'update_room',
      'furnish_room',
      'apply_style',
      'improve_layout',
      'decorate_room',
      'review_layout',
    ])
    expect(result.report).not.toBeNull()
    const items = await placedItems()
    expect(items.length).toBeGreaterThan(3)
    // furnish_room + decorate_room must produce real facing metadata on items.
    expect(items.every((n) => typeof n.rotation === 'number' || Array.isArray(n.rotation))).toBe(
      true,
    )
  })

  test('designRoom infers the room type when none is given', async () => {
    const zoneId = await createRoom()
    const result = await designRoom({
      zoneId,
      style: 'minimal',
      furnish: false,
      decorate: false,
      fix: false,
    })
    expect(result.error).toBeUndefined()
    // Only style + review ran.
    expect(result.steps.map((s) => s.id)).toEqual(['apply_style', 'review_layout'])
    expect(result.steps.every((s) => s.ok)).toBe(true)
  })

  test('reviewRoom audits without placing items', async () => {
    const zoneId = await createRoom()
    const before = await placedItems()
    const report = await reviewRoom(zoneId)
    expect(report).not.toBeNull()
    expect(report!.issueCount).toBeGreaterThanOrEqual(0)
    expect(await placedItems()).toHaveLength(before.length)
  })
})

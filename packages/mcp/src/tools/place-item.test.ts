import { beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SlabNode, WallNode } from '@pascal-app/core/schema'
import { SceneBridge } from '../bridge/scene-bridge'
import { registerPlaceItem } from './place-item'

describe('place_item', () => {
  let client: Client
  let bridge: SceneBridge

  beforeEach(async () => {
    bridge = new SceneBridge()
    bridge.setScene({}, [])
    bridge.loadDefault()
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    registerPlaceItem(server, bridge)
    const [srvT, cliT] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(srvT), client.connect(cliT)])
  })

  test('places an item on a wall and derives wallT', async () => {
    const level = Object.values(bridge.getNodes()).find((n) => n.type === 'level')!
    const wall = WallNode.parse({ start: [0, 0], end: [10, 0] })
    bridge.createNode(wall, level.id)

    const result = await client.callTool({
      name: 'place_item',
      arguments: {
        catalogItemId: 'shelf',
        targetNodeId: wall.id,
        position: [5, 0, 0],
      },
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text)
    expect(parsed.itemId).toMatch(/^item_/)
    expect(parsed.status).toBe('ok')
    const item = bridge.getNode(parsed.itemId)
    expect(item).not.toBeNull()
    // Midpoint of a [0..10] wall at x=5 → wallT = 0.5.
    expect((item as { wallT?: number }).wallT).toBeCloseTo(0.5, 3)
    expect((item as { position: [number, number, number] }).position[0]).toBeCloseTo(5, 3)
  })

  test('places a floor item through a slab target but parents it to the level for rendering', async () => {
    const level = Object.values(bridge.getNodes()).find((n) => n.type === 'level')!
    const slab = SlabNode.parse({
      polygon: [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
    })
    bridge.createNode(slab, level.id)

    const result = await client.callTool({
      name: 'place_item',
      arguments: {
        catalogItemId: 'sofa',
        targetNodeId: slab.id,
        position: [2, 0, 2],
      },
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const item = bridge.getNode(parsed.itemId)
    expect(item?.parentId).toBe(level.id)
    expect(bridge.validateScene().valid).toBe(true)
  })

  test('rejects placement on an unsupported node', async () => {
    const building = Object.values(bridge.getNodes()).find((n) => n.type === 'building')!
    const result = await client.callTool({
      name: 'place_item',
      arguments: {
        catalogItemId: 'foo',
        targetNodeId: building.id,
        position: [0, 0, 0],
      },
    })
    expect(result.isError).toBe(true)
  })

  test('rejects unknown target', async () => {
    const result = await client.callTool({
      name: 'place_item',
      arguments: {
        catalogItemId: 'foo',
        targetNodeId: 'wall_nope',
        position: [0, 0, 0],
      },
    })
    expect(result.isError).toBe(true)
  })

  test('facing point aims the placed item front (+Z toward the point)', async () => {
    const level = Object.values(bridge.getNodes()).find((n) => n.type === 'level')!
    const result = await client.callTool({
      name: 'place_item',
      arguments: {
        catalogItemId: 'sofa',
        targetNodeId: level.id,
        position: [3, 0, 3],
        facing: { mode: 'point', point: [6, 3] },
      },
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const item = bridge.getNode(parsed.itemId) as { rotation: [number, number, number] }
    expect(item.rotation[1]).toBeCloseTo(Math.PI / 2, 3)
  })

  test('facing node aims the item at another node', async () => {
    const level = Object.values(bridge.getNodes()).find((n) => n.type === 'level')!
    const table = await client.callTool({
      name: 'place_item',
      arguments: {
        catalogItemId: 'dining-table',
        targetNodeId: level.id,
        position: [0, 0, 5],
      },
    })
    const tableId = JSON.parse(
      (table.content as Array<{ type: string; text: string }>)[0]!.text,
    ).itemId
    const chair = await client.callTool({
      name: 'place_item',
      arguments: {
        catalogItemId: 'dining-chair',
        targetNodeId: level.id,
        position: [0, 0, 0],
        facing: { mode: 'node', nodeId: tableId },
      },
    })
    expect(chair.isError).toBeFalsy()
    const chairId = JSON.parse(
      (chair.content as Array<{ type: string; text: string }>)[0]!.text,
    ).itemId
    const item = bridge.getNode(chairId) as { rotation: [number, number, number] }
    // chair at z=0 facing table at z=5 → +z → yaw 0
    expect(item.rotation[1]).toBeCloseTo(0, 3)
  })

  test('catalog metadata (front, clearance, role) lands on the placed item', async () => {
    const level = Object.values(bridge.getNodes()).find((n) => n.type === 'level')!
    const result = await client.callTool({
      name: 'place_item',
      arguments: {
        catalogItemId: 'toilet',
        targetNodeId: level.id,
        position: [0, 0, 0],
      },
    })
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const item = bridge.getNode(parsed.itemId) as {
      asset: { front?: string; clearance?: { front?: number }; role?: string }
    }
    expect(item.asset.front).toBe('z+')
    expect(item.asset.clearance?.front).toBeCloseTo(0.6, 3)
    expect(item.asset.role).toBe('fixture')
  })
})

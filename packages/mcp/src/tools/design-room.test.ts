import { beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SceneBridge } from '../bridge/scene-bridge'
import { registerRoomTools } from './room-tools'
import { registerSharedTools } from './shared-tools'

describe('design_room', () => {
  let client: Client
  let bridge: SceneBridge

  const createRoom = async (name = 'Bedroom') => {
    const level = Object.values(bridge.getNodes()).find((n) => n.type === 'level')
    if (!level) throw new Error('no level')
    const result = await client.callTool({
      name: 'create_room',
      arguments: {
        levelId: level.id,
        name,
        polygon: [
          [0, 0],
          [5, 0],
          [5, 4],
          [0, 4],
        ],
        wallHeight: 2.7,
      },
    })
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}',
    )
    return parsed.zoneId as string
  }

  const placedItems = () => Object.values(bridge.getNodes()).filter((n) => n.type === 'item')

  beforeEach(async () => {
    bridge = new SceneBridge()
    bridge.setScene({}, [])
    bridge.loadDefault()
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    registerRoomTools(server, bridge)
    registerSharedTools(server, bridge)
    const [srvT, cliT] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(srvT), client.connect(cliT)])
  })

  test('runs the whole design pipeline in one call', async () => {
    const zoneId = await createRoom()
    const result = await client.callTool({
      name: 'design_room',
      arguments: { zoneId, roomType: 'bedroom', style: 'japandi' },
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}',
    )
    expect(parsed.zoneId).toBe(zoneId)
    expect(parsed.roomType).toBe('bedroom')
    expect(parsed.style).toBe('japandi')
    expect(parsed.steps.map((s: { step: string }) => s.step)).toEqual([
      'update_room',
      'furnish_room',
      'apply_style',
      'improve_layout',
      'decorate_room',
      'review_layout',
    ])
    expect(parsed.steps.every((s: { ok: boolean }) => s.ok)).toBe(true)
    expect(parsed.furnished.placed).toBeGreaterThan(2)
    expect(placedItems().length).toBeGreaterThan(2)
    expect(parsed.review.issueCount).toBeDefined()

    const zone = bridge.getNode(zoneId as never)
    expect(zone?.type === 'zone' && zone.occupancy).toBe('bedroom')
  })

  test('refuses cleanly when the room type cannot be inferred', async () => {
    const zoneId = await createRoom('Room 1')
    const result = await client.callTool({
      name: 'design_room',
      arguments: { zoneId },
    })
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}',
    )
    expect(parsed.error).toContain('furnish_room')
    expect(parsed.code).toBe('room_type_unknown')
  })

  test('style-only run furnishes nothing', async () => {
    const zoneId = await createRoom()
    const result = await client.callTool({
      name: 'design_room',
      arguments: { zoneId, style: 'minimal', furnish: false, decorate: 'off', fix: false },
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}',
    )
    expect(parsed.steps.map((s: { step: string }) => s.step)).toEqual([
      'apply_style',
      'review_layout',
    ])
    expect(parsed.furnished).toBeUndefined()
    expect(placedItems().length).toBe(0)
  })

  test('renames the room while designing', async () => {
    const zoneId = await createRoom('Room 1')
    const result = await client.callTool({
      name: 'design_room',
      arguments: { zoneId, name: 'Guest office', roomType: 'office' },
    })
    expect(result.isError).toBeFalsy()
    const zone = bridge.getNode(zoneId as never)
    expect(zone?.name).toBe('Guest office')
    expect(zone?.type === 'zone' && zone.occupancy).toBe('office')
  })
})

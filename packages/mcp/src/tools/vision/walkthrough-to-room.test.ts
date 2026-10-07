import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { SceneBridge } from '../../bridge/scene-bridge'
import { registerWalkthroughToRoom } from './walkthrough-to-room'

type Handler = (req: unknown) => unknown | Promise<unknown>

async function makeWiredPair(opts: {
  withSampling: boolean
  samplingHandler?: Handler
}): Promise<{ client: Client; bridge: SceneBridge }> {
  const bridge = new SceneBridge()
  bridge.setScene({}, [])
  bridge.loadDefault()
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerWalkthroughToRoom(server, bridge)

  const [srvT, cliT] = InMemoryTransport.createLinkedPair()
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    { capabilities: opts.withSampling ? { sampling: {} } : {} },
  )
  if (opts.withSampling && opts.samplingHandler) {
    const handler = opts.samplingHandler
    client.setRequestHandler(
      CreateMessageRequestSchema,
      async (request) => (await handler(request)) as never,
    )
  }
  await Promise.all([server.connect(srvT), client.connect(cliT)])
  return { client, bridge }
}

const VISION_REPLY = {
  model: 'mock-model',
  role: 'assistant',
  content: {
    type: 'text',
    text: JSON.stringify({
      roomName: 'Living Room',
      roomType: 'living',
      approximateDimensions: { widthM: 6, depthM: 5 },
      items: [
        { label: 'sofa', position: [0, -1], facingDeg: 0 },
        { label: 'coffee table', position: [0, 0.5], facingDeg: 0 },
        { label: 'television', position: [0, 2], facingDeg: 180 },
        { label: 'antique gramophone', position: [2, 0], facingDeg: 270 },
      ],
      doors: [{ edgeIndex: 0, positionT: 0.5 }],
      confidence: 0.7,
      notes: 'single-angle estimate',
    }),
  },
}

describe('walkthrough_to_room', () => {
  test('happy path: vision reply → zone + walls + catalog items placed with facing', async () => {
    const { client, bridge } = await makeWiredPair({
      withSampling: true,
      samplingHandler: () => VISION_REPLY,
    })
    const level = Object.values(bridge.getNodes()).find((n) => n.type === 'level')!
    const result = await client.callTool({
      name: 'walkthrough_to_room',
      arguments: { images: ['aGVsbG8='], levelId: level.id },
    })
    expect(result.isError).toBeFalsy()
    const out = result.structuredContent as {
      zoneId: string
      wallIds: (string | null)[]
      placed: { itemId: string; assetId: string; facingDeg: number }[]
      unmatched: string[]
      skipped: string[]
      confidence: number
      review: { issueCount: number }
    }
    const zone = bridge.getNode(out.zoneId)
    expect(zone?.type).toBe('zone')
    expect(zone?.name).toBe('Living Room')
    expect((zone as { occupancy?: string }).occupancy).toBe('living')
    // walls built for the estimated rectangle
    expect(out.wallIds!.filter(Boolean).length).toBeGreaterThanOrEqual(4)
    // 3 catalog-matched items placed; the gramophone unmatched
    expect(out.placed.map((p) => p.assetId).sort()).toEqual(['coffee-table', 'sofa', 'television'])
    expect(out.unmatched).toEqual(['antique gramophone'])
    // the television faces -z (facingDeg 180)
    const tv = out.placed.find((p) => p.assetId === 'television')!
    const tvNode = bridge.getNode(tv.itemId) as { rotation: number[] }
    expect(Math.abs(tvNode.rotation[1])).toBeCloseTo(Math.PI, 1)
    expect(out.review.issueCount).toBeGreaterThanOrEqual(0)
  })

  test('sampling unavailable → sampling_unavailable', async () => {
    const { client } = await makeWiredPair({ withSampling: false })
    const result = await client.callTool({
      name: 'walkthrough_to_room',
      arguments: { images: ['aGVsbG8='], levelId: 'level_x' },
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text
    expect(text).toContain('sampling_unavailable')
  })

  test('multi-image input forwards every frame to the host', async () => {
    let capturedRequest: unknown
    const { client, bridge } = await makeWiredPair({
      withSampling: true,
      samplingHandler: (req) => {
        capturedRequest = req
        return VISION_REPLY
      },
    })
    const level = Object.values(bridge.getNodes()).find((n) => n.type === 'level')!
    await client.callTool({
      name: 'walkthrough_to_room',
      arguments: { images: ['aGVsbG8=', 'aGVsbG8=', 'aGVsbG8='], levelId: level.id },
    })
    const params = (capturedRequest as { params: { messages: Array<{ content: unknown }> } }).params
    const content = params.messages[0]!.content as Array<{ type: string }>
    expect(content.filter((b) => b.type === 'image').length).toBe(3)
  })
})

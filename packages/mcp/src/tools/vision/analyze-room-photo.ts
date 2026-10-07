import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { SceneOperations } from '../../operations'
import { READ_ONLY_OPEN_WORLD_TOOL_ANNOTATIONS } from '../annotations'
import { assertSampling, extractText, parseSamplingJson, resolveImageBlock } from './sampling'

/**
 * Input shape for `analyze_room_photo`.
 *
 * Same image resolution rules as `analyze_floorplan_image`.
 */
export const analyzeRoomPhotoInput = {
  image: z.string().describe('Base64-encoded image or http(s) URL'),
}

export const analyzeRoomPhotoOutput = {
  approximateDimensions: z.object({
    widthM: z.number(),
    lengthM: z.number(),
    heightM: z.number().optional(),
  }),
  identifiedFixtures: z.array(
    z.object({
      type: z.string(),
      approximatePosition: z.tuple([z.number(), z.number()]).optional(),
    }),
  ),
  identifiedWindows: z.array(
    z.object({
      wallLabel: z.string().optional(),
      approximateWidthM: z.number().optional(),
      approximateHeightM: z.number().optional(),
    }),
  ),
}

const OutputSchema = z.object(analyzeRoomPhotoOutput)

const SYSTEM_PROMPT = `You are a vision assistant that extracts structured room data from a single photograph.
Your ONLY job: return a JSON object that exactly matches this schema — no prose, no markdown fences.

{
  "approximateDimensions": { "widthM": number, "lengthM": number, "heightM": number? },
  "identifiedFixtures": [{ "type": string, "approximatePosition": [x, z]? }, ...],
  "identifiedWindows": [{ "wallLabel": string?, "approximateWidthM": number?, "approximateHeightM": number? }, ...]
}

All measurements are in metres. "type" for fixtures is a short noun phrase such as "sofa", "kitchen island", "door".
If measurements cannot be estimated confidently, omit the optional fields rather than guessing.
DO NOT wrap the JSON in markdown. DO NOT explain. Just output the raw JSON.`

export function registerAnalyzeRoomPhoto(server: McpServer, _bridge: SceneOperations): void {
  server.registerTool(
    'analyze_room_photo',
    {
      title: 'Analyze room photo',
      description:
        'Defer to the MCP host (via sampling) to extract approximate dimensions, fixtures, and windows from a single-room photograph. Requires host support for sampling.',
      inputSchema: analyzeRoomPhotoInput,
      outputSchema: analyzeRoomPhotoOutput,
      annotations: READ_ONLY_OPEN_WORLD_TOOL_ANNOTATIONS,
    },
    async ({ image }) => {
      assertSampling(() => server.server.getClientCapabilities())

      const imageBlock = await resolveImageBlock(image)

      const response = await server.server.createMessage({
        systemPrompt: SYSTEM_PROMPT,
        temperature: 0,
        maxTokens: 2000,
        messages: [
          {
            role: 'user',
            content: [
              imageBlock,
              {
                type: 'text',
                text: 'Analyze this room photo. Return ONLY the JSON described by the system prompt.',
              },
            ],
          },
        ],
      })

      const text = extractText(response.content as Parameters<typeof extractText>[0])
      const payload = parseSamplingJson(text, (parsed) => OutputSchema.safeParse(parsed))
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      }
    },
  )
}

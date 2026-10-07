import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { visionComplete } from '../../ai/vision-channel'
import type { SceneOperations } from '../../operations'
import { READ_ONLY_OPEN_WORLD_TOOL_ANNOTATIONS } from '../annotations'
import { parseSamplingJson, resolveImageBlock } from './sampling'

/**
 * Input shape for `analyze_floorplan_image`.
 *
 * `image` is either a base64-encoded payload (optionally prefixed with a
 * `data:image/<mime>;base64,` URL) or an `http(s)` URL which we fetch and
 * inline as base64 before forwarding to the MCP host via sampling.
 */
export const analyzeFloorplanImageInput = {
  image: z.string().describe('Base64-encoded image or http(s) URL'),
  scaleHint: z
    .string()
    .optional()
    .describe("Text hint about scale, e.g. '1 cm = 1 m' or 'approximately 80 m²'"),
}

export const analyzeFloorplanImageOutput = {
  walls: z.array(
    z.object({
      start: z.tuple([z.number(), z.number()]),
      end: z.tuple([z.number(), z.number()]),
      thickness: z.number().optional(),
    }),
  ),
  rooms: z.array(
    z.object({
      name: z.string(),
      polygon: z.array(z.tuple([z.number(), z.number()])),
      approximateAreaSqM: z.number().optional(),
    }),
  ),
  approximateDimensions: z.object({
    widthM: z.number(),
    depthM: z.number(),
  }),
  confidence: z.number().min(0).max(1),
}

const OutputSchema = z.object(analyzeFloorplanImageOutput)

const SYSTEM_PROMPT = `You are a vision assistant that extracts structured floor-plan data from an image.
Your ONLY job: return a JSON object that exactly matches this schema — no prose, no markdown fences.

{
  "walls": [{ "start": [x, z], "end": [x, z], "thickness": number? }, ...],
  "rooms": [{ "name": string, "polygon": [[x,z], ...], "approximateAreaSqM": number? }, ...],
  "approximateDimensions": { "widthM": number, "depthM": number },
  "confidence": number 0..1
}

Coordinates are in metres. Origin can be the floor plan's centre or bottom-left — be consistent.
If the image is unclear, lower the confidence score but still produce your best attempt.
DO NOT wrap the JSON in markdown. DO NOT explain. Just output the raw JSON.`

export function registerAnalyzeFloorplanImage(server: McpServer, _bridge: SceneOperations): void {
  server.registerTool(
    'analyze_floorplan_image',
    {
      title: 'Analyze floor-plan image',
      description:
        'Extract walls, rooms, and approximate dimensions from a floor-plan image with the configured AI provider (`pascal ai login`), falling back to MCP host sampling. See list_ai_providers for what is connected.',
      inputSchema: analyzeFloorplanImageInput,
      outputSchema: analyzeFloorplanImageOutput,
      annotations: READ_ONLY_OPEN_WORLD_TOOL_ANNOTATIONS,
    },
    async ({ image, scaleHint }) => {
      const imageBlock = await resolveImageBlock(image)
      const instruction = scaleHint
        ? `Analyze this floor plan. Scale hint: ${scaleHint}. Return ONLY the JSON described by the system prompt.`
        : 'Analyze this floor plan. Return ONLY the JSON described by the system prompt.'

      const { text } = await visionComplete(server, {
        systemPrompt: SYSTEM_PROMPT,
        prompt: instruction,
        images: [imageBlock],
        maxTokens: 2000,
      })
      const payload = parseSamplingJson(text, (parsed) => OutputSchema.safeParse(parsed))
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      }
    },
  )
}

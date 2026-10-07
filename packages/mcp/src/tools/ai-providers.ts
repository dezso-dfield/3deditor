import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  AI_PROVIDER_IDS,
  AI_PROVIDERS,
  type AiProviderId,
  resolveProviderCredential,
} from '@pascal-app/core/ai'
import { z } from 'zod'
import { loadAuthFile, resolveAuthFilePath } from '../ai/auth-file'
import { READ_ONLY_TOOL_ANNOTATIONS } from './annotations'

/**
 * `list_ai_providers` — which AI providers the user has connected, how (API
 * key, subscription sign-in, env var), which one the vision/generation tools
 * will use, and how to connect one. Never returns token material.
 */
export function registerAiProviderTools(server: McpServer): void {
  server.registerTool(
    'list_ai_providers',
    {
      title: 'List AI providers',
      description:
        'Report which AI providers are configured for the vision and generation tools (anthropic, openai, google): connection kind (api key, subscription OAuth, env var), which one is selected, token expiry, and the CLI commands to connect or switch. No secrets are returned.',
      inputSchema: {},
      outputSchema: {
        selected: z.string().nullable(),
        authFile: z.string(),
        providers: z.array(
          z.object({
            id: z.string(),
            displayName: z.string(),
            configured: z.boolean(),
            selected: z.boolean(),
            kind: z.enum(['api_key', 'oauth', 'env']).nullable(),
            expired: z.boolean(),
            accountId: z.string().nullable(),
            visionModel: z.string(),
            apiKeyHelp: z.string(),
            oauthHelp: z.string(),
          }),
        ),
        setup: z.string(),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async () => {
      const filePath = resolveAuthFilePath()
      const file = loadAuthFile(filePath)
      const providers = AI_PROVIDER_IDS.map((id: AiProviderId) => {
        const cred = resolveProviderCredential(file, id, process.env)
        return {
          id,
          displayName: AI_PROVIDERS[id].displayName,
          configured: cred !== null,
          selected: file?.selectedProvider === id,
          kind: cred?.kind ?? null,
          expired: cred?.expired ?? false,
          accountId: cred?.oauth?.accountId ?? null,
          visionModel: AI_PROVIDERS[id].visionModel,
          apiKeyHelp: AI_PROVIDERS[id].apiKeyHelp,
          oauthHelp: AI_PROVIDERS[id].oauthHelp,
        }
      })
      const payload = {
        selected: file?.selectedProvider ?? null,
        authFile: filePath,
        providers,
        setup:
          'Connect a provider with `pascal ai login <provider>` (subscription sign-in) or `pascal ai login <provider> --api-key <key>`; `pascal ai use <provider>` selects it; env vars ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY work without a file.',
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      }
    },
  )
}

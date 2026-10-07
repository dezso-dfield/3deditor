import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * ~/.pascal/auth.json — the credential store `pascal ai login` writes and the
 * MCP service (`packages/mcp/src/ai/auth-file.ts`) reads. Mode 0600; the shape
 * is the `PascalAuthFile` contract in packages/core/src/ai/providers.ts.
 */

export interface PascalAuthFile {
  selectedProvider?: string
  providers?: Partial<
    Record<
      string,
      {
        apiKey?: string
        oauth?: {
          accessToken: string
          refreshToken?: string
          expiresAt?: number
          accountId?: string
        }
      }
    >
  >
}

export function loadAuthFile(filePath: string): PascalAuthFile | null {
  if (!existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as PascalAuthFile
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

export function saveAuthFile(file: PascalAuthFile, filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  chmodSync(filePath, 0o600)
}

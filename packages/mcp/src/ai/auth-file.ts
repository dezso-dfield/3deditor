import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  type AiProviderId,
  type PascalAuthFile,
  type ResolvedCredential,
  resolveActiveCredential,
  resolveProviderCredential,
} from '@pascal-app/core/ai'

/**
 * Where the user's AI-provider credentials live. The CLI (`pascal ai login`)
 * writes this file with 0600; the MCP service reads it — never logs it, never
 * exposes token values through tools.
 *
 * Resolution follows the CLI's resolvePascalPaths convention (the CLI is what
 * writes the file on `pascal ai login`):
 *   PASCAL_AUTH_FILE → PASCAL_HOME/auth.json → %APPDATA%/Pascal/auth.json (win)
 *   → ~/.pascal/auth.json
 */
export function resolveAuthFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PASCAL_AUTH_FILE) return env.PASCAL_AUTH_FILE
  const root = env.PASCAL_HOME
  if (root) return path.join(root, 'auth.json')
  if (process.platform === 'win32') {
    const appData = env.APPDATA
    if (appData) return path.join(appData, 'Pascal', 'auth.json')
  }
  return path.join(homedir(), '.pascal', 'auth.json')
}

export function loadAuthFile(filePath: string = resolveAuthFilePath()): PascalAuthFile | null {
  if (!existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as PascalAuthFile
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

export function saveAuthFile(file: PascalAuthFile, filePath = resolveAuthFilePath()): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  chmodSync(filePath, 0o600)
}

export function removeProviderFromAuthFile(
  provider: AiProviderId,
  filePath = resolveAuthFilePath(),
): boolean {
  const file = loadAuthFile(filePath)
  if (!file?.providers?.[provider]) return false
  delete file.providers[provider]
  if (file.selectedProvider === provider) {
    delete file.selectedProvider
  }
  saveAuthFile(file, filePath)
  return true
}

export function activeCredential(
  env: NodeJS.ProcessEnv = process.env,
  filePath = resolveAuthFilePath(env),
): ResolvedCredential | null {
  return resolveActiveCredential(loadAuthFile(filePath), env)
}

export function credentialFor(
  provider: AiProviderId,
  env: NodeJS.ProcessEnv = process.env,
  filePath = resolveAuthFilePath(env),
): ResolvedCredential | null {
  return resolveProviderCredential(loadAuthFile(filePath), provider, env)
}

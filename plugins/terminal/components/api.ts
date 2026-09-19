import { pluginFetch } from '@makinbakin/sdk/utils'
let tabId: string | undefined
export function clientId(): string {
  // getRandomValues remains available on HTTP LAN/Tailscale origins.
  return tabId ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export function terminalFetch(path: string, init: Parameters<typeof pluginFetch>[2] = {}): Promise<Response> {
  return pluginFetch('terminal', path, { ...init, headers: { ...init.headers, 'X-Bakin-Terminal-Client': clientId() } })
}
export async function api<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await terminalFetch(path, body ? { method: 'POST', body } : {})
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? `Terminal request failed (${response.status})`)
  return data as T
}

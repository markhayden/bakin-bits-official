import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { useState } from 'react'

export function PluginLink({ to, children, ...props }) {
  return React.createElement('a', { ...props, href: to }, children)
}

export function useRouter() {
  const hook = globalThis.__bakinTestSdkHooks?.useRouter
  if (hook) return hook()
  return {
    push: () => {},
    replace: () => {},
    back: () => {},
  }
}

// ── Entity links (functional port of the real SDK's entityHref). The app
// seeds its registry from every loaded plugin's manifest; here it is the core
// kinds Bakin declares plus whatever the plugins in this repo declare. ──────
const CORE_ENTITY_HREFS = {
  'tasks:task': '/tasks?taskId={id}',
  'assets:asset': '/assets/{id}',
  'schedule:job': '/schedule?jobId={id}',
  'workflows:workflow': '/workflows/{id}',
  'brands:brand': '/brands/{id}',
  'brands:doc': '/brands/{brandId}/docs/{kind}/{name}',
  'chat:chat': '/chat/{id}',
  'team:agent': '/team/{id}',
}

let entityHrefs = null
function declaredEntityHrefs() {
  if (entityHrefs) return entityHrefs
  entityHrefs = { ...CORE_ENTITY_HREFS }
  // This file runs from its installed copy under node_modules, so walk up to
  // the repo root (the directory that holds both `plugins` and `test-sdk`).
  let root = dirname(fileURLToPath(import.meta.url))
  while (!(existsSync(join(root, 'plugins')) && existsSync(join(root, 'test-sdk')))) {
    const parent = dirname(root)
    if (parent === root) return entityHrefs
    root = parent
  }
  const pluginsDir = join(root, 'plugins')
  for (const id of readdirSync(pluginsDir)) {
    const manifestPath = join(pluginsDir, id, 'bakin-plugin.json')
    if (id.startsWith('_') || !existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const entity of manifest.contributes?.entities ?? []) entityHrefs[`${manifest.id}:${entity.kind}`] = entity.href
  }
  return entityHrefs
}

export function entityHref(kind, id, options = {}) {
  const template = declaredEntityHrefs()[kind]
  if (!template) return null
  let missing = false
  const href = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name) => {
    const value = name === 'id' ? id : options.params?.[name]
    if (typeof value !== 'string' || value === '') { missing = true; return '' }
    return encodeURIComponent(value)
  })
  if (missing) return null
  const extra = Object.entries(options.query ?? {})
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  return extra ? `${href}${href.includes('?') ? '&' : '?'}${extra}` : href
}

export function usePathname() {
  return globalThis.__bakinTestSdkHooks?.usePathname?.() ?? '/'
}

export function useSearchParams() {
  return globalThis.__bakinTestSdkHooks?.useSearchParams?.() ?? new URLSearchParams()
}

export function useQueryState(_key, defaultValue = '') {
  const [value, setValue] = useState(defaultValue)
  return [value, setValue, setValue]
}

export function useQueryArrayState() {
  const [value, setValue] = useState([])
  return [value, setValue, setValue]
}

// Unit-only controlled exit surface; actual routing/beforeunload is browser-tested.
export function useUnsavedChangesGuard(options) {
  const [open, setOpen] = useState(false)
  return {
    requestExit: () => options.hasUnsavedChanges ? setOpen(true) : options.onCancel?.(),
    reset: () => setOpen(false),
    dialog: open ? React.createElement('div', { role: 'dialog', 'aria-label': 'Unsaved changes' },
      options.error ? React.createElement('div', { role: 'alert' }, options.error) : null,
      React.createElement('button', { disabled: options.saving, onClick: async () => { if (await options.onSaveAndExit()) { setOpen(false); options.onCancel?.() } } }, options.saveLabel ?? 'Save and exit'),
      React.createElement('button', { disabled: options.saving, onClick: () => { options.onDiscardAndExit(); setOpen(false); options.onCancel?.() } }, 'Discard and leave'),
      React.createElement('button', { onClick: () => setOpen(false) }, 'Stay')) : null,
  }
}

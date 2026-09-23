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

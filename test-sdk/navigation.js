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

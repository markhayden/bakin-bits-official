/**
 * Ambient module declarations for `@bakin/sdk` and its sub-paths.
 *
 * The SDK is published from bakin's `packages/sdk` once it ships to
 * npm (issue #178); until then, plugin code in this repo compiles
 * against permissive `any` typings declared here. After #178 ships,
 * `bun add @bakin/sdk` brings real types and these ambient
 * declarations are shadowed automatically.
 *
 * Authors: don't add real types here. The SDK's source of truth lives
 * in the bakin repo. This file's job is to keep the workspace
 * type-checkable while we wait for the npm package.
 */
declare module '@bakin/sdk' {
  export const registerPlugin: (def: unknown) => void
  export const unregisterPlugin: (id: string) => void
  export const getAllNavItems: () => unknown[]
  export interface NavItem {
    id: string
    label: string
    icon?: string
    href: string
    order?: number
  }
}

declare module '@bakin/sdk/types' {
  export interface PluginContext {
    pluginId: string
    registerRoute: (route: unknown) => void
    registerHealthCheck: (def: unknown) => string
    registerNav: (items: unknown) => void
    registerSlot: (reg: unknown) => void
    registerExecTool: (tool: unknown) => void
    registerSkill: (skill: unknown) => void
    registerWorkflow: (def: unknown) => void
    registerNodeType: (def: unknown) => string
    registerNotificationChannel: (def: unknown) => string
    watchFiles: (patterns: string[]) => void
    getSettings: <T = Record<string, unknown>>() => T
    updateSettings: (patch: Record<string, unknown>) => void
    activity: {
      log: (agent: string, message: string, opts?: unknown) => void
      audit: (event: string, agent: string, data?: Record<string, unknown>) => void
    }
    search: {
      index: (...args: unknown[]) => Promise<unknown>
      remove: (...args: unknown[]) => Promise<unknown>
      registerContentType: (...args: unknown[]) => unknown
      registerFileBackedContentType: (...args: unknown[]) => unknown
    }
    hooks: {
      register: (name: string, handler: unknown) => () => void
      has: (name: string) => boolean
      invoke: <R>(name: string, data: unknown) => Promise<R | undefined>
    }
    storage: unknown
    events: unknown
  }

  export interface BakinPlugin {
    id: string
    name: string
    version: string
    navItems?: unknown[]
    activate: (ctx: PluginContext) => void | Promise<void>
    onShutdown?: (ctx?: PluginContext) => void | Promise<void>
    onReady?: () => void | Promise<void>
    onUninstall?: (ctx: PluginContext) => void | Promise<void>
    onSettingsChange?: (settings: Record<string, unknown>) => void | Promise<void>
    settingsSchema?: unknown
  }
}

declare module '@bakin/sdk/components' {
  import type { ReactNode } from 'react'
  export const PluginHeader: (props: { title: string; count?: number; children?: ReactNode }) => JSX.Element
}

declare module '@bakin/sdk/hooks' {
  export const useAgent: (...args: unknown[]) => unknown
  export const useAgentList: (...args: unknown[]) => unknown
  export const useSSE: (...args: unknown[]) => unknown
  export const useSearch: (...args: unknown[]) => unknown
  export const useQueryState: <T>(key: string, defaultValue: T) => [T, (next: T) => void]
  export const useQueryArrayState: (key: string) => [string[], (next: string[]) => void]
  export const useDebug: () => { enabled: boolean }
}

declare module '@bakin/sdk/ui' {
  // Shadcn primitives — re-exported by the SDK. Permissive typing
  // until the real package ships.
  export const Button: (props: Record<string, unknown>) => JSX.Element
  export const Card: (props: Record<string, unknown>) => JSX.Element
  export const Input: (props: Record<string, unknown>) => JSX.Element
}

declare module '@bakin/sdk/slots' {
  import type { ComponentType } from 'react'
  export const Slot: ComponentType<{ name: string; [key: string]: unknown }>
  export const registerSlot: (name: string, component: ComponentType<unknown>, order?: number) => void
}

declare module '@bakin/sdk/utils' {
  export const cn: (...args: Array<string | undefined | null | false>) => string
  export const formatAge: (date: Date | string) => string
  export const formatSize: (bytes: number) => string
}

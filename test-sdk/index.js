const registry = new Map()

function normalizeRoutes(routes = {}, owner = '') {
  if (Array.isArray(routes)) return routes
  return Object.entries(routes).map(([path, component]) => ({ path, component, owner }))
}

export function registerPlugin(def) {
  registry.set(def.id, def)
}

export function unregisterPlugin(id) {
  registry.delete(id)
}

export function getAllNavItems() {
  return Array.from(registry.values()).flatMap(def => def.navItems ?? [])
}

export function getPluginRoutes(id) {
  return normalizeRoutes(registry.get(id)?.routes, id)
}

export function getPluginRoute(id, path) {
  return getPluginRoutes(id).find(route => route.path === path)
}

export function getRegistryVersion() {
  return registry.size
}

export function subscribeRegistry() {
  return () => {}
}

const navBadges = new Map()

export function setNavBadge(pluginId, navItemId, badge) {
  if (badge === null) navBadges.delete(navItemId)
  else navBadges.set(navItemId, badge)
}

export function getNavBadge(navItemId) {
  return navBadges.get(navItemId)
}

// Declarative routing (host #642 migration): identity passthroughs are enough
// for tests — the real dispatcher lives host-side; tests invoke handlers via
// the recorded route table.
export function defineRoute(route) {
  return route
}

export function definePlugin(plugin) {
  return plugin
}

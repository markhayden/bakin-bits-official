import React from 'react'

export function PluginLink({ to, children, ...props }) {
  return React.createElement('a', { ...props, href: to }, children)
}

import React from 'react'

function component(tag) {
  return function LayoutComponent({ as, children, ...props }) {
    return React.createElement(as ?? tag, props, children)
  }
}

export const Stack = component('div')
export const Inline = component('div')
export const Grid = component('div')
export const PageShell = component('div')
export const BoundedOverflow = component('div')

// Panel: bounded surface with an optional tone rail (pass-four conformance)
export const Panel = ({ as, tone, variant, padding, scroll, children, ...props }) =>
  React.createElement(as ?? 'div', { ...props, 'data-slot': 'panel', 'data-tone': tone }, children)

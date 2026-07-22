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

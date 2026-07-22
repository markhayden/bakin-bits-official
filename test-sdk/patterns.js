import React from 'react'

function component(tag) {
  return function PatternComponent({ children, ...props }) {
    return React.createElement(tag, props, children)
  }
}

export const DetailPage = component('div')
export const DetailPageBody = component('div')
export const DetailPageMain = component('div')
export const PageHeader = ({ title, description, eyebrow, meta, ...props }) => React.createElement(
  'header',
  props,
  eyebrow ? React.createElement('p', null, eyebrow) : null,
  React.createElement('h1', null, title),
  description ? React.createElement('p', null, description) : null,
  meta,
)

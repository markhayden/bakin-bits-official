import React from 'react'

// Focused rich-content stubs mirroring `@makinbakin/sdk/content`.

export function MarkdownContent({ content, className }) {
  return React.createElement('div', { 'data-testid': 'markdown-content', className }, content)
}

export function MarkdownEditor({ content = '', editing, mode, onChange, placeholder, label, className }) {
  const isEditing = mode ? mode === 'edit' : editing
  if (!isEditing) {
    return React.createElement(
      'div',
      { 'data-markdown-editor': '', 'data-mode': 'preview', className },
      content || placeholder,
    )
  }
  return React.createElement('textarea', {
    'aria-label': label,
    'data-markdown-editor': '',
    'data-mode': 'edit',
    placeholder,
    className,
    value: content,
    onChange: event => onChange?.(event.target.value),
  })
}

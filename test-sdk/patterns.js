import React from 'react'

function component(tag) {
  return function PatternComponent({ children, ...props }) {
    return React.createElement(tag, props, children)
  }
}

// Consolidated Page family (storybook-refit T5.1)
export const Page = ({ children, width, scroll, density, ...props }) => React.createElement(
  'div',
  { ...props, 'data-archetype': 'page', 'data-scroll': scroll ?? 'page' },
  children,
)
export const PageBody = ({ children, state, feedback, busy, layout, gap, label, labelledBy, ...props }) => React.createElement(
  'section',
  { ...props, 'aria-label': label, 'aria-labelledby': labelledBy, 'aria-busy': busy || undefined },
  feedback ?? null,
  state ?? children,
)
export const PageControls = ({ children, actions, as, divider, label, labelledBy, ...props }) => React.createElement(
  'section',
  { ...props, 'aria-label': label, 'aria-labelledby': labelledBy },
  children,
  actions ?? null,
)
export const PageAside = ({ children, label, labelledBy, ...props }) => React.createElement(
  'aside',
  { ...props, 'aria-label': label, 'aria-labelledby': labelledBy },
  children,
)
export const PageCanvas = ({ children, orientation, ...props }) => React.createElement('div', props, children)
export const PageTimeline = ({ children, live, label, labelledBy, ...props }) => React.createElement(
  'div',
  { ...props, role: 'log', 'aria-label': label, 'aria-labelledby': labelledBy },
  children,
)
export const PageComposer = component('div')

export const WorkspacePage = component('div')
export const WorkspacePageBody = component('div')
export const WorkspacePageHeader = component('div')
export const StatusBadge = ({ children, tone = 'neutral', ...props }) => React.createElement(
  'span',
  { ...props, 'data-tone': tone },
  children,
)
export const StatusMarker = ({ tone = 'neutral', label, ...props }) => React.createElement(
  'span',
  {
    ...props,
    'data-status-marker': '',
    'data-tone': tone,
    role: label ? 'img' : undefined,
    'aria-label': label,
    'aria-hidden': label ? undefined : 'true',
  },
)
export const PageHeaderOverflowMenu = ({ children, label = 'More actions' }) => React.createElement(
  'div',
  null,
  React.createElement('button', { type: 'button', 'aria-label': label }, '…'),
  children,
)
export const PageHeader = ({ title, description, eyebrow, navigation, meta, controls, actions, overflowActions, overflowActionsLabel, ...props }) => React.createElement(
  'header',
  props,
  navigation,
  eyebrow ? React.createElement('p', null, eyebrow) : null,
  overflowActions ? React.createElement(PageHeaderOverflowMenu, { label: overflowActionsLabel }, overflowActions) : null,
  React.createElement('h1', null, title),
  description ? React.createElement('p', null, description) : null,
  meta,
  controls,
  actions,
)

export function SearchInput({ label, value, onValueChange, placeholder }) {
  return React.createElement('input', {
    'aria-label': label,
    type: 'search',
    value,
    placeholder,
    onChange: event => onValueChange?.(event.target.value),
  })
}

export function AgentAvatar({ agent }) {
  return React.createElement('span', { 'data-testid': `avatar-${agent?.id ?? 'unknown'}` }, agent?.name)
}

export function AgentFilter({ options = [] }) {
  return React.createElement(
    'div',
    { 'data-testid': 'agent-filter' },
    ...options.map(option => React.createElement(
      'span',
      { key: option.value, 'data-testid': `agent-option-${option.value}` },
      option.label,
    )),
  )
}

export function FacetFilter({ label, options = [] }) {
  return React.createElement(
    'div',
    { 'data-testid': `facet-${label}` },
    ...options.map(option => React.createElement(
      'span',
      { key: option.value, 'data-testid': `facet-option-${label}-${option.value}` },
      option.label,
    )),
  )
}

export function SegmentedControl({ options = [], value, onValueChange, ariaLabel, idPrefix, ...props }) {
  return React.createElement(
    'div',
    { ...props, role: 'tablist', 'aria-label': ariaLabel },
    ...options.map(option => React.createElement(
      'button',
      {
        key: option.value,
        id: idPrefix ? `${idPrefix}-tab-${option.value}` : undefined,
        type: 'button',
        role: 'tab',
        'aria-selected': value === option.value,
        'aria-controls': idPrefix ? `${idPrefix}-panel-${option.value}` : undefined,
        disabled: option.disabled,
        onClick: () => onValueChange?.(option.value),
      },
      option.label,
    )),
  )
}

// ── AgentSelect (presentation-only; consumer supplies the agents) ─────────
export function AgentSelect({ value, onValueChange, agents = [], ariaLabel, placeholder, disabled }) {
  return React.createElement(
    'select',
    {
      'data-testid': 'agent-select',
      'aria-label': ariaLabel ?? placeholder,
      value: value ?? '',
      disabled,
      onChange: event => onValueChange?.(event.target.value),
    },
    ...agents.map(agent => React.createElement('option', { key: agent.id, value: agent.id }, agent.name)),
  )
}

// ── ConfirmDialog (canonical confirm/danger flow) ─────────────────────────
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  busyLabel,
  cancelLabel = 'Cancel',
  busy = false,
  error,
  confirmTestId,
  children,
  onConfirm,
  onCancel,
}) {
  if (!open) return null
  return React.createElement(
    'div',
    {
      role: 'dialog',
      'aria-modal': 'true',
      // The real ConfirmDialog names the dialog from its title (aria-labelledby).
      'aria-label': typeof title === 'string' ? title : undefined,
      'data-testid': 'confirm-dialog',
    },
    React.createElement('h2', null, title),
    description ? React.createElement('p', null, description) : null,
    children,
    error ? React.createElement('div', { role: 'alert' }, error) : null,
    React.createElement('button', { type: 'button', disabled: busy, onClick: onCancel }, cancelLabel),
    React.createElement(
      'button',
      { type: 'button', disabled: busy, 'data-testid': confirmTestId, onClick: onConfirm },
      busy && busyLabel ? busyLabel : confirmLabel,
    ),
  )
}

// ── Vetted dense-row list (Lists taxonomy type 1) ─────────────────────────
export const ListRows = ({ children, variant = 'bordered', columns, columnsAt, columnsAlign, ...props }) =>
  React.createElement('ul', { ...props, 'data-list-rows': '', 'data-variant': variant }, children)
export const ListRow = ({ children, ...props }) =>
  React.createElement('li', { ...props, 'data-slot': 'list-row' }, children)
export const ListRowLabels = ({ children, ...props }) =>
  React.createElement('li', { ...props, 'aria-hidden': 'true', 'data-slot': 'list-row-labels' }, children)
export const ListRowGroup = ({ label, children, ...props }) =>
  React.createElement(
    'div',
    { ...props, 'data-slot': 'list-row-group' },
    React.createElement('div', { 'data-slot': 'list-row-group-label' }, label),
    children,
  )

// ── CalendarGrid (Lists taxonomy type 7; shared calendar STRUCTURE) ───────
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function calendarToDate(value) {
  if (value === undefined) return null
  if (typeof value === 'string') {
    const dateOnly = DATE_ONLY_PATTERN.exec(value)
    if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
  }
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function calendarDayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/**
 * Functional stub of the shared calendar structure: places items into the
 * visible month / week / day like the real kit (local date parsing included)
 * and renders them through the consumer-owned renderItem, without the real
 * grid chrome or keyboard navigation.
 */
export function CalendarGrid({
  view,
  date,
  items = [],
  renderItem,
  label,
  renderDayHeader,
  outsideDays = 'hidden',
  granularity = 'hour',
  dimPastDays = false,
  className,
}) {
  const anchor = date instanceof Date ? date : new Date(date)
  const placed = items
    .map(item => ({ item, instant: calendarToDate(item.start) ?? calendarToDate(item.date) }))
    .filter(entry => entry.instant !== null)

  let visible
  if (view === 'month') {
    visible = placed.filter(({ instant }) =>
      outsideDays === 'muted'
        ? Math.abs(instant.getTime() - anchor.getTime()) < 45 * 24 * 60 * 60 * 1000
        : instant.getFullYear() === anchor.getFullYear() && instant.getMonth() === anchor.getMonth())
  } else if (view === 'week') {
    const start = new Date(anchor)
    start.setHours(0, 0, 0, 0)
    start.setDate(start.getDate() - start.getDay())
    const end = new Date(start)
    end.setDate(end.getDate() + 7)
    visible = placed.filter(({ instant }) => instant >= start && instant < end)
  } else {
    const dayKey = calendarDayKey(anchor)
    visible = placed.filter(({ instant }) => calendarDayKey(instant) === dayKey)
  }

  const dayKeys = [...new Set(visible.map(({ instant }) => calendarDayKey(instant)))]
  return React.createElement(
    'div',
    {
      role: 'grid',
      'aria-label': label,
      'data-calendar-grid': '',
      'data-view': view,
      'data-granularity': granularity === 'day' ? 'day' : undefined,
      'data-dim-past-days': dimPastDays ? '' : undefined,
      'data-outside-days': outsideDays,
      className,
    },
    ...(renderDayHeader
      ? dayKeys.map(key => {
        const [year, month, day] = key.split('-').map(Number)
        return React.createElement(
          'span',
          { key: `header-${key}`, 'data-slot': 'calendar-day-header' },
          renderDayHeader(new Date(year, month, day)),
        )
      })
      : []),
    ...visible.map(({ item }) => React.createElement(React.Fragment, { key: item.key }, renderItem(item))),
  )
}

// ── AssetPicker (presentation-only picker pattern; storybook-refit T5.x) ──
function AssetPickerPanel({
  busy = false,
  collection,
  notice,
  onPick,
  onQueryChange,
  onRetry,
  query,
  searchLabel = 'Search assets',
  searchPlaceholder = 'Search assets…',
  emptyTitle = 'No assets yet',
  emptyDescription = 'Add an asset to the library, then return here to choose it.',
  noResultsTitle = 'No assets match your search',
  noResultsDescription = 'Try another search or clear the current query.',
  view = 'grid',
}) {
  const normalized = (query ?? '').trim().toLowerCase()
  const visible = collection.status === 'ready'
    ? collection.assets.filter(asset => {
        if (!normalized) return true
        return [asset.id, asset.label, asset.description, asset.type]
          .filter(Boolean)
          .some(value => value.toLowerCase().includes(normalized))
      })
    : []

  let body
  if (collection.status === 'loading') {
    body = React.createElement('p', null, 'Loading assets')
  } else if (collection.status === 'error') {
    body = React.createElement(
      'div',
      { role: 'alert' },
      React.createElement('p', null, collection.message ?? 'The asset library is unavailable right now.'),
      onRetry ? React.createElement('button', { type: 'button', onClick: onRetry }, 'Try again') : null,
    )
  } else if (visible.length > 0) {
    body = React.createElement(
      'ul',
      { 'data-asset-picker-choices': '', 'data-view': view },
      ...visible.map(asset => React.createElement(
        'li',
        { key: asset.id },
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: busy || asset.disabled,
            'aria-label': `Select ${asset.label}`,
            'data-asset-picker-item': asset.id,
            onClick: () => onPick(asset.id),
          },
          React.createElement('span', null, asset.label),
          asset.description ? React.createElement('span', null, asset.description) : null,
        ),
      )),
    )
  } else if (normalized) {
    body = React.createElement('p', null, `${noResultsTitle} — ${noResultsDescription}`)
  } else {
    body = React.createElement('p', null, `${emptyTitle} — ${emptyDescription}`)
  }

  return React.createElement(
    'div',
    { 'data-asset-picker-panel': '' },
    React.createElement('input', {
      type: 'search',
      value: query,
      'aria-label': searchLabel,
      placeholder: searchPlaceholder,
      disabled: busy,
      'data-asset-picker-search': '',
      onChange: event => onQueryChange?.(event.target.value),
    }),
    notice ? React.createElement('div', { role: 'alert' }, notice) : null,
    body,
  )
}

export function AssetPicker(props) {
  const title = props.title ?? 'Choose an asset'
  const description = props.description ?? 'Search the available library and choose one asset.'
  if (props.variant === 'inline') {
    return React.createElement(
      'section',
      { 'aria-label': title, 'data-asset-picker': '', 'data-variant': 'inline', className: props.className },
      React.createElement('h2', null, title),
      React.createElement('p', null, description),
      React.createElement(AssetPickerPanel, props),
    )
  }
  if (!props.open) return null
  return React.createElement(
    'div',
    { role: 'dialog', 'aria-label': title, 'data-asset-picker': '', 'data-variant': 'dialog', className: props.className },
    React.createElement('h2', null, title),
    React.createElement('p', null, description),
    React.createElement('button', { type: 'button', 'aria-label': 'Close', onClick: () => props.onOpenChange?.(false) }, 'Close'),
    React.createElement(AssetPickerPanel, props),
  )
}

// ── ChannelIcon (focused successor to the frozen-barrel export) ──────────
export function ChannelIcon({ channelId }) {
  return React.createElement('span', { 'data-testid': `channel-icon-${channelId ?? 'unknown'}` })
}

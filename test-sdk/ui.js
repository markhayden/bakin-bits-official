import React from 'react'

function createElement(tag, defaultProps = {}) {
  return function Component({ children, ...props }) {
    return React.createElement(tag, { ...defaultProps, ...props }, children)
  }
}

export const Alert = createElement('div')
export const AlertDescription = createElement('div')
export const AlertTitle = createElement('div')
export const Avatar = createElement('span')
export const Drawer = ({ children, open = true }) => open ? React.createElement('div', null, children) : null
export const Badge = createElement('span', { 'data-testid': 'badge' })
export const Button = ({ busy, focusableWhenDisabled, children, ...props }) => React.createElement('button', props, children)
export const Card = ({ children, interactive, selected, tone, orientation, size, ...props }) =>
  React.createElement(
    'div',
    { ...props, 'data-slot': 'card', 'data-selected': selected ? '' : undefined, 'data-tone': tone },
    interactive
      ? React.createElement('button', {
          type: 'button',
          'aria-label': interactive.label,
          onClick: interactive.onActivate,
        })
      : null,
    children,
  )
export const CardMedia = createElement('div')
export const CardAction = createElement('div')
export const CardContent = createElement('div')
export const CardDescription = createElement('div')
export const CardFooter = ({ children, variant, ...props }) =>
  React.createElement('div', { ...props, 'data-slot': 'card-footer', 'data-variant': variant }, children)
export const CardHeader = createElement('div')
export const CardTitle = createElement('div')
export const Checkbox = createElement('input', { type: 'checkbox' })
export const Collapsible = createElement('div')
export const Command = createElement('div')
// Functional minimum of the kit Dialog: role/aria-labelledby wiring from the
// title and Escape → onOpenChange(false), so tests can find a dialog by its
// accessible name and dismiss it the way the real overlay does.
const DialogContext = React.createContext({ onOpenChange: undefined, titleId: undefined })
export function Dialog({ children, open = true, onOpenChange, busy: _busy }) {
  const titleId = React.useId()
  React.useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event) => { if (event.key === 'Escape') onOpenChange?.(false) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onOpenChange])
  if (!open) return null
  return React.createElement(
    DialogContext.Provider,
    { value: { onOpenChange, titleId } },
    React.createElement('div', null, children),
  )
}
export function DialogContent({ children, closeLabel: _closeLabel, showCloseButton: _showCloseButton, overlayProps: _overlayProps, portalProps: _portalProps, ...props }) {
  const { titleId } = React.useContext(DialogContext)
  return React.createElement(
    'div',
    { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': props['aria-label'] ? undefined : titleId, ...props, 'data-slot': 'dialog-content' },
    children,
  )
}
export const DialogHeader = createElement('div')
export function DialogTitle({ children, ...props }) {
  const { titleId } = React.useContext(DialogContext)
  return React.createElement('h2', { id: titleId, ...props }, children)
}
export const DialogDescription = createElement('p', { 'data-slot': 'dialog-description' })
export const DropdownMenu = createElement('div')
export const DropdownMenuTrigger = createElement('button')
export const DropdownMenuContent = createElement('div')
export const DropdownMenuItem = createElement('button')
export const DropdownMenuSeparator = createElement('hr')
export const Form = ({ busy, children, ...props }) => React.createElement('form', props, children)
export const FormActions = createElement('div')
export const Field = createElement('div')
export const FieldDescription = createElement('div')
export const FieldLabel = createElement('label')
export const Input = createElement('input')
export const InputGroup = createElement('div')
export const Label = createElement('label')
export const Popover = createElement('div')
export const Progress = createElement('progress')
// Functional minimum of the kit Select — a native <select> facade so tests
// drive real change events; options harvested from SelectItem descendants.
function collectSelectItems(node, out) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach(child => collectSelectItems(child, out))
    return out
  }
  if (node.type === SelectItem) {
    out.push({ value: node.props.value, label: node.props.children })
    return out
  }
  collectSelectItems(node.props?.children, out)
  return out
}
export const Select = ({ children, value, defaultValue, onValueChange, ...props }) => {
  const items = collectSelectItems(children, [])
  return React.createElement(
    'select',
    {
      ...props,
      value: value ?? defaultValue ?? '',
      onChange: event => onValueChange?.(event.target.value),
    },
    items.map(item => React.createElement('option', { key: String(item.value), value: item.value }, item.label)),
  )
}
export const SelectContent = ({ children }) => React.createElement(React.Fragment, null, children)
export const SelectItem = () => null
export const SelectTrigger = () => null
export const SelectValue = () => null
export const Separator = createElement('hr')
export const Sheet = createElement('div')
export const Skeleton = createElement('div')
export const Switch = createElement('button')
export const Table = createElement('table')
export const TableHeader = createElement('thead')
export const TableBody = createElement('tbody')
export const TableRow = createElement('tr')
export const TableHead = createElement('th')
export const TableCell = createElement('td')
const TabsContext = React.createContext({ value: undefined, onValueChange: undefined })

export function Tabs({ children, value, defaultValue, onValueChange, ...props }) {
  return React.createElement(
    TabsContext.Provider,
    { value: { value: value ?? defaultValue, onValueChange } },
    React.createElement('div', props, children),
  )
}

export function TabsList({ children, variant, activateOnFocus, ...props }) {
  return React.createElement(
    'div',
    { ...props, role: 'tablist', 'data-variant': variant },
    children,
  )
}

export function TabsTrigger({ children, value, disabled, ...props }) {
  return React.createElement(
    TabsContext.Consumer,
    null,
    ({ value: activeValue, onValueChange }) => React.createElement(
      'button',
      {
        ...props,
        type: 'button',
        role: 'tab',
        'aria-selected': activeValue === value,
        disabled,
        onClick: () => onValueChange?.(value),
      },
      children,
    ),
  )
}

export function TabsContent({ children, value, ...props }) {
  return React.createElement(
    TabsContext.Consumer,
    null,
    ({ value: activeValue }) => activeValue === value
      ? React.createElement('div', { ...props, role: 'tabpanel' }, children)
      : null,
  )
}

export const Textarea = createElement('textarea')
export const Tooltip = createElement('span')

export const SubmitButton = ({ busy, busyLabel, children, ...props }) =>
  React.createElement('button', { ...props, type: 'submit' }, busy ? (busyLabel ?? 'Submitting…') : children)

export function SystemState({ action, description, title, headingLevel = 2, preview, recovery, align, announce, ...props }) {
  return React.createElement(
    'section',
    { ...props, 'data-kind': props.kind, 'data-recovery': recovery },
    React.createElement(`h${headingLevel}`, null, title),
    description ? React.createElement('p', null, description) : null,
    action,
  )
}

export function buttonVariants({ className = '' } = {}) {
  return className
}

// ── Typography + form/overlay additions (pass-four conformance) ───────────
export const Overline = ({ as, children, ...props }) =>
  React.createElement(as ?? 'span', { ...props, 'data-slot': 'overline' }, children)
export const Text = ({ as, size, tone, weight, mono, children, ...props }) =>
  React.createElement(as ?? 'span', { ...props, 'data-slot': 'text', 'data-size': size, 'data-tone': tone }, children)

// Functional minimum of the kit RadioGroup: role wiring + one selected value.
const RadioGroupContext = React.createContext({ value: undefined, select: undefined, disabled: false })
export function RadioGroup({ children, value, defaultValue, onValueChange, disabled = false, ...props }) {
  const [internal, setInternal] = React.useState(defaultValue)
  const current = value ?? internal
  const select = next => {
    setInternal(next)
    onValueChange?.(next)
  }
  return React.createElement(
    RadioGroupContext.Provider,
    { value: { value: current, select, disabled } },
    React.createElement('div', { ...props, role: 'radiogroup', 'data-slot': 'radio-group' }, children),
  )
}
export function Radio({ value, disabled = false, ...props }) {
  const group = React.useContext(RadioGroupContext)
  return React.createElement('button', {
    ...props,
    type: 'button',
    role: 'radio',
    'aria-checked': group.value === value,
    disabled: disabled || group.disabled,
    'data-slot': 'radio',
    onClick: () => group.select?.(value),
  })
}

export const FieldGroup = createElement('div', { 'data-slot': 'field-group' })
export const FieldError = ({ children, ...props }) => React.createElement('div', { ...props, role: 'alert' }, children)
export const FieldControl = ({ render, children, ...props }) =>
  render ? React.cloneElement(render, props, children ?? render.props.children) : React.createElement('input', props)
export function DialogFooter({ children, showCloseButton, ...props }) {
  const { onOpenChange } = React.useContext(DialogContext)
  return React.createElement(
    'div',
    { ...props, 'data-slot': 'dialog-footer' },
    children,
    showCloseButton
      ? React.createElement('button', { type: 'button', onClick: () => onOpenChange?.(false) }, 'Close')
      : null,
  )
}

export const TooltipProvider = ({ children }) => React.createElement(React.Fragment, null, children)
export const TooltipTrigger = ({ render, children, ...props }) =>
  render
    ? React.cloneElement(render, props, children ?? render.props.children)
    : React.createElement('button', { type: 'button', ...props }, children)
// Closed tooltip — the real popup only mounts on hover/focus.
export const TooltipContent = () => null

// ── InputGroup family (pass-four conformance: projects checklist) ────────
export const InputGroupAddon = ({ align, children, ...props }) =>
  React.createElement('div', { ...props, 'data-slot': 'input-group-addon', 'data-align': align }, children)
export const InputGroupButton = ({ children, type = 'button', size, variant, ...props }) =>
  React.createElement('button', { ...props, type, 'data-size': size }, children)
export const InputGroupInput = createElement('input', { 'data-slot': 'input-group-control' })
export const Fieldset = createElement('fieldset', { 'data-slot': 'fieldset' })
export const FieldsetLegend = createElement('legend', { 'data-slot': 'fieldset-legend' })
export const FieldsetDescription = createElement('p', { 'data-slot': 'fieldset-description' })

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
export const Button = createElement('button')
export const Card = createElement('div')
export const CardAction = createElement('div')
export const CardContent = createElement('div')
export const CardDescription = createElement('div')
export const CardHeader = createElement('div')
export const CardTitle = createElement('div')
export const Checkbox = createElement('input', { type: 'checkbox' })
export const Collapsible = createElement('div')
export const Command = createElement('div')
export const Dialog = ({ children, open = true }) => open ? React.createElement('div', null, children) : null
export const DialogContent = createElement('div')
export const DialogHeader = createElement('div')
export const DialogTitle = createElement('h2')
export const DropdownMenu = createElement('div')
export const DropdownMenuTrigger = createElement('button')
export const DropdownMenuContent = createElement('div')
export const DropdownMenuItem = createElement('button')
export const DropdownMenuSeparator = createElement('hr')
export const Form = createElement('form')
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

export const SubmitButton = createElement('button', { type: 'submit' })

export function SystemState({ action, description, title, ...props }) {
  return React.createElement(
    'section',
    props,
    React.createElement('h2', null, title),
    description ? React.createElement('p', null, description) : null,
    action,
  )
}

export function buttonVariants({ className = '' } = {}) {
  return className
}

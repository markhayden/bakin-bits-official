import './setup-dom'
import { afterEach, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { KeyBar } from '../components/key-bar'
import { NO_MODIFIERS, type ModifierState } from '../components/terminal-input'
afterEach(cleanup)

function bar(options: { session?: 'typing' | 'sheet'; disabled?: boolean; modifiers?: ModifierState } = {}) {
  const sent: string[] = []
  const view = render(<KeyBar session={options.session ?? 'typing'} disabled={options.disabled ?? false} modifiers={options.modifiers ?? NO_MODIFIERS}
    onKey={key => sent.push(key)} onModifier={(modifier, action) => sent.push(`${modifier}:${action}`)}
    onSheet={() => sent.push('sheet')} onKeyboard={() => sent.push('keyboard')} onHide={() => sent.push('hide')} />)
  return { view, sent, row: within(view.getByRole('group', { name: 'Terminal keys' })) }
}

test('one row: esc, tab, the two modifiers, •••, and hide keyboard, each acting once', () => {
  const { row, sent } = bar()
  expect(row.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Esc', 'Tab', 'Control', 'Option', 'More keys', 'Hide keyboard'])
  expect(row.getByRole('button', { name: 'Esc' }).textContent).toBe('esc')
  expect(row.getByRole('button', { name: 'Tab' }).textContent).toBe('⇥')
  const tab = row.getByRole('button', { name: 'Tab' })
  fireEvent.mouseDown(tab)
  fireEvent.click(tab)
  fireEvent.click(row.getByRole('button', { name: 'Control' }))
  fireEvent.click(row.getByRole('button', { name: 'More keys' }))
  fireEvent.click(row.getByRole('button', { name: 'Hide keyboard' }))
  expect(sent).toEqual(['Tab', 'ctrl:tap', 'sheet', 'hide'])
})

test('pressing a key keeps focus where it is (the keyboard stays up)', () => {
  const { row } = bar()
  for (const name of ['Esc', 'Control', 'More keys', 'Hide keyboard']) {
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    row.getByRole('button', { name }).dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  }
})

test('modifiers announce armed and locked, not by colour alone', () => {
  const { row, view } = bar({ modifiers: { ctrl: 'once', alt: 'locked' } })
  const ctrl = row.getByRole('button', { name: 'Control, on for the next key' })
  expect(ctrl.getAttribute('aria-pressed')).toBe('true')
  expect(ctrl.getAttribute('data-state')).toBe('once')
  const alt = row.getByRole('button', { name: 'Option, locked' })
  expect(alt.querySelector('.terminal-keycap-lock')).toBeTruthy()
  expect(view.container.querySelector('[data-terminal-keys]')).toBeTruthy()
})

test('the sheet holds every other key, labelled Control shortcuts and lock toggles; abc goes back', () => {
  const { view, row, sent } = bar({ session: 'sheet', modifiers: { ctrl: 'locked', alt: 'off' } })
  expect(row.queryByRole('button', { name: 'More keys' })).toBeNull()
  fireEvent.click(row.getByRole('button', { name: 'Back to keyboard' }))
  const sheet = within(view.getByRole('region', { name: 'More keys' }))
  expect(within(sheet.getByRole('group', { name: 'Keys' })).getAllByRole('button').map(button => button.getAttribute('aria-label')))
    .toEqual(['Esc', 'Tab', 'Shift+Tab', 'Enter', 'Backspace', 'Delete', 'Left', 'Down', 'Up', 'Right', 'Home', 'End', 'Page Up', 'Page Down', '|', '~', '/', '-'])
  const control = within(sheet.getByRole('group', { name: 'Control' }))
  expect(control.getAllByRole('button')).toHaveLength(10)
  fireEvent.click(control.getByRole('button', { name: 'Ctrl+C Interrupt' }))
  fireEvent.click(sheet.getByRole('button', { name: 'Left' }))
  // A locked modifier's toggle releases it; an unlocked one locks.
  const locks = within(sheet.getByRole('group', { name: 'Locks' }))
  expect(locks.getByRole('button', { name: 'Control lock' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(locks.getByRole('button', { name: 'Control lock' }))
  fireEvent.click(locks.getByRole('button', { name: 'Option lock' }))
  expect(sent).toEqual(['keyboard', 'Ctrl+C', 'Left', 'ctrl:tap', 'alt:lock'])
})

test('Escape inside the sheet goes back to the keyboard', () => {
  const { view, sent } = bar({ session: 'sheet' })
  fireEvent.keyDown(within(view.getByRole('region', { name: 'More keys' })).getByRole('button', { name: 'Home' }), { key: 'Escape' })
  expect(sent).toEqual(['keyboard'])
})

test('while sending is disabled every sending key and modifier is off, but hide and ••• still work', () => {
  const { view, row, sent } = bar({ disabled: true })
  for (const button of view.getAllByRole('button')) {
    const name = button.getAttribute('aria-label')
    expect((button as HTMLButtonElement).disabled).toBe(name !== 'More keys' && name !== 'Hide keyboard')
  }
  fireEvent.click(row.getByRole('button', { name: 'Tab' }))
  fireEvent.click(row.getByRole('button', { name: 'Hide keyboard' }))
  expect(sent).toEqual(['hide'])
})

test('while sending is disabled the sheet still takes focus and Escape anywhere goes back', () => {
  const { view, row, sent } = bar({ session: 'sheet', disabled: true })
  const sheet = view.getByRole('region', { name: 'More keys' })
  expect(sheet.getAttribute('tabindex')).toBe('-1')
  fireEvent.keyDown(row.getByRole('button', { name: 'Back to keyboard' }), { key: 'Escape' })
  fireEvent.keyDown(sheet, { key: 'Escape' })
  expect(sent).toEqual(['keyboard', 'keyboard'])
})

test('Escape on the bar does nothing while typing (it belongs to the terminal then)', () => {
  const { row, sent } = bar()
  fireEvent.keyDown(row.getByRole('button', { name: 'More keys' }), { key: 'Escape' })
  expect(sent).toEqual([])
})

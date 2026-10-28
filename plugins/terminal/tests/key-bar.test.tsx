import './setup-dom'
import { afterEach, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { KeyBar } from '../components/key-bar'
import { DEFAULT_PINS, type TerminalKey } from '../components/terminal-input'
afterEach(cleanup)

function bar(options: { disabled?: boolean; ctrl?: boolean; arrow?: 'Up' | 'Down' | 'Left' | 'Right' } = {}) {
  const sent: string[] = []
  const view = render(<KeyBar disabled={options.disabled ?? false} ctrl={options.ctrl ?? false} onCtrl={() => sent.push('Ctrl')} onKey={(key: TerminalKey) => sent.push(key)} onFocusTerminal={() => sent.push('focus')} arrow={options.arrow ?? 'Up'} pins={DEFAULT_PINS} />)
  return { view, sent, strip: within(view.container.querySelector<HTMLElement>('.terminal-key-strip')!) }
}

test('the strip holds Esc, Tab, Ctrl, one arrow key and the default pins, each sending exactly once', () => {
  const { strip, sent } = bar()
  const names = strip.getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent)
  expect(names).toEqual(['Esc', 'Tab', 'Ctrl', 'Up', 'Shift+Tab', 'Ctrl+C', 'Ctrl+R', 'Enter'])
  expect(strip.getByRole('button', { name: 'Ctrl+C' }).textContent).toBe('^C')
  expect(strip.getByRole('button', { name: 'Shift+Tab' }).textContent).toBe('⇧Tab')
  const tab = strip.getByRole('button', { name: 'Tab' })
  fireEvent.pointerDown(tab)
  fireEvent.mouseDown(tab)
  fireEvent.click(tab)
  fireEvent.click(strip.getByRole('button', { name: 'Up' }))
  fireEvent.click(strip.getByRole('button', { name: 'Ctrl' }))
  fireEvent.click(strip.getByRole('button', { name: 'Ctrl+C' }))
  expect(sent).toEqual(['Tab', 'Up', 'Ctrl', 'Ctrl+C'])
})

test('the arrow key sends the direction on its face', () => {
  const { strip, sent } = bar({ arrow: 'Left' })
  fireEvent.click(strip.getByRole('button', { name: 'Left' }))
  expect(sent).toEqual(['Left'])
})

test('key presses keep focus where it is', () => {
  const { strip } = bar()
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  strip.getByRole('button', { name: 'Esc' }).dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
})

test('••• holds the other keys, all four arrows and the labelled Control shortcuts', () => {
  const { view, sent } = bar()
  expect(view.getByRole('button', { name: 'More keys' })).toBeTruthy()
  const keys = within(view.getByRole('region', { name: 'Keys' }))
  expect(keys.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Enter', 'Backspace', 'Delete', 'Shift+Tab', 'Home', 'End', 'Page Up', 'Page Down', 'Left', 'Down', 'Up', 'Right'])
  const control = within(view.getByRole('region', { name: 'Control' }))
  expect(control.getByRole('button', { name: 'Ctrl+C Interrupt' }).textContent).toBe('^CInterrupt')
  expect(control.getAllByRole('button')).toHaveLength(10)
  fireEvent.click(control.getByRole('button', { name: 'Ctrl+R Search history' }))
  fireEvent.click(keys.getByRole('button', { name: 'Page Up' }))
  expect(sent).toEqual(['Ctrl+R', 'Page Up'])
})

test('the bar and its menu mark themselves as part of the terminal (the Ctrl latch survives touching them)', () => {
  const { view } = bar()
  expect(view.getByRole('toolbar', { name: 'Terminal keys' }).hasAttribute('data-terminal-keys')).toBe(true)
  expect(view.getByRole('region', { name: 'Keys' }).closest('[data-terminal-keys]')).toBeTruthy()
})

test('watching disables every sending key while ••• stays available and Ctrl shows its latch', () => {
  const { view, sent } = bar({ disabled: true, ctrl: true })
  for (const button of view.getAllByRole('button').filter(button => button.getAttribute('aria-label') !== 'More keys')) {
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
  }
  expect(sent).toEqual([])
  expect((view.getByRole('button', { name: 'More keys' }) as HTMLButtonElement).disabled).toBe(false)
  expect(view.getByRole('button', { name: 'Ctrl' }).getAttribute('aria-pressed')).toBe('true')
})

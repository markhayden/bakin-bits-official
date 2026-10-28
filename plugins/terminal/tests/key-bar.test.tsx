import './setup-dom'
import { afterEach, expect, test } from 'bun:test'
import { useState } from 'react'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { KeyBar } from '../components/key-bar'
import type { PasteOutcome } from '../components/compose-sheet'
import { NO_MODIFIERS, type ModifierState } from '../components/terminal-input'
afterEach(cleanup)

function bar(options: { session?: 'typing' | 'sheet' | 'compose'; disabled?: boolean; modifiers?: ModifierState; draft?: { text: string; kept: boolean }; outcome?: PasteOutcome } = {}) {
  const sent: string[] = []
  const view = render(<KeyBar session={options.session ?? 'typing'} disabled={options.disabled ?? false} modifiers={options.modifiers ?? NO_MODIFIERS}
    draft={options.draft ?? { text: '', kept: true }} onDraft={text => sent.push(`draft:${text}`)}
    onKey={key => sent.push(key)} onModifier={(modifier, action) => sent.push(`${modifier}:${action}`)}
    onSheet={() => sent.push('sheet')} onCompose={() => sent.push('compose')} onPaste={(text, enter) => { sent.push(`paste:${enter}:${text}`); return options.outcome ?? 'sent' }}
    onKeyboard={() => sent.push('keyboard')} onHide={() => sent.push('hide')} />)
  return { view, sent, row: within(view.getByRole('group', { name: 'Terminal keys' })) }
}

test('one row: esc, tab, the two modifiers, the arrow joystick, •••, and hide keyboard, each acting once', () => {
  const { row, sent } = bar()
  expect(row.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Esc', 'Tab', 'Control', 'Option', 'Arrow keys', 'More keys', 'Hide keyboard'])
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

test('the joystick sends arrows from the keyboard when focused, and a click alone sends nothing', () => {
  const { row, sent } = bar()
  const stick = row.getByRole('button', { name: 'Arrow keys' })
  fireEvent.keyDown(stick, { key: 'ArrowLeft' })
  fireEvent.keyDown(stick, { key: 'ArrowUp' })
  fireEvent.keyDown(stick, { key: 'a' })
  fireEvent.click(stick)
  expect(sent).toEqual(['Left', 'Up'])
})

test('Compose in the sheet opens the compose sheet and puts the keyboard in its textarea within the tap', () => {
  function Harness() {
    const [session, setSession] = useState<'sheet' | 'compose'>('sheet')
    return <KeyBar session={session} disabled={false} modifiers={NO_MODIFIERS} draft={{ text: '', kept: true }} onDraft={() => {}} onKey={() => {}} onModifier={() => {}}
      onSheet={() => {}} onCompose={() => setSession('compose')} onPaste={() => 'sent'} onKeyboard={() => {}} onHide={() => {}} />
  }
  const view = render(<Harness />)
  fireEvent.click(view.getByRole('button', { name: 'Compose' }))
  const textarea = view.getByRole('textbox', { name: 'Text to send' })
  expect(document.activeElement).toBe(textarea)
  // The row stays, with abc back to the keyboard.
  expect(view.getByRole('button', { name: 'Back to keyboard' })).toBeTruthy()
  expect(view.queryByRole('region', { name: 'More keys' })).toBeNull()
})

test('the compose sheet shows the draft, reports every edit, and sends the text once as Paste or Paste + Enter', () => {
  const { view, sent } = bar({ session: 'compose', draft: { text: 'echo one', kept: true } })
  const textarea = view.getByRole('textbox', { name: 'Text to send' }) as HTMLTextAreaElement
  expect(textarea.value).toBe('echo one')
  fireEvent.change(textarea, { target: { value: 'echo one\necho two' } })
  const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  view.getByRole('button', { name: 'Paste + Enter' }).dispatchEvent(mousedown)
  expect(mousedown.defaultPrevented).toBe(true)
  fireEvent.click(view.getByRole('button', { name: 'Paste + Enter' }))
  expect(sent).toEqual(['draft:echo one\necho two', 'paste:true:echo one\necho two'])
  // The page clears the draft once the server accepts the paste; the sheet does not.
  expect(textarea.value).toBe('echo one\necho two')
})

test('a send that does not go says why and keeps the text; sending is disabled while typing is, the draft editable', () => {
  const tooLong = bar({ session: 'compose', draft: { text: 'a lot', kept: true }, outcome: 'too-long' })
  fireEvent.click(tooLong.view.getByRole('button', { name: 'Paste' }))
  expect(tooLong.view.getByRole('status').textContent).toContain('Too long to send in one go')
  expect((tooLong.view.getByRole('textbox', { name: 'Text to send' }) as HTMLTextAreaElement).value).toBe('a lot')
  cleanup()
  const unavailable = bar({ session: 'compose', draft: { text: 'later', kept: true }, outcome: 'unavailable' })
  fireEvent.click(unavailable.view.getByRole('button', { name: 'Paste' }))
  expect(unavailable.view.getByRole('status').textContent).toContain('Your text is kept')
  cleanup()
  const disabled = bar({ session: 'compose', disabled: true, draft: { text: 'kept', kept: true } })
  expect((disabled.view.getByRole('button', { name: 'Paste' }) as HTMLButtonElement).disabled).toBe(true)
  expect((disabled.view.getByRole('textbox', { name: 'Text to send' }) as HTMLTextAreaElement).disabled).toBe(false)
})

test('a draft this browser cannot keep says so', () => {
  const { view } = bar({ session: 'compose', draft: { text: 'huge', kept: false } })
  expect(view.getByRole('status').textContent).toContain('too long to keep after you leave this page')
})

test('Escape returns to the keyboard from a sheet, but not inside a composition or once another handler claimed it', () => {
  const { view, sent } = bar({ session: 'compose', draft: { text: '', kept: true } })
  const textarea = view.getByRole('textbox', { name: 'Text to send' })
  fireEvent.keyDown(textarea, { key: 'Escape', isComposing: true })
  const claimed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  claimed.preventDefault()
  textarea.dispatchEvent(claimed)
  expect(sent).toEqual([])
  fireEvent.keyDown(textarea, { key: 'Escape' })
  expect(sent).toEqual(['keyboard'])
})

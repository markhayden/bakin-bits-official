import './setup-dom'
import { afterEach, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { TerminalControls } from '../components/terminal-controls'
afterEach(cleanup)

test('compact keys activate once and More exposes accessible editing controls', () => {
  const sent: string[] = []
  const view = render(<TerminalControls disabled={false} ctrl={false} onCtrl={() => sent.push('Ctrl')} onKey={key => sent.push(key)} />)
  const tab = view.getByRole('button', { name: 'Tab' })
  fireEvent.pointerDown(tab)
  fireEvent.click(tab)
  fireEvent.click(tab)
  expect(sent).toEqual(['Tab', 'Tab'])
  fireEvent.click(view.getByRole('button', { name: 'More' }))
  expect(view.getByRole('button', { name: 'More' }).getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(view.getByRole('button', { name: 'Ctrl+C' }))
  expect(sent.at(-1)).toBe('Ctrl+C')
  expect(view.getByRole('button', { name: 'Shift+Tab' })).toBeTruthy()
})

test('watching disables every sending key while More remains available', () => {
  const sent: string[] = []
  const view = render(<TerminalControls disabled ctrl onCtrl={() => sent.push('Ctrl')} onKey={key => sent.push(key)} />)
  fireEvent.click(view.getByRole('button', { name: 'More' }))
  for (const button of view.getAllByRole('button').filter(button => button.textContent !== 'More')) {
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
  }
  expect(sent).toEqual([])
  expect(view.getByRole('button', { name: 'Ctrl' }).getAttribute('aria-pressed')).toBe('true')
})

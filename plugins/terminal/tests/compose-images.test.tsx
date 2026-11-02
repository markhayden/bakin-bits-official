import './setup-dom'
import { afterEach, describe, expect, test } from 'bun:test'
import { useState } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { composePastes, imageFiles, PasteSequence, shellQuote, type DraftImage } from '../components/compose-images'
import { ComposeSheet, type PasteOutcome } from '../components/compose-sheet'
afterEach(cleanup)

describe('composePastes', () => {
  const images = [{ id: 'i1', name: 'a.png', path: '/data/uploads/s1/a.png' }, { id: 'i2', name: "b'q.png", path: "/data/up loads/s1/b'q.png" }]
  test('Claude Code and Codex: each image its own literal paste, then the text (after a space)', () => {
    for (const program of ['claude', 'codex'] as const) {
      expect(composePastes(program, 'what is wrong here', images)).toEqual([
        { text: '/data/uploads/s1/a.png', uploads: ['a.png'], imageIds: ['i1'], carriesText: false },
        { text: "/data/up loads/s1/b'q.png", uploads: ["b'q.png"], imageIds: ['i2'], carriesText: false },
        { text: ' what is wrong here', uploads: [], imageIds: [], carriesText: true },
      ])
    }
    expect(composePastes('claude', 'just text', [])).toEqual([{ text: 'just text', uploads: [], imageIds: [], carriesText: true }])
    expect(composePastes('codex', '', images.slice(0, 1))).toEqual([{ text: '/data/uploads/s1/a.png', uploads: ['a.png'], imageIds: ['i1'], carriesText: false }])
  })
  test('a shell: one paste — the text, then each path shell-quoted', () => {
    expect(composePastes('shell', 'open', images)).toEqual([{ text: "open '/data/uploads/s1/a.png' '/data/up loads/s1/b'\\''q.png'", uploads: ['a.png', "b'q.png"], imageIds: ['i1', 'i2'], carriesText: true }])
    expect(composePastes('shell', '', [])).toEqual([])
  })
  test('shellQuote round-trips through a real shell', async () => {
    const path = "/tmp/it's a \"path\" $HOME `x` \\ ;"
    const child = Bun.spawn(['/bin/sh', '-c', `printf '%s' ${shellQuote(path)}`], { stdout: 'pipe' })
    expect(await new Response(child.stdout).text()).toBe(path)
  })
  test('only PNG, JPEG and WebP files are taken', () => {
    const files = [new File(['x'], 'a.png', { type: 'image/png' }), new File(['x'], 'b.gif', { type: 'image/gif' }), new File(['x'], 'c.txt', { type: 'text/plain' }), new File(['x'], 'd.webp', { type: 'image/webp' })]
    expect(imageFiles(files).map((file) => file.name)).toEqual(['a.png', 'd.webp'])
    expect(imageFiles(null)).toEqual([])
  })
})

describe('PasteSequence', () => {
  const parts = composePastes('claude', 'look', [{ id: 'i1', name: 'a.png', path: '/a.png' }, { id: 'i2', name: 'b.png', path: '/b.png' }])
  function sequence(enter: boolean, refuse = new Set<number>()) {
    const sent: string[] = []
    const delivered: string[] = []
    let envelope = 0
    const run = new PasteSequence(parts, enter, (paste, withEnter) => { if (refuse.has(sent.length)) return false; sent.push(`${paste.text}${withEnter ? '⏎' : ''}`); return ++envelope }, (paste) => { delivered.push(paste.text) })
    return { run, sent, delivered }
  }
  test('one paste at a time, each only after the one before was accepted; Return only with the last', () => {
    const { run, sent, delivered } = sequence(true)
    expect(run.start()).toBe(1)
    expect(sent).toEqual(['/a.png'])
    expect(run.accepted()).toBe(2)
    expect(run.accepted()).toBe(3)
    expect(sent).toEqual(['/a.png', '/b.png', ' look⏎'])
    expect(run.accepted()).toBe('done')
    expect(delivered).toEqual(['/a.png', '/b.png', ' look'])
  })
  test('a refused paste stops the rest: nothing after it, no Return; only what went is delivered', () => {
    const { run, sent, delivered } = sequence(true)
    run.start()
    run.accepted()
    // The second paste is refused: the caller does not call accepted again.
    expect(sent).toEqual(['/a.png', '/b.png'])
    expect(delivered).toEqual(['/a.png'])
  })
  test('a paste that cannot go (reconnecting) is answered, and nothing after it goes', () => {
    const { run, sent, delivered } = sequence(false, new Set([1]))
    run.start()
    expect(run.accepted()).toBe(false)
    expect(sent).toEqual(['/a.png'])
    expect(delivered).toEqual(['/a.png'])
  })
})

describe('ComposeSheet with images', () => {
  const image = (id: string, status: DraftImage['status'], extra: Partial<DraftImage> = {}): DraftImage => ({ id, label: `${id}.png`, preview: 'blob:preview', status, ...extra })
  function sheet(options: { images?: DraftImage[]; text?: string; onClose?: () => void } = {}) {
    const calls: string[] = []
    function Host() {
      const [text, setText] = useState(options.text ?? '')
      return <ComposeSheet draft={text} kept disabled={false} textarea={{ current: null }} images={options.images ?? []} onDraft={setText}
        onSend={(sent, enter): PasteOutcome => { calls.push(`send:${enter}:${sent}`); return 'sent' }}
        onAddImages={(files) => calls.push(`add:${files.map((file) => file.name).join(',')}`)} onRemoveImage={(id) => calls.push(`remove:${id}`)} onClose={options.onClose} />
    }
    return { view: render(<Host />), calls }
  }
  test('thumbnails with remove, and a copy-path button only once an image is kept', () => {
    const { view, calls } = sheet({ images: [image('ready', 'ready', { upload: { name: 'n.png', path: '/data/n.png' } }), image('busy', 'uploading'), image('bad', 'failed', { error: 'Images are at most 10 MB' })] })
    expect(view.getByRole('img', { name: 'ready.png' })).toBeTruthy()
    expect(view.getByRole('status', { name: 'Uploading busy.png' })).toBeTruthy()
    expect(view.getByRole('alert').textContent).toContain('Images are at most 10 MB')
    expect(view.getByRole('button', { name: 'Copy the path of ready.png' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Copy the path of busy.png' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Remove bad.png' }))
    expect(calls).toEqual(['remove:bad'])
  })
  test('nothing is sent while an image is still uploading; a kept image alone can be sent', () => {
    const uploading = sheet({ images: [image('busy', 'uploading')], text: 'look' })
    expect((uploading.view.getByRole('button', { name: 'Paste + Enter' }) as HTMLButtonElement).disabled).toBe(true)
    expect(uploading.view.getByText('Adding the image…')).toBeTruthy()
    cleanup()
    const ready = sheet({ images: [image('ok', 'ready', { upload: { name: 'n.png', path: '/p' } })] })
    const send = ready.view.getByRole('button', { name: 'Paste + Enter' }) as HTMLButtonElement
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(ready.calls).toEqual(['send:true:'])
  })
  test('an image pasted into the text joins the draft; a text paste stays text', () => {
    const { view, calls } = sheet()
    const textarea = view.getByRole('textbox', { name: 'Text to send' })
    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    const imagePaste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
    imagePaste.clipboardData = { items: [{ kind: 'file', type: 'image/png' }], files: [file] }
    act(() => { textarea.dispatchEvent(imagePaste) })
    expect(imagePaste.defaultPrevented).toBe(true)
    const textPaste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
    textPaste.clipboardData = { items: [{ kind: 'string', type: 'text/plain' }], files: [] }
    act(() => { textarea.dispatchEvent(textPaste) })
    expect(textPaste.defaultPrevented).toBe(false)
    expect(calls).toEqual(['add:shot.png'])
  })
  test('on a desktop the sheet says what it is for and closes from a button, keeping the draft', () => {
    let closed = 0
    const { view } = sheet({ text: 'kept', onClose: () => { closed++ } })
    expect(view.getByRole('heading', { name: 'Compose' })).toBeTruthy()
    expect(view.getByText('Paste types it into the terminal; Paste + Enter also presses Return.')).toBeTruthy()
    expect((view.getByRole('textbox', { name: 'Text to send' }) as HTMLTextAreaElement).placeholder).toBe('Write a message, or paste or drop an image')
    fireEvent.click(view.getByRole('button', { name: 'Close compose' }))
    expect(closed).toBe(1)
    expect((view.getByRole('textbox', { name: 'Text to send' }) as HTMLTextAreaElement).value).toBe('kept')
  })
  test('in the key accessory (no close) the sheet stays compact: no heading, no close button', () => {
    const { view } = sheet()
    expect(view.queryByRole('heading', { name: 'Compose' })).toBeNull()
    expect(view.queryByRole('button', { name: 'Close compose' })).toBeNull()
  })
  test('a kept image says what its copy button copies', () => {
    const { view } = sheet({ images: [image('ready', 'ready', { upload: { name: 'n.png', path: '/data/n.png' } })] })
    expect(view.getByText('Copy path')).toBeTruthy()
  })
  test('the picker takes images; Escape closes (when the page lets it) and keeps the draft', () => {
    let closed = 0
    const { view, calls } = sheet({ text: 'kept', onClose: () => { closed++ } })
    const picker = view.container.querySelector('input[type="file"]') as HTMLInputElement
    expect(picker.accept).toBe('image/png,image/jpeg,image/webp')
    Object.defineProperty(picker, 'files', { value: [new File(['x'], 'p.jpg', { type: 'image/jpeg' }), new File(['x'], 'n.txt', { type: 'text/plain' })], configurable: true })
    fireEvent.change(picker)
    expect(calls).toEqual(['add:p.jpg'])
    fireEvent.keyDown(view.getByRole('textbox', { name: 'Text to send' }), { key: 'Escape' })
    expect(closed).toBe(1)
    expect((view.getByRole('textbox', { name: 'Text to send' }) as HTMLTextAreaElement).value).toBe('kept')
  })
})

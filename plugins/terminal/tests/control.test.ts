import { describe, expect, it } from 'bun:test'
import { ControlClient, ControlError, controlCommandLine, ControlParser, type ControlTransport } from '../lib/control'

function parse(text: string) {
  const blocks: Array<{ ok: boolean; lines: string[] }> = []
  const notes: string[] = []
  const parser = new ControlParser((ok, lines) => blocks.push({ ok, lines }), (line) => notes.push(line))
  parser.feed(text)
  return { parser, blocks, notes, feed: (chunk: string) => parser.feed(chunk) }
}

describe('ControlParser', () => {
  it('collects a command block and separates notifications', () => {
    const { blocks, notes } = parse('%begin 1 7 1\nline one\nline two\n%end 1 7 1\n%session-changed $1 x\n')
    expect(blocks).toEqual([{ ok: true, lines: ['line one', 'line two'] }])
    expect(notes).toEqual(['%session-changed $1 x'])
  })

  it('handles frames split across chunks', () => {
    const { feed, blocks } = parse('')
    feed('%beg')
    feed('in 2 8 1\nhal')
    feed('f\n%end 2 8')
    expect(blocks).toEqual([])
    feed(' 1\n')
    expect(blocks).toEqual([{ ok: true, lines: ['half'] }])
  })

  it('reports %error blocks as failures', () => {
    const { blocks } = parse('%begin 3 9 1\ncan\'t find session\n%error 3 9 1\n')
    expect(blocks).toEqual([{ ok: false, lines: ["can't find session"] }])
  })

  it('only ends a block on the %end that matches its %begin', () => {
    const { blocks } = parse('%begin 4 10 1\n%end 4 99 1\n%end 4 10 1\n')
    expect(blocks).toEqual([{ ok: true, lines: ['%end 4 99 1'] }])
  })
})

describe('controlCommandLine', () => {
  it('double-quotes every argument and escapes what tmux would expand', () => {
    expect(controlCommandLine(['set-option', '-p', '-t', 's1', '@bakin_title', 'Say "hi" $HOME \\ ok'])).toBe('"set-option" "-p" "-t" "s1" "@bakin_title" "Say \\"hi\\" \\$HOME \\\\ ok"')
  })

  it('refuses arguments that would break the line protocol', () => {
    expect(() => controlCommandLine(['display', 'a\nb'])).toThrow(ControlError)
  })
})

function fakeTransport() {
  const written: string[] = []
  let exit!: (code: number) => void
  const transport: ControlTransport = {
    write: (line) => { written.push(line) },
    close: () => { exit(0) },
    exited: new Promise<number>((resolve) => { exit = resolve }),
  }
  return { transport, written, exit: (code: number) => exit(code) }
}

describe('ControlClient', () => {
  it('waits for the attach block, then answers commands in order', async () => {
    const { transport, written } = fakeTransport()
    const notes: string[] = []
    const client = new ControlClient(transport, (line) => notes.push(line))
    const first = client.command(['display-message', '-p', 'one'])
    const second = client.command(['display-message', '-p', 'two'])
    client.feed('%begin 1 1 0\n%end 1 1 0\n')
    await client.ready
    client.feed('%begin 1 2 1\none\n%end 1 2 1\n%client-detached /dev/ttys1\n%begin 1 3 1\ntwo\n%end 1 3 1\n')
    expect(await first).toEqual(['one'])
    expect(await second).toEqual(['two'])
    expect(written).toEqual(['"display-message" "-p" "one"\n', '"display-message" "-p" "two"\n'])
    expect(notes).toEqual(['%client-detached /dev/ttys1'])
  })

  it('closes a connection whose reply never comes, failing every waiter (replies correlate by order)', async () => {
    const { transport } = fakeTransport()
    const client = new ControlClient(transport, () => {}, 20)
    client.feed('%begin 1 1 0\n%end 1 1 0\n')
    const settled = await Promise.allSettled([client.command(['resize-window', '-t', 's1', '-x', '80', '-y', '24']), client.command(['display-message', '-p', 'x'])])
    expect(settled.map((result) => result.status === 'rejected' && (result.reason as Error).message)).toEqual(['Terminal control connection closed', 'Terminal control connection closed'])
    expect(client.isClosed).toBe(true)
  })

  it('rejects a failed command with tmux\'s message', async () => {
    const { transport } = fakeTransport()
    const client = new ControlClient(transport, () => {})
    client.feed('%begin 1 1 0\n%end 1 1 0\n')
    const failing = client.command(['kill-session', '-t', 'nope'])
    client.feed("%begin 1 2 1\ncan't find session: nope\n%error 1 2 1\n")
    await expect(failing).rejects.toThrow("can't find session: nope")
  })

  it('sends input as hex send-keys in ordered chunks of at most 4096 bytes', async () => {
    const { transport, written } = fakeTransport()
    const client = new ControlClient(transport, () => {})
    client.feed('%begin 1 1 0\n%end 1 1 0\n')
    const data = new Uint8Array(5000).fill(0x41)
    data[0] = 0x0d
    const sent = client.sendKeys('%3', data)
    expect(written).toHaveLength(2)
    expect(written[0]!.startsWith('"send-keys" "-t" "%3" "-H" "0d" "41"')).toBe(true)
    expect(written[0]!.split(' ')).toHaveLength(4 + 4096)
    expect(written[1]!.split(' ')).toHaveLength(4 + 904)
    client.feed('%begin 1 2 1\n%end 1 2 1\n%begin 1 3 1\n%end 1 3 1\n')
    await sent
  })

  it('rejects everything pending when the control process exits, and refuses new commands', async () => {
    const { transport, exit } = fakeTransport()
    const client = new ControlClient(transport, () => {})
    const pending = client.command(['list-clients'])
    exit(1)
    await expect(pending).rejects.toThrow('Terminal control connection closed')
    await expect(client.command(['list-clients'])).rejects.toThrow('Terminal control connection closed')
  })

  it('bounds the command queue', async () => {
    const { transport } = fakeTransport()
    const client = new ControlClient(transport, () => {})
    const queued = Array.from({ length: 256 }, () => client.command(['list-clients']).catch(() => undefined))
    await expect(client.command(['list-clients'])).rejects.toThrow('Terminal control queue is full')
    client.close()
    await Promise.all(queued)
  })
})

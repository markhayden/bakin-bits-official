import { describe, expect, it } from 'bun:test'
import { ControlClient, ControlError, controlCommandLine, ControlParser, decodeOutput, MAX_CONTROL_LINE, type ControlBlock, type ControlTransport } from '../lib/control'

const bytes = (text: string) => new TextEncoder().encode(text)
function parse(text: string | Uint8Array = '') {
  const blocks: ControlBlock[] = []
  const notes: string[] = []
  const output: Array<{ pane: string; bytes: number[] }> = []
  const invalid: string[] = []
  const parser = new ControlParser({
    block: (block) => blocks.push(block),
    notification: (line) => notes.push(line),
    output: (pane, data) => output.push({ pane, bytes: [...data] }),
    invalid: (reason) => invalid.push(reason),
  })
  const feed = (chunk: string | Uint8Array) => parser.feed(typeof chunk === 'string' ? bytes(chunk) : chunk)
  feed(text)
  return { blocks, notes, output, invalid, feed }
}

describe('ControlParser', () => {
  it('collects a command block with its flags and separates notifications', () => {
    const { blocks, notes } = parse('%begin 1 7 1\nline one\nline two\n%end 1 7 1\n%session-changed $1 x\n')
    expect(blocks).toEqual([{ ok: true, flags: '1', lines: ['line one', 'line two'] }])
    expect(notes).toEqual(['%session-changed $1 x'])
  })
  it('handles frames split across chunks', () => {
    const { feed, blocks } = parse()
    feed('%beg')
    feed('in 2 8 1\nhal')
    feed('f\n%end 2 8')
    expect(blocks).toEqual([])
    feed(' 1\n')
    expect(blocks).toEqual([{ ok: true, flags: '1', lines: ['half'] }])
  })
  it('reports %error blocks as failures', () => {
    const { blocks } = parse('%begin 3 9 1\ncan\'t find session\n%error 3 9 1\n')
    expect(blocks).toEqual([{ ok: false, flags: '1', lines: ["can't find session"] }])
  })
  it('only ends a block on the %end that matches its %begin', () => {
    const { blocks } = parse('%begin 4 10 1\n%end 4 99 1\n%end 4 10 1\n')
    expect(blocks).toEqual([{ ok: true, flags: '1', lines: ['%end 4 99 1'] }])
  })
  it('a captured row inside a block that looks like an %output line stays a row', () => {
    const { blocks, output } = parse('%begin 5 11 1\n%output %0 fake\n%end 5 11 1\n')
    expect(blocks[0]!.lines).toEqual(['%output %0 fake'])
    expect(output).toEqual([])
  })
  it('decodes %output as bytes: octal escapes back to bytes, raw UTF-8 and invalid bytes kept', () => {
    // As tmux 3.7c sends it: `é a\b ESC[1m X 0xff CR LF`.
    const line = new Uint8Array([...bytes('%output %0 '), 0xc3, 0xa9, ...bytes(' a\\134b\\033[1mX'), 0xff, ...bytes('\\015\\012'), 0x0a])
    const { output } = parse(line)
    expect(output).toEqual([{ pane: '%0', bytes: [0xc3, 0xa9, 0x20, 0x61, 0x5c, 0x62, 0x1b, 0x5b, 0x31, 0x6d, 0x58, 0xff, 0x0d, 0x0a] }])
  })
  it('a multi-byte character split across chunks arrives whole', () => {
    const { feed, output } = parse()
    const line = new Uint8Array([...bytes('%output %0 '), 0xf0, 0x9f, 0x98, 0x83, 0x0a])
    feed(line.subarray(0, 13))
    feed(line.subarray(13))
    expect(output).toEqual([{ pane: '%0', bytes: [0xf0, 0x9f, 0x98, 0x83] }])
  })
  it('an over-long line is a protocol fault', () => {
    const { feed, invalid } = parse()
    feed(new Uint8Array(MAX_CONTROL_LINE + 1).fill(0x41))
    expect(invalid).toEqual(['control line too long'])
  })
})

describe('decodeOutput', () => {
  it('leaves a backslash that is not an octal escape alone', () => {
    expect([...decodeOutput(bytes('a\\9b\\'))]).toEqual([...bytes('a\\9b\\')])
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
const attached = (client: ControlClient) => client.feed('%begin 1 1 0\n%end 1 1 0\n')

describe('ControlClient', () => {
  it('waits for the attach block, then answers commands in order', async () => {
    const { transport, written } = fakeTransport()
    const notes: string[] = []
    const client = new ControlClient(transport, { notification: (line) => notes.push(line) })
    const first = client.command(['display-message', '-p', 'one'])
    const second = client.command(['display-message', '-p', 'two'])
    attached(client)
    await client.ready
    client.feed('%begin 1 2 1\none\n%end 1 2 1\n%client-detached /dev/ttys1\n%begin 1 3 1\ntwo\n%end 1 3 1\n')
    expect(await first).toEqual(['one'])
    expect(await second).toEqual(['two'])
    expect(written).toEqual(['"display-message" "-p" "one"\n', '"display-message" "-p" "two"\n'])
    expect(notes).toEqual(['%client-detached /dev/ttys1'])
  })
  it('a block that is not this client\'s (flags 0) after the attach answers nothing', async () => {
    const { transport } = fakeTransport()
    const client = new ControlClient(transport)
    attached(client)
    const reply = client.command(['display-message', '-p', 'mine'])
    client.feed('%begin 1 2 0\nsomeone else\n%end 1 2 0\n%begin 1 3 1\nmine\n%end 1 3 1\n')
    expect(await reply).toEqual(['mine'])
  })
  it('a group sends one line and answers once every command has replied, in order', async () => {
    const { transport, written } = fakeTransport()
    const client = new ControlClient(transport)
    attached(client)
    const group = client.group([['display-message', '-p', 'one'], ['display-message', '-p', 'two']])
    const after = client.command(['display-message', '-p', 'three'])
    expect(written).toEqual(['"display-message" "-p" "one" ; "display-message" "-p" "two"\n', '"display-message" "-p" "three"\n'])
    client.feed('%begin 1 2 1\none\n%end 1 2 1\n')
    client.feed('%begin 1 3 1\ntwo\n%end 1 3 1\n%begin 1 4 1\nthree\n%end 1 4 1\n')
    expect(await group).toEqual([['one'], ['two']])
    expect(await after).toEqual(['three'])
  })
  it('an error ends a group (tmux skips the rest) and the next command still correlates', async () => {
    const { transport } = fakeTransport()
    const client = new ControlClient(transport)
    attached(client)
    const group = client.group([['kill-session', '-t', 'nope'], ['display-message', '-p', 'skipped']])
    const after = client.command(['display-message', '-p', 'next'])
    client.feed("%begin 1 2 1\ncan't find session: nope\n%error 1 2 1\n%begin 1 3 1\nnext\n%end 1 3 1\n")
    await expect(group).rejects.toThrow("can't find session: nope")
    expect(await after).toEqual(['next'])
  })
  it('delivers output in order and reports why the connection ended, once', async () => {
    const { transport, exit } = fakeTransport()
    const output: string[] = []
    const closed: string[] = []
    const client = new ControlClient(transport, { output: (_pane, data) => output.push(new TextDecoder().decode(data)), closed: (reason) => closed.push(reason) })
    attached(client)
    client.feed('%output %0 one\\015\\012\n%output %0 two\n%exit too far behind\n')
    exit(0)
    await Bun.sleep(0)
    expect(output).toEqual(['one\r\n', 'two'])
    expect(closed).toEqual(['too far behind'])
    client.close()
    expect(closed).toEqual(['too far behind'])
  })
  it('%exit ends the connection at once: pending commands reject with it, even while the process lingers', async () => {
    const written: string[] = []
    let killed = 0
    const transport: ControlTransport = { write: (line) => { written.push(line) }, close: () => { killed++ }, exited: new Promise(() => {}) }
    const closed: string[] = []
    const client = new ControlClient(transport, { closed: (reason) => closed.push(reason) })
    attached(client)
    const pending = client.command(['display-message', '-p', 'x'])
    client.feed('%exit too far behind\n')
    await expect(pending).rejects.toThrow('closed')
    expect(client.isClosed).toBe(true)
    expect(closed).toEqual(['too far behind'])
    expect(killed).toBe(1)
  })
  it('reports EOF without %exit as eof, and a protocol fault by its reason', async () => {
    const eof = fakeTransport()
    const closed: string[] = []
    new ControlClient(eof.transport, { closed: (reason) => closed.push(reason) })
    eof.exit(0)
    await Bun.sleep(0)
    const fault = fakeTransport()
    const client = new ControlClient(fault.transport, { closed: (reason) => closed.push(reason) })
    client.feed(new Uint8Array(MAX_CONTROL_LINE + 1).fill(0x41))
    expect(closed).toEqual(['eof', 'control line too long'])
  })
  it('closes a connection whose reply never comes, failing every waiter (replies correlate by order)', async () => {
    const { transport } = fakeTransport()
    const closed: string[] = []
    const client = new ControlClient(transport, { closed: (reason) => closed.push(reason) }, 20)
    attached(client)
    const settled = await Promise.allSettled([client.command(['resize-window', '-t', 's1', '-x', '80', '-y', '24']), client.command(['display-message', '-p', 'x'])])
    expect(settled.map((result) => result.status === 'rejected' && (result.reason as Error).message)).toEqual(['Terminal control connection closed', 'Terminal control connection closed'])
    expect(client.isClosed).toBe(true)
    expect(closed).toEqual(['timeout'])
  })
  it('closes a connection whose attach is never answered', async () => {
    const { transport } = fakeTransport()
    const client = new ControlClient(transport, {}, 20)
    await expect(client.ready).rejects.toThrow('closed')
    expect(client.isClosed).toBe(true)
  })
  it('rejects a failed command with tmux\'s message', async () => {
    const { transport } = fakeTransport()
    const client = new ControlClient(transport)
    attached(client)
    const failing = client.command(['kill-session', '-t', 'nope'])
    client.feed("%begin 1 2 1\ncan't find session: nope\n%error 1 2 1\n")
    await expect(failing).rejects.toThrow("can't find session: nope")
  })
  it('sends input as hex send-keys in ordered chunks of at most 4096 bytes', async () => {
    const { transport, written } = fakeTransport()
    const client = new ControlClient(transport)
    attached(client)
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
    const client = new ControlClient(transport)
    const pending = client.command(['list-clients'])
    exit(1)
    await expect(pending).rejects.toThrow('Terminal control connection closed')
    await expect(client.command(['list-clients'])).rejects.toThrow('Terminal control connection closed')
  })
  it('bounds the command queue', async () => {
    const { transport } = fakeTransport()
    const client = new ControlClient(transport)
    const queued = Array.from({ length: 256 }, () => client.command(['list-clients']).catch(() => undefined))
    await expect(client.command(['list-clients'])).rejects.toThrow('Terminal control queue is full')
    client.close()
    await Promise.all(queued)
  })
})

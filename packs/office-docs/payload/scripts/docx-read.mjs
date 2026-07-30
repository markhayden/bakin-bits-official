#!/usr/bin/env node
/**
 * Read a .docx as text on stdout.
 *
 * Usage: docx-read.mjs <file.docx> [--html]
 *
 * mammoth maps Word's semantic styles (headings, lists, bold/italic) onto
 * Markdown and drops the layout noise, which is what makes the output
 * quotable. Its Markdown writer has no table syntax, though, so a table
 * arrives as one cell per line with its grid lost — pass `--html` when the
 * structure matters and read the `<table>` instead.
 *
 * Anything Word could not express semantically — text boxes, drawing-canvas
 * content, floating shapes — does not survive either writer; the warnings
 * mammoth raises are printed to stderr so that loss is visible rather than
 * silent.
 */
import { readFile } from 'node:fs/promises'
import mammoth from 'mammoth'

const args = process.argv.slice(2)
const html = args.includes('--html')
const [file] = args.filter((a) => a !== '--html')
if (!file) {
  console.error('usage: docx-read.mjs <file.docx> [--html]')
  process.exit(2)
}

let buffer
try {
  buffer = await readFile(file)
} catch (err) {
  console.error(`cannot read ${file}: ${err.message}`)
  process.exit(1)
}

try {
  const convert = html ? mammoth.convertToHtml : mammoth.convertToMarkdown
  const { value, messages } = await convert({ buffer })
  process.stdout.write(value.trimEnd() + '\n')
  for (const message of messages) console.error(`[${message.type}] ${message.message}`)
} catch (err) {
  console.error(`not a readable .docx: ${err.message}`)
  process.exit(1)
}

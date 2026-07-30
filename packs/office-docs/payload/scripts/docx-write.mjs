#!/usr/bin/env node
/**
 * Write a .docx from a JSON block spec.
 *
 * Usage: docx-write.mjs <spec.json|-> <out.docx>
 *
 * The spec is deliberately small — headings, paragraphs, bullets, and
 * tables cover the documents agents actually produce, and every block maps
 * to a NAMED Word style rather than direct formatting, so the result stays
 * editable and picks up the theme of whatever template it is pasted into.
 *
 *   {"blocks":[
 *     {"type":"heading","level":1,"text":"Q3 Review"},
 *     {"type":"paragraph","text":"Revenue grew 12%."},
 *     {"type":"bullets","items":["Churn down","NPS flat"]},
 *     {"type":"table","header":["Metric","Value"],"rows":[["MRR","$42k"]]},
 *     {"type":"pagebreak"}
 *   ]}
 */
import { readFile, writeFile } from 'node:fs/promises'
import { Document, HeadingLevel, Packer, Paragraph, PageBreak, Table, TableCell, TableRow, TextRun, WidthType } from 'docx'

const [specPath, outPath] = process.argv.slice(2)
if (!specPath || !outPath) {
  console.error('usage: docx-write.mjs <spec.json|-> <out.docx>')
  process.exit(2)
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

const HEADINGS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
]

function cell(text) {
  return new TableCell({ children: [new Paragraph({ children: [new TextRun(String(text ?? ''))] })] })
}

function build(block, index) {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(Math.max(Number(block.level) || 1, 1), 6)
      return [new Paragraph({ text: String(block.text ?? ''), heading: HEADINGS[level - 1] })]
    }
    case 'paragraph':
      return [new Paragraph({ children: [new TextRun(String(block.text ?? ''))] })]
    case 'bullets':
      return (block.items ?? []).map((item) =>
        new Paragraph({ text: String(item), bullet: { level: 0 } }))
    case 'numbers':
      return (block.items ?? []).map((item) =>
        new Paragraph({ text: String(item), numbering: { reference: 'ordered', level: 0 } }))
    case 'table': {
      const header = block.header ? [new TableRow({ tableHeader: true, children: block.header.map(cell) })] : []
      const body = (block.rows ?? []).map((row) => new TableRow({ children: row.map(cell) }))
      if (!header.length && !body.length) throw new Error(`block ${index}: table has no rows`)
      return [new Table({ rows: [...header, ...body], width: { size: 100, type: WidthType.PERCENTAGE } })]
    }
    case 'pagebreak':
      return [new Paragraph({ children: [new PageBreak()] })]
    default:
      throw new Error(`block ${index}: unknown type ${JSON.stringify(block.type)}`)
  }
}

let spec
try {
  spec = JSON.parse(specPath === '-' ? await readStdin() : await readFile(specPath, 'utf-8'))
} catch (err) {
  console.error(`cannot parse spec: ${err.message}`)
  process.exit(1)
}

if (!Array.isArray(spec.blocks) || spec.blocks.length === 0) {
  console.error('spec needs a non-empty "blocks" array')
  process.exit(1)
}

let children
try {
  children = spec.blocks.flatMap(build)
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

const doc = new Document({
  numbering: {
    config: [{
      reference: 'ordered',
      levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'left' }],
    }],
  },
  sections: [{ children }],
})

await writeFile(outPath, await Packer.toBuffer(doc))
console.log(`wrote ${outPath} (${children.length} blocks)`)

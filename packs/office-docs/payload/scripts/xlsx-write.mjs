#!/usr/bin/env node
/**
 * Write a .xlsx from a JSON spec.
 *
 * Usage: xlsx-write.mjs <spec.json|-> <out.xlsx>
 *
 *   {"sheets":[{
 *     "name":"Q3",
 *     "header":["Metric","Value"],
 *     "rows":[["MRR",42000],["Churn",0.031]],
 *     "widths":[24,12]
 *   }]}
 *
 * A string that starts with "=" is written as a real formula, so
 * ["Total","=SUM(B2:B10)"] behaves the way it would if typed. Everything
 * else keeps its JSON type — numbers stay numeric so the sheet can sum them.
 */
import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'

const [specPath, outPath] = process.argv.slice(2)
if (!specPath || !outPath) {
  console.error('usage: xlsx-write.mjs <spec.json|-> <out.xlsx>')
  process.exit(2)
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

function cellValue(v) {
  return typeof v === 'string' && v.startsWith('=') ? { formula: v.slice(1) } : v
}

let spec
try {
  spec = JSON.parse(specPath === '-' ? await readStdin() : await readFile(specPath, 'utf-8'))
} catch (err) {
  console.error(`cannot parse spec: ${err.message}`)
  process.exit(1)
}

if (!Array.isArray(spec.sheets) || spec.sheets.length === 0) {
  console.error('spec needs a non-empty "sheets" array')
  process.exit(1)
}

const workbook = new ExcelJS.Workbook()
let cellCount = 0

for (const [index, sheet] of spec.sheets.entries()) {
  const worksheet = workbook.addWorksheet(sheet.name || `Sheet${index + 1}`)
  if (Array.isArray(sheet.header)) {
    const row = worksheet.addRow(sheet.header)
    row.font = { bold: true }
    // Freezing the header is what makes a long sheet readable; it costs
    // nothing and no caller has ever wanted the opposite.
    worksheet.views = [{ state: 'frozen', ySplit: 1 }]
    cellCount += sheet.header.length
  }
  for (const row of sheet.rows ?? []) {
    worksheet.addRow(row.map(cellValue))
    cellCount += row.length
  }
  ;(sheet.widths ?? []).forEach((width, i) => {
    if (worksheet.columns[i]) worksheet.columns[i].width = width
  })
}

await workbook.xlsx.writeFile(outPath)
console.log(`wrote ${outPath} (${spec.sheets.length} sheet(s), ${cellCount} cells)`)

#!/usr/bin/env node
/**
 * Read a .xlsx as JSON on stdout.
 *
 * Usage: xlsx-read.mjs <file.xlsx> [sheet-name]
 *
 * Emits {"sheets":[{"name":…,"rows":[[…]]}]} — every sheet when no name is
 * given, one when it is. Cells come out as their real types (numbers stay
 * numbers, dates become ISO strings), and a formula cell reports its CACHED
 * RESULT rather than the formula text, because the cached value is what the
 * spreadsheet actually shows.
 */
import ExcelJS from 'exceljs'

const [file, sheetName] = process.argv.slice(2)
if (!file) {
  console.error('usage: xlsx-read.mjs <file.xlsx> [sheet-name]')
  process.exit(2)
}

function value(cell) {
  const v = cell.value
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v !== 'object') return v
  // Formulas carry {formula|sharedFormula} and, only if the file was last
  // saved by a spreadsheet app, a cached {result}. A file this pack wrote has
  // no cached results yet, so fall back to the formula text with its leading
  // "=" — never a stringified object.
  if ('formula' in v || 'sharedFormula' in v) {
    const result = v.result
    if (result !== undefined && result !== null) {
      return typeof result === 'object' ? (result.error ?? JSON.stringify(result)) : result
    }
    return `=${v.formula ?? v.sharedFormula}`
  }
  if ('richText' in v) return v.richText.map((part) => part.text).join('')
  if ('error' in v) return v.error
  if ('text' in v) return v.text
  return JSON.stringify(v)
}

const workbook = new ExcelJS.Workbook()
try {
  await workbook.xlsx.readFile(file)
} catch (err) {
  console.error(`cannot read ${file}: ${err.message}`)
  process.exit(1)
}

const sheets = []
workbook.eachSheet((worksheet) => {
  if (sheetName && worksheet.name !== sheetName) return
  const rows = []
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = []
    // row.values is 1-indexed with a leading hole; slice(1) drops it.
    row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = value(cell) })
    rows.push(Array.from(cells, (c) => (c === undefined ? null : c)))
  })
  sheets.push({ name: worksheet.name, rows })
})

if (sheetName && sheets.length === 0) {
  console.error(`no sheet named ${JSON.stringify(sheetName)} — sheets are: ${workbook.worksheets.map((w) => w.name).join(', ')}`)
  process.exit(1)
}

process.stdout.write(JSON.stringify({ sheets }, null, 2) + '\n')

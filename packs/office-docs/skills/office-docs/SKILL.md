---
name: office-docs
description: 'Read and write Microsoft Word (.docx) and Excel (.xlsx) files — extract a document as text, turn a spreadsheet into JSON, and generate formatted documents and workbooks. Use whenever a task involves a .docx or .xlsx file, a Word document, or an Excel workbook.'
---

# Word & Excel Documents

## Agent Directive

A `.docx` or `.xlsx` is a ZIP of XML, not text — `cat`, `grep`, and `head`
produce garbage on them. Use these four scripts instead. Everything is
already installed; do NOT run npm install.

```bash
node ~/.bakin/npm/office-docs/scripts/docx-read.mjs  <file.docx> [--html]
node ~/.bakin/npm/office-docs/scripts/docx-write.mjs <spec.json|-> <out.docx>
node ~/.bakin/npm/office-docs/scripts/xlsx-read.mjs  <file.xlsx> [sheet-name]
node ~/.bakin/npm/office-docs/scripts/xlsx-write.mjs <spec.json|-> <out.xlsx>
```

Both write scripts accept `-` as the spec path and read JSON from stdin,
which avoids a temp file for short documents.

## Reading a Word document

`docx-read.mjs` prints Markdown: headings, bold and italic, and both list
kinds survive.

**Tables are the exception.** The Markdown writer has no table syntax, so a
table arrives as one cell per line with its grid lost. When the structure
matters — and it usually does if the task is about a table — pass `--html`
and read the `<table>` markup instead.

Warnings go to stderr. They tell you what could not be converted (text
boxes, floating shapes, drawing-canvas content). If the operator asks about
content you cannot find, check stderr before concluding it is absent.

## Reading a spreadsheet

`xlsx-read.mjs` prints `{"sheets":[{"name":…,"rows":[[…]]}]}` — every sheet,
or one when you name it. Types are preserved: numbers stay numbers, dates
become ISO strings, and rich text collapses to its plain text.

A formula cell reports its **cached result** — the value the spreadsheet
last displayed. If the file was written by this pack and never opened in
Excel, there is no cached result and you get the formula text back instead
(`"=SUM(B2:B3)"`). That is honest, not an error: nothing has computed it yet.
Never present a formula string as if it were a computed number.

Name the sheet when you know it. Workbooks get large, and dumping every
sheet of a big file wastes the context you need for the actual task.

## Writing a Word document

```json
{"blocks":[
  {"type":"heading","level":1,"text":"Q3 Review"},
  {"type":"paragraph","text":"Revenue grew 12% against a flat headcount."},
  {"type":"bullets","items":["Churn down to 3.1%","NPS flat at 41"]},
  {"type":"numbers","items":["Ship billing v2","Close the EU region"]},
  {"type":"table","header":["Metric","Value"],"rows":[["MRR","$42k"]]},
  {"type":"pagebreak"}
]}
```

Every block maps to a **named Word style** rather than direct formatting, so
the result stays editable and adopts the theme of whatever template someone
pastes it into. `heading` levels run 1–6. There are no other block types —
the script fails loudly on an unknown one rather than dropping it silently.

## Writing a spreadsheet

```json
{"sheets":[{
  "name":"Q3",
  "header":["Metric","Value"],
  "rows":[["MRR",42000],["Churn",0.031],["Total","=SUM(B2:B3)"]],
  "widths":[24,14]
}]}
```

- A `header` is bolded and frozen, so a long sheet stays readable.
- A string starting with `=` becomes a **real formula**, exactly as if typed.
- Everything else keeps its JSON type. Write `42000`, not `"42000"` — a
  number stored as text cannot be summed, and that is the single most common
  way a generated sheet turns out useless.
- `widths` is optional and indexed by column.

## Rules

- **Never overwrite a document the operator did not ask you to change.**
  Write to a new path and say where it is. There is no undo here.
- **Read before you rewrite.** These scripts generate documents; they do not
  edit one in place. Regenerating a file from a spec silently discards
  anything the original had that the spec does not cover — comments, tracked
  changes, headers and footers, styling, embedded images. If a task needs a
  small edit to an existing document, say plainly that this pack cannot do it
  without losing that content.
- **Save deliverables as assets.** A generated document is a deliverable:
  write it to a file, then save it with `bakin_exec_assets_save` rather than
  pasting its content into chat.
- **Report failures verbatim.** Every script exits non-zero with a real
  message on stderr. Quote it; never guess at a document's contents because
  a read failed.
- Legacy `.doc` and `.xls` (the pre-2007 binary formats) are not supported by
  any of these scripts. Say so rather than trying.

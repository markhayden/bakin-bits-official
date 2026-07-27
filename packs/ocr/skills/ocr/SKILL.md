---
name: ocr
description: Read text out of images, screenshots, and scanned PDFs with local Apple Vision OCR. Use when a task references an image or scanned document whose text needs to be read or quoted exactly.
---

# OCR

Extract text from images and scanned PDFs, fully local (Apple's Vision
framework — no API, nothing leaves this machine). The `ocrit` binary is
already installed and on PATH.

## Usage

Any image (png, jpg, heic, tiff, …) or PDF — text prints to stdout:

```bash
ocrit photo.png
ocrit scanned-document.pdf
```

Multiple files in one call:

```bash
ocrit page-1.png page-2.png
```

Non-English documents — pass language codes (repeatable):

```bash
ocrit facture.pdf -l fr-FR
```

## When to use which lane

- **Scanned/image-only PDFs:** `ocrit` reads PDFs directly — you usually do
  NOT need to render pages first. `bakin_exec_pdf_read` tells you when pages
  look scanned; run `ocrit <path>` on the PDF it flagged.
- **Exact text vs. understanding:** OCR gives you machine-exact text
  (serial numbers, amounts, codes) for free. If you instead need layout,
  handwriting judgment, or "what IS this?", render with
  `bakin_exec_pdf_render` and view the PNGs with your own eyes — vision
  handles what OCR can't.
- **Screenshots and photos:** point `ocrit` at the file directly.

## Honest failure

If output is empty or garbled, the page may be handwritten, rotated, or
very low quality — fall back to rendering + viewing the image yourself,
and say which pages OCR could not read. Never present partial OCR as the
full document.

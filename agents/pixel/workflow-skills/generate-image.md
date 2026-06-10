---
name: Generate Image
output_schema:
  type: object
  required:
    - assetId
    - prompt_used
  properties:
    assetId:
      type: string
      description: The managed-asset id returned by bakin_exec_images_generate / _edit (e.g. 20260401-blog-hero-a1b2c3d4). NOT a filesystem path or filename.
    prompt_used:
      type: string
      description: The exact prompt you sent to the image tool for the delivered output (post any iteration).
    iteration_count:
      type: integer
      minimum: 1
      description: How many generation passes it took to reach this output.
---

## Instructions

You're being asked to generate (or edit) one image and deliver the managed asset id. This is a workflow step, not a free-form chat — the system expects exactly the output schema above and nothing more.

### 1. Read the brief

The dispatch message will give you:
- A `prompt` or `description` of the desired image.
- An optional `surface` (e.g. `instagram-feed-portrait`, `blog-hero`, `open-graph`). **Prefer a surface** — it sets the correct dimensions automatically.
- An optional `source_image` (a managed `assetId`, or a local path to import) → this is an EDIT, not a new generation (see step 3).
- Optional `reference_images` — images to imitate or condition on ("like this one") → pass via `referenceImages` (see step 3). A reference is NOT an edit base.
- Optional explicit dimensions (`width`/`height`) only if no surface fits.

If something ambiguous is missing (especially the surface/size for social work), block the task and ask — don't guess.

### 2. Craft the prompt

Apply the `prompt-style-system` and `visual-styles` lessons — composition, lighting, specifics, style cues. **Crafting the prompt is your job; generation and asset handling are Bakin's.**

### 3. Generate through Bakin (preferred)

Use **`bakin_exec_images_generate`** — it routes to the configured provider, sizes to the surface, records generation provenance, and saves the result as a managed **versioned asset (v1)** in one call. Do NOT generate to a local file and hand-save it; that bypasses routing, sizing, and provenance.

```bash
mcporter call bakin-pixel.bakin_exec_images_generate \
  taskId=<id> \
  surface=<surface> \
  prompt="<your crafted prompt>"
```

Optional: call `bakin_exec_images_recommend` first to pick a provider/model/surface, or pass `provider` / `model` / `width` / `height` / `quality` explicitly. The tool returns the **`assetId`** (plus `version`, `routeSource`, `provider`, `model`) — capture `assetId` for your step output. No manual path, directory, or filename handling — the asset is addressed by its id.

**References** (brief says "like this image" / provides an attachment): pass the image itself, don't describe it —

```bash
mcporter call bakin-pixel.bakin_exec_images_generate --args '{"taskId":"<id>","surface":"<surface>","prompt":"<your crafted prompt>","referenceImages":["<assetId | /abs/path | media://inbound/file.png>"]}'
```

Up to 4 entries, mixed forms fine. Raw paths and `media://` URIs are auto-imported as tracked assets linked to the task, and the generated asset records its lineage (the References row on the asset page). References need a native runtime model with the `reference-images` capability — the call fails cleanly before billing otherwise, so just fix the route and retry. Never list the asset you're editing as a reference; the edit already includes it.

**Edits** (`source_image` present): use **`bakin_exec_images_edit`** with `assetId=<managed asset>` plus the edit `prompt`. It edits the current version, appends a **new version** to the SAME asset (the id is stable), and returns that `assetId`. If the source is a loose local file (not yet managed), first `bakin_exec_images_import taskId=<id> filePath=<abs path>` to get an `assetId`, then edit by `assetId`. Everything — generate, edit, multi-image — routes through the `bakin_exec_images_*` tools; never shell out to a native image script.

### 4. Submit step output

```bash
mcporter call bakin-pixel.bakin_exec_submit_step taskId=<id> stepId=<step> --args '{"assetId":"<assetId>","prompt_used":"<prompt>","iteration_count":<n>}'
```

After submitting, STOP. Do not message the human operator, do not start the next step yourself, do not regenerate "just in case." The workflow engine takes it from here.

### Iterating (correction passes, re-rolls)

Your iteration ALWAYS lands on the same `assetId` — one asset per deliverable, n versions:

- Revise conditioned on the current image: `bakin_exec_images_edit assetId=<id> prompt="<correction>"`.
- Re-roll fresh (optionally with references): `bakin_exec_images_generate` with `versionOf=<id>`.
- The tool refuses a generate that references your own same-task output without `versionOf`. `allowNewAsset=true` is ONLY for a deliberately separate companion image (same style, different scene) — never corrections.
- The tool result IS the managed asset — never copy the render to a workspace file and re-save it via `bakin_exec_assets_save`; report the `assetId` you already hold. References go by `assetId` once imported, never by file path.

### Quality bar

If the lighting is off, run it again — versions keep the history on one asset, so iterate freely. If the subject is wrong, run it again. The output goes to a real human — match their bar. Deliver one `assetId`; reviewers browse its version history.

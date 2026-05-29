---
name: Generate Image
output_schema:
  type: object
  required:
    - image_filename
    - prompt_used
  properties:
    image_filename:
      type: string
      description: The canonical managed-asset filename returned by bakin_exec_images_generate (NOT a filesystem path).
    prompt_used:
      type: string
      description: The exact prompt you sent to the image tool for the delivered output (post any iteration).
    iteration_count:
      type: integer
      minimum: 1
      description: How many generation passes it took to reach this output.
---

## Instructions

You're being asked to generate (or edit) one image and deliver the managed asset filename. This is a workflow step, not a free-form chat — the system expects exactly the output schema above and nothing more.

### 1. Read the brief

The dispatch message will give you:
- A `prompt` or `description` of the desired image.
- An optional `surface` (e.g. `instagram-feed-portrait`, `blog-hero`, `open-graph`). **Prefer a surface** — it sets the correct dimensions automatically.
- An optional `source_image` path → this is an EDIT, not a new generation (see step 3).
- Optional explicit dimensions (`width`/`height`) only if no surface fits.

If something ambiguous is missing (especially the surface/size for social work), block the task and ask — don't guess.

### 2. Craft the prompt

Apply the `prompt-style-system` and `visual-styles` lessons — composition, lighting, specifics, style cues. **Crafting the prompt is your job; generation and asset handling are Bakin's.**

### 3. Generate through Bakin (preferred)

Use **`bakin_exec_images_generate`** — it routes to the configured provider, sizes to the surface, records generation provenance, and saves the result as a managed asset in one call. Do NOT generate to a local file and hand-save it with `bakin_exec_assets_save`; that bypasses routing, sizing, and provenance.

```bash
mcporter call bakin-pixel.bakin_exec_images_generate \
  taskId=<id> \
  surface=<surface> \
  prompt="<your crafted prompt>"
```

Optional: call `bakin_exec_images_recommend` first to pick a provider/model/surface, or pass `provider` / `model` / `width` / `height` / `quality` explicitly. The tool returns the canonical **`image_filename`** (plus `routeSource`, `provider`, `model`) — capture `image_filename` for your step output. No manual `get_paths`, directory, or sidecar handling — the tool does all of it.

**Edits** (`source_image` present): Bakin does not yet expose an image *edit* tool, so fall back to your native nano-banana flow per AGENTS.md for the edit itself, then register the result with **`bakin_exec_images_import`** to get a managed `image_filename`.

### 4. Submit step output

```bash
mcporter call bakin-pixel.bakin_exec_submit_step taskId=<id> stepId=<step> --args '{"image_filename":"<filename>","prompt_used":"<prompt>","iteration_count":<n>}'
```

After submitting, STOP. Do not message the human operator, do not start the next step yourself, do not regenerate "just in case." The workflow engine takes it from here.

### Quality bar

If the lighting is off, run it again. If the subject is wrong, run it again. The output goes to a real human — match their bar.

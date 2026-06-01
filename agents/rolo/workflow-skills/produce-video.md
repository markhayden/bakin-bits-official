---
name: Produce Video
output_schema:
  type: object
  required:
    - assetId
  properties:
    assetId:
      type: string
      description: The managed-asset id returned by bakin_exec_assets_save for the finished video. NOT a filesystem path or filename.
    duration_s:
      type: number
      description: Final runtime of the delivered video in seconds.
    has_audio:
      type: boolean
      description: Whether the delivered video includes a mixed audio track (music / SFX / voiceover).
---

## Instructions

You're being asked to produce one finished video and deliver the managed asset id. This is a
workflow step, not a free-form chat — the system expects exactly the output schema above and
nothing more.

### 1. Read the brief

The dispatch message will give you some of:
- A `script` or `description` of the video.
- A `surface` / aspect ratio (e.g. `9:16`, `16:9`) and target length.
- Optional `source_image` assets (managed `assetId`s) to use as video components — if stills are
  missing or need creating, dispatch to **Pixel**, don't generate them yourself.

If aspect ratio or length is missing (it changes everything about pacing), block and ask — don't
guess. Apply the `video-pacing` lesson for structure.

### 2. Generate the video

Use the installed Runway runtime skill (Gen-4 text-to-video / image-to-video). Handle sequencing,
transitions, and pacing per `video-pacing`.

### 3. Generate and mix the audio

Generate ALL audio via ElevenLabs — never source or synthesize it. Exact endpoints, request
shapes, mix levels, and the ffmpeg recipe live in the `audio-craft` lesson (enable it). Mix the
audio under the video with ffmpeg.

### 4. Save as a managed asset

```bash
mcporter call bakin-rolo.bakin_exec_assets_save filePath=<final mp4 path> taskId=<id> type=video
```

Capture the returned **`assetId`** — that, not a filesystem path, is the deliverable.

### 5. Submit step output

```bash
mcporter call bakin-rolo.bakin_exec_submit_step taskId=<id> stepId=<step> \
  --args '{"assetId":"<assetId>","duration_s":<seconds>,"has_audio":<true|false>}'
```

After submitting, STOP. Do not message the operator, do not post anywhere, do not start the next
step. The workflow engine takes it from here.

### Quality bar

If the pacing drags or the audio masks the voiceover, fix it and re-render — the output goes to a
real human. Front-load the strongest frame, cut to the beat, end on the payoff (see `video-pacing`).

---
name: youtube-transcript
description: Fetch the transcript of a YouTube video (timestamped text) for summarization, notes, or analysis. Use when a task references a YouTube URL or video ID.
---

# YouTube Transcript

Fetch the caption transcript of a YouTube video as timestamped text.
Everything is already installed — do NOT run npm install.

## Usage

```bash
node ~/.bakin/npm/youtube-transcript/scripts/transcript.js <video-id-or-url>
```

Accepts a video ID or any YouTube URL form:
- `EBw7gsDPAYQ`
- `https://www.youtube.com/watch?v=EBw7gsDPAYQ`
- `https://youtu.be/EBw7gsDPAYQ`

## Output

Timestamped transcript lines on stdout:

```
[0:00] All right. So, I got this UniFi Theta
[0:15] I took the camera out, painted it
[1:23] And here's the final result
```

## Honest failure

- Only works when the video HAS captions (auto-generated or manual). If the
  script reports no transcript available, say so — do not guess the content.
- YouTube occasionally blocks automated caption fetches; report the error
  verbatim rather than retrying in a loop.

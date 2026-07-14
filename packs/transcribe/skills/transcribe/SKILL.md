---
name: transcribe
description: Transcribe audio or video files to timestamped text, fully locally. Use when a task references an audio/video file that needs its content read.
---

# Transcribe

Turn any audio file into a timestamped transcript, fully local (no API,
nothing leaves this machine). Everything is already installed — the
`parakeet-cpp-transcribe` binary is on PATH and its speech model is
preinstalled (PARAKEET_CPP_MODEL_PATH is set).

## Usage

WAV input (PCM 16/24/32-bit or float32):

```bash
parakeet-cpp-transcribe --text recording.wav
```

Anything else (m4a, mp3, mp4, mov, …) — convert to WAV first with ffmpeg:

```bash
ffmpeg -y -loglevel error -i input.m4a -ac 1 -ar 16000 /tmp/transcribe.wav
parakeet-cpp-transcribe --text /tmp/transcribe.wav
```

## Output

Plain text in 15-second timestamped chunks on stdout:

```
[00:00-00:15] Welcome everyone, let's get started with the quarterly review
[00:15-00:30] First item on the agenda is the budget
```

Drop `--text` for JSON with per-word timestamps and confidence scores.

## Honest failure

- If `ffmpeg` is missing for a non-WAV file, say so and point at
  https://ffmpeg.org/download.html — do not attempt other converters.
- Long files take time (roughly real-time ÷ 10 on this hardware); for very
  long recordings, mention progress rather than going silent.

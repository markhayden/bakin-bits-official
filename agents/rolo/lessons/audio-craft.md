---
title: Audio Craft
tags: [audio, mixing, music, sfx]
defaultEnabled: false
---

# Audio Craft

Sound is half the video. Bad audio kills good visuals; good audio elevates mediocre visuals.

## Generating the audio (ElevenLabs)

All audio comes from ElevenLabs — three different endpoints. Keys are in your workspace `.env`
(`ELEVENLABS_API_KEY`); voice id and any model id default from `TOOLS.md`. Don't hardcode model
ids here — check current ElevenLabs docs, they change.

**Sound effects** — `POST /v1/sound-generation`:
```bash
curl -X POST https://api.elevenlabs.io/v1/sound-generation \
  -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" \
  -d '{"text": "food sizzling in a hot pan", "duration_seconds": 10}' \
  --output /tmp/sizzle.mp3
```

**Background music** — `POST /v1/music` (NOT `sound-generation` — that's SFX only). The music
endpoint takes a `prompt` and `music_length_ms` (milliseconds):
```bash
curl -X POST https://api.elevenlabs.io/v1/music \
  -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" \
  -d '{"prompt": "warm jazzy commercial bed, brushed drums, walking bass", "music_length_ms": 10000}' \
  --output /tmp/bgmusic.mp3
```

**Voiceover (TTS)** — `POST /v1/text-to-speech/<voice_id>`:
```bash
curl -X POST "https://api.elevenlabs.io/v1/text-to-speech/<voice_id>" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" \
  -d '{"text": "your voiceover text"}' \
  --output /tmp/voiceover.mp3
```

**Mix with ffmpeg** (video + music ducked under SFX):
```bash
ffmpeg -i video.mp4 -i /tmp/bgmusic.mp3 -i /tmp/sizzle.mp3 \
  -filter_complex "[1:a]volume=0.4,atrim=0:10[music];[2:a]volume=0.7[sfx];[music][sfx]amix=inputs=2:duration=shortest[aout]" \
  -map 0:v -map "[aout]" -c:v copy -c:a aac -shortest output_final.mp4
```

## Levels (in dB, relative)

When mixing with ffmpeg, the standard relationship between tracks:

| Track        | Level (relative)  | volume= filter   |
|--------------|-------------------|-------------------|
| Voiceover    | 0 dB (reference)  | 1.0               |
| Music (with VO) | -10 to -14 dB    | 0.25 to 0.4       |
| Music (no VO)   | -3 to -6 dB     | 0.5 to 0.7        |
| SFX hits     | -3 to -1 dB        | 0.7 to 0.9        |
| Ambient bed  | -18 to -20 dB    | 0.1 to 0.15       |

If music with voiceover sounds "fine" but the voice is hard to follow, drop the music another 3 dB. Listeners on phone speakers always lose more than you expect.

## ElevenLabs music prompts

Be VERY specific about genre + mood + instrumentation:

| Vague (avoid)              | Specific (use this)                                      |
|----------------------------|-----------------------------------------------------------|
| "upbeat music"             | "warm acoustic jazz, brushed drums, walking bass, food-commercial style" |
| "sad music"                | "minor-key piano, slow tempo, single-line melody, sparse" |
| "epic music"               | "cinematic orchestral build, low strings → swell at 0:08" |
| "fun music"                | "bouncy ukulele, hand claps, whistling melody, summer vibe" |

The model handles named-genre requests better than mood adjectives alone.

## Sound effects — diegetic vs designed

- **Diegetic** = sounds that exist in the world on screen. Sizzle for a pan shot, footsteps for a walking shot. Always include these. Their absence registers as "off."
- **Designed** = sounds added for emphasis. Whoosh on a transition, ding on a payoff. Use sparingly — one designed SFX per 5 seconds is plenty.
- **Foley** = the texture of small movements. Cloth rustle, plate clink, button click. Most viewers don't notice them but their absence makes everything feel sterile.

## Voiceover delivery

Default ElevenLabs voice is fine for neutral narration. For specific moods:

- **Energetic / promotional** — speed up the model output 1.05–1.10× via ffmpeg `atempo=1.05`
- **Intimate / quiet** — slow to 0.95×, drop volume to 0.85, EQ low end up
- **Authoritative / news** — straight neutral delivery, light compression, no reverb

Never add reverb to commercial voiceover unless the brief calls for it. Reverb reads as "old radio" and ages content fast.

## When music masks voiceover

If you can hear the music clearly under speech, the music is too loud. Two fixes:

1. **Sidechain duck**: drop music 6dB whenever voice is present, restore between phrases. ffmpeg's `sidechaincompress` works for this.
2. **Lowpass the music**: cut everything above 8 kHz from the music bed during voice. The music stays audible but stops competing for the consonant range.

## What kills audio

- Compressed-MP3 voiceover dropped into a polished video — listeners hear it instantly
- Same loop repeating (music NOT cutting at scene boundaries)
- SFX without diegetic anchor — a "whoosh" with nothing visually whooshing
- Voice EQ that's too bass-heavy (sounds muddy on phones) or too thin (sounds tinny)
- Over-mastering — heavy compression on a 15-second video is overkill

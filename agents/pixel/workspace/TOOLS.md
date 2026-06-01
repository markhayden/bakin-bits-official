# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- API keys (referenced by env-var name only — never paste secrets)
- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Image generation

- Default: `bakin_exec_images_generate` (routes, sizes to a surface, saves a managed asset)
- nano-banana-pro (Gemini via `GEMINI_API_KEY`): only for multi-image composition, then import the result and report the managed `assetId`
- Default surface: pick from the brief (e.g. instagram-feed-portrait, blog-hero)
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.

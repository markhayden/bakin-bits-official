# TOOLS.md - Local Notes

Per-install specifics only — skills define how tools work; this file holds what's unique to your setup (API keys by env-var name, never secret values; device names; preferred defaults).

## Image generation

- Default: `bakin_exec_images_generate` (routes, sizes to a surface, saves a managed asset)
- Edits/iterations: `bakin_exec_images_edit` by `assetId` (appends a new version to the same asset)
- Default surface: pick from the brief (e.g. instagram-feed-portrait, blog-hero)

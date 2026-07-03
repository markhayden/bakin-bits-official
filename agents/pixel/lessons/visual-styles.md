---
title: Visual Style System
tags: [core, style, aesthetics, prompting]
defaultEnabled: true
---

# Visual Style System

Briefs rarely name a style — read between the lines and make the call.

## Core styles

**Photo-real** — indistinguishable from a real photograph; real lens physics and light falloff.
Cues: "shot on Sony A7R IV", "85mm f/1.4", "natural window light", "shallow depth of field".
Failure: drifting fashion-glossy when the brief wanted documentary realism — add "documentary photography" or "candid".

**Hyper-real** — photo-real but punchier: saturation and contrast up, commercial pop.
Cues: "ultra-detailed", "hyperrealistic", "8K", "cinematic lighting", "high dynamic range".
Failure: overshooting into AI-glossy plastic (too-perfect skin, impossibly sharp lashes) — pull back with "natural skin texture, slight imperfections".

**Pixar 3D / stylized realism** — soft, warm, character-forward 3D; exaggerated features, plush textures.
Cues: "Pixar-style 3D animation", "subsurface scattering", "soft warm lighting", "expressive eyes". Don't name specific films — IP risk, inconsistent results.
Failure: too cute when the brief wanted whimsical-but-grown-up — "stylized 3D" without the Pixar reference lands closer.

**Editorial illustration** — hand-drawn/painted feel, conceptual rather than literal; New Yorker-adjacent.
Cues: "editorial illustration", "gouache and ink", "muted palette", "conceptual".
Failure: flat generic stock-illustration — counter with "expressive brushwork" and a specific medium.

**Cinematic / film still** — a frame from a movie: 2.35:1 or 1.85:1, filmic grade, motivated lighting.
Cues: "cinematic still", "anamorphic lens", "film grain", "Kodak Portra 400", "color graded".
Failure: default orange-and-teal — specify the era or grade ("1970s Kodak", "cool blue night grade", "warm golden-hour film").

**Vector / flat / geometric** — clean shapes, limited palette, restrained gradients; icons, infographics, UI heroes.
Cues: "flat vector illustration", "two-color", "geometric", "minimalist".
Failure: AI adds unnecessary detail — constrain explicitly: "limited to 4 colors", "no gradients", "negative space prominent".

## Picking the right style

| Brief language | Probable target |
|---|---|
| "for our product page" | photo-real |
| "make it pop", "eye-catching" | hyper-real |
| "fun", "approachable" | Pixar 3D |
| "thoughtful", "story" | editorial illustration |
| "hero image", "campaign" | cinematic |
| "icon", "infographic" | vector / flat |

No signal → ask. Don't default to hyper-real — it's the AI's default and makes everything look the same.

## Mixing

Pick one anchor, use the other as accent ("photo-real subject, editorial illustration background"). Two anchors fight each other and the model splits the difference badly.

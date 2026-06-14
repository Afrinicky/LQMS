---
name: nano-banana
description: >
  Generate images and videos using the Nano Banana 2 MCP tools. Use this skill
  whenever the user wants to create, generate, or edit any visual media — photos,
  illustrations, icons, thumbnails, hero images, banners, product shots, logos,
  social media graphics, website visuals, placeholder images, or any graphic asset.
  Also use for video generation — cinematic clips, animations, short-form video,
  product videos, or any moving visual content. Triggers on phrases like "generate
  an image", "create a visual", "make me a photo", "design a thumbnail", "generate
  a video", "animate this", "create a clip", "edit this image", "make a banner",
  "I need a poster", "create artwork", or any task involving image or video creation
  and manipulation. Use proactively whenever a task would benefit from a visual
  — e.g. populating a UI mockup, creating a slide hero, illustrating a concept.
compatibility: Requires Nano Banana 2 MCP connected in Claude.ai
---

# Nano Banana 2 — Image & Video Generation

Generate and edit images and videos via the Nano Banana 2 MCP tools. All generation is
done through `generate_media` and editing through `edit_image`.

## Core Workflow

### Step 1 — Choose media type
Determine whether the user wants an **image** or **video**.

### Step 2 — Pick the right model
Consult `references/models.md` for the full model catalogue with credit costs, capabilities,
and when to use each. Key defaults:

| Goal | Default model |
|------|--------------|
| Fast, quality image | `nano-banana-2` |
| High-fidelity / 4K image | `nano-banana-pro` |
| Budget image (text-to-image only) | `flux-2-klein-4b` |
| Photorealism (Google) | `imagen4` |
| Cinematic video | `kling-v3.0-pro` |
| Budget/fast video | `veo3.1-lite` |
| Typography in images | `flux-kontext-max` |
| GPT-based editing | `gpt-image` |

Always call `Nano Banana 2:models` with `action: recommend` and a natural language
`query` when uncertain — it ranks models for the specific use case.

### Step 3 — Craft the prompt
Write a narrative prompt, not a keyword list. See **Prompting** section below.

### Step 4 — Generate
Call `Nano Banana 2:generate_media` with `model`, `prompt`, and optional parameters.

### Step 5 — Present & offer iteration
The tool renders results inline. Always offer to refine, upscale, expand, or remove background
as a follow-up.

---

## generate_media Parameters

```
model         — model ID (required)
prompt        — text description (required)
aspect_ratio  — "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3" | "5:4" | "4:5" | "21:9"
num_variations — 1–4 (default: 1)
output_format  — "png" | "jpg" | "webp" (images only)
media_type    — "image" | "video"
attachments   — list of image URLs or asset IDs for image-to-image / editing
```

For video models, also specify:
- `duration` via the model's supported values (see `references/models.md`)
- Resolution via a model parameter if supported (e.g. `"1080p"`)

> Note: Parameters like `duration`, `resolution`, `enable_audio`, `quality` are passed
> via the model's own parameter schema — confirm in `references/models.md` before using.

---

## edit_image Parameters

Use `edit_image` for three operations on **existing images**:

| action | What it does | Key params |
|--------|-------------|------------|
| `remove_background` | Strip background, transparent PNG | `image` |
| `upscale` | 2× or 4× resolution boost | `image`, `scale: "2"\|"4"` |
| `expand` | Outpaint / extend canvas with AI fill | `image`, `left/right/top/bottom` (px) OR `aspect_ratio` |

`image` accepts a URL or an `asset_id` from a previous generation result.

---

## Prompting

Write prompts as narrative descriptions, not keyword lists.

**General formula:**
"A [style] [shot type] of [subject], [action/context], [environment]. [Lighting]. [Mood/atmosphere]. [Technical spec]."

**By use case:**

- **Website hero (16:9):** "A wide cinematic shot of [scene]. Soft ambient lighting, [palette] tones. Clean, modern, suitable for a website header."
- **Product shot:** "A product shot of [item] on a clean surface, soft diffused studio lighting, subtle shadow, centered composition."
- **Social media (1:1 or 4:5):** "Bold, eye-catching [subject] for Instagram. Vibrant colors, high contrast, text-safe composition."
- **Portrait / avatar:** "Professional headshot of [description], warm natural lighting, shallow depth of field, neutral background."
- **Illustration:** "A [art style] illustration of [subject]. [Color palette]. [Medium]. [Mood]." — styles: watercolor, flat vector, isometric, line art, oil painting, pixel art.
- **Icon / logo:** "Minimal [style] icon of [subject]. Flat design, [color] on [background]. Clean lines, suitable for UI."
- **Video:** "A [duration]-second [shot type] of [scene]. [Movement description]. [Lighting]. [Mood]. [Resolution if needed]."
- **Text in image:** Put text in quotes in the prompt; use `flux-kontext-max` or `nano-banana-pro` at 2K+ for best rendering.
- **Editing:** Be specific about what to change AND what to preserve. "Replace the sky with a dramatic sunset while keeping the foreground buildings unchanged."

---

## Chaining Operations (Multi-step Workflows)

Generated results include an `asset_id`. Use it for downstream operations instead of the temporary URL:

1. Generate image → get `asset_id`
2. Upscale: `edit_image(action="upscale", image=asset_id, scale="2")`
3. Remove background: `edit_image(action="remove_background", image=asset_id)`
4. Expand canvas: `edit_image(action="expand", image=asset_id, aspect_ratio="16:9")`
5. Share / download: `get_download_url(asset_id=asset_id)` for a direct download link

---

## Asset & Collection Management

- `Nano Banana 2:assets` — list, search, retrieve past generated assets
- `Nano Banana 2:collections` — organize assets into named groups
- `Nano Banana 2:display` — render asset IDs or collections visually in the chat
- `Nano Banana 2:share_links` — create shareable links to asset selections

---

## Checking Job Status

`generate_media` returns a `job_id` immediately. In Claude.ai the widget polls automatically —
do NOT call `get_job_status` manually unless you're in a text-only environment.

---

## Error Handling

If `generate_media` returns an `upgrade_url` field in an error response, present it as a
clickable link so the user can upgrade their plan. Do not retry the same call.

---

## Reference Files

- `references/models.md` — Full model catalogue: IDs, providers, credit costs, capabilities, aspect ratios, durations, and selection guidance. Read this when choosing a model for a specific use case.

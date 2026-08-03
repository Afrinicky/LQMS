# Nano Banana 2 — Model Catalogue

Full reference for all available models as of May 2026. Use `Nano Banana 2:models` with
`action: recommend` and a natural language `query` to get ranked recommendations at runtime.

---

## Quick Selection Guide

| Use case | Best model | Credits |
|----------|-----------|---------|
| General-purpose fast image | `nano-banana-2` | 30/img |
| High-fidelity / 4K image | `nano-banana-pro` | 30/img |
| Budget text-to-image | `flux-2-klein-4b` | 1/img |
| Photorealism (Google) | `imagen4` | 12/img |
| Speed + photorealism | `imagen4-fast` | 8/img |
| Image editing / context-aware | `flux-kontext-pro` | 12/img |
| Typography in images | `flux-kontext-max` | 18/img |
| GPT-quality editing | `gpt-image` | 40/img |
| Highest-quality image | `gpt-image-2` | 87/img |
| Cinematic video (latest) | `kling-v3.0-pro` | 16 credits/sec |
| Budget/fast video | `veo3.1-lite` | 10 credits/sec |
| Cinematic + audio | `veo3.1-fast` | 30 credits/sec |

---

## Image Models

### Google / Nano Banana

| Model ID | Name | Credits | Notes |
|----------|------|---------|-------|
| `nano-banana-2` | Nano Banana 2 | 30/img | Default fast model; accepts up to 3 input images; resolution: 1K/2K/4K |
| `nano-banana-pro` | Nano Banana Pro | 30/img | High-fidelity; same attachments/resolutions as above |
| `nano-banana` | Nano Banana | 12/img | Original model; accepts up to 3 input images; no resolution param |
| `imagen3` | Imagen 3 | 10/img | Photorealistic; no image input |
| `imagen3-fast` | Imagen 3 Fast | 10/img | Speed-optimised; no image input |
| `imagen4` | Imagen 4 | 12/img | Latest Google photorealism; no image input |
| `imagen4-fast` | Imagen 4 Fast | 8/img | Speed-optimised; no image input |

**nano-banana-2/pro attachments:** `image_0`, `image_1`, `image_2` (up to 3 reference/input images)
**Aspect ratios (all Nano Banana / Imagen):** 1:1, 3:4, 4:3, 3:2, 2:3, 5:4, 4:5, 9:16, 16:9, 21:9

---

### Black Forest Labs — Flux 2

| Model ID | Name | Credits | Notes |
|----------|------|---------|-------|
| `flux-2-pro` | Flux 2 Pro | 12/img | Up to 4 input images; resolution 1K/2K |
| `flux-2-flex` | Flux 2 Flex | 12/img | Flagship Flux 2; up to 4 input images; resolution 1K/2K |
| `flux-2-max` | Flux 2 Max | 14/img | Maximum quality; up to 4 input images; resolution 1K/2K |
| `flux-2-klein-4b` | Flux 2 Klein 4B | 1/img | Budget; fast; no image input; no resolution param |
| `flux-2-klein-9b` | Flux 2 Klein 9B | 2/img | Higher quality budget; no image input; no resolution param |

**Flux 2 Pro/Flex/Max attachments:** `input_image`, `input_image_2`, `input_image_3`, `input_image_4`
**Flux 2 Pro/Flex/Max aspect ratios:** 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9
**Flux 2 Klein aspect ratios:** 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9

---

### Black Forest Labs — Flux Kontext (Editing)

| Model ID | Name | Credits | Notes |
|----------|------|---------|-------|
| `flux-kontext-pro` | Flux Kontext Pro | 12/img | Context-aware editing; requires `input` attachment |
| `flux-kontext-max` | Flux Kontext Max | 18/img | Best for typography; requires `input` attachment |

**Attachments:** single `input` image
**Aspect ratios:** 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9

> Use Flux Kontext when you need precise text rendering in images or surgical edits to
> existing photos. `flux-kontext-max` is the top choice for any image with text overlay.

---

### Black Forest Labs — Flux Legacy

| Model ID | Name | Credits | Notes |
|----------|------|---------|-------|
| `flux/dev` | Flux Dev | 8/img | Balanced; no image input |
| `flux-pro/v1.1` | Flux Pro v1.1 | 12/img | Fast, high-quality; no image input |
| `flux-pro/v1.1-ultra` | Flux Pro v1.1 Ultra | 18/img | Ultra-high resolution; no image input |

**Aspect ratios:** 1:1, 3:4, 4:3, 9:16, 16:9

---

### OpenAI — GPT Image

| Model ID | Name | Credits | Notes |
|----------|------|---------|-------|
| `gpt-image` | ChatGPT Image | 40/img | Powerful editing; `input` attachment |
| `gpt-image-1-mini` | ChatGPT Image Mini | 12/img | Budget GPT editing; `input` attachment |
| `gpt-image-2` | ChatGPT Image 2 | 87/img | Next-gen; quality param: low/medium/high; resolution 1K/2K/4K; `input` attachment |

**GPT Image 2 aspect ratios:** auto, 1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3
**GPT Image / Mini aspect ratios:** 1:1, 3:2, 2:3

---

## Video Models

Credits are charged **per second** of generated video.

### Kling (Recommended for Cinematic)

| Model ID | Name | Credits/sec | Durations | Aspect ratios | Notes |
|----------|------|-------------|-----------|---------------|-------|
| `kling-v3.0-pro` | Kling v3.0 Pro | 16 | 3–15 s | 9:16, 16:9, 1:1 | Multi-shot; elements (up to 5 imgs); audio; 1080p |
| `kling-v2.6-pro` | Kling v2.6 Pro | 14 | 5, 10 s | 9:16, 16:9, 1:1 | Audio; 1080p |
| `kling-omni-pro` | Kling Omni Pro | 15 | 5, 10 s | 9:16, 16:9, 1:1 | Advanced capabilities |
| `kling-omni-pro-references` | Kling Omni Pro References | 15 | 5, 10 s | 9:16, 16:9, 1:1 | Elements (5) + references (2) via @image1/@image2 syntax |
| `kling-v2.5-turbo-pro` | Kling v2.5 Turbo Pro | 14 | 5, 10 s | 9:16, 16:9, 1:1 | Cinematic physics |

> **Default video choice:** `kling-v3.0-pro` for quality; `kling-v2.5-turbo-pro` for cost efficiency.

---

### Google Veo

| Model ID | Name | Credits/sec | Durations | Aspect ratios | Notes |
|----------|------|-------------|-----------|---------------|-------|
| `veo3.1` | Veo3.1 | 80 | 4, 6, 8 s | 16:9, 9:16 | Ultra-realistic; audio; 720p/1080p/4k |
| `veo3.1-fast` | Veo3.1 Fast | 30 | 4, 6, 8 s | 16:9, 9:16 | Fast cinematic; audio; 720p/1080p/4k |
| `veo3.1-lite` | Veo3.1 Lite | 10 | 4, 6, 8 s | 16:9, 9:16 | Budget; 720p/1080p; no audio param |
| `veo3` | Veo3 | 80 | 4, 6, 8 s | 16:9, 9:16 | Prior gen; audio; 720p/1080p/4k |
| `veo3-fast` | Veo3 Fast | 30 | 4, 6, 8 s | 16:9, 9:16 | Prior gen fast; audio |

> Use `veo3.1-fast` for a balance of quality and cost. Use `veo3.1-lite` for budget video.

---

### OpenAI Sora

| Model ID | Name | Credits/sec | Durations | Aspect ratios | Notes |
|----------|------|-------------|-----------|---------------|-------|
| `sora-2` | Sora 2 | 20 | 4, 8, 12, 16, 20 s | 9:16, 16:9 | Audio; up to 20s |
| `sora-2-pro` | Sora 2 Pro | 100 | 4, 8, 12, 16, 20 s | 9:16, 16:9 | State-of-the-art; 720p/1080p; audio |

> Use for long-form video (up to 20s). High credit cost; recommend for premium outputs only.

---

### Bytedance Seedance

| Model ID | Name | Credits/sec | Durations | Aspect ratios | Notes |
|----------|------|-------------|-----------|---------------|-------|
| `seedance-v2.0` | Seedance v2.0 | 61 | 4–15 s | auto, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | Text-to-video, image-to-video, reference-to-video (9 refs); audio |
| `seedance-v2.0-fast` | Seedance v2.0 Fast | 50 | 4–15 s | auto, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | Faster; same capabilities; audio |
| `seedance-v1.5-pro` | Seedance v1.5 Pro | 20 | 4–12 s | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | Improved motion; audio |
| `seedance-v1.0-pro` | Seedance v1.0 Pro | 25 | 3–12 s | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | 480p/720p/1080p |
| `seedance-v1.0-lite` | Seedance v1.0 Lite | 12 | 3–12 s | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | Budget; 480p/720p/1080p |

> Seedance v2.0 supports 21:9 ultra-wide — unique among video models. Good for reference-based generation.

---

### Wan 2.5

| Model ID | Name | Credits/sec | Durations | Aspect ratios | Notes |
|----------|------|-------------|-----------|---------------|-------|
| `wan2.5` | Wan 2.5 | 16 | 5, 10 s | 1:1, 9:16, 16:9 | Audio synchronized |

---

### Hailuo

| Model ID | Name | Credits/sec | Durations | Aspect ratios | Notes |
|----------|------|-------------|-----------|---------------|-------|
| `hailuo-v2.0-std` | Hailuo v2.0 Standard | 14 | 6, 10 s | 16:9 only | 768p |
| `hailuo-v2.0-pro` | Hailuo v2.0 Pro | 16 | 5 s only | 16:9 only | 1080p |

---

## Notes on Attachments

- For models with attachment slots, pass asset IDs or image URLs in the `attachments` parameter of `generate_media`.
- Attachment slot names (`image_0`, `input_image`, `input`, `elements`, `references`) vary by model — use the correct slot name.
- When chaining edits, always use `asset_id` from a prior result rather than a temporary URL.

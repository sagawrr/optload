# optload

Effect-powered image intake with an idiomatic Promise API and a deliberate
server fallback.

Optload treats an upload as untrusted bytes, not as whatever its extension or
`File.type` claims. It inspects a bounded prefix, applies policy, chooses a
processing route, normalizes supported images in a fresh worker, and makes the
server path explicit when the browser cannot safely finish the job.

> Production ready: the browser pipeline, server orchestration, and a
> process-isolated sharp decoder adapter are end to end and
> security-hardened — bounded header inspection with defensive read limits,
> post-decode dimension verification, per-route server policies, deadlines
> covering every pipeline stage, and a cross-browser matrix generated from
> real Playwright runs. See [SECURITY.md](./SECURITY.md) for the trust model
> and the remaining deployment obligations.

## Why hybrid

The browser should do the work that improves UX and reduces transfer size. The
server must remain the authority that decides what gets stored or served.

1. Inspect magic bytes and dimensions without trusting MIME or extension.
2. Reject obvious policy violations before invoking a decoder.
3. Resize and re-encode ordinary still images in a one-image, one-lifetime worker.
4. Upload the smaller normalized blob.
5. Route missing codecs, unknown dimensions, and local failures to an explicit
   server handler.
6. Re-inspect and decode under server-side resource limits before accepting the
   result. Browser output is still attacker-controlled input.

## Packages

- `@optload/core` — bounded header inspection, policy, and tagged Effect errors.
- `@optload/browser` — Promise-first capability planning, worker processing,
  and whole-page file-drop handling; `/effect` exposes the native Effect API.
- `@optload/server` — independent re-inspection, isolated-normalizer
  orchestration, deadlines, and output verification, with Promise and Effect
  entry points.
- `@optload/sharp-normalizer` — the reference server decoder adapter: one
  forked sharp/libvips process per image, header re-checks, raw-pixel
  boundary, metadata and ICC stripping, sRGB-pinned output, and decode
  probes that prove codec capability instead of trusting format tables.
- `@optload/playground` — runnable Vite example demonstrating every scenario:
  the local worker route, the server fallback route, active-content rejection,
  mid-flight cancellation, and inspection warnings for mismatched files.

Effect is pinned to the latest stable 3.x release rather than the 4.x release
candidate. It powers cancellation, typed failures, resource cleanup, and
timeouts internally without requiring every application to adopt Effect.

## One engine, your API style

The default packages expose ordinary TypeScript values, async callbacks, and
Promises. Consumers do not import Effect or return Effects from callbacks.

Effect users opt into `@optload/browser/effect` or `@optload/server/effect`.
Those entry points use the same factory and method names, but preserve the typed
Effect error channel for composition. There is one implementation, not separate
Promise and Effect pipelines.

## Quick start

```sh
pnpm add @optload/browser
```

```ts
import { createImageIntake } from "@optload/browser"

const images = createImageIntake({
  policy: {
    maxInputBytes: 32 * 1024 * 1024,
    maxSourcePixels: 33_554_432,
    allowAnimation: false,
  },
  output: {
    format: "webp",
    maxWidth: 2048,
    maxHeight: 2048,
    quality: 0.84,
  },
  fallback: async ({ file, inspection, reason, signal }) => {
    const body = new FormData()
    body.set("image", file)
    body.set("detectedFormat", inspection.format ?? "unknown")
    body.set("fallbackReason", reason.code)

    const response = await fetch("/api/images/fallback", {
      method: "POST",
      body,
      signal,
    })
    if (!response.ok) throw new Error(`Upload failed: ${response.status}`)
    return response.json() as Promise<{ imageId: string }>
  },
})
```

Promise callers get cancellation directly on the obvious method:

```ts
const result = await images.process(file, {
  signal: abortController.signal,
  onProgress: ({ stage, progress }) => updateUi(stage, progress),
})

if (result.kind === "local") {
  const body = new FormData()
  body.set("image", result.blob, `upload.${result.output.format}`)
  await fetch("/api/images/normalized", { method: "POST", body })
}
```

Effect callers retain the typed error channel by changing only the import:

```sh
pnpm add @optload/browser effect
```

```ts
import { createImageIntake } from "@optload/browser/effect"
import { Effect } from "effect"

const images = createImageIntake({
  output: { format: "webp", maxWidth: 2048, maxHeight: 2048 },
  fallback: ({ file }) => uploadOriginalEffect(file),
})

const program = images.process(file).pipe(
  Effect.tap((result) => Effect.logInfo(result.kind)),
)
```

Handle file drops anywhere without hijacking ordinary text/link drags:

```ts
const detach = images.attachDropTarget(window, {
  onActiveChange: (active) => showDropOverlay(active),
  onResult: (result, file) => showResult(result, file),
  onError: (error, file) => showError(error, file),
})

// Call when the view unmounts.
detach()
```

`execution: "auto"` and `execution: "worker"` require an isolated module
worker. They never silently downgrade to UI-thread decoding. Use
`execution: "main-thread"` only as an explicit compatibility tradeoff.

On the server, re-inspect, decode, and re-encode in an isolated process:

```sh
pnpm add @optload/server @optload/sharp-normalizer
```

```ts
import { createServerImageIntake } from "@optload/server"
import { createSharpNormalizer, probeDecoders } from "@optload/sharp-normalizer"

// Prove codec capability once at boot — the format table is not a codec
// claim (prebuilt libvips decodes AV1, not HEVC).
const decoders = await probeDecoders()
if (!decoders.heic) {
  // Route .heic uploads elsewhere, or reject them, before they reach intake.
}

const intake = createServerImageIntake({
  normalizer: createSharpNormalizer(),
  output: { format: "webp", maxWidth: 2048, maxHeight: 2048 },
})

const result = await intake.process(upload)
// result.output is re-encoded from decoded pixels: no source metadata,
// profiles, or appended bytes survive; the server verified it twice.
```

## Defaults that are intentional

- JPEG, PNG, WebP, AVIF, HEIC, and HEIF are recognized input formats.
- SVG, unknown formats, oversize files, decompression-bomb dimensions, and
  animation are rejected by default.
- Default intake limits are 32 MB, 33.5 MP, and 8,192 px per side; the decoded
  bitmap is re-verified against the pixel and dimension limits after decode,
  because a header can understate the real frame size.
- A JPEG declaring several conflicting frame sizes in the inspected prefix is
  judged by the largest and reported as `inconsistent_dimensions`.
- Bytes past a container's end marker (PNG IEND, JPEG EOI, the declared WebP
  RIFF extent) are reported as `trailing_data`; local re-encoding drops them,
  and both server routes reject them by default.
- EXIF, XMP, ICC, and text metadata are reported as `metadata_present`;
  re-encoded output never carries them forward, but a server fallback that
  stores the original file does.
- Unknown dimensions, unavailable native codecs, and output formats the engine
  cannot encode require server fallback.
- Only a bounded file prefix is read during preflight.
- One fresh worker processes one image and is then terminated.
- Output is a newly encoded JPEG, PNG, or WebP blob; source metadata is not copied.
- Drop targets accept an optional `maxFiles` cap so one adversarial drop cannot
  enqueue unbounded decoder work.

See [SECURITY.md](./SECURITY.md) for the trust model and server obligations,
[docs/browser-matrix.md](./docs/browser-matrix.md) for verified per-engine
behavior (regenerate with `pnpm test:browsers`), and
[docs/security-research.md](./docs/security-research.md) for the incident
research behind every rule.

## MediaBunny

MediaBunny is a strong fit for a future video/audio package: container parsing,
demuxing, WebCodecs orchestration, and remuxing. It is not the primary image
decoder for this package, and adding it would not remove the need for policy,
resource limits, worker isolation, or server validation.

## Develop

```sh
pnpm install
pnpm test
pnpm test:browsers   # regenerate docs/browser-matrix.md from real engine runs
pnpm typecheck
pnpm lint
pnpm dev
```

`pnpm lint` runs oxlint with complexity ceilings (cyclomatic complexity ≤ 15,
depth/params/nesting caps), security rules (no `eval`-adjacent constructs,
prototype pollution vectors), and every enabled rule at error severity.

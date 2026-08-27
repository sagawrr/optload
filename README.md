# optload

Effect-native image intake for the browser, with a deliberate server fallback.

Optload treats an upload as untrusted bytes, not as whatever its extension or
`File.type` claims. It inspects a bounded prefix, applies policy, chooses a
processing route, normalizes supported images in a fresh worker, and makes the
server path explicit when the browser cannot safely finish the job.

> Early alpha. The browser pipeline and server orchestration work end to end;
> production decoder adapters and the cross-browser compatibility matrix are
> still being built.

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
- `@optload/browser` — capability planning, worker processing, Promise adapter,
  and whole-page file-drop handling.
- `@optload/server` — independent re-inspection, isolated-normalizer
  orchestration, deadlines, and output verification.
- `@optload/playground` — runnable Vite example.

Effect is pinned to the latest stable 3.x release rather than the 4.x release
candidate, so the public API is built on stable primitives.

## Quick start

```sh
pnpm add @optload/browser effect
```

```ts
import { createImageIntake } from "@optload/browser"
import { Effect } from "effect"

const images = createImageIntake({
  policy: {
    maxInputBytes: 32 * 1024 * 1024,
    maxSourcePixels: 100_000_000,
    allowAnimation: false,
  },
  output: {
    format: "webp",
    maxWidth: 2048,
    maxHeight: 2048,
    quality: 0.84,
  },
  fallback: ({ file, inspection, reason }) =>
    Effect.tryPromise({
      try: async () => {
        const body = new FormData()
        body.set("image", file)
        body.set("detectedFormat", inspection.format ?? "unknown")
        body.set("fallbackReason", reason.code)

        const response = await fetch("/api/images/fallback", {
          method: "POST",
          body,
        })
        if (!response.ok) throw new Error(`Upload failed: ${response.status}`)
        return response.json() as Promise<{ imageId: string }>
      },
      catch: (cause) => new Error("Server fallback failed", { cause }),
    }),
})
```

Effect callers retain the typed error channel:

```ts
const program = images.process(file).pipe(
  Effect.tap((result) =>
    Effect.logInfo(result.kind === "local" ? "ready to upload" : "server handled"),
  ),
)
```

Promise callers get cancellation without a second implementation:

```ts
const result = await images.processPromise(file, {
  signal: abortController.signal,
  onProgress: ({ stage, progress }) => updateUi(stage, progress),
})

if (result.kind === "local") {
  const body = new FormData()
  body.set("image", result.blob, `upload.${result.output.format}`)
  await fetch("/api/images/normalized", { method: "POST", body })
}
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

## Defaults that are intentional

- JPEG, PNG, WebP, AVIF, HEIC, and HEIF are recognized input formats.
- SVG, unknown formats, oversize files, decompression-bomb dimensions, and
  animation are rejected by default.
- Unknown dimensions and unavailable native codecs require server fallback.
- Only a bounded file prefix is read during preflight.
- One fresh worker processes one image and is then terminated.
- Output is a newly encoded JPEG, PNG, or WebP blob; source metadata is not copied.

See [SECURITY.md](./SECURITY.md) for the trust model and server obligations.

## MediaBunny

MediaBunny is a strong fit for a future video/audio package: container parsing,
demuxing, WebCodecs orchestration, and remuxing. It is not the primary image
decoder for this package, and adding it would not remove the need for policy,
resource limits, worker isolation, or server validation.

## Develop

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```

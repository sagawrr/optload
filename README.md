# optload

[![CI](https://github.com/sagawrr/optload/actions/workflows/ci.yml/badge.svg)](https://github.com/sagawrr/optload/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Image intake for browsers and Node.js with Promise-first and Effect-native APIs.
Optload identifies uploads from bytes, applies explicit policy, normalizes
ordinary still images in a fresh browser worker by default, and routes
unsupported work to a server normalizer.

## Security boundary

Browser output is untrusted input. Client-side normalization improves latency,
bandwidth, and privacy, but the receiving server must still enforce request
limits, re-inspect the bytes, decode outside the application process, re-encode,
and verify the result before storage.

The default flow is:

1. Inspect a bounded prefix without trusting the filename or `File.type`.
2. Reject policy violations before browser decode.
3. Decode, dimension-check, resize, and re-encode in a one-image worker.
4. Invoke the configured fallback when the browser lacks a codec, encoder, or
   isolated-worker capability, or when local processing fails.
5. Re-inspect accepted server input, normalize it across a declared
   process/container/service boundary, and structurally inspect the output.

`local` and `fallback` are successful results. `reject` is a typed failure; a
rejected file is never sent automatically to the broader fallback endpoint.

## Packages

- `@optload/core` — byte-based header inspection, policy, and tagged errors.
- `@optload/browser` — browser planning, worker normalization, drop handling,
  Promise API, and `/effect` entry point.
- `@optload/server` — route-specific server policy, deadlines, normalizer
  orchestration, and output re-inspection.
- `@optload/sharp-normalizer` — reference Sharp/libvips adapter using one child
  process per image and an explicit buffer-loader allowlist.
- `@optload/playground` — local processing and simulated fallback/rejection UI.

## Browser usage

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

`execution: "auto"` (the default) and `execution: "worker"` require a module
worker with `OffscreenCanvas`. They route to fallback when isolation is
unavailable; they do not silently decode on the UI thread. Set
`execution: "main-thread"` only as an explicit compatibility choice.

Drop handling has a default cap of 20 files per drop and can be lowered:

```ts
const detach = images.attachDropTarget(window, {
  maxFiles: 5,
  onResult: (result, file) => showResult(result, file),
  onError: (error, file) => showError(error, file),
})

// Call on unmount.
detach()
```

Effect users install `effect` and import the same factory name from
`@optload/browser/effect`; callbacks and failures remain in the Effect channel.

## Server usage

```sh
pnpm add @optload/server @optload/sharp-normalizer
```

```ts
import { createServerImageIntake } from "@optload/server"
import { createSharpNormalizer, probeDecoders } from "@optload/sharp-normalizer"

const codecs = await probeDecoders()
if (!codecs.heic) {
  // Reject HEVC-backed HEIC/HEIF or route it to a compatible service.
}

const intake = createServerImageIntake({
  normalizer: createSharpNormalizer(),
  output: { format: "webp", maxWidth: 2048, maxHeight: 2048 },
})

const result = await intake.process(upload, {
  source: "original-fallback",
  signal: request.signal,
})
```

The supplied `FileLike.size` must be the real stream length. Request-body
limits must run before constructing a `FileLike`; the library cannot recover
bytes that an upstream wrapper hides or safely buffer an unbounded stream.

## Defaults

| Route | Formats | Max bytes | Max pixels | Max side | Unknown dimensions |
| --- | --- | ---: | ---: | ---: | --- |
| Browser | JPEG, PNG, WebP, AVIF, HEIC, HEIF | 32 MiB | 33,554,432 | 8,192 | fallback |
| Server: browser-normalized | JPEG, PNG, WebP | 16 MiB | 16,777,216 | 4,096 | reject |
| Server: original-fallback | all six inputs | 32 MiB | 33,554,432 | 8,192 | reject |

Detected animation and SVG are rejected by default. Inconclusive animation or
frame state routes to fallback in the browser and rejects at the server.
Browser outputs are JPEG, PNG, or WebP. The reference server output is lossy
WebP unless configured otherwise. Server input policy has a non-overridable
64 MiB ceiling so accepted input can receive a complete structural walk.

## Limits of the guarantee

- Header inspection is a bounded preflight, not proof that a container or
  decoder is bug-free.
- A browser worker limits lifetime and state sharing; it is not a stronger
  sandbox than the browser.
- A forked decoder child is crash/hang isolation, not an OS resource sandbox.
  Containerize the service when hostile uploads require memory, CPU, filesystem,
  syscall, or egress controls.
- Re-encoding removes source container structure and detected metadata but does
  not provide malware scanning, content moderation, or reliable steganography
  detection.
- URL fetching is intentionally out of scope.

See [SECURITY.md](./SECURITY.md) for deployment obligations and vulnerability
reporting, [security evidence](./docs/security-research.md) for the primary
advisories behind the controls, and the checked-in
[browser matrix](./docs/browser-matrix.md) for the latest recorded Playwright
run. CI uploads a newly generated matrix as an artifact without granting pull
requests repository write access.

## Development

```sh
pnpm install --frozen-lockfile
pnpm audit:prod
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm sbom:all
pnpm test:browsers
pnpm dev
```

Runtime dependencies are pinned where they cross a decoder boundary. CI uses
read-only permissions for pull requests, immutable action commits, a production
audit gate, strict TypeScript, deterministic security/fuzz regressions, package
builds, and CycloneDX SBOM artifacts.

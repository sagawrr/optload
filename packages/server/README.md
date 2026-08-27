# @optload/server

Server-side orchestration for re-inspecting and re-normalizing both browser-
optimized blobs and original fallback uploads.

The package deliberately does not bundle a native decoder. Supply an adapter
that crosses a real process, container, or external-service boundary:

```ts
import { createServerImageIntake } from "@optload/server"

const images = createServerImageIntake({
  normalizer: sandboxedNormalizer,
  output: { format: "webp", maxWidth: 2048, maxHeight: 2048 },
})

const result = await images.processPromise(untrustedUpload, {
  source: "browser-normalized",
  signal: request.signal,
})
```

The normalizer output is inspected again and must satisfy output format, byte,
dimension, pixel, frame, and animation policy. A worker thread is intentionally
not accepted as sufficient isolation for native server codecs.

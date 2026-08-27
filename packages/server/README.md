# @optload/server

Server-side orchestration for re-inspecting and re-normalizing both browser-
optimized blobs and original fallback uploads.

The package deliberately does not bundle a native decoder. Supply an adapter
that crosses a real process, container, or external-service boundary:

```ts
import { createServerImageIntake } from "@optload/server"

const images = createServerImageIntake({
  normalizer: {
    isolation: "external-service",
    normalize: async (request) => sandboxedNormalizer.normalize(request),
  },
  output: { format: "webp", maxWidth: 2048, maxHeight: 2048 },
})

const result = await images.process(untrustedUpload, {
  source: "browser-normalized",
  signal: request.signal,
})
```

Effect applications use the same API names from `@optload/server/effect` and
provide an Effect-returning normalizer.

The normalizer output is inspected again and must satisfy output format, byte,
dimension, pixel, frame, and animation policy. A worker thread is intentionally
not accepted as sufficient isolation for native server codecs.

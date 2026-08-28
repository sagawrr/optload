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
not accepted as sufficient isolation for native server codecs. Accepted inputs
and bounded outputs receive a full-container structural walk so PNG/JPEG
terminal markers and WebP RIFF extents can be enforced.

Server input has a non-overridable 64 MiB ceiling; route defaults are stricter
(16 MiB for browser-normalized input and 32 MiB for original fallback).

The `FileLike.size` supplied to this package must be the real stream length;
enforce request-body limits before buffering. See the
[security policy](https://github.com/sagawrr/optload/blob/main/SECURITY.md) for
the complete deployment contract.

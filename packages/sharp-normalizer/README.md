# @optload/sharp-normalizer

Reference Sharp/libvips decoder adapter for `@optload/server`. It implements the
`ServerImageNormalizer` contract with one forked child per image.

## Isolation and limits

The child is killed when the request succeeds, fails, is aborted, or exceeds its
decode timeout (25 seconds by default). No decoder state is reused across
images.

Inside the child:

1. all libvips foreign loaders are blocked;
2. only JPEG, PNG, WebP, and HEIF buffer loaders plus the raw-pixel
   intermediate are enabled;
3. the full input is re-inspected and restricted to JPEG, PNG, WebP, AVIF,
   HEIC, or HEIF;
4. declared dimensions are checked before Sharp sees the bytes;
5. decode materializes bounded, EXIF-oriented, 8-bit sRGB raw pixels;
6. decoded dimensions are checked and compared with the declaration before
   resize;
7. output is resized to the configured side and pixel budgets; and
8. encoded output size is checked before bytes cross IPC to the parent.

Only raw pixels enter the second encode stage, so source container structure,
appended bytes, EXIF, and source ICC profiles are not copied to output.

A child process contains crashes/hangs and prevents state reuse; it is not an
OS memory or CPU sandbox. Containerize the service or use an external sandbox
when the deployment threat model requires resource, filesystem, syscall, or
egress controls.

## Usage

```ts
import { createServerImageIntake } from '@optload/server'
import { createSharpNormalizer } from '@optload/sharp-normalizer'

const intake = createServerImageIntake({
  normalizer: createSharpNormalizer(),
  output: { format: 'webp', maxWidth: 2048, maxHeight: 2048 },
})

const result = await intake.process(upload, {
  source: 'original-fallback',
  signal: request.signal,
})
```

Effect users keep the same factory names:

```ts
import { createServerImageIntake } from '@optload/server/effect'
import { createSharpNormalizer } from '@optload/sharp-normalizer/effect'

const intake = createServerImageIntake({
  normalizer: createSharpNormalizer(),
})
```

HEIF container support does not prove HEVC pixel decode. Official prebuilt
Sharp binaries decode AV1-backed AVIF, while HEVC-backed HEIC/HEIF depends on
the bundled libvips build. Call `probeDecoders()` at boot; reject or reroute
HEIC/HEIF when its HEVC result is false.

See the [security policy](https://github.com/sagawrr/optload/blob/main/SECURITY.md)
for request-stream, storage, serving-origin, and container obligations.

# @optload/sharp-normalizer

Production decoder adapter for `@optload/server`: a process-isolated
sharp/libvips normalizer implementing the `ServerImageNormalizer` contract.

## Why sharp

Evaluated against every practical alternative for decoding untrusted input in
Node: wasm-vips is 2.2–8.3× slower than native sharp (libvips maintainer's own
figures), jimp and squoosh-class tools are pure-JS and far behind, and the
ImageMagick family is both slower and disqualified for untrusted input by the
delegate-execution class (ImageTragick, CVE-2022-44268). sharp wraps libvips —
demand-driven, tiled decoding that never materializes unbounded bitmaps — and
the prebuilt binaries bundle patched codecs (libvips 8.18.6, past the
CVE-2026-35590 EXIF fix). libvips has run continuously under OSS-Fuzz since
2019.

## Isolation model

One forked child per image, `SIGKILL`ed when the request settles, the abort
signal fires, or the wall-clock budget (default 25 s, under the server
package's 30 s deadline) expires. A decoder crash or hang is contained, and no
state survives between images.

Inside the child, before libvips sees any byte:

1. the header is re-inspected and its declared dimensions checked against the
   decode budget (defense in depth for direct users of this package);
2. decode proceeds with sharp's own `limitInputPixels` as a second bound.

The output is fully normalized: EXIF-oriented upright, resized inside the
target box without enlargement, stripped of all source metadata and ICC
profiles, and pinned to 8-bit sRGB. Stored bytes are only pixels this adapter
produced — never input structure.

## Usage

```ts
import { createServerImageIntake } from '@optload/server';
import { createSharpNormalizer } from '@optload/sharp-normalizer';

const intake = createServerImageIntake({
  normalizer: createSharpNormalizer(),
  output: { format: 'webp', maxWidth: 2048, maxHeight: 2048 },
});

const result = await intake.process(upload);
```

For Effect integrators, the `/effect` entry preserves the typed error channel
(`SharpNormalizerError`) and interruption — aborting the fiber SIGKILLs the
forked child:

```ts
import { createServerImageIntakeEffect } from '@optload/server/effect';
import { createSharpNormalizer } from '@optload/sharp-normalizer/effect';

const intake = createServerImageIntakeEffect({
  normalizer: createSharpNormalizer(),
});
```

`supportedInputFormats()` reports container-level input support (jpeg,
png, webp, tiff, gif, svg, plus the HEIF family when libheif is compiled in).
For the HEIF family the container claim is not enough: official prebuilt
libvips decodes AV1 payloads (AVIF) but ships without libde265, so `.heic`
HEVC files parse and then fail the pixel decode. Call `probeDecoders()` once
at boot — it proves real pixel decode of embedded probe images in the forked
child — and route `heic`/`heif` uploads to a build of libvips with libde265
(or reject them) when the probe reports false.

Keep WebP (the default, lossy) or JPEG as the server output format: a
lossless PNG round-trip preserves pixel-domain stego (see SECURITY.md,
obligation 14).

See [SECURITY.md](../../SECURITY.md) for the full server obligations.

# Optload security model

## The non-negotiable boundary

Everything received from a browser is untrusted, including an Optload-generated
blob and every client-supplied inspection field. Client processing improves UX,
bandwidth, and privacy; it is not a security verdict.

A production server must independently:

1. enforce request and decompressed-body byte limits before buffering;
2. identify the format from bytes rather than filename or `Content-Type`;
3. enforce dimensions, total pixels, frames, and processing deadlines;
4. decode in an isolated, memory/CPU-constrained process or service;
5. patch codec and image-processing dependencies promptly;
6. re-encode into an allowed output format rather than preserving arbitrary
   source structure or metadata;
7. verify the encoded output again before durable storage;
8. serve uploads from a separate origin with fixed safe `Content-Type`,
   `X-Content-Type-Options: nosniff`, and no user-controlled active content;
9. build the server `FileLike` from the real stream length: `size` is what the
   byte limit checks, and a wrapper that misreports it defeats `maxInputBytes`;
10. honor the `AbortSignal` handed to normalizers so the configured deadline
    stops the actual decode work instead of only failing the request;
11. reject bytes past a container's terminal marker wherever bytes are
    persisted (both server routes default `rejectTrailingData` to true —
    appended data is the aCropalypse/polyglot channel);
12. never run general-purpose EXIF/metadata tooling on untrusted input
    (CVE-2021-22204 and CVE-2022-44268 class: metadata parsing is code
    execution and file read);
13. offer no "image from URL" intake; if a product requires it, the fetcher
    must be an isolated, egress-controlled service applying the OWASP SSRF
    prevention set (resolve-once, reject private/link-local results, no
    redirects);
14. store and serve only re-encoded output, never original upload bytes
    (steganographic-C2 campaigns use image hosts as payload transport; the
    re-encode is what destroys those channels — and for *pixel-domain* stego
    it must be lossy or geometry-changing: a lossless PNG→PNG round-trip
    preserves pixel LSBs, and Worok's PNG loader reads pixels only, so
    metadata stripping alone does not stop it; optload's default WebP
    outputs are lossy).

## Browser defenses

| Risk | Current behavior |
| --- | --- |
| Forged MIME/extension | Magic-byte detection wins; mismatches are reported. |
| Oversize transfer | `maxInputBytes` rejects before decode. |
| Decompression bombs | Header dimensions/pixels are bounded before decode, and the decoded bitmap's dimensions are re-verified against the same limits after decode. |
| Lying headers | A frame header that understates the real size still meets the post-decode verification; the image routes to server fallback instead of local processing. |
| Conflicting frame declarations | A JPEG whose inspected prefix carries several SOF markers is judged by the largest declared frame and reported as `inconsistent_dimensions`. |
| Appended data (polyglots, truncated-overwrite leaks) | Bytes past the PNG IEND chunk, the JPEG EOI marker, or the declared WebP RIFF extent are reported as `trailing_data`; local re-encoding drops them. |
| Metadata leakage | Canvas output is newly encoded; source metadata is not copied. EXIF, XMP, ICC, and text chunks seen in the prefix are reported as `metadata_present`, because a server fallback that stores the original does not strip them. |
| Decoder hang/crash | Default processing uses a fresh worker with a deadline. |
| Worker contamination | A new worker is created for one image and is terminated. |
| Active SVG | Recognized but rejected by the default bitmap policy. |
| Animation/frame bombs | Animation and more than one frame are rejected when detectable in the inspected prefix; otherwise animation is reported as unknown rather than assumed still. |
| Drop floods | Each accepted file runs a fresh decoder worker; `maxFiles` caps how many files a single drop can enqueue. |
| Missing HEIC/AVIF codec | Explicit server fallback; no format guessing. |
| Unencodable output format | Encode capability is proven with a real 1×1 probe before planning; formats the engine silently substitutes (WebKit returns PNG for `image/webp`) route to server fallback instead of a doomed encode. |
| Page refresh on drop | File drags are intercepted globally; non-file drags are ignored. |

## Default limits

| Route | Formats | Max bytes | Max pixels | Max dimension | Unknown dimensions |
| --- | --- | --- | --- | --- | --- |
| Browser intake | jpeg, png, webp, avif, heic, heif | 32 MB | 33,554,432 (≈ 8K frame) | 8,192 px | fallback |
| Server, browser-normalized | jpeg, png, webp | 16 MB | 16,777,216 | 4,096 px | reject |
| Server, original-fallback | all six input formats | 32 MB | 33,554,432 | 8,192 px | reject |

Both server routes merge defaults with configured policies by ignoring keys
explicitly set to `undefined`, so a partially populated policy object cannot
silently widen a limit back to the library-wide default. The server always
rejects unknown dimensions: it is the last tier and has nowhere to fall back.

Header inspection is a cheap preflight, not a proof that the full file is valid.
A malicious file can lie in its header, and native browser decoders are part of
the attack surface. Worker isolation reduces impact but does not create a browser
sandbox stronger than the browser itself.

The server output verification is deliberately stricter than its input policy:
normalizer output must prove stillness (`animated === false` from the
re-inspected bytes), mirroring the rule that the last tier rejects unknown
dimensions rather than assuming the best.

## Route semantics

- `local`: preflight passed, the browser reports codec support, and isolated
  processing succeeded. The resulting blob still requires server validation.
- `fallback`: the input is policy-eligible, but local capability or processing
  is insufficient. The configured handler owns the server request.
- `reject`: the file violates policy. Rejected active or over-limit content is
  not automatically forwarded to the broad-codec endpoint.

This distinction prevents a permissive fallback service from becoming a bypass
for client-side policy.

## Dependency policy

- Pin security-sensitive runtime dependencies exactly where practical.
- Keep dev-tooling version floors at or above versions with published fixes
  (currently vite ≥ 7.3.5 and vitest ≥ 3.2.6); the lockfile resolves newer.
- Keep the browser core small; codecs should come from the patched browser rather
  than shipping a large native/Wasm codec bundle by default. libwebp
  CVE-2023-4863 (in-the-wild exploited heap overflow, 2023) is the reference
  case: every embedder of an unpatched codec was vulnerable regardless of
  upload validation. CVE-2019-11932 is the companion case from the app side:
  a double-free in a GIF library bundled into WhatsApp (and, per the
  advisory, many other Android apps) fired while merely generating gallery
  previews — preview generation is decode, and every embedder of a bundled
  codec inherits its bugs.
- Treat optional codec packs as separate, lazy-loaded trust domains.
- Generate an SBOM and run dependency plus malicious-fixture tests before release.
- A server decoder must run behind an OS/container boundary; a JavaScript worker
  thread alone is not adequate isolation for native codec failures. The
  reference adapter forks one child process per image and pins sharp 0.35.4
  (libvips 8.18.6, past the CVE-2026-35590 EXIF fix of 8.18.2); bump the pin
  whenever a libvips CVE lands.

Incident research that informed these rules is collected in
[docs/security-research.md](./docs/security-research.md), and the verified
cross-engine behavior in [docs/browser-matrix.md](./docs/browser-matrix.md).

## Reference decoder adapter

[`@optload/sharp-normalizer`](./packages/sharp-normalizer) is the shipped
implementation of the server normalizer contract: one forked child process
per image (SIGKILLed on settle, abort, or deadline), a header re-check before
libvips sees bytes, decode to bounded raw pixels, and re-encode to the
requested output format. It was selected over every practical alternative:
wasm-vips is 2.2–8.3× slower than native sharp (libvips maintainer's figures),
Jimp/squoosh-class tools are far behind, and the ImageMagick family is
disqualified for untrusted input by the delegate-execution class this
project's research documents. libvips has run continuously under OSS-Fuzz
since 2019.

Two honesty rules the adapter encodes:

- The HEIF container claim is not a codec claim. Official prebuilt libvips
  (sharp) parses any HEIF container but decodes only AV1 payloads — HEVC
  pixels need a libvips built with libde265. `probeDecoders()` proves real
  pixel decode in the forked child before you route heic/heif uploads.
- Encoders can silently substitute formats (WebKit's canvas returns PNG for
  `image/webp`). The browser planner probes encode capability with a real
  1×1 encode and routes to the server when the output format cannot be
  encoded, instead of attempting work that cannot succeed.

Keep WebP (the default, lossy) or JPEG as the server output format; a
lossless PNG round-trip preserves pixel-domain stego (obligation 14).

## Status

- Server orchestration and a production decoder adapter are shipped; a
  native decoder still belongs behind a container boundary where the threat
  model demands it (the adapter forks per image; containerize the whole
  service for defense in depth).
- The cross-browser matrix is generated from real Playwright runs
  (`pnpm test:browsers`) and refreshed by CI; engines unavailable on a given
  host are reported, not silently skipped.
- Color handling is pinned: decode applies the source ICC profile
  (`colorSpaceConversion: 'default'`), canvas output is 8-bit sRGB, the sharp
  adapter re-encodes via `toColourspace('srgb')`, and neither route ever
  carries a source ICC profile forward.
- Animated-image preservation is intentionally unsupported.
- Client-side antivirus and content moderation are out of scope.

Do not present any deployment as secure until the server obligations above
are met end to end.

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
   `X-Content-Type-Options: nosniff`, and no user-controlled active content.
9. build the server `FileLike` from the real stream length: `size` is what the
   byte limit checks, and a wrapper that misreports it defeats `maxInputBytes`;
10. honor the `AbortSignal` handed to normalizers so the configured deadline
    stops the actual decode work instead of only failing the request.

## Browser defenses

| Risk | Current behavior |
| --- | --- |
| Forged MIME/extension | Magic-byte detection wins; mismatches are reported. |
| Oversize transfer | `maxInputBytes` rejects before decode. |
| Decompression bombs | Header dimensions/pixels are bounded before decode, and the decoded bitmap's dimensions are re-verified against the same limits after decode. |
| Lying headers | A frame header that understates the real size still meets the post-decode verification; the image routes to server fallback instead of local processing. |
| Decoder hang/crash | Default processing uses a fresh worker with a deadline. |
| Worker contamination | A new worker is created for one image and is terminated. |
| Active SVG | Recognized but rejected by the default bitmap policy. |
| Animation/frame bombs | Animation and more than one frame are rejected when detectable in the inspected prefix; otherwise animation is reported as unknown rather than assumed still. |
| Missing HEIC/AVIF codec | Explicit server fallback; no format guessing. |
| Metadata leakage | Canvas output is newly encoded; source metadata is not copied. |
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
  than shipping a large native/Wasm codec bundle by default.
- Treat optional codec packs as separate, lazy-loaded trust domains.
- Generate an SBOM and run dependency plus malicious-fixture tests before release.
- A server decoder must run behind an OS/container boundary; a JavaScript worker
  thread alone is not adequate isolation for native codec failures.

## Current alpha limitations

- Server orchestration is shipped, but a production native decoder adapter is
  not yet included.
- The cross-browser and mobile memory compatibility matrix is not complete.
- Color-profile behavior depends on browser canvas and encoder implementation.
- Animated-image preservation is intentionally unsupported.
- Client-side antivirus and content moderation are out of scope.

Do not present the alpha as a complete secure upload system until the server
package, fuzz corpus, and supported-browser matrix are in place.

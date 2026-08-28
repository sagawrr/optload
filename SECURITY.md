# Optload security policy

## Supported versions

Security fixes are applied to the latest release line and `main`.

| Version | Supported |
| --- | --- |
| Latest 1.x | Yes |
| Older releases | No |

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/sagawrr/optload/security/advisories/new).
Include the affected package/version, impact, reproduction, and any suggested
mitigation. Do not open a public issue for an undisclosed vulnerability.

## Trust boundary

Everything received from a browser is untrusted, including blobs produced by
Optload and every client-supplied inspection field. Browser processing is a UX,
bandwidth, and privacy optimization; it is not a server security verdict.

A production deployment must:

1. enforce request and decompressed-body byte limits before buffering;
2. construct `FileLike.size` from the real stream length;
3. identify formats from bytes and enforce byte, side, pixel, frame, and
   deadline limits independently on the server;
4. decode in a process/container/service boundary that can be terminated;
5. add OS/container memory, CPU, filesystem, syscall, and egress controls when
   a child process alone is not sufficient for the threat model;
6. re-encode to a fixed output format and structurally re-inspect the result;
7. store only normalized output, using server-generated names;
8. serve it from a separate origin with a fixed `Content-Type`,
   `X-Content-Type-Options: nosniff`, and no user-controlled active content;
9. patch browsers, Sharp/libvips, and codec dependencies promptly; and
10. honor the normalizer `AbortSignal` so a failed request terminates decode
    work rather than merely abandoning its result.

Remote URL intake is intentionally absent. A product that adds it needs a
separate egress-controlled fetcher following the
[OWASP SSRF prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html),
including resolve-once address validation and redirect controls.

## Implemented controls

| Area | Behavior |
| --- | --- |
| Identity | Magic bytes determine format; filename and declared MIME mismatches are warnings. |
| Browser preflight | Reads a 512 KiB prefix by default and enforces input bytes, dimensions, pixels, formats, frames, animation, and optional trailing-data policy. Inconclusive dimension or animation state routes to fallback. |
| Browser decode | Default execution uses a fresh module worker for one image. Decoded dimensions are checked against limits and the inspected declaration before resize. |
| Browser encode | A real 1×1 probe verifies the requested canvas encoder. Returned blob type and nonzero length are checked. |
| Browser fallback | Missing worker/codec/encoder capability, unknown dimensions, timeouts, and local failures invoke only the configured fallback. Policy rejections do not. |
| Drop handling | File drags are handled without intercepting text/link drags; one drop is capped at 20 files by default. |
| Server input | Route-specific policy is reapplied. Accepted inputs within the byte limit receive a full-container structural walk, enabling terminal-marker checks for PNG/JPEG and RIFF-extent checks for WebP. |
| Server orchestration | The normalizer must declare process, container, or external-service isolation. A single deadline covers inspection, policy, normalization, and output checks. |
| Server output | Format, byte size, dimensions, pixels, terminal markers, frame count, and proven stillness are checked again. |
| Runtime configuration | Non-finite, unsafe, or malformed JavaScript values cannot erase stricter server route defaults. An invalid server source value selects the stricter browser-normalized route. |
| Error transport | Decoder reasons crossing a worker/process boundary are converted to plain, truncated strings. |

Header inspection is deliberately a preflight, not a validity proof. It does
not check every container checksum or replace a decoder. Browser workers reduce
lifetime and cross-image state, but they do not strengthen the browser sandbox.

## Default policies

| Route | Formats | Max bytes | Max pixels | Max side | Unknown dimensions/animation | Trailing data |
| --- | --- | ---: | ---: | ---: | --- | --- |
| Browser | JPEG, PNG, WebP, AVIF, HEIC, HEIF | 32 MiB | 33,554,432 | 8,192 | fallback | warn/re-encode |
| Server: browser-normalized | JPEG, PNG, WebP | 16 MiB | 16,777,216 | 4,096 | reject | reject |
| Server: original-fallback | all six inputs | 32 MiB | 33,554,432 | 8,192 | reject | reject |
| Server output | configured JPEG/PNG/WebP | 12 MiB | 16,777,216 | 4,096 | reject | reject |

Server policy objects discard malformed runtime overrides instead of allowing
them to erase a stricter route default. Server input bytes have a hard 64 MiB
ceiling; accepted input can therefore receive a complete structural walk. The
server rejects inconclusive dimensions, animation, or frame count.

## Reference Sharp adapter

`@optload/sharp-normalizer` uses one forked child per image. The child is killed
on success, failure, abort, or its 25-second decode timeout. Inside that child:

- all libvips foreign loaders are blocked, then only JPEG, PNG, WebP, and HEIF
  buffer loaders plus the raw-pixel intermediate are enabled;
- the complete bytes are re-inspected and only JPEG, PNG, WebP, AVIF, HEIC, and
  HEIF are admitted;
- declared dimensions are checked before Sharp receives the bytes;
- Sharp decodes to bounded, EXIF-oriented, 8-bit sRGB raw pixels;
- decoded dimensions are checked again before resize and compared with the
  header declaration;
- only raw pixels cross into the resize/encode stage; and
- output is resized to the configured side and pixel budgets, then encoded
  bytes are capped before they cross IPC back to the parent.

This boundary contains a decoder crash or hang and prevents state reuse between
images. It does not enforce an OS memory or CPU quota. Containerize the service
or use an external sandbox when those controls are required. The
[libvips security checklist](https://github.com/libvips/libvips/blob/master/doc/developer-checklist.md#security)
also recommends enabling only the loaders needed for untrusted data.

HEIF container support is not proof of HEVC pixel decode. `probeDecoders()`
decodes embedded AV1 and HEVC samples in disposable children; route HEIC/HEIF
elsewhere or reject them when the HEVC probe is false.

## Dependency and CVE posture

As reviewed on 2026-08-28:

- the production npm graph has no known advisories under `pnpm audit --prod`;
- Sharp is pinned to 0.35.4 and its prebuilt bundle reports libvips 8.18.6;
- Sharp's reviewed advisory for CVE-2026-33327, CVE-2026-33328,
  CVE-2026-35590, and CVE-2026-35591 affects Sharp `<0.35.0` and is patched in
  `>=0.35.0`: [GHSA-f88m-g3jw-g9cj](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj);
- CI runs a high-severity production audit and emits a CycloneDX inventory that
  includes installed `@img/*` native packages; and
- pnpm applies a 24-hour minimum release age to dependency updates, while the
  lockfile and exact runtime pins make CI installs reproducible.

An audit result is a point-in-time signal, not proof that bundled codecs are
safe. Re-run the audit and review Sharp/libvips advisories before every release.

## Residual risks

- Native image decoders will continue to receive CVEs; isolation and patching
  remain mandatory.
- A custom `ServerImageNormalizer` is trusted to implement the isolation label
  it declares. Optload can reject an invalid label but cannot attest a remote
  service or container boundary.
- `FileLike` is not a streaming enforcement primitive. Upstream request limits
  and accurate lengths are mandatory.
- Re-encoding removes container, appended-data, and metadata channels. It does
  not reliably detect malware encoded in pixels, robust steganography, abusive
  imagery, or policy-sensitive content.
- Antivirus and content moderation are out of scope.

The concise primary-source record behind these controls is in
[docs/security-research.md](./docs/security-research.md).

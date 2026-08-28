# Security evidence

Reviewed 2026-08-28. This is the small set of primary advisories and guidance
that directly informs Optload's controls. The deployment contract is in
[SECURITY.md](../SECURITY.md).

## Evidence mapped to controls

| Evidence | Relevant failure | Control in Optload |
| --- | --- | --- |
| [Sharp/libvips advisory GHSA-f88m-g3jw-g9cj](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj) | Multiple 2026 libvips memory-safety/availability flaws affected Sharp `<0.35.0` when processing untrusted input. | Sharp is pinned to 0.35.4/libvips 8.18.6; CI audits the production graph; decode runs in a disposable child. |
| [Sharp advisory for CVE-2023-4863](https://github.com/lovell/sharp/security/advisories/GHSA-54xq-cgqr-rpm3) | A WebP decoder memory corruption affected every application embedding a vulnerable libwebp. | Treat all image codecs, including the default output codec, as an attack surface; patch and isolate instead of assuming a “safe” format. |
| [libvips security checklist](https://github.com/libvips/libvips/blob/master/doc/developer-checklist.md#security) | General-purpose builds expose loaders an image service may not need. | The Sharp child blocks all foreign loaders and enables only JPEG/PNG/WebP/HEIF buffer loaders plus its raw intermediate. |
| [GitLab response to CVE-2021-22205](https://about.gitlab.com/blog/action-needed-in-response-to-cve2021-22205/) | An image path invoked ExifTool and became pre-authenticated remote code execution; exploitation was observed. | Core inspection uses a small bounds-checked byte walker. It does not invoke general-purpose EXIF tooling. |
| [ImageTragick disclosure](https://imagetragick.com/) | ImageMagick delegate and pseudo-protocol behavior enabled command execution, file operations, and SSRF. | No URL-fetch feature; normalizers must cross a declared isolation boundary; the reference adapter consumes bytes and allowlists loaders. |
| [Cloudflare's aCropalypse response](https://blog.cloudflare.com/how-cloudflare-images-addressed-the-acropalypse-vulnerability/) | Editors left recoverable original data after the logical end of a rewritten PNG. | PNG IEND, JPEG EOI, and WebP RIFF extents are tracked. Server inputs/outputs within byte policy receive a full structural walk and reject detected trailing bytes. |
| [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) | Extension/MIME spoofing, parser exploits, oversized files, public retrieval, and overwrite risks compound. | Byte-based format detection, layered limits, server-generated output, re-encode, separate serving origin, and defense in depth. |
| [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) | A remote-import feature can turn an image service into an internal-network fetcher. | URL intake is absent. Any product-specific fetcher is explicitly outside the normalizer and requires egress/address/redirect controls. |

## Derived engineering rules

1. Header checks reject cheap violations early; decoded dimensions remain the
   authority and are checked before resize.
2. A worker or child process is a lifetime/crash boundary, not proof that a
   decoder is safe and not a substitute for an OS resource sandbox.
3. The server never trusts browser inspection or output. It uses route-specific
   policy and verifies normalized structure again.
4. Terminal-marker checks protect against appended container data. Re-encoding
   is still required because many polyglots live inside otherwise valid input.
5. Metadata is both private data and parser attack surface. The reference path
   carries only decoded pixels into its encoder.
6. Capability tables are not codec proofs. HEVC-backed HEIC/HEIF support is
   established with real pixel-decode probes in disposable children.
7. Dependency scans are time-bound signals. Exact decoder pins, native-package
   inventory, advisory review, and timely upgrades are all required.

## Explicit non-claims

Optload does not claim that re-encoding detects malware, robust steganography,
or harmful visual content. It does not attest custom containers or external
normalizer services. These remain deployment responsibilities, as do request
stream limits and accurate `FileLike` lengths.

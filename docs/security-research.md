# Security research notes — how big-industry incidents map onto optload

Compiled 2026-08-27. This document records the real-world incidents and
attacker techniques that informed the current hardening pass, and what each
one changed (or re-affirmed) in this repository. It complements
[SECURITY.md](../SECURITY.md), which states the trust model and obligations.

**Verification status.** Research passed in three waves. The first two ran
into environment limits (agent content filters on the WeChat topics, then a
hard usage limit, plus a rate-limited web-search quota). A third pass, using
web search against primary sources, closed the gap: every incident below is
now **[verified]** — official CVE records via the CVE Services API, NVD and
GitHub advisory records, vendor advisories and blogs, Citizen Lab reports,
vendor threat research, or fetched advisory pages. The third pass also
produced corrections: the WeChat MMTLS analysis was published in 2024, not
2023; a recalled "WeChat for Mac privileged-helper link following" advisory
could not be found on ZDI despite targeted searching and has been replaced
by the adjacent advisory that does exist; and the WhatsApp GIF bug an early
note could not pin down is CVE-2019-11932, now fully cited. Where an
identifier could not be verified (one campaign name from earlier notes,
"PureRAT"), it is deliberately left out rather than guessed.

---

## 1. Incidents and what they teach an image-intake pipeline

### Parser memory safety in the media path (the RCE class)

| Incident | What happened | Lesson applied here |
| --- | --- | --- |
| WhatsApp VOIP stack overflow, CVE-2019-3568 **[verified]** | Heap buffer overflow (CWE-122, CVSS 9.8, CISA KEV "actively exploited") in WhatsApp's VOIP stack; a crafted RTCP packet sequence to a phone number delivered NSO Pegasus zero-click (May 2019). Fixed by patching every client platform at once. | Any byte path that touches attacker data is a code-execution surface, including "just headers" and "just a preview". Decode must run isolated with a deadline; assume the codec will eventually have a bug like this. |
| WhatsApp bundled GIF library double-free, CVE-2019-11932 **[verified]** | Double free (CWE-415, CVSS 8.8, EPSS ~44.5%, 99th percentile) in `DDGifSlurp` in the android-gif-drawable library < 1.2.18, embedded in WhatsApp for Android (< 2.19.244) and, per the advisory, "many other Android applications". The malicious GIF arrived as a Document (auto-downloaded when the sender was a contact) and detonated when the victim merely opened the Gallery, because *preview generation runs the native decoder*. Fixed in both the app and the upstream library. | Preview/thumbnail generation **is** decode of attacker bytes, so it gets the same worker/process isolation and deadline as any decode. A codec bundled inside a product makes every embedder inherit its bugs — the same patch-everywhere failure mode as libwebp below. The exploit also depended on a send path that skipped transcoding, which is exactly why the server never trusts the client's claimed type or channel. |
| WeChat in-house emoji decoder DoS, CVE-2019-11419 **[verified]** | A crafted `.wxgf` emoji file swapped into WeChat's world-writable `/sdcard/tencent/MicroMsg/.../emoji` store crashed the proprietary decoder (`vcodec2_hls_filter` in `libvoipCodec_v7a.so`) the moment any chat containing the emoji was rendered. Tencent declined to fix it as "not critical". | A custom in-house codec receives none of the external scrutiny that libpng/libjpeg-turbo/libwebp get — treat it as *more* dangerous, not less. A "not critical" crash is still proof that the decode path consumes attacker-shaped bytes without bounds discipline. For server integrators: any directory a decoder reads from (caches, temp files, emoji stores) must not be writable by a less-privileged party. |
| libwebp Huffman-table overflow, CVE-2023-4863 **[verified]** | Heap overflow in WebP lossless `BuildHuffmanTable`, exploited in the wild (Google TAG); forced an ecosystem-wide scramble across Chrome, Safari, Electron apps, and every libwebp embedder — messengers included. Initially misattributed to Apple ImageIO. | This is the canonical argument for (a) worker/process isolation around decode, (b) never shipping a stale bundled codec, and (c) treating WebP — our default output — as exactly as dangerous as any other codec. Our browser core deliberately relies on the patched browser rather than bundling a Wasm codec. |
| ImageMagick delegate execution, ImageTragick CVE-2016-3714…3718 **[verified]** | One root cause — delegates invoked via shell with unfiltered input names — produced RCE, file delete/move/read, and SSRF from image "processing". Renaming an MVG file to `.jpg` was enough because of content sniffing. | Never hand untrusted images to a general-purpose processing tool on the intake path. Our server package takes integrator-supplied normalizers but demands a real process/container boundary and re-inspects what they return. |
| ImageMagick PNG `tEXt` file read, CVE-2022-44267/44268 **[verified]** | A PNG metadata chunk with keyword `profile` made ImageMagick treat the chunk value as a filename and embed that file's contents into the output — arbitrary file read through pure metadata. | Metadata is not inert. We parse only the bytes we need (dimensions, orientation, animation flags) with our own bounds-checked walker and never run EXIF tooling on untrusted input. |
| ExifTool DjVu RCE, CVE-2021-22204 (and GitLab CVE-2021-22205) **[verified]** | Code execution at *metadata parse time* via a DjVu block inside a JPEG/PNG — before any decode. Mass-scanned in the wild against unpatched GitLab. | Same rule from the other side: "we only read the tags" is still code execution if the tag reader is exploitable. Our inspection reads a bounded prefix with index checks, not a metadata library. |

### Truncated-overwrite leaks and appended data

| Incident | What happened | Lesson applied here |
| --- | --- | --- |
| aCropalypse, CVE-2023-21036 and CVE-2023-28303 **[verified]** | Android's Markup screenshot editor (CVE-2023-21036) and — independently, in an unrelated codebase — Windows Snip & Sketch (CVE-2023-28303, MSRC-confirmed) rewrote cropped images **without truncation** ("w" vs "wt" open mode), leaving the original pixels recoverable *after the new PNG IEND*. Victims' redactions were undone. Verified platform responses: Cloudflare Images published its mitigation — once an end-of-image marker is consumed, the entire input must be consumed, or the upload is not clean — and Discord's CDN began stripping PNG trailing data in-flight (tracked by the public AntiCropalypse checker), protecting even old uploads. | Bytes past a terminal marker are both a privacy channel and a polyglot channel. We now detect trailing data past PNG IEND, JPEG EOI, and the declared WebP RIFF extent; the server tiers reject it by default (`rejectTrailingData`), and local re-encoding drops it. Re-encode must fully replace, never overwrite in place. Two independent codebases shipping the same truncation bug is the argument for making the check structural (in the intake library) rather than per-product. |

### Polyglots and interpretation disagreement

GIFAR (2008), Stegosploit IMAJS (2015), and the corkami polyglot corpus
**[verified]** demonstrate one byte stream parsing validly under two grammars —
typically a genuine image with a second format (ZIP, HTML/JS) appended or
woven into comment/metadata segments. This defeats every check that asks
"are you an image?" while the serving path asks a different question.

Defenses that actually work: **one interpretation, chosen by the defender** —
full decode-and-re-encode (the stored bytes are only pixels we produced),
`Content-Type` derived from the re-encoded format,
`X-Content-Type-Options: nosniff`, a separate serving origin, and
server-generated names. These are standing obligations in SECURITY.md; the
trailing-data rejection added this pass closes the "append after EOI/IEND"
construction inside the library itself.

### Decompression and decode-cost bombs

- Pillow's `MAX_IMAGE_PIXELS` model **[verified]** (warn tier + hard tier,
  evaluated from the header *before* decode) is the industry-standard shape:
  cap total pixels and per-side dimensions pre-decode, then re-verify the
  decoded bitmap. That is exactly our two-tier design, and this pass added
  the missing honesty check: decoded dimensions that *differ from* (not just
  exceed) the header declaration now fail closed to the server route
  (`DECODED_DIMENSION_MISMATCH`).
- A single PNG zlib stream is capped near ~1032:1, so honest threat-model
  math keys on **decoded output size**, not compression ratio: cap w×h and
  per-side, and budget w×h×4 bytes before allocation. **[verified]**
- "Slow decode" (pathological progressive scans, Huffman tables) is a CPU
  DoS distinct from memory bombs: our worker deadline plus server-side
  `AbortSignal`-aware normalizers address it.

### Metadata privacy

EXIF from phone cameras carries GPS and device identifiers; OSINT workflows
are built on it. The metadata-processing CVEs above show the dual risk:
metadata is both a privacy leak *and* an exploitation surface. Our answer:
local output is re-encoded (metadata never copied forward), and inspection
now reports `metadata_present` (EXIF/XMP/ICC/text in JPEG, PNG, WebP, and
HEIC containers) so integrators can warn when the **server fallback route**
is about to ship an original file with its metadata intact.

### SSRF through "fetch this for me" features

The FFmpeg HLS playlist PoC (server-side video processing fetching attacker
URLs incl. `file://` and cloud metadata) **[verified]**, ImageTragick's URL
coder, and the Capital One breach (SSRF to EC2 instance metadata, 100M+
records) **[verified]** define the rule: no intake path may dereference
user-supplied URLs. Optload has no URL-fetch feature and SECURITY.md now
states the obligation explicitly, including the resolve-once / pin-IP /
reject-private / no-redirects regime for any future remote-import feature.

### Steganographic C2 over image hosts

Verified campaigns now span a full decade, with named tooling and primary
reports. **Stegoloader** (Dell SecureWorks CTU, June 2015) pulled its
deployment module from a PNG hosted on a legitimate image host. **Worok**
(ESET, "Worok: the big picture", September 2022, with an Avast follow-up)
runs a .NET loader ("PNGLoad") that extracts a PowerShell payload from PNG
**pixels** — ESET notes it reads pixel data only, never file metadata, so it
survives defenses that merely strip metadata. **APT28** in 2025 (Sekoia's
"Operation Phantom Net Voxel" — BeardShell decoding shellcode from LSBs of
`windows.png` — and ExaTrack's 2024–2026 PixyNetLoader tracking, extracting
shellcode from a companion `SplashScreen.png` behind COM persistence) does
the same at state-actor quality. **OilRig** (2025 reporting, with Unit42
documenting a sibling email-based stego C2) hid C2 configuration via LSB in
a PNG served from Google Drive. **Caminho** (Arctic Wolf, 2025) is a
Brazilian loader-as-a-service pairing LSB stego with fileless delivery. All
of them abuse legitimate image hosting as trusted, CDN-cached payload
transport: the file is a genuinely valid image, so every content check
passes.

The structural counter remains **never store or serve original upload
bytes** — with one precision added this pass: for *pixel-domain* stego the
re-encode must be lossy or geometry-changing. A lossless PNG→PNG round-trip
preserves pixel LSBs exactly, and Worok's loader deliberately counts on
metadata-only defenses. Optload's durable path qualifies by default — both
server routes re-encode through the normalizer as lossy WebP at quality
0.88 — while the browser route's local output (WebP 0.84 for opaque images,
lossless PNG when alpha is preserved) is ephemeral and still subject to
server re-normalization. An integrator who configures `png` as the server
output format opts into keeping the pixel channel and owns that residual
risk. Appended-data and metadata channels are dropped by any honest
re-encode regardless of codec.

### Platform-adjacent incidents (verified)

- **Twitter, July 2020 [verified]**: attackers social-engineered employees
  into internal admin tools and posted from 130 high-profile accounts. Lesson
  for us: the pipeline's *operational* surface (who can view/reprocess
  uploads) is part of the threat model; least privilege applies to internal
  tooling around any intake service.
- **Twitter Circle disclosure, July 2023 [verified]**: Twitter notified
  users that posts shared to their Circle may have been seen by individuals
  outside it; the underlying API bug had been fixed in January 2023, and the
  company stated it found no evidence of exploitation (SecurityWeek covered
  the notification). A boundary failure between "restricted audience" and
  "processing surface". Our analog: rejected or policy-eligible files must
  not leak through the fallback route's telemetry or logs.
- **Twitter plaintext-password logging, 2018 [verified]**: a bug wrote
  unmasked passwords to an internal log before the hashing step completed;
  ~330 million users were told to change their passwords (Krebs on Security,
  May 2018; the company said it found no evidence of breach or misuse). Our
  worker protocol already truncates and sanitizes error reasons
  (`safeReason`); keep every log line content-free by default.
- **WeChat image handling [verified]**: Citizen Lab's "We Chat, They Watch"
  (May 2020) showed that images and documents shared between *non-China*
  accounts undergo MD5 file-hash surveillance against an index of sensitive
  hashes plus perceptual content surveillance, and that flagged content
  feeds the censorship database applied to China accounts — proven by
  crafting MD5-colliding benign/sensitive image pairs. Engineering takeaways:
  exact-hash matching is trivially brittle (transit transcoding alone changes
  bytes — which is exactly why re-encoding is a privacy *feature*), and
  client-side enforcement is not a verdict — the same principle as our
  "browser output is still attacker-controlled input" rule.
- **WeChat transport crypto [verified, date corrected]**: Citizen Lab's
  "Should We Chat, Too?" (published October 2024, after an April 2024
  disclosure and a May 2024 Tencent response; the 2023 report, "Should We
  Chat?", was the ecosystem privacy study) analyzed MMTLS: a modified TLS
  1.3 whose changes introduce weaknesses (deterministic IVs, no forward
  secrecy on the observed paths) layered above a still-used legacy
  "business-layer" cipher. Lesson: transport security is not a content
  verdict — obligations attach to what bytes do at decode and at rest,
  independent of how securely they traveled.
- **WeChat for Mac privileged helper [claim withdrawn, adjacent advisory
  verified]**: the earlier class-level claim — a ZDI-disclosed WeChat helper
  following symlinks through user-writable paths — could not be found on
  ZDI despite targeted searching, so it is withdrawn rather than kept as
  folklore. What is verifiable in that space: ZDI-22-1066 / CVE-2022-26696
  (CVSS 7.8), an Apple macOS LaunchServices sandbox escape where a crafted
  XPC message triggers a privileged operation; reported 2021-12-22 and fixed
  in macOS 12.4, credited to macOS app-security researcher Wojciech Regula.
  The operational lesson stands on the verified advisory alone: privileged
  helpers and IPC-reachable privileged operations exposed to an app context
  are real escalation surface. For server integrators: temp files,
  caches, and extracted outputs must live in paths unprivileged writers
  cannot plant symlinks into; write with O_NOFOLLOW-style semantics and
  truncate-on-write.

---

## 2. Changes made in this hardening pass

| # | Change | Where |
| --- | --- | --- |
| 1 | JPEG multi-SOF honesty: all SOF markers in the inspected prefix are evaluated; the largest drives policy; conflicts warn (`inconsistent_dimensions`). | `packages/core/src/detect.ts` |
| 2 | Trailing-data detection past PNG IEND, JPEG EOI, and the declared WebP RIFF extent: `trailingData` on the inspection, `trailing_data` warning, and a `rejectTrailingData` policy knob (default **on** for both server input routes and server output verification). | core detect/policy/errors, `packages/server/src/server.ts` |
| 3 | Metadata-presence signal (`metadata_present`) for EXIF/XMP/ICC/text chunks in JPEG, PNG (eXIf/tEXt/zTXt/iTXt), WebP (EXIF/XMP), and BMFF (HEIC/AVIF Exif box). | `packages/core/src/detect.ts` |
| 4 | Decoded-vs-declared dimension verification after decode (orientation-aware); mismatches fail closed to the server route instead of producing output from a lying header. | `packages/browser/src/processor.ts` |
| 5 | Server output must prove stillness: `animated === false` from the re-inspected bytes, mirroring the reject-unknown-dimensions rule. | `packages/server/src/server.ts` |
| 6 | GIF frame counting skips the global color table (palette bytes are not frame separators). | `packages/core/src/detect.ts` |
| 7 | Drop-flood guard: optional `maxFiles` cap on how many files one drop can enqueue. | `packages/browser/src/drop.ts`, `types.ts` |
| 8 | PNG chunk walk continues past IDAT to IEND (needed for 2/3 and honest APNG verdicts). | `packages/core/src/detect.ts` |

Regression tests for every vector live in `tests/security-repro.test.ts`
(V6–V12) and the detector unit tests.

## 3. Standing integrator obligations (re-affirmed and extended)

1. Serve re-encoded media only, from a separate origin, fixed safe
   `Content-Type` from the output format, `nosniff`, server-generated names.
2. Never store or expose original upload bytes (stego-C2 and polyglot rule).
3. No URL-fetch intake; if a product needs it, apply the OWASP SSRF
   prevention set in the isolated fetcher.
4. Never run general-purpose metadata/EXIF tooling on untrusted input
   (CVE-2021-22204 / CVE-2022-44268 class).
5. Decode server-side in a real process/container boundary with byte, pixel,
   and wall-clock budgets; honor the `AbortSignal` handed to normalizers.
6. Keep logging content-free; error strings are truncated and sanitized, and
   filenames must never be rendered unescaped anywhere.

## 4. Sources verified this session

- CVE Services records: CVE-2019-3568, CVE-2023-4863, CVE-2023-5217,
  CVE-2022-44267, CVE-2022-44268, CVE-2021-22204, CVE-2020-13790,
  CVE-2023-21036 — https://cveawg.mitre.org/api/cve/<ID>
- Wikipedia: 2020 Twitter account hijacking;
  aCropalypse; billion laughs; zip bomb.
- ZDI published-advisory index — https://www.zerodayinitiative.com/advisories/published/
- OWASP Unrestricted File Upload; OWASP SSRF Prevention Cheat Sheet.
- PortSwigger Web Security Academy: file upload vulnerabilities; web cache
  deception.
- ImageTragick disclosure — https://imagetragick.com/
- FFmpeg HLS SSRF PoC — https://github.com/neex/ffmpeg-avi-m3u-xbin
- Snyk Zip Slip — https://github.com/snyk/zip-slip
- MDN `X-Content-Type-Options`; Pillow `Image.MAX_IMAGE_PIXELS` docs;
  libpng CHANGES (CVE history); corkami/pics polyglot corpus.
- Stego-C2 primaries (third research pass): Dell SecureWorks CTU,
  "Stegoloader: A Stealthy Information Stealer" (June 2015); ESET
  WeLiveSecurity, "Worok: the big picture" (Sept 2022), plus Avast's
  decoded.avast.io PNG-steganography follow-up; Sekoia, "APT28 Operation
  Phantom Net Voxel" (2025); ExaTrack, "Tracking APT28 PixyNetLoader:
  Evolutions from 2024 to 2026"; 2025 OilRig Google-Drive LSB C2-config
  reporting and Unit42's OilRig stego-C2 analysis; Arctic Wolf, "Brazilian
  Caminho Loader Employs LSB Steganography..." (2025).
- NVD record and GitHub advisory GHSA-x534-j49x-mqvj for CVE-2019-11932
  (CVSS 3.1 8.8, CWE-415, EPSS 44.53%), plus the discoverer's full exploit
  walkthrough — awakened1712.github.io/hacking/hacking-whatsapp-gif-rce
  (trigger via Gallery preview; android-gif-drawable 1.2.18 fix).
- Awakened, "DoS WeChat with an emoji" (CVE-2019-11419) —
  awakened1712.github.io/hacking/hacking-wechat-dos (proprietary WXGF
  decoder, world-writable emoji store, vendor declined fix).
- Citizen Lab primaries: "We Chat, They Watch" (May 2020) —
  citizenlab.ca/research/we-chat-they-watch/; "Should We Chat? Privacy in
  the WeChat Ecosystem" (2023); "Should We Chat, Too? Security Analysis of
  WeChat's MMTLS Encryption Protocol" (Oct 2024).
- Krebs on Security, "Twitter to All Users: Change Your Password Now!"
  (May 2018); SecurityWeek, "Private Tweets Exposed Due to Twitter Circle
  Security Bug" (July 2023).
- Cloudflare, "How Cloudflare Images addressed the aCropalypse
  vulnerability" — blog.cloudflare.com; MSRC record for CVE-2023-28303
  (Windows Snip & Sketch); the AntiCropalypse checker
  (anticropalypse.qixils.dev) documenting Discord CDN trailing-data
  stripping; ZDI-22-1066 / CVE-2022-26696 (Apple LaunchServices sandbox
  escape, macOS 12.4 fix).

After the third pass no class-level items remain. The two deliberate
omissions are recorded rather than guessed: the withdrawn "WeChat for Mac
helper link-following" claim (replaced by ZDI-22-1066 above) and the
"PureRAT" campaign name from earlier notes (no primary located this
session).

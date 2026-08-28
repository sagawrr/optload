# Cross-browser matrix

Generated 2026-08-28 by `pnpm test:browsers` (Playwright driving the real
package through its published exports in a Vite-served page). Every row
below is an actual run, not a vendor claim.

## Environment

| Engine | User agent | Notes |
| --- | --- | --- |
| chromium | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.7922.34 Safari/537.36` | ran |
| firefox | `Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0` | ran |
| webkit | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15` | ran |

## Decode capability (createImageBitmap on real bytes)

| Engine | jpeg | png | webp | heic | worker | offscreen |
| --- | --- | --- | --- | --- | --- | --- |
| chromium | 800x600 | 128x128 | 640x480 | no | true | true |
| firefox | 800x600 | 128x128 | 640x480 | no | true | true |
| webkit | 800x600 | 128x128 | 640x480 | no | true | true |

## Pipeline scenarios

| Engine | local JPEG (EXIF stripped, worker) | local PNG alpha | trailing data dropped | HEIC routes honestly | SVG rejected | unknown bytes identified |
| --- | --- | --- | --- | --- | --- | --- |
| chromium | pass | pass | pass | pass | pass | pass |
| firefox | pass | pass | pass | pass | pass | pass |
| webkit | pass | pass | pass | pass | pass | pass |

## Notes

- HEIC: engines without a native HEIC decoder must surface
  `SERVER_FALLBACK_REQUIRED`; engines that decode it natively may finish
  locally. Both are honest outcomes; silent success or silent failure is
  a bug.
- EXIF GPS/device metadata is reported (`metadata_present`) on the source
  inspection and never copied into re-encoded output.
- All local processing runs in a fresh module worker that is terminated
  after one image.
- Color handling: decode applies the source ICC profile via
  `colorSpaceConversion: 'default'`; canvas output is 8-bit sRGB and never
  carries a source ICC profile.

# @optload/browser

Effect-native browser image inspection, policy, worker normalization, and
explicit server fallback.

```ts
import { createImageIntake } from "@optload/browser"

const images = createImageIntake({
  output: { format: "webp", maxWidth: 2048, maxHeight: 2048 },
  fallback: ({ file }) => uploadOriginalToYourServer(file),
})

const result = await images.processPromise(file, { signal })
```

The fallback function returns an `Effect`; the Promise API is an adapter over the
same pipeline. Browser output remains untrusted and must be validated by the
receiving server. See the repository `README.md` and `SECURITY.md` for the full
contract.

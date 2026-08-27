# @optload/browser

Effect-powered browser image inspection, policy, worker normalization, and
explicit server fallback. The default API is Promise-first.

```ts
import { createImageIntake } from "@optload/browser"

const images = createImageIntake({
  output: { format: "webp", maxWidth: 2048, maxHeight: 2048 },
  fallback: async ({ file, signal }) =>
    uploadOriginalToYourServer(file, { signal }),
})

const result = await images.process(file, { signal })
```

Effect users import the native API from `@optload/browser/effect`; its factory
and method names are identical, while callbacks and results remain composable
Effects. Both entry points run the same Effect-native engine.

Browser output remains untrusted and must be validated by the receiving server.
See the repository `README.md` and `SECURITY.md` for the full contract.

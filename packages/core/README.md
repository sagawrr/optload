# @optload/core

Bounded image-header inspection, upload policy, and tagged Effect errors for
Optload. Identification is byte-based: filenames and declared MIME types are
never trusted, only reported when they disagree with the bytes.

The default API is Effect-first; `runEffectPromise` bridges to Promises for
consumers that do not use Effect.

See the [repository README](https://github.com/sagawrr/optload#readme) for the
intake pipeline and the
[security policy](https://github.com/sagawrr/optload/blob/main/SECURITY.md) for
the trust model.

import { runEffectPromise, type FileLike } from '@optload/core';
import { Effect } from 'effect';
import { createServerImageIntakeEffect } from './server.js';
import type {
  ServerImageIntake,
  ServerImageIntakeOptions,
} from './types.js';

/** Promise-first server boundary backed by the Effect-native orchestrator. */
export function createServerImageIntake<Output extends FileLike>(
  config: ServerImageIntakeOptions<Output>,
): ServerImageIntake<Output> {
  const { normalizer, ...shared } = config;
  const effectIntake = createServerImageIntakeEffect<Output, unknown>({
    ...shared,
    normalizer: {
      isolation: normalizer.isolation,
      normalize: (request) =>
        Effect.tryPromise({
          try: (signal) =>
            Promise.resolve(normalizer.normalize({ ...request, signal })),
          catch: (cause) => cause,
        }),
    },
  });

  return {
    process: (input, options = {}) => {
      const { signal, ...effectOptions } = options;
      return runEffectPromise(effectIntake.process(input, effectOptions), {
        signal,
      });
    },
  };
}

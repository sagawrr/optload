import { runEffectPromise } from '@optload/core';
import { Effect } from 'effect';
import { attachDropTarget } from './drop.js';
import { createImageIntakeEffect } from './intake.js';
import type {
  ImageFallbackRequest,
  ImageIntake,
  ImageIntakeOptions,
} from './types.js';

/** Promise-first public boundary backed by the Effect-native intake engine. */
export function createImageIntake<FallbackValue = never>(
  config: ImageIntakeOptions<FallbackValue> = {},
): ImageIntake<FallbackValue> {
  const { fallback, ...shared } = config;
  const effectIntake = createImageIntakeEffect<FallbackValue, unknown>({
    ...shared,
    fallback: fallback
      ? (request) => promiseFallback(fallback, request)
      : undefined,
  });

  const intake: ImageIntake<FallbackValue> = {
    inspect: (file, options = {}) =>
      runEffectPromise(effectIntake.inspect(file), { signal: options.signal }),
    plan: (file, options = {}) => {
      const { signal, ...effectOptions } = options;
      return runEffectPromise(effectIntake.plan(file, effectOptions), { signal });
    },
    process: (file, options = {}) => {
      const { signal, ...effectOptions } = options;
      return runEffectPromise(effectIntake.process(file, effectOptions), { signal });
    },
    attachDropTarget: (target, options) =>
      attachDropTarget(intake, target, options),
  };

  return intake;
}

function promiseFallback<Value>(
  fallback: NonNullable<ImageIntakeOptions<Value>['fallback']>,
  request: ImageFallbackRequest,
): Effect.Effect<Value, unknown> {
  return Effect.tryPromise({
    try: (signal) => Promise.resolve(fallback({ ...request, signal })),
    catch: (cause) => cause,
  });
}

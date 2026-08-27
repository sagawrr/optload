import {
  ProcessingTimeoutError,
  enforceImagePolicy,
  inspectImage,
  runEffectPromise,
  type FileLike,
  type ImagePolicy,
} from '@optload/core';
import { Duration, Effect } from 'effect';
import {
  OutputDimensionExceededError,
  UnsafeNormalizerError,
} from './errors.js';
import type {
  NormalizerIsolation,
  ProcessServerImageOptions,
  ResolvedServerOutputOptions,
  ServerImageIntake,
  ServerImageIntakeOptions,
  ServerImageResult,
  ServerOutputFormat,
  ServerOutputOptions,
} from './types.js';

const mediaTypes: Readonly<Record<ServerOutputFormat, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const hardMaxOutputDimension = 32_768;
const defaultBrowserInputPolicy: ImagePolicy = {
  allowedFormats: ['jpeg', 'png', 'webp'],
  maxInputBytes: 16 * 1024 * 1024,
  maxSourcePixels: 16_777_216,
  maxSourceDimension: 4096,
  maxFrames: 1,
  allowAnimation: false,
  unknownDimensions: 'reject',
};

const allowedIsolation = new Set<NormalizerIsolation>([
  'process',
  'container',
  'external-service',
]);

export function createServerImageIntake<
  Output extends FileLike,
  NormalizerError = never,
>(
  config: ServerImageIntakeOptions<Output, NormalizerError>,
): ServerImageIntake<Output, NormalizerError> {
  const output = resolveServerOutputOptions(config.output);
  const timeoutMs = positiveInteger(config.timeoutMs, 30_000);

  const process = (
    input: FileLike,
    options: Omit<ProcessServerImageOptions, 'signal'> = {},
  ) =>
    Effect.gen(function* () {
      const startedAt = performanceNow();
      const source = options.source ?? 'browser-normalized';
      const inputInspection = yield* inspectImage(input);
      yield* enforceImagePolicy(
        inputInspection,
        inputPolicyFor(source, config),
      );

      const isolation = config.normalizer.isolation;
      if (!allowedIsolation.has(isolation)) {
        return yield* Effect.fail(new UnsafeNormalizerError({ isolation }));
      }

      const normalized = yield* config.normalizer
        .normalize({
          input,
          source,
          inspection: inputInspection,
          output,
        })
        .pipe(
          Effect.timeoutFail({
            duration: Duration.millis(timeoutMs),
            onTimeout: () => new ProcessingTimeoutError({ timeoutMs }),
          }),
        );

      const outputInspection = yield* inspectImage(normalized);
      yield* enforceImagePolicy(outputInspection, outputPolicy(output));
      if (
        outputInspection.width !== null &&
        outputInspection.height !== null &&
        (outputInspection.width > output.maxWidth ||
          outputInspection.height > output.maxHeight)
      ) {
        return yield* Effect.fail(
          new OutputDimensionExceededError({
            width: outputInspection.width,
            height: outputInspection.height,
            maxWidth: output.maxWidth,
            maxHeight: output.maxHeight,
          }),
        );
      }

      return {
        output: normalized,
        source,
        inputInspection,
        outputInspection,
        isolation,
        durationMs: performanceNow() - startedAt,
      } satisfies ServerImageResult<Output>;
    });

  return {
    process,
    processPromise: (input, options = {}) =>
      runEffectPromise(process(input, options), { signal: options.signal }),
  };
}

export function resolveServerOutputOptions(
  options: ServerOutputOptions = {},
): ResolvedServerOutputOptions {
  const format = options.format ?? 'webp';
  return {
    format,
    mediaType: mediaTypes[format],
    maxWidth: positiveDimension(options.maxWidth, 4096),
    maxHeight: positiveDimension(options.maxHeight, 4096),
    maxOutputPixels: positiveInteger(options.maxOutputPixels, 16_777_216),
    maxOutputBytes: positiveInteger(options.maxOutputBytes, 12 * 1024 * 1024),
    quality: finiteClamp(options.quality, 0.88, 0, 1),
  };
}

function outputPolicy(output: ResolvedServerOutputOptions): ImagePolicy {
  return {
    allowedFormats: [output.format],
    maxInputBytes: output.maxOutputBytes,
    maxSourcePixels: output.maxOutputPixels,
    maxSourceDimension: Math.max(output.maxWidth, output.maxHeight),
    maxFrames: 1,
    allowAnimation: false,
    unknownDimensions: 'reject',
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function positiveDimension(value: number | undefined, fallback: number): number {
  return Math.min(hardMaxOutputDimension, positiveInteger(value, fallback));
}

function finiteClamp(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function inputPolicyFor<Output extends FileLike, Error>(
  source: import('./types.js').ServerImageSource,
  config: ServerImageIntakeOptions<Output, Error>,
): ImagePolicy {
  return source === 'browser-normalized'
    ? {
        ...defaultBrowserInputPolicy,
        ...config.inputPolicy,
        ...config.browserInputPolicy,
      }
    : {
        ...config.inputPolicy,
        ...config.fallbackInputPolicy,
      };
}

function performanceNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

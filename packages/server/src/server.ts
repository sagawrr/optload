import {
  ProcessingTimeoutError,
  enforceImagePolicy,
  inspectImage,
  resolveImagePolicy,
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
  ServerImageResult,
  ServerOutputFormat,
  ServerOutputOptions,
} from './types.js';
import type {
  EffectServerImageIntake,
  EffectServerImageIntakeOptions,
} from './effect-types.js';

const mediaTypes: Readonly<Record<ServerOutputFormat, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const hardMaxOutputDimension = 32_768;
const hardMaxOutputPixels = 67_108_864;
const hardMaxOutputBytes = 64 * 1024 * 1024;
const hardMaxInputBytes = 64 * 1024 * 1024;
const hardMaxTimeoutMs = 300_000;
const defaultBrowserInputPolicy: ImagePolicy = {
  allowedFormats: ['jpeg', 'png', 'webp'],
  maxInputBytes: 16 * 1024 * 1024,
  maxSourcePixels: 16_777_216,
  maxSourceDimension: 4096,
  maxFrames: 1,
  allowAnimation: false,
  unknownAnimation: 'reject',
  unknownDimensions: 'reject',
  // The server tier persists bytes, and appended bytes past a container's
  // terminal marker survive storage verbatim: polyglot payloads and
  // truncated-overwrite leaks live there.
  rejectTrailingData: true,
  requireCompleteContainer: true,
};

/**
 * The original-fallback route accepts broader codecs (HEIC/HEIF/AVIF cameras)
 * but is the broad-codec endpoint of the system: its defaults must never be
 * looser than the limits a browser-normalized upload already passed.
 */
const defaultFallbackInputPolicy: ImagePolicy = {
  allowedFormats: ['jpeg', 'png', 'webp', 'avif', 'heic', 'heif'],
  maxInputBytes: 32 * 1024 * 1024,
  maxSourcePixels: 33_554_432,
  maxSourceDimension: 8192,
  maxFrames: 1,
  allowAnimation: false,
  unknownAnimation: 'reject',
  unknownDimensions: 'reject',
  rejectTrailingData: true,
  requireCompleteContainer: true,
};

const allowedIsolation = new Set<NormalizerIsolation>([
  'process',
  'container',
  'external-service',
]);

export function createServerImageIntakeEffect<
  Output extends FileLike,
  NormalizerError = never,
>(
  config: EffectServerImageIntakeOptions<Output, NormalizerError>,
): EffectServerImageIntake<Output, NormalizerError> {
  const output = resolveServerOutputOptions(config.output);
  const timeoutMs = boundedPositiveInteger(
    config.timeoutMs,
    30_000,
    hardMaxTimeoutMs,
  );

  const process = (
    input: FileLike,
    options: Omit<ProcessServerImageOptions, 'signal'> = {},
  ) =>
    Effect.gen(function* () {
      const startedAt = performanceNow();
      const source = resolveSource(options.source);
      const inputPolicy = inputPolicyFor(source, config);
      const inputInspection = yield* inspectImage(
        input,
        fullInspectionOptions(input, resolveImagePolicy(inputPolicy).maxInputBytes),
      );
      yield* enforceImagePolicy(inputInspection, inputPolicy);

      const isolation = config.normalizer.isolation;
      if (!allowedIsolation.has(isolation)) {
        return yield* Effect.fail(new UnsafeNormalizerError({ isolation }));
      }

      const normalized = yield* config.normalizer.normalize({
        input,
        source,
        inspection: inputInspection,
        output,
      });

      const outputInspection = yield* inspectImage(
        normalized,
        fullInspectionOptions(normalized, output.maxOutputBytes),
      );
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
    }).pipe(
      // No stage of the pipeline may outlive the deadline.
      Effect.timeoutFail({
        duration: Duration.millis(timeoutMs),
        onTimeout: () => new ProcessingTimeoutError({ timeoutMs }),
      }),
    );

  return {
    process,
  };
}

export function resolveServerOutputOptions(
  options: ServerOutputOptions = {},
): ResolvedServerOutputOptions {
  const format =
    options.format === 'jpeg' || options.format === 'png' || options.format === 'webp'
      ? options.format
      : 'webp';
  return {
    format,
    mediaType: mediaTypes[format],
    maxWidth: positiveDimension(options.maxWidth, 4096),
    maxHeight: positiveDimension(options.maxHeight, 4096),
    maxOutputPixels: boundedPositiveInteger(
      options.maxOutputPixels,
      16_777_216,
      hardMaxOutputPixels,
    ),
    maxOutputBytes: boundedPositiveInteger(
      options.maxOutputBytes,
      12 * 1024 * 1024,
      hardMaxOutputBytes,
    ),
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
    unknownAnimation: 'reject',
    unknownDimensions: 'reject',
    rejectTrailingData: true,
    requireCompleteContainer: true,
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return Math.min(maximum, positiveInteger(value, fallback));
}

function positiveDimension(value: number | undefined, fallback: number): number {
  return boundedPositiveInteger(value, fallback, hardMaxOutputDimension);
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

function validPolicyNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Retains only runtime values that cannot erase stricter route defaults. */
function safePolicyOverride(policy: ImagePolicy | undefined): ImagePolicy {
  if (!policy) return {};
  return {
    ...(Array.isArray(policy.allowedFormats)
      ? { allowedFormats: policy.allowedFormats }
      : {}),
    ...(validPolicyNumber(policy.maxInputBytes)
      ? { maxInputBytes: policy.maxInputBytes }
      : {}),
    ...(validPolicyNumber(policy.maxSourcePixels)
      ? { maxSourcePixels: policy.maxSourcePixels }
      : {}),
    ...(validPolicyNumber(policy.maxSourceDimension)
      ? { maxSourceDimension: policy.maxSourceDimension }
      : {}),
    ...(validPolicyNumber(policy.maxFrames) ? { maxFrames: policy.maxFrames } : {}),
    ...(typeof policy.allowAnimation === 'boolean'
      ? { allowAnimation: policy.allowAnimation }
      : {}),
    ...(policy.unknownAnimation === 'fallback' ||
    policy.unknownAnimation === 'reject'
      ? { unknownAnimation: policy.unknownAnimation }
      : {}),
    ...(policy.unknownDimensions === 'fallback' ||
    policy.unknownDimensions === 'reject'
      ? { unknownDimensions: policy.unknownDimensions }
      : {}),
    ...(typeof policy.rejectTrailingData === 'boolean'
      ? { rejectTrailingData: policy.rejectTrailingData }
      : {}),
    ...(typeof policy.requireCompleteContainer === 'boolean'
      ? { requireCompleteContainer: policy.requireCompleteContainer }
      : {}),
  };
}

function inputPolicyFor<Output extends FileLike, Error>(
  source: import('./types.js').ServerImageSource,
  config: EffectServerImageIntakeOptions<Output, Error>,
): ImagePolicy {
  const routeDefaults =
    source === 'browser-normalized'
      ? defaultBrowserInputPolicy
      : defaultFallbackInputPolicy;
  const routePolicy =
    source === 'browser-normalized'
      ? config.browserInputPolicy
      : config.fallbackInputPolicy;

  const merged: ImagePolicy = {
    ...routeDefaults,
    ...safePolicyOverride(config.inputPolicy),
    ...safePolicyOverride(routePolicy),
    // The server is the last tier; inconclusive structural policy routes
    // reject rather than attempting another fallback.
    unknownAnimation: 'reject',
    unknownDimensions: 'reject',
  };
  return {
    ...merged,
    maxInputBytes: Math.min(
      hardMaxInputBytes,
      resolveImagePolicy(merged).maxInputBytes,
    ),
  };
}

function resolveSource(
  source: ProcessServerImageOptions['source'],
): import('./types.js').ServerImageSource {
  return source === 'original-fallback'
    ? 'original-fallback'
    : 'browser-normalized';
}

function fullInspectionOptions(
  file: FileLike,
  maximumBytes: number,
): { readonly maxHeaderBytes?: number } {
  return Number.isSafeInteger(file.size) && file.size > 0 && file.size <= maximumBytes
    ? { maxHeaderBytes: file.size }
    : {};
}

function performanceNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

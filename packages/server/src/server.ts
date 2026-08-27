import {
  AnimationNotAllowedError,
  ProcessingTimeoutError,
  enforceImagePolicy,
  inspectImage,
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
const defaultBrowserInputPolicy: ImagePolicy = {
  allowedFormats: ['jpeg', 'png', 'webp'],
  maxInputBytes: 16 * 1024 * 1024,
  maxSourcePixels: 16_777_216,
  maxSourceDimension: 4096,
  maxFrames: 1,
  allowAnimation: false,
  unknownDimensions: 'reject',
  // The server tier persists bytes, and appended bytes past a container's
  // terminal marker survive storage verbatim: polyglot payloads and
  // truncated-overwrite leaks live there.
  rejectTrailingData: true,
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
  unknownDimensions: 'reject',
  rejectTrailingData: true,
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

      const normalized = yield* config.normalizer.normalize({
        input,
        source,
        inspection: inputInspection,
        output,
      });

      const outputInspection = yield* inspectImage(normalized);
      yield* enforceImagePolicy(outputInspection, outputPolicy(output));
      // The server is the last tier: like unknown dimensions, animation that
      // cannot be ruled out from the re-inspected bytes is rejected rather
      // than assumed absent. A normalizer that emits animation state the
      // header cannot confirm is itself suspect.
      if (outputInspection.animated !== false) {
        return yield* Effect.fail(
          new AnimationNotAllowedError({
            frameCount: outputInspection.frameCount,
          }),
        );
      }
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
    rejectTrailingData: true,
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

/**
 * Object spread lets an explicitly `undefined` key override a layered default,
 * after which `resolveImagePolicy` falls back to the looser core defaults.
 * Dropping undefined keys keeps an unconfigured field on the stricter
 * route-level default instead of silently widening it.
 */
function definedPolicy(policy: ImagePolicy | undefined): ImagePolicy {
  return Object.fromEntries(
    Object.entries(policy ?? {}).filter(([, value]) => value !== undefined),
  ) as ImagePolicy;
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

  return {
    ...routeDefaults,
    ...definedPolicy(config.inputPolicy),
    ...definedPolicy(routePolicy),
    // The server is the last tier; unknown dimensions always reject here
    // regardless of the configured fallback behavior.
    unknownDimensions: 'reject',
  };
}

function performanceNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

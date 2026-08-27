import {
  EnvironmentUnsupportedError,
  ProcessingTimeoutError,
  ServerFallbackRequiredError,
  checkImagePolicy,
  enforceImagePolicy,
  inspectImage,
  runEffectPromise,
  type ImageInspection,
  type ImagePolicyError,
  type ImageProcessingError,
  type OptloadError,
} from '@optload/core';
import { Duration, Effect, Either } from 'effect';
import { canUseFreshWorker, nativeDecodeCapability } from './capabilities.js';
import { attachDropTarget } from './drop.js';
import { resolveOutputOptions, resolveTargetDimensions } from './options.js';
import {
  processOnCurrentThread,
  type LocalProcessorRequest,
  type LocalProcessorResult,
} from './processor.js';
import { notifyProgress, reportProgress } from './progress.js';
import type {
  ImageFallbackRequest,
  ImageIntake,
  ImageIntakeOptions,
  ImagePlan,
  ImageProgressEvent,
  ImageProgressHandler,
  ImageResult,
  LocalExecution,
  ProcessImageOptions,
} from './types.js';
import { processInFreshWorker } from './worker-client.js';

interface ExecutedLocalResult extends LocalProcessorResult {
  readonly execution: LocalExecution;
}

const defaultTimeoutMs = 15_000;

export function createImageIntake<FallbackValue = never, FallbackError = never>(
  config: ImageIntakeOptions<FallbackValue, FallbackError> = {},
): ImageIntake<FallbackValue, FallbackError> {
  const inspect = (file: File) => inspectImage(file);

  const plan = (
    file: File,
    options: ProcessImageOptions = {},
  ): Effect.Effect<ImagePlan, import('@optload/core').InspectionError> =>
    inspect(file).pipe(
      Effect.flatMap((inspection) => makePlan(inspection, config, options)),
    );

  const process = (
    file: File,
    options: ProcessImageOptions = {},
  ): Effect.Effect<
    ImageResult<FallbackValue>,
    import('./types.js').ImageIntakeError | FallbackError
  > => {
    const onProgress = combineProgressHandlers(config.onProgress, options.onProgress);
    const startedAt = performanceNow();

    return Effect.gen(function* () {
      yield* reportProgress(onProgress, 'inspect', 0.05, 'Inspecting file…');
      const inspection = yield* inspect(file);
      yield* reportProgress(onProgress, 'plan', 0.16, 'Planning safe processing route…');
      const imagePlan = yield* makePlan(inspection, config, options);

      if (imagePlan.route === 'reject') {
        const reason =
          imagePlan.reason ??
          new EnvironmentUnsupportedError({ feature: 'policy validation' });
        return yield* Effect.fail(reason);
      }

      if (imagePlan.route === 'fallback') {
        return yield* runFallback(
          file,
          inspection,
          imagePlan.reason,
          imagePlan.policy.issues,
          config,
          onProgress,
        );
      }

      if (!imagePlan.target) {
        return yield* runFallback(
          file,
          inspection,
          imagePlan.reason,
          imagePlan.policy.issues,
          config,
          onProgress,
        );
      }

      const request: LocalProcessorRequest = {
        file,
        inspection,
        target: imagePlan.target,
        output: imagePlan.output,
      };
      const timeoutMs = validTimeout(config.timeoutMs);
      const local = executeLocally(
        request,
        config.execution ?? 'auto',
        onProgress,
      ).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(timeoutMs),
          onTimeout: () => new ProcessingTimeoutError({ timeoutMs }),
        }),
        Effect.either,
      );
      const attempted = yield* local;

      if (Either.isLeft(attempted)) {
        return yield* runFallback(
          file,
          inspection,
          attempted.left,
          imagePlan.policy.issues,
          config,
          onProgress,
        );
      }

      const processed = attempted.right;
      const durationMs = performanceNow() - startedAt;
      yield* reportProgress(onProgress, 'complete', 1, 'Image ready.');
      return {
        kind: 'local',
        blob: processed.blob,
        inspection,
        output: {
          format: imagePlan.output.format,
          mediaType: imagePlan.output.mediaType,
          width: processed.width,
          height: processed.height,
          bytes: processed.blob.size,
        },
        execution: processed.execution,
        durationMs,
        savings:
          inspection.fileSize > 0
            ? 1 - processed.blob.size / inspection.fileSize
            : 0,
      } as const;
    });
  };

  const intake: ImageIntake<FallbackValue, FallbackError> = {
    inspect,
    plan,
    process,
    processPromise: (file, options = {}) =>
      runEffectPromise(process(file, options), { signal: options.signal }),
    attachDropTarget: (target, options) =>
      attachDropTarget(intake, target, options),
  };

  return intake;
}

function makePlan<FallbackValue, FallbackError>(
  inspection: ImageInspection,
  config: ImageIntakeOptions<FallbackValue, FallbackError>,
  options: ProcessImageOptions,
): Effect.Effect<ImagePlan> {
  return Effect.gen(function* () {
    const policy = checkImagePolicy(inspection, config.policy);
    const output = resolveOutputOptions(inspection, {
      ...config.output,
      ...options.output,
    });
    const target = resolveTargetDimensions(inspection, output);
    const validation = yield* enforceImagePolicy(inspection, config.policy).pipe(
      Effect.either,
    );
    const policyReason = Either.isLeft(validation) ? validation.left : null;

    if (policy.outcome === 'reject') {
      return {
        inspection,
        policy,
        route: 'reject',
        nativeDecode: 'unknown',
        target,
        output,
        reason: policyReason,
      };
    }

    if (policy.outcome === 'fallback') {
      return {
        inspection,
        policy,
        route: 'fallback',
        nativeDecode: 'unknown',
        target,
        output,
        reason: policyReason,
      };
    }

    const capability = yield* nativeDecodeCapability(inspection);
    const unsupported =
      capability === 'unsupported'
        ? new EnvironmentUnsupportedError({
            feature: `native ${inspection.mediaType ?? 'image'} decoding`,
          })
        : null;

    return {
      inspection,
      policy,
      route: unsupported ? 'fallback' : 'local',
      nativeDecode: capability,
      target,
      output,
      reason: unsupported,
    };
  });
}

function executeLocally(
  request: LocalProcessorRequest,
  execution: 'auto' | 'worker' | 'main-thread',
  onProgress: ImageProgressHandler | undefined,
): Effect.Effect<ExecutedLocalResult, ImageProcessingError> {
  const main = processOnCurrentThread(request, onProgress).pipe(
    Effect.map((result) => ({ ...result, execution: 'main-thread' as const })),
  );

  if (execution === 'main-thread') return main;
  if (!canUseFreshWorker()) {
    return Effect.fail(
      new EnvironmentUnsupportedError({ feature: 'isolated module workers' }),
    );
  }

  return processInFreshWorker(request, onProgress).pipe(
    Effect.map((result) => ({ ...result, execution: 'worker' as const })),
  );
}

function runFallback<FallbackValue, FallbackError>(
  file: File,
  inspection: ImageInspection,
  reason: OptloadError | null,
  policyIssues: readonly import('@optload/core').PolicyIssue[],
  config: ImageIntakeOptions<FallbackValue, FallbackError>,
  onProgress: ImageProgressHandler | undefined,
): Effect.Effect<
  ImageResult<FallbackValue>,
  FallbackError | ServerFallbackRequiredError
> {
  const actualReason =
    reason ?? new EnvironmentUnsupportedError({ feature: 'local image processing' });
  if (!config.fallback) {
    return Effect.fail(new ServerFallbackRequiredError({ reason: actualReason }));
  }

  const request: ImageFallbackRequest = {
    file,
    inspection,
    reason: actualReason,
    policyIssues,
  };
  return reportProgress(
    onProgress,
    'fallback',
    0.3,
    'Using secure server fallback…',
  ).pipe(
    Effect.zipRight(config.fallback(request)),
    Effect.map(
      (value): ImageResult<FallbackValue> => ({
        kind: 'fallback',
        value,
        inspection,
        reason: actualReason,
      }),
    ),
  );
}

function combineProgressHandlers(
  first: ImageProgressHandler | undefined,
  second: ImageProgressHandler | undefined,
): ImageProgressHandler | undefined {
  if (!first) return second;
  if (!second || first === second) return first;
  return (event: ImageProgressEvent) => {
    notifyProgress(first, event);
    notifyProgress(second, event);
  };
}

function validTimeout(value: number | undefined): number {
  return value && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : defaultTimeoutMs;
}

function performanceNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

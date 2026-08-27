import {
  EnvironmentUnsupportedError,
  ProcessingTimeoutError,
  ServerFallbackRequiredError,
  checkImagePolicy,
  enforceImagePolicy,
  inspectImage,
  runEffectPromise,
  type ImageInspection,
  type ImageProcessingError,
  type OptloadError,
  type PolicyIssue,
} from '@optload/core';
import { Duration, Effect, Either } from 'effect';
import { canUseFreshWorker, nativeDecodeCapability, probeEncodeCapability } from './capabilities.js';
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
  ImageIntakeError,
  ImagePlan,
  ImageProgressEvent,
  ImageProgressHandler,
  ImageResult,
  LocalExecution,
  ProcessImageOptions,
  TargetDimensions,
} from './types.js';
import type {
  EffectImageIntake,
  EffectImageIntakeOptions,
} from './effect-types.js';
import { processInFreshWorker } from './worker-client.js';

interface ExecutedLocalResult extends LocalProcessorResult {
  readonly execution: LocalExecution;
}

const defaultTimeoutMs = 15_000;

const inspectFile = (file: File) => inspectImage(file);

export function createImageIntakeEffect<
  FallbackValue = never,
  FallbackError = never,
>(
  config: EffectImageIntakeOptions<FallbackValue, FallbackError> = {},
): EffectImageIntake<FallbackValue, FallbackError> {
  const encodeCache = new Map<string, Promise<boolean>>();
  const encode = (format: string): Promise<boolean> => {
    const cached = encodeCache.get(format);
    if (cached) return cached;
    const probe = probeEncodeCapability(format);
    encodeCache.set(format, probe);
    return probe;
  };

  const plan = (
    file: File,
    options: ProcessImageOptions = {},
  ): Effect.Effect<ImagePlan, import('@optload/core').InspectionError> =>
    inspectFile(file).pipe(
      Effect.flatMap((inspection) => makePlan(inspection, config, options, encode)),
    );

  const process = (
    file: File,
    options: ProcessImageOptions = {},
  ): Effect.Effect<
    ImageResult<FallbackValue>,
    ImageIntakeError | FallbackError
  > => {
    const onProgress = combineProgressHandlers(config.onProgress, options.onProgress);
    const startedAt = performanceNow();

    return Effect.gen(function* () {
      yield* reportProgress(onProgress, 'inspect', 0.05, 'Inspecting file…');
      const inspection = yield* inspectFile(file);
      yield* reportProgress(onProgress, 'plan', 0.16, 'Planning safe processing route…');
      const imagePlan = yield* makePlan(inspection, config, options, encode);

      if (imagePlan.route === 'reject') {
        const reason =
          imagePlan.reason ??
          new EnvironmentUnsupportedError({ feature: 'policy validation' });
        return yield* Effect.fail(reason);
      }

      const fallbackContext: FallbackContext<FallbackValue, FallbackError> = {
        file,
        inspection,
        policyIssues: imagePlan.policy.issues,
        config,
        onProgress,
      };

      if (imagePlan.route === 'fallback') {
        return yield* runFallback(fallbackContext, imagePlan.reason);
      }

      if (!imagePlan.target) {
        return yield* runFallback(fallbackContext, imagePlan.reason);
      }

      return yield* runLocalAttempt({
        file,
        inspection,
        plan: imagePlan,
        target: imagePlan.target,
        config,
        onProgress,
        startedAt,
      });
    });
  };

  const intake: EffectImageIntake<FallbackValue, FallbackError> = {
    inspect: inspectFile,
    plan,
    process,
    attachDropTarget: (target, options) =>
      attachDropTarget(
        {
          process: (file) => runEffectPromise(process(file)),
        },
        target,
        options,
      ),
  };

  return intake;
}

function makePlan<FallbackValue, FallbackError>(
  inspection: ImageInspection,
  config: EffectImageIntakeOptions<FallbackValue, FallbackError>,
  options: ProcessImageOptions,
  encode: (format: string) => Promise<boolean>,
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

    // Decode support alone is not a verdict: WebKit decodes WebP but cannot
    // encode it from canvas. An unencodable output format routes to the
    // server before any work is attempted, not after a doomed encode.
    const encodable = yield* Effect.promise(() =>
      encode(output.format).catch(() => false),
    );
    const encodeUnsupported =
      !encodable && !unsupported
        ? new EnvironmentUnsupportedError({
            feature: `native ${output.format} encoding`,
          })
        : null;

    const reason = unsupported ?? encodeUnsupported;
    return {
      inspection,
      policy,
      route: reason ? 'fallback' : 'local',
      nativeDecode: capability,
      target,
      output,
      reason,
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

interface FallbackContext<FallbackValue, FallbackError> {
  readonly file: File;
  readonly inspection: ImageInspection;
  readonly policyIssues: readonly PolicyIssue[];
  readonly config: EffectImageIntakeOptions<FallbackValue, FallbackError>;
  readonly onProgress: ImageProgressHandler | undefined;
}

function runFallback<FallbackValue, FallbackError>(
  context: FallbackContext<FallbackValue, FallbackError>,
  reason: OptloadError | null,
): Effect.Effect<
  ImageResult<FallbackValue>,
  FallbackError | ServerFallbackRequiredError
> {
  const actualReason =
    reason ?? new EnvironmentUnsupportedError({ feature: 'local image processing' });
  if (!context.config.fallback) {
    return Effect.fail(new ServerFallbackRequiredError({ reason: actualReason }));
  }

  const request: ImageFallbackRequest = {
    file: context.file,
    inspection: context.inspection,
    reason: actualReason,
    policyIssues: context.policyIssues,
  };
  return reportProgress(
    context.onProgress,
    'fallback',
    0.3,
    'Using secure server fallback…',
  ).pipe(
    Effect.zipRight(context.config.fallback(request)),
    Effect.map(
      (value): ImageResult<FallbackValue> => ({
        kind: 'fallback',
        value,
        inspection: context.inspection,
        reason: actualReason,
      }),
    ),
  );
}

interface LocalAttemptContext<FallbackValue, FallbackError> {
  readonly file: File;
  readonly inspection: ImageInspection;
  readonly plan: ImagePlan;
  readonly target: TargetDimensions;
  readonly config: EffectImageIntakeOptions<FallbackValue, FallbackError>;
  readonly onProgress: ImageProgressHandler | undefined;
  readonly startedAt: number;
}

function runLocalAttempt<FallbackValue, FallbackError>(
  context: LocalAttemptContext<FallbackValue, FallbackError>,
): Effect.Effect<ImageResult<FallbackValue>, ImageIntakeError | FallbackError> {
  const request: LocalProcessorRequest = {
    file: context.file,
    inspection: context.inspection,
    target: context.target,
    output: context.plan.output,
    limits: {
      maxDimension: context.plan.policy.policy.maxSourceDimension,
      maxPixels: context.plan.policy.policy.maxSourcePixels,
    },
  };
  const timeoutMs = validTimeout(context.config.timeoutMs);
  const local = executeLocally(
    request,
    context.config.execution ?? 'auto',
    context.onProgress,
  ).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () => new ProcessingTimeoutError({ timeoutMs }),
    }),
    Effect.either,
  );

  return Effect.gen(function* () {
    const attempted = yield* local;

    if (Either.isLeft(attempted)) {
      return yield* runFallback(
        {
          file: context.file,
          inspection: context.inspection,
          policyIssues: context.plan.policy.issues,
          config: context.config,
          onProgress: context.onProgress,
        },
        attempted.left,
      );
    }

    const processed = attempted.right;
    const durationMs = performanceNow() - context.startedAt;
    yield* reportProgress(context.onProgress, 'complete', 1, 'Image ready.');
    return {
      kind: 'local',
      blob: processed.blob,
      inspection: context.inspection,
      output: {
        format: context.plan.output.format,
        mediaType: context.plan.output.mediaType,
        width: processed.width,
        height: processed.height,
        bytes: processed.blob.size,
      },
      execution: processed.execution,
      durationMs,
      savings:
        context.inspection.fileSize > 0
          ? 1 - processed.blob.size / context.inspection.fileSize
          : 0,
    } as const;
  });
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

import type {
  FileLike,
  ImageInspection,
  ImagePolicy,
  ImagePolicyError,
  InspectionError,
  ProcessingTimeoutError,
} from '@optload/core';
import type { Effect } from 'effect';
import type {
  OutputDimensionExceededError,
  UnsafeNormalizerError,
} from './errors.js';

export type ServerImageSource = 'browser-normalized' | 'original-fallback';
export type ServerOutputFormat = 'jpeg' | 'png' | 'webp';
export type NormalizerIsolation = 'process' | 'container' | 'external-service';

export interface ServerOutputOptions {
  readonly format?: ServerOutputFormat;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly maxOutputPixels?: number;
  readonly maxOutputBytes?: number;
  readonly quality?: number;
}

export interface ResolvedServerOutputOptions {
  readonly format: ServerOutputFormat;
  readonly mediaType: string;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxOutputPixels: number;
  readonly maxOutputBytes: number;
  readonly quality: number;
}

export interface ServerNormalizationRequest {
  readonly input: FileLike;
  readonly source: ServerImageSource;
  readonly inspection: ImageInspection;
  readonly output: ResolvedServerOutputOptions;
}

/**
 * Implementations must cross a real process/container/service boundary. A
 * worker thread is not sufficient isolation for native codecs.
 */
export interface ServerImageNormalizer<Output extends FileLike, Error = never> {
  readonly isolation: NormalizerIsolation;
  readonly normalize: (
    request: ServerNormalizationRequest,
  ) => Effect.Effect<Output, Error>;
}

export interface ServerImageIntakeOptions<
  Output extends FileLike,
  NormalizerError = never,
> {
  readonly normalizer: ServerImageNormalizer<Output, NormalizerError>;
  /** Baseline policy merged into both upload routes. */
  readonly inputPolicy?: ImagePolicy;
  readonly browserInputPolicy?: ImagePolicy;
  readonly fallbackInputPolicy?: ImagePolicy;
  readonly output?: ServerOutputOptions;
  readonly timeoutMs?: number;
}

export interface ProcessServerImageOptions {
  readonly source?: ServerImageSource;
  readonly signal?: AbortSignal;
}

export interface ServerImageResult<Output extends FileLike> {
  readonly output: Output;
  readonly source: ServerImageSource;
  readonly inputInspection: ImageInspection;
  readonly outputInspection: ImageInspection;
  readonly isolation: NormalizerIsolation;
  readonly durationMs: number;
}

export type ServerImageIntakeError<NormalizerError> =
  | InspectionError
  | ImagePolicyError
  | ProcessingTimeoutError
  | UnsafeNormalizerError
  | OutputDimensionExceededError
  | NormalizerError;

export interface ServerImageIntake<Output extends FileLike, NormalizerError> {
  readonly process: (
    input: FileLike,
    options?: Omit<ProcessServerImageOptions, 'signal'>,
  ) => Effect.Effect<
    ServerImageResult<Output>,
    ServerImageIntakeError<NormalizerError>
  >;
  readonly processPromise: (
    input: FileLike,
    options?: ProcessServerImageOptions,
  ) => Promise<ServerImageResult<Output>>;
}

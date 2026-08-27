import type {
  FileLike,
  ImageInspection,
  ImagePolicy,
  ImagePolicyError,
  InspectionError,
  ProcessingTimeoutError,
} from '@optload/core';
import type {
  OutputDimensionExceededError,
  UnsafeNormalizerError,
} from './errors.js';

export type MaybePromise<Value> = Value | PromiseLike<Value>;

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
  /** Present for Promise-based normalizers so remote work can be cancelled. */
  readonly signal?: AbortSignal;
}

/**
 * Implementations must cross a real process/container/service boundary. A
 * worker thread is not sufficient isolation for native codecs.
 */
export interface ServerImageNormalizer<Output extends FileLike> {
  readonly isolation: NormalizerIsolation;
  readonly normalize: (
    request: ServerNormalizationRequest,
  ) => MaybePromise<Output>;
}

export interface ServerImageIntakeOptions<Output extends FileLike> {
  readonly normalizer: ServerImageNormalizer<Output>;
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

export type ServerImageIntakeError<NormalizerError = unknown> =
  | InspectionError
  | ImagePolicyError
  | ProcessingTimeoutError
  | UnsafeNormalizerError
  | OutputDimensionExceededError
  | NormalizerError;

export interface ServerImageIntake<Output extends FileLike> {
  readonly process: (
    input: FileLike,
    options?: ProcessServerImageOptions,
  ) => Promise<ServerImageResult<Output>>;
}

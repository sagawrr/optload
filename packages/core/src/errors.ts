import { Data } from 'effect';
import type { ImageFormat } from './types.js';

export type OptloadStage =
  | 'inspect'
  | 'policy'
  | 'plan'
  | 'decode'
  | 'transform'
  | 'encode'
  | 'fallback';

export class FileEmptyError extends Data.TaggedError('FileEmptyError')<{
  readonly size: number;
}> {
  readonly code = 'FILE_EMPTY' as const;
  readonly stage = 'inspect' as const;
  override readonly message = 'The selected file is empty.';
}

export class InspectionReadError extends Data.TaggedError('InspectionReadError')<{
  readonly reason: unknown;
}> {
  readonly code = 'INSPECTION_READ_FAILED' as const;
  readonly stage = 'inspect' as const;
  override readonly message = 'The file header could not be read.';
}

export class UnsupportedFormatError extends Data.TaggedError('UnsupportedFormatError')<{
  readonly format: ImageFormat | null;
}> {
  readonly code = 'UNSUPPORTED_FORMAT' as const;
  readonly stage = 'policy' as const;
  override readonly message = this.format
    ? `The detected ${this.format} format is not allowed by this pipeline.`
    : 'The file format could not be identified.';
}

export class InputTooLargeError extends Data.TaggedError('InputTooLargeError')<{
  readonly actual: number;
  readonly maximum: number;
}> {
  readonly code = 'INPUT_TOO_LARGE' as const;
  readonly stage = 'policy' as const;
  override readonly message = `The file exceeds the ${this.maximum}-byte input limit.`;
}

export class DimensionsUnknownError extends Data.TaggedError('DimensionsUnknownError')<{}> {
  readonly code = 'DIMENSIONS_UNKNOWN' as const;
  readonly stage = 'policy' as const;
  override readonly message = 'The image dimensions must be resolved before local processing.';
}

export class InvalidDimensionsError extends Data.TaggedError(
  'InvalidDimensionsError',
)<{
  readonly width: number;
  readonly height: number;
}> {
  readonly code = 'INVALID_DIMENSIONS' as const;
  readonly stage = 'policy' as const;
  override readonly message = 'The image declares invalid or unsafe dimensions.';
}

export class SourceDimensionExceededError extends Data.TaggedError(
  'SourceDimensionExceededError',
)<{
  readonly width: number;
  readonly height: number;
  readonly maximum: number;
}> {
  readonly code = 'SOURCE_DIMENSION_EXCEEDED' as const;
  readonly stage = 'policy' as const;
  override readonly message = `The image exceeds the ${this.maximum}px source-dimension limit.`;
}

export class PixelLimitExceededError extends Data.TaggedError('PixelLimitExceededError')<{
  readonly actual: number;
  readonly maximum: number;
}> {
  readonly code = 'PIXEL_LIMIT_EXCEEDED' as const;
  readonly stage = 'policy' as const;
  override readonly message = `The image exceeds the ${this.maximum}-pixel source limit.`;
}

export class AnimationNotAllowedError extends Data.TaggedError(
  'AnimationNotAllowedError',
)<{
  readonly frameCount: number | null;
}> {
  readonly code = 'ANIMATION_NOT_ALLOWED' as const;
  readonly stage = 'policy' as const;
  override readonly message = 'Animated images are not enabled for this pipeline.';
}

export class FrameLimitExceededError extends Data.TaggedError('FrameLimitExceededError')<{
  readonly actual: number;
  readonly maximum: number;
}> {
  readonly code = 'FRAME_LIMIT_EXCEEDED' as const;
  readonly stage = 'policy' as const;
  override readonly message = `The image exceeds the ${this.maximum}-frame limit.`;
}

export class DecodeError extends Data.TaggedError('DecodeError')<{
  readonly format: ImageFormat | null;
  readonly reason: unknown;
}> {
  readonly code = 'DECODE_FAILED' as const;
  readonly stage = 'decode' as const;
  override readonly message = this.format
    ? `The browser could not decode the ${this.format} image.`
    : 'The browser could not decode the image.';
}

export class EncodeError extends Data.TaggedError('EncodeError')<{
  readonly mediaType: string;
  readonly reason: unknown;
}> {
  readonly code = 'ENCODE_FAILED' as const;
  readonly stage = 'encode' as const;
  override readonly message = `The browser could not encode ${this.mediaType}.`;
}

export class ProcessingTimeoutError extends Data.TaggedError('ProcessingTimeoutError')<{
  readonly timeoutMs: number;
}> {
  readonly code = 'TIMEOUT' as const;
  readonly stage = 'transform' as const;
  override readonly message = `Image processing exceeded the ${this.timeoutMs}ms timeout.`;
}

export class EnvironmentUnsupportedError extends Data.TaggedError(
  'EnvironmentUnsupportedError',
)<{
  readonly feature: string;
  readonly reason?: unknown;
}> {
  readonly code = 'ENVIRONMENT_UNSUPPORTED' as const;
  readonly stage = 'plan' as const;
  override readonly message = `This environment does not provide ${this.feature}.`;
}

export class ServerFallbackRequiredError extends Data.TaggedError(
  'ServerFallbackRequiredError',
)<{
  readonly reason: OptloadError;
}> {
  readonly code = 'SERVER_FALLBACK_REQUIRED' as const;
  readonly stage = 'fallback' as const;
  override readonly message = 'This image requires the configured server fallback.';
}

export type InspectionError = FileEmptyError | InspectionReadError;

export type ImagePolicyError =
  | UnsupportedFormatError
  | InputTooLargeError
  | DimensionsUnknownError
  | InvalidDimensionsError
  | SourceDimensionExceededError
  | PixelLimitExceededError
  | AnimationNotAllowedError
  | FrameLimitExceededError;

export type ImageProcessingError =
  | DecodeError
  | EncodeError
  | ProcessingTimeoutError
  | EnvironmentUnsupportedError;

export type OptloadError =
  | InspectionError
  | ImagePolicyError
  | ImageProcessingError
  | ServerFallbackRequiredError;

export type OptloadErrorCode = OptloadError['code'];

export function isOptloadError(value: unknown): value is OptloadError {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_tag' in value &&
    'code' in value &&
    'stage' in value
  );
}

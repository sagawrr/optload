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

export class AnimationUnknownError extends Data.TaggedError(
  'AnimationUnknownError',
)<{}> {
  readonly code = 'ANIMATION_UNKNOWN' as const;
  readonly stage = 'policy' as const;
  override readonly message =
    'Animation and frame count must be resolved before processing.';
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

/**
 * The decoder produced dimensions that exceed policy, which means the
 * inspected header disagreed with (or understated) the real frame size.
 */
export class DecodedDimensionError extends Data.TaggedError(
  'DecodedDimensionError',
)<{
  readonly width: number;
  readonly height: number;
  readonly maxDimension: number;
  readonly maxPixels: number;
}> {
  readonly code = 'DECODED_DIMENSION_EXCEEDED' as const;
  readonly stage = 'decode' as const;
  override readonly message = `The decoded image is ${this.width}×${this.height}, exceeding the ${this.maxDimension}px-per-side or ${this.maxPixels}-pixel decode limit.`;
}

/**
 * The decoder produced dimensions that differ from (while remaining within)
 * the inspected header's declaration, so the header lied about the frame.
 */
export class DecodedDimensionMismatchError extends Data.TaggedError(
  'DecodedDimensionMismatchError',
)<{
  readonly declaredWidth: number;
  readonly declaredHeight: number;
  readonly decodedWidth: number;
  readonly decodedHeight: number;
}> {
  readonly code = 'DECODED_DIMENSION_MISMATCH' as const;
  readonly stage = 'decode' as const;
  override readonly message = `The decoded image is ${this.decodedWidth}×${this.decodedHeight}, but the header declared ${this.declaredWidth}×${this.declaredHeight}.`;
}

/** Bytes continue past the format's terminal marker and policy forbids them. */
export class TrailingDataError extends Data.TaggedError('TrailingDataError')<{
  readonly format: ImageFormat | null;
}> {
  readonly code = 'TRAILING_DATA' as const;
  readonly stage = 'policy' as const;
  override readonly message = `Bytes continue past the ${this.format ?? 'image'} container's end marker; appended data is not part of the image.`;
}

export class ContainerIncompleteError extends Data.TaggedError(
  'ContainerIncompleteError',
)<{
  readonly format: ImageFormat | null;
}> {
  readonly code = 'CONTAINER_INCOMPLETE' as const;
  readonly stage = 'policy' as const;
  override readonly message = `The ${this.format ?? 'image'} container does not include its required end marker or declared extent.`;
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
  | AnimationUnknownError
  | FrameLimitExceededError
  | ContainerIncompleteError
  | TrailingDataError;

export type ImageProcessingError =
  | DecodeError
  | DecodedDimensionError
  | DecodedDimensionMismatchError
  | EncodeError
  | ProcessingTimeoutError
  | EnvironmentUnsupportedError;

export type OptloadError =
  | InspectionError
  | ImagePolicyError
  | ImageProcessingError
  | ServerFallbackRequiredError;

export type OptloadErrorCode = OptloadError['code'];

const errorIdentities: Readonly<
  Record<OptloadError['_tag'], readonly [OptloadErrorCode, OptloadStage]>
> = {
  FileEmptyError: ['FILE_EMPTY', 'inspect'],
  InspectionReadError: ['INSPECTION_READ_FAILED', 'inspect'],
  UnsupportedFormatError: ['UNSUPPORTED_FORMAT', 'policy'],
  InputTooLargeError: ['INPUT_TOO_LARGE', 'policy'],
  DimensionsUnknownError: ['DIMENSIONS_UNKNOWN', 'policy'],
  InvalidDimensionsError: ['INVALID_DIMENSIONS', 'policy'],
  SourceDimensionExceededError: ['SOURCE_DIMENSION_EXCEEDED', 'policy'],
  PixelLimitExceededError: ['PIXEL_LIMIT_EXCEEDED', 'policy'],
  AnimationNotAllowedError: ['ANIMATION_NOT_ALLOWED', 'policy'],
  AnimationUnknownError: ['ANIMATION_UNKNOWN', 'policy'],
  FrameLimitExceededError: ['FRAME_LIMIT_EXCEEDED', 'policy'],
  ContainerIncompleteError: ['CONTAINER_INCOMPLETE', 'policy'],
  TrailingDataError: ['TRAILING_DATA', 'policy'],
  DecodeError: ['DECODE_FAILED', 'decode'],
  DecodedDimensionError: ['DECODED_DIMENSION_EXCEEDED', 'decode'],
  DecodedDimensionMismatchError: ['DECODED_DIMENSION_MISMATCH', 'decode'],
  EncodeError: ['ENCODE_FAILED', 'encode'],
  ProcessingTimeoutError: ['TIMEOUT', 'transform'],
  EnvironmentUnsupportedError: ['ENVIRONMENT_UNSUPPORTED', 'plan'],
  ServerFallbackRequiredError: ['SERVER_FALLBACK_REQUIRED', 'fallback'],
};

export function isOptloadError(value: unknown): value is OptloadError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    readonly _tag?: unknown;
    readonly code?: unknown;
    readonly stage?: unknown;
  };
  if (typeof candidate._tag !== 'string') return false;
  const identity = errorIdentities[candidate._tag as OptloadError['_tag']];
  return identity?.[0] === candidate.code && identity[1] === candidate.stage;
}

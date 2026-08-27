import {
  DecodeError,
  DecodedDimensionError,
  DecodedDimensionMismatchError,
  EncodeError,
  EnvironmentUnsupportedError,
  ProcessingTimeoutError,
  imageFormats,
  type ImageFormat,
  type ImageProcessingError,
} from '@optload/core';
import type { LocalProcessorRequest, LocalProcessorResult } from './processor.js';
import type { ImageProgressEvent } from './types.js';

export interface WorkerProcessRequest {
  readonly _tag: 'Process';
  readonly request: LocalProcessorRequest;
}

export interface SerializedImageProcessingError {
  readonly _tag: ImageProcessingError['_tag'];
  readonly details: Readonly<Record<string, string | number | null>>;
}

export type WorkerProcessResponse =
  | { readonly _tag: 'Progress'; readonly event: ImageProgressEvent }
  | { readonly _tag: 'Success'; readonly result: LocalProcessorResult }
  | { readonly _tag: 'Failure'; readonly error: SerializedImageProcessingError };

export function serializeProcessingError(
  error: ImageProcessingError,
): SerializedImageProcessingError {
  switch (error._tag) {
    case 'DecodeError':
      return {
        _tag: error._tag,
        details: { format: error.format, reason: safeReason(error.reason) },
      };
    case 'DecodedDimensionError':
      return {
        _tag: error._tag,
        details: {
          width: error.width,
          height: error.height,
          maxDimension: error.maxDimension,
          maxPixels: error.maxPixels,
        },
      };
    case 'DecodedDimensionMismatchError':
      return {
        _tag: error._tag,
        details: {
          declaredWidth: error.declaredWidth,
          declaredHeight: error.declaredHeight,
          decodedWidth: error.decodedWidth,
          decodedHeight: error.decodedHeight,
        },
      };
    case 'EncodeError':
      return {
        _tag: error._tag,
        details: {
          mediaType: error.mediaType,
          reason: safeReason(error.reason),
        },
      };
    case 'ProcessingTimeoutError':
      return { _tag: error._tag, details: { timeoutMs: error.timeoutMs } };
    case 'EnvironmentUnsupportedError':
      return {
        _tag: error._tag,
        details: {
          feature: error.feature,
          reason: safeReason(error.reason),
        },
      };
  }
}

export function deserializeProcessingError(
  error: SerializedImageProcessingError,
): ImageProcessingError {
  switch (error._tag) {
    case 'DecodeError':
      return new DecodeError({
        format: imageFormat(error.details.format),
        reason: error.details.reason,
      });
    case 'DecodedDimensionError':
      return new DecodedDimensionError({
        width: numberDetail(error.details.width, 0),
        height: numberDetail(error.details.height, 0),
        maxDimension: numberDetail(error.details.maxDimension, 0),
        maxPixels: numberDetail(error.details.maxPixels, 0),
      });
    case 'DecodedDimensionMismatchError':
      return new DecodedDimensionMismatchError({
        declaredWidth: numberDetail(error.details.declaredWidth, 0),
        declaredHeight: numberDetail(error.details.declaredHeight, 0),
        decodedWidth: numberDetail(error.details.decodedWidth, 0),
        decodedHeight: numberDetail(error.details.decodedHeight, 0),
      });
    case 'EncodeError':
      return new EncodeError({
        mediaType: stringDetail(error.details.mediaType, 'unknown'),
        reason: error.details.reason,
      });
    case 'ProcessingTimeoutError':
      return new ProcessingTimeoutError({
        timeoutMs: numberDetail(error.details.timeoutMs, 0),
      });
    case 'EnvironmentUnsupportedError':
      return new EnvironmentUnsupportedError({
        feature: stringDetail(error.details.feature, 'image worker runtime'),
        reason: error.details.reason,
      });
  }
}

function safeReason(reason: unknown): string {
  try {
    const message = reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : String(reason ?? 'unknown');
    return message.slice(0, 2048);
  } catch {
    return 'unprintable error';
  }
}

function stringDetail(value: string | number | null | undefined, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function numberDetail(value: string | number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function imageFormat(
  value: string | number | null | undefined,
): DecodeError['format'] {
  return typeof value === 'string' && imageFormats.includes(value as ImageFormat)
    ? (value as ImageFormat)
    : null;
}

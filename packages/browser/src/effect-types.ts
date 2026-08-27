import type { ImageInspection, InspectionError } from '@optload/core';
import type { Effect } from 'effect';
import type {
  DropTarget,
  DropTargetOptions,
  ImageFallbackRequest,
  ImageIntakeError,
  ImageIntakeOptions,
  ImagePlan,
  ImageResult,
  ProcessImageOptions,
} from './types.js';

export type EffectImageFallback<Value, Error = never> = (
  request: ImageFallbackRequest,
) => Effect.Effect<Value, Error>;

export interface EffectImageIntakeOptions<
  FallbackValue = never,
  FallbackError = never,
> extends Omit<ImageIntakeOptions<FallbackValue>, 'fallback'> {
  readonly fallback?: EffectImageFallback<FallbackValue, FallbackError>;
}

export interface EffectImageIntake<
  FallbackValue = never,
  FallbackError = never,
> {
  readonly inspect: (
    file: File,
  ) => Effect.Effect<ImageInspection, InspectionError>;
  readonly plan: (
    file: File,
    options?: ProcessImageOptions,
  ) => Effect.Effect<ImagePlan, InspectionError>;
  readonly process: (
    file: File,
    options?: ProcessImageOptions,
  ) => Effect.Effect<
    ImageResult<FallbackValue>,
    ImageIntakeError | FallbackError
  >;
  readonly attachDropTarget: (
    target: DropTarget,
    options: DropTargetOptions<FallbackValue>,
  ) => () => void;
}

import type { FileLike } from '@optload/core';
import type { Effect } from 'effect';
import type {
  NormalizerIsolation,
  ProcessServerImageOptions,
  ServerImageIntakeError,
  ServerImageIntakeOptions,
  ServerImageResult,
  ServerNormalizationRequest,
} from './types.js';

export interface EffectServerImageNormalizer<
  Output extends FileLike,
  Error = never,
> {
  readonly isolation: NormalizerIsolation;
  readonly normalize: (
    request: ServerNormalizationRequest,
  ) => Effect.Effect<Output, Error>;
}

export interface EffectServerImageIntakeOptions<
  Output extends FileLike,
  NormalizerError = never,
> extends Omit<ServerImageIntakeOptions<Output>, 'normalizer'> {
  readonly normalizer: EffectServerImageNormalizer<Output, NormalizerError>;
}

export interface EffectServerImageIntake<
  Output extends FileLike,
  NormalizerError = never,
> {
  readonly process: (
    input: FileLike,
    options?: Omit<ProcessServerImageOptions, 'signal'>,
  ) => Effect.Effect<
    ServerImageResult<Output>,
    ServerImageIntakeError<NormalizerError>
  >;
}

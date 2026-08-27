import { Data } from 'effect';

export class UnsafeNormalizerError extends Data.TaggedError(
  'UnsafeNormalizerError',
)<{
  readonly isolation: unknown;
  readonly code: 'UNSAFE_NORMALIZER';
  readonly stage: 'normalize';
  readonly message: string;
}> {
  constructor(options: { readonly isolation: unknown }) {
    super({
      isolation: options.isolation,
      code: 'UNSAFE_NORMALIZER',
      stage: 'normalize',
      message:
        'The server normalizer must declare process, container, or external-service isolation.',
    });
  }
}

export class OutputDimensionExceededError extends Data.TaggedError(
  'OutputDimensionExceededError',
)<{
  readonly width: number;
  readonly height: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly code: 'OUTPUT_DIMENSION_EXCEEDED';
  readonly stage: 'verify';
  readonly message: string;
}> {
  constructor(options: {
    readonly width: number;
    readonly height: number;
    readonly maxWidth: number;
    readonly maxHeight: number;
  }) {
    super({
      ...options,
      code: 'OUTPUT_DIMENSION_EXCEEDED',
      stage: 'verify',
      message: `The normalized output is ${options.width}×${options.height}; the limit is ${options.maxWidth}×${options.maxHeight}.`,
    });
  }
}

/** Parent-to-child: normalize one image. */
export interface ChildNormalizeRequest {
  readonly _tag: 'Normalize';
  readonly bytes: Uint8Array;
  readonly output: {
    readonly format: 'jpeg' | 'png' | 'webp';
    readonly maxWidth: number;
    readonly maxHeight: number;
    readonly maxOutputPixels: number;
    readonly maxOutputBytes: number;
    readonly quality: number;
  };
  readonly limits: {
    readonly maxPixels: number;
    readonly maxDimension: number;
  };
}

/** Child-to-parent: success carries the re-encoded bytes. */
export type ChildResponse =
  | { readonly _tag: 'Success'; readonly bytes: Uint8Array }
  | { readonly _tag: 'Failure'; readonly failure: ChildFailure };

/**
 * Failure codes cross the process boundary as plain strings; the parent maps
 * them onto typed errors. Messages are truncated and content-free.
 */
export type ChildFailureCode =
  | 'UNSUPPORTED_FORMAT'
  | 'INPUT_LIMIT_EXCEEDED'
  | 'DECODE_FAILED'
  | 'ENCODE_FAILED';

export interface ChildFailure {
  readonly code: ChildFailureCode;
  readonly message: string;
}

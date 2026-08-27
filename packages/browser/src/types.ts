import type {
  ImageInspection,
  ImagePolicy,
  ImagePolicyDecision,
  ImagePolicyError,
  ImageProcessingError,
  InspectionError,
  OptloadError,
  PolicyIssue,
  ServerFallbackRequiredError,
} from '@optload/core';
import type { Effect } from 'effect';

export type ImageOutputFormat = 'jpeg' | 'png' | 'webp';
export type ImageOutputFormatOption = ImageOutputFormat | 'auto';
/** `auto` prefers an isolated worker and never silently drops to the main thread. */
export type ProcessingExecution = 'auto' | 'worker' | 'main-thread';
export type LocalExecution = Exclude<ProcessingExecution, 'auto'>;

export interface ImageOutputOptions {
  readonly format?: ImageOutputFormatOption;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly quality?: number;
  /** Background applied before encoding an alpha image as JPEG. */
  readonly background?: string;
}

export interface ResolvedImageOutputOptions {
  readonly format: ImageOutputFormat;
  readonly mediaType: string;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality: number;
  readonly background: string;
}

export interface TargetDimensions {
  readonly width: number;
  readonly height: number;
}

export type NativeDecodeCapability = 'supported' | 'unsupported' | 'unknown';

export interface ImagePlan {
  readonly inspection: ImageInspection;
  readonly policy: ImagePolicyDecision;
  readonly route: 'local' | 'fallback' | 'reject';
  readonly nativeDecode: NativeDecodeCapability;
  readonly target: TargetDimensions | null;
  readonly output: ResolvedImageOutputOptions;
  readonly reason: OptloadError | null;
}

export type ImageProgressStage =
  | 'inspect'
  | 'plan'
  | 'decode'
  | 'transform'
  | 'encode'
  | 'fallback'
  | 'complete';

export interface ImageProgressEvent {
  readonly stage: ImageProgressStage;
  readonly progress: number;
  readonly message: string;
}

export type ImageProgressHandler = (event: ImageProgressEvent) => void;

export interface LocalImageResult {
  readonly kind: 'local';
  readonly blob: Blob;
  readonly inspection: ImageInspection;
  readonly output: {
    readonly format: ImageOutputFormat;
    readonly mediaType: string;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
  };
  readonly execution: LocalExecution;
  readonly durationMs: number;
  readonly savings: number;
}

export interface FallbackImageResult<Value> {
  readonly kind: 'fallback';
  readonly value: Value;
  readonly inspection: ImageInspection;
  readonly reason: OptloadError;
}

export type ImageResult<FallbackValue = never> =
  | LocalImageResult
  | FallbackImageResult<FallbackValue>;

export interface ImageFallbackRequest {
  readonly file: File;
  readonly inspection: ImageInspection;
  readonly reason: OptloadError;
  readonly policyIssues: readonly PolicyIssue[];
}

export type ImageFallback<Value, Error = never> = (
  request: ImageFallbackRequest,
) => Effect.Effect<Value, Error>;

export interface ImageIntakeOptions<FallbackValue = never, FallbackError = never> {
  readonly policy?: ImagePolicy;
  readonly output?: ImageOutputOptions;
  readonly execution?: ProcessingExecution;
  readonly timeoutMs?: number;
  readonly fallback?: ImageFallback<FallbackValue, FallbackError>;
  readonly onProgress?: ImageProgressHandler;
}

export interface ProcessImageOptions {
  readonly output?: ImageOutputOptions;
  readonly onProgress?: ImageProgressHandler;
}

export interface RunImageOptions extends ProcessImageOptions {
  readonly signal?: AbortSignal;
}

export type ImageIntakeError =
  | InspectionError
  | ImagePolicyError
  | ImageProcessingError
  | ServerFallbackRequiredError;

export interface DropTargetOptions<FallbackValue> {
  readonly multiple?: boolean;
  readonly onActiveChange?: (active: boolean) => void;
  readonly onResult: (result: ImageResult<FallbackValue>, file: File) => void;
  readonly onError?: (error: unknown, file: File) => void;
}

export type DropTarget = Window | Document | HTMLElement;

export interface ImageIntake<FallbackValue = never, FallbackError = never> {
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
  readonly processPromise: (
    file: File,
    options?: RunImageOptions,
  ) => Promise<ImageResult<FallbackValue>>;
  readonly attachDropTarget: (
    target: DropTarget,
    options: DropTargetOptions<FallbackValue>,
  ) => () => void;
}

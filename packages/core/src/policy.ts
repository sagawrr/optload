import { Effect } from 'effect';
import {
  AnimationNotAllowedError,
  AnimationUnknownError,
  ContainerIncompleteError,
  DimensionsUnknownError,
  FrameLimitExceededError,
  InputTooLargeError,
  InvalidDimensionsError,
  PixelLimitExceededError,
  SourceDimensionExceededError,
  TrailingDataError,
  UnsupportedFormatError,
  type ImagePolicyError,
} from './errors.js';
import type {
  ImageFormat,
  ImageInspection,
  SupportedInputFormat,
} from './types.js';
import { imageFormats } from './types.js';

export type UnknownDimensionBehavior = 'fallback' | 'reject';
export type UnknownAnimationBehavior = 'fallback' | 'reject';

export interface ImagePolicy {
  readonly allowedFormats?: readonly ImageFormat[];
  readonly maxInputBytes?: number;
  readonly maxSourcePixels?: number;
  readonly maxSourceDimension?: number;
  readonly maxFrames?: number;
  readonly allowAnimation?: boolean;
  /** Route or reject when animation/frame count cannot be established. */
  readonly unknownAnimation?: UnknownAnimationBehavior;
  readonly unknownDimensions?: UnknownDimensionBehavior;
  /**
   * Reject files whose inspected bytes continue past the format's terminal
   * marker (PNG IEND, JPEG EOI, the declared WebP RIFF extent). Appended
   * bytes are invisible to decoders but survive verbatim storage: they are
   * the polyglot and truncated-overwrite-leak channel. Warnings are always
   * reported; this escalates them to rejections where original bytes are
   * stored. Unknown for formats without a cheap terminal marker.
   */
  readonly rejectTrailingData?: boolean;
  /** Reject JPEG/PNG/WebP when a full inspection cannot establish container end. */
  readonly requireCompleteContainer?: boolean;
}

export interface ResolvedImagePolicy {
  readonly allowedFormats: readonly ImageFormat[];
  readonly maxInputBytes: number;
  readonly maxSourcePixels: number;
  readonly maxSourceDimension: number;
  readonly maxFrames: number;
  readonly allowAnimation: boolean;
  readonly unknownAnimation: UnknownAnimationBehavior;
  readonly unknownDimensions: UnknownDimensionBehavior;
  readonly rejectTrailingData: boolean;
  readonly requireCompleteContainer: boolean;
}

export type PolicyIssueCode = ImagePolicyError['code'];

export interface PolicyIssue {
  readonly code: PolicyIssueCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type ImagePolicyDecision =
  | {
      readonly outcome: 'accept';
      readonly policy: ResolvedImagePolicy;
      readonly issues: readonly [];
    }
  | {
      readonly outcome: 'fallback' | 'reject';
      readonly policy: ResolvedImagePolicy;
      readonly issues: readonly PolicyIssue[];
    };

const defaultAllowedFormats: readonly SupportedInputFormat[] = Object.freeze([
  'jpeg',
  'png',
  'webp',
  'avif',
  'heic',
  'heif',
]);
const knownFormats = new Set<ImageFormat>(imageFormats);

/**
 * Decode limits default to values that survive a lying or hostile header on
 * memory-constrained devices: 33,554,432 pixels still admits every 8K frame
 * (7680×4320 = 33.2 MP) while capping a decoded bitmap near 128 MB of RGBA.
 */
export const defaultImagePolicy: ResolvedImagePolicy = Object.freeze({
  allowedFormats: defaultAllowedFormats,
  maxInputBytes: 32 * 1024 * 1024,
  maxSourcePixels: 33_554_432,
  maxSourceDimension: 8_192,
  maxFrames: 1,
  allowAnimation: false,
  unknownAnimation: 'fallback',
  unknownDimensions: 'fallback',
  rejectTrailingData: false,
  requireCompleteContainer: false,
});

export function resolveImagePolicy(policy: ImagePolicy = {}): ResolvedImagePolicy {
  return {
    allowedFormats: resolveAllowedFormats(policy.allowedFormats),
    maxInputBytes: nonNegativeInteger(
      policy.maxInputBytes,
      defaultImagePolicy.maxInputBytes,
    ),
    maxSourcePixels: nonNegativeInteger(
      policy.maxSourcePixels,
      defaultImagePolicy.maxSourcePixels,
    ),
    maxSourceDimension: nonNegativeInteger(
      policy.maxSourceDimension,
      defaultImagePolicy.maxSourceDimension,
    ),
    maxFrames: nonNegativeInteger(policy.maxFrames, defaultImagePolicy.maxFrames),
    allowAnimation: booleanOption(
      policy.allowAnimation,
      defaultImagePolicy.allowAnimation,
    ),
    unknownAnimation:
      policy.unknownAnimation === 'fallback' || policy.unknownAnimation === 'reject'
        ? policy.unknownAnimation
        : defaultImagePolicy.unknownAnimation,
    unknownDimensions:
      policy.unknownDimensions === 'fallback' || policy.unknownDimensions === 'reject'
        ? policy.unknownDimensions
        : defaultImagePolicy.unknownDimensions,
    rejectTrailingData: booleanOption(
      policy.rejectTrailingData,
      defaultImagePolicy.rejectTrailingData,
    ),
    requireCompleteContainer: booleanOption(
      policy.requireCompleteContainer,
      defaultImagePolicy.requireCompleteContainer,
    ),
  };
}

function resolveAllowedFormats(
  formats: readonly ImageFormat[] | undefined,
): readonly ImageFormat[] {
  if (!Array.isArray(formats)) return defaultImagePolicy.allowedFormats;
  return Object.freeze(
    [...new Set(formats.filter((format) => knownFormats.has(format)))],
  );
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function booleanOption(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function formatPolicyIssue(
  inspection: ImageInspection,
  policy: ResolvedImagePolicy,
): PolicyIssue | null {
  if (inspection.format && policy.allowedFormats.includes(inspection.format)) {
    return null;
  }
  return {
    code: 'UNSUPPORTED_FORMAT',
    message: inspection.format
      ? `The detected ${inspection.format} format is not allowed by this pipeline.`
      : 'The file format could not be identified.',
    details: { format: inspection.format },
  };
}

function inputSizeIssue(
  inspection: ImageInspection,
  policy: ResolvedImagePolicy,
): PolicyIssue | null {
  if (inspection.fileSize <= policy.maxInputBytes) return null;
  return {
    code: 'INPUT_TOO_LARGE',
    message: `The file exceeds the ${policy.maxInputBytes}-byte input limit.`,
    details: { actual: inspection.fileSize, maximum: policy.maxInputBytes },
  };
}

interface DimensionCheck {
  readonly rejected: readonly PolicyIssue[];
  readonly fallback: readonly PolicyIssue[];
}

function hasSafeDimensions(
  inspection: ImageInspection,
): inspection is ImageInspection & {
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
} {
  return (
    inspection.width !== null &&
    inspection.height !== null &&
    inspection.pixels !== null &&
    Number.isSafeInteger(inspection.width) &&
    Number.isSafeInteger(inspection.height) &&
    inspection.width > 0 &&
    inspection.height > 0 &&
    Number.isSafeInteger(inspection.pixels)
  );
}

function dimensionIssues(
  inspection: ImageInspection,
  policy: ResolvedImagePolicy,
): DimensionCheck {
  const unknownDimensions: PolicyIssue = {
    code: 'DIMENSIONS_UNKNOWN',
    message: 'The image dimensions must be resolved before local processing.',
    details: {},
  };
  if (inspection.width === null || inspection.height === null) {
    return policy.unknownDimensions === 'reject'
      ? { rejected: [unknownDimensions], fallback: [] }
      : { rejected: [], fallback: [unknownDimensions] };
  }

  if (!hasSafeDimensions(inspection)) {
    return {
      rejected: [
        {
          code: 'INVALID_DIMENSIONS',
          message: 'The image declares invalid or unsafe dimensions.',
          details: {
            width: inspection.width,
            height: inspection.height,
            pixels: inspection.pixels,
          },
        },
      ],
      fallback: [],
    };
  }

  const rejected: PolicyIssue[] = [];
  if (
    inspection.width > policy.maxSourceDimension ||
    inspection.height > policy.maxSourceDimension
  ) {
    rejected.push({
      code: 'SOURCE_DIMENSION_EXCEEDED',
      message: `The image exceeds the ${policy.maxSourceDimension}px source-dimension limit.`,
      details: {
        width: inspection.width,
        height: inspection.height,
        maximum: policy.maxSourceDimension,
      },
    });
  }

  if (inspection.pixels > policy.maxSourcePixels) {
    rejected.push({
      code: 'PIXEL_LIMIT_EXCEEDED',
      message: `The image exceeds the ${policy.maxSourcePixels}-pixel source limit.`,
      details: { actual: inspection.pixels, maximum: policy.maxSourcePixels },
    });
  }

  return { rejected, fallback: [] };
}

function animationIssues(
  inspection: ImageInspection,
  policy: ResolvedImagePolicy,
): DimensionCheck {
  const rejected: PolicyIssue[] = [];
  const fallback: PolicyIssue[] = [];
  if (inspection.animated === true && !policy.allowAnimation) {
    rejected.push({
      code: 'ANIMATION_NOT_ALLOWED',
      message: 'Animated images are not enabled for this pipeline.',
      details: { frameCount: inspection.frameCount },
    });
  }
  const animationUnknown =
    inspection.animated === null ||
    (policy.allowAnimation &&
      inspection.animated === true &&
      inspection.frameCount === null);
  if (animationUnknown) {
    const issue: PolicyIssue = {
      code: 'ANIMATION_UNKNOWN',
      message: 'Animation and frame count could not be established.',
      details: {},
    };
    if (policy.unknownAnimation === 'reject') rejected.push(issue);
    else fallback.push(issue);
  }
  if (inspection.frameCount !== null && inspection.frameCount > policy.maxFrames) {
    rejected.push({
      code: 'FRAME_LIMIT_EXCEEDED',
      message: `The image exceeds the ${policy.maxFrames}-frame limit.`,
      details: { actual: inspection.frameCount, maximum: policy.maxFrames },
    });
  }
  return { rejected, fallback };
}

function trailingDataIssue(
  inspection: ImageInspection,
  policy: ResolvedImagePolicy,
): PolicyIssue | null {
  if (!policy.rejectTrailingData || inspection.trailingData !== true) {
    return null;
  }
  return {
    code: 'TRAILING_DATA',
    message:
      'The file continues past its container end marker; appended bytes are not part of the image.',
    details: { format: inspection.format },
  };
}

function incompleteContainerIssue(
  inspection: ImageInspection,
  policy: ResolvedImagePolicy,
): PolicyIssue | null {
  const terminalChecked =
    inspection.format === 'jpeg' ||
    inspection.format === 'png' ||
    inspection.format === 'webp';
  if (
    !policy.requireCompleteContainer ||
    !terminalChecked ||
    inspection.trailingData !== null
  ) {
    return null;
  }
  return {
    code: 'CONTAINER_INCOMPLETE',
    message:
      'The image container does not include its required end marker or declared extent.',
    details: { format: inspection.format },
  };
}

function isPolicyIssue(issue: PolicyIssue | null): issue is PolicyIssue {
  return issue !== null;
}

export function checkImagePolicy(
  inspection: ImageInspection,
  inputPolicy: ImagePolicy = {},
): ImagePolicyDecision {
  const policy = resolveImagePolicy(inputPolicy);
  const dimensions = dimensionIssues(inspection, policy);
  const animation = animationIssues(inspection, policy);
  const rejected = [
    formatPolicyIssue(inspection, policy),
    inputSizeIssue(inspection, policy),
    trailingDataIssue(inspection, policy),
    ...dimensions.rejected,
    incompleteContainerIssue(inspection, policy),
    ...animation.rejected,
  ].filter(isPolicyIssue);

  if (rejected.length > 0) {
    return { outcome: 'reject', policy, issues: rejected };
  }
  const fallback = [...dimensions.fallback, ...animation.fallback];
  if (fallback.length > 0) {
    return { outcome: 'fallback', policy, issues: fallback };
  }
  return { outcome: 'accept', policy, issues: [] };
}

function dimensionIssueToError(
  issue: PolicyIssue,
): ImagePolicyError | null {
  switch (issue.code) {
    case 'DIMENSIONS_UNKNOWN':
      return new DimensionsUnknownError();
    case 'INVALID_DIMENSIONS':
      return new InvalidDimensionsError({
        width: Number(issue.details.width),
        height: Number(issue.details.height),
      });
    case 'SOURCE_DIMENSION_EXCEEDED':
      return new SourceDimensionExceededError({
        width: Number(issue.details.width),
        height: Number(issue.details.height),
        maximum: Number(issue.details.maximum),
      });
    case 'PIXEL_LIMIT_EXCEEDED':
      return new PixelLimitExceededError({
        actual: Number(issue.details.actual),
        maximum: Number(issue.details.maximum),
      });
    default:
      return null;
  }
}

function issueToError(
  inspection: ImageInspection,
  issue: PolicyIssue,
): ImagePolicyError {
  switch (issue.code) {
    case 'UNSUPPORTED_FORMAT':
      return new UnsupportedFormatError({ format: inspection.format });
    case 'INPUT_TOO_LARGE':
      return new InputTooLargeError({
        actual: inspection.fileSize,
        maximum: Number(issue.details.maximum),
      });
    case 'DIMENSIONS_UNKNOWN':
    case 'INVALID_DIMENSIONS':
    case 'SOURCE_DIMENSION_EXCEEDED':
    case 'PIXEL_LIMIT_EXCEEDED': {
      const dimension = dimensionIssueToError(issue);
      if (dimension) return dimension;
      throw new Error(`Unhandled dimension issue: ${String(issue.code)}`);
    }
    case 'ANIMATION_NOT_ALLOWED':
      return new AnimationNotAllowedError({ frameCount: inspection.frameCount });
    case 'ANIMATION_UNKNOWN':
      return new AnimationUnknownError();
    case 'FRAME_LIMIT_EXCEEDED':
      return new FrameLimitExceededError({
        actual: inspection.frameCount ?? 0,
        maximum: Number(issue.details.maximum),
      });
    case 'TRAILING_DATA':
      return new TrailingDataError({ format: inspection.format });
    case 'CONTAINER_INCOMPLETE':
      return new ContainerIncompleteError({ format: inspection.format });
  }
}

/** Fails in the typed Effect error channel when the policy does not accept an image. */
export function enforceImagePolicy(
  inspection: ImageInspection,
  policy: ImagePolicy = {},
): Effect.Effect<void, ImagePolicyError> {
  const decision = checkImagePolicy(inspection, policy);
  if (decision.outcome === 'accept') return Effect.void;
  const firstIssue = decision.issues[0];
  return firstIssue
    ? Effect.fail(issueToError(inspection, firstIssue))
    : Effect.void;
}

import { Effect } from 'effect';
import {
  AnimationNotAllowedError,
  DimensionsUnknownError,
  FrameLimitExceededError,
  InputTooLargeError,
  InvalidDimensionsError,
  PixelLimitExceededError,
  SourceDimensionExceededError,
  UnsupportedFormatError,
  type ImagePolicyError,
} from './errors.js';
import type {
  ImageFormat,
  ImageInspection,
  SupportedInputFormat,
} from './types.js';

export type UnknownDimensionBehavior = 'fallback' | 'reject';

export interface ImagePolicy {
  readonly allowedFormats?: readonly ImageFormat[];
  readonly maxInputBytes?: number;
  readonly maxSourcePixels?: number;
  readonly maxSourceDimension?: number;
  readonly maxFrames?: number;
  readonly allowAnimation?: boolean;
  readonly unknownDimensions?: UnknownDimensionBehavior;
}

export interface ResolvedImagePolicy {
  readonly allowedFormats: readonly ImageFormat[];
  readonly maxInputBytes: number;
  readonly maxSourcePixels: number;
  readonly maxSourceDimension: number;
  readonly maxFrames: number;
  readonly allowAnimation: boolean;
  readonly unknownDimensions: UnknownDimensionBehavior;
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

const defaultAllowedFormats: readonly SupportedInputFormat[] = [
  'jpeg',
  'png',
  'webp',
  'avif',
  'heic',
  'heif',
];

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
  unknownDimensions: 'fallback',
});

export function resolveImagePolicy(policy: ImagePolicy = {}): ResolvedImagePolicy {
  return {
    allowedFormats: policy.allowedFormats ?? defaultImagePolicy.allowedFormats,
    maxInputBytes: policy.maxInputBytes ?? defaultImagePolicy.maxInputBytes,
    maxSourcePixels: policy.maxSourcePixels ?? defaultImagePolicy.maxSourcePixels,
    maxSourceDimension:
      policy.maxSourceDimension ?? defaultImagePolicy.maxSourceDimension,
    maxFrames: policy.maxFrames ?? defaultImagePolicy.maxFrames,
    allowAnimation: policy.allowAnimation ?? defaultImagePolicy.allowAnimation,
    unknownDimensions:
      policy.unknownDimensions ?? defaultImagePolicy.unknownDimensions,
  };
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
): readonly PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  if (inspection.animated === true && !policy.allowAnimation) {
    issues.push({
      code: 'ANIMATION_NOT_ALLOWED',
      message: 'Animated images are not enabled for this pipeline.',
      details: { frameCount: inspection.frameCount },
    });
  }
  if (inspection.frameCount !== null && inspection.frameCount > policy.maxFrames) {
    issues.push({
      code: 'FRAME_LIMIT_EXCEEDED',
      message: `The image exceeds the ${policy.maxFrames}-frame limit.`,
      details: { actual: inspection.frameCount, maximum: policy.maxFrames },
    });
  }
  return issues;
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
  const rejected = [
    formatPolicyIssue(inspection, policy),
    inputSizeIssue(inspection, policy),
    ...dimensions.rejected,
    ...animationIssues(inspection, policy),
  ].filter(isPolicyIssue);

  if (rejected.length > 0) {
    return { outcome: 'reject', policy, issues: rejected };
  }
  if (dimensions.fallback.length > 0) {
    return { outcome: 'fallback', policy, issues: dimensions.fallback };
  }
  return { outcome: 'accept', policy, issues: [] };
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
      return new DimensionsUnknownError();
    case 'INVALID_DIMENSIONS':
      return new InvalidDimensionsError({
        width: inspection.width ?? 0,
        height: inspection.height ?? 0,
      });
    case 'SOURCE_DIMENSION_EXCEEDED':
      return new SourceDimensionExceededError({
        width: inspection.width ?? 0,
        height: inspection.height ?? 0,
        maximum: Number(issue.details.maximum),
      });
    case 'PIXEL_LIMIT_EXCEEDED':
      return new PixelLimitExceededError({
        actual: inspection.pixels ?? 0,
        maximum: Number(issue.details.maximum),
      });
    case 'ANIMATION_NOT_ALLOWED':
      return new AnimationNotAllowedError({ frameCount: inspection.frameCount });
    case 'FRAME_LIMIT_EXCEEDED':
      return new FrameLimitExceededError({
        actual: inspection.frameCount ?? 0,
        maximum: Number(issue.details.maximum),
      });
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

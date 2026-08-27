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

export const defaultImagePolicy: ResolvedImagePolicy = Object.freeze({
  allowedFormats: defaultAllowedFormats,
  maxInputBytes: 32 * 1024 * 1024,
  maxSourcePixels: 100_000_000,
  maxSourceDimension: 32_768,
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

export function checkImagePolicy(
  inspection: ImageInspection,
  inputPolicy: ImagePolicy = {},
): ImagePolicyDecision {
  const policy = resolveImagePolicy(inputPolicy);
  const rejected: PolicyIssue[] = [];
  const fallback: PolicyIssue[] = [];

  if (!inspection.format || !policy.allowedFormats.includes(inspection.format)) {
    rejected.push({
      code: 'UNSUPPORTED_FORMAT',
      message: inspection.format
        ? `The detected ${inspection.format} format is not allowed by this pipeline.`
        : 'The file format could not be identified.',
      details: { format: inspection.format },
    });
  }

  if (inspection.fileSize > policy.maxInputBytes) {
    rejected.push({
      code: 'INPUT_TOO_LARGE',
      message: `The file exceeds the ${policy.maxInputBytes}-byte input limit.`,
      details: { actual: inspection.fileSize, maximum: policy.maxInputBytes },
    });
  }

  if (inspection.width === null || inspection.height === null) {
    const issue: PolicyIssue = {
      code: 'DIMENSIONS_UNKNOWN',
      message: 'The image dimensions must be resolved before local processing.',
      details: {},
    };
    if (policy.unknownDimensions === 'reject') rejected.push(issue);
    else fallback.push(issue);
  } else if (
    !Number.isSafeInteger(inspection.width) ||
    !Number.isSafeInteger(inspection.height) ||
    inspection.width <= 0 ||
    inspection.height <= 0 ||
    inspection.pixels === null ||
    !Number.isSafeInteger(inspection.pixels)
  ) {
    rejected.push({
      code: 'INVALID_DIMENSIONS',
      message: 'The image declares invalid or unsafe dimensions.',
      details: {
        width: inspection.width,
        height: inspection.height,
        pixels: inspection.pixels,
      },
    });
  } else {
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

    if (inspection.pixels !== null && inspection.pixels > policy.maxSourcePixels) {
      rejected.push({
        code: 'PIXEL_LIMIT_EXCEEDED',
        message: `The image exceeds the ${policy.maxSourcePixels}-pixel source limit.`,
        details: { actual: inspection.pixels, maximum: policy.maxSourcePixels },
      });
    }
  }

  if (inspection.animated === true && !policy.allowAnimation) {
    rejected.push({
      code: 'ANIMATION_NOT_ALLOWED',
      message: 'Animated images are not enabled for this pipeline.',
      details: { frameCount: inspection.frameCount },
    });
  }

  if (inspection.frameCount !== null && inspection.frameCount > policy.maxFrames) {
    rejected.push({
      code: 'FRAME_LIMIT_EXCEEDED',
      message: `The image exceeds the ${policy.maxFrames}-frame limit.`,
      details: { actual: inspection.frameCount, maximum: policy.maxFrames },
    });
  }

  if (rejected.length > 0) {
    return { outcome: 'reject', policy, issues: rejected };
  }
  if (fallback.length > 0) {
    return { outcome: 'fallback', policy, issues: fallback };
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

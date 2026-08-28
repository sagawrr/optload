import type { ImageInspection } from '@optload/core';
import type {
  ImageOutputFormat,
  ImageOutputOptions,
  ResolvedImageOutputOptions,
  TargetDimensions,
} from './types.js';

const outputMediaTypes: Readonly<Record<ImageOutputFormat, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const hardMaxOutputDimension = 32_768;

export function resolveOutputOptions(
  inspection: ImageInspection,
  options: ImageOutputOptions = {},
): ResolvedImageOutputOptions {
  const requested = options.format;
  const format =
    requested === 'jpeg' || requested === 'png' || requested === 'webp'
      ? requested
      : inspection.hasAlpha === true
        ? 'png'
        : 'webp';

  const defaultQuality = format === 'jpeg' ? 0.86 : format === 'webp' ? 0.84 : 1;
  return {
    format,
    mediaType: outputMediaTypes[format],
    maxWidth: positiveInteger(options.maxWidth, 4096),
    maxHeight: positiveInteger(options.maxHeight, 4096),
    quality: finiteClamp(options.quality, defaultQuality, 0, 1),
    background: options.background ?? '#ffffff',
  };
}

export function resolveTargetDimensions(
  inspection: ImageInspection,
  output: ResolvedImageOutputOptions,
): TargetDimensions | null {
  if (inspection.width === null || inspection.height === null) return null;

  const swapsAxes =
    inspection.orientation !== null && inspection.orientation >= 5;
  const sourceWidth = swapsAxes ? inspection.height : inspection.width;
  const sourceHeight = swapsAxes ? inspection.width : inspection.height;
  const scale = Math.min(
    1,
    output.maxWidth / sourceWidth,
    output.maxHeight / sourceHeight,
  );

  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value && Number.isFinite(value) && value > 0
    ? Math.min(hardMaxOutputDimension, Math.max(1, Math.floor(value)))
    : fallback;
}

function finiteClamp(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

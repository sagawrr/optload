import sharp from 'sharp';
import type { OutputInfo, Sharp } from 'sharp';
import type { ChildNormalizeRequest } from './protocol.js';

// This process handles one image and nothing else, so a global loader allowlist
// is safe here. File/URL/unfuzzed loaders remain unavailable even if libvips
// happens to have been compiled with them.
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({
  operation: [
    'VipsForeignLoadJpegBuffer',
    'VipsForeignLoadPngBuffer',
    'VipsForeignLoadWebpBuffer',
    'VipsForeignLoadHeifBuffer',
    'VipsForeignLoadRaw',
  ],
});

/**
 * A failure sharp (or the header guard) can classify. Crosses the process
 * boundary as a plain code plus a truncated message.
 */
export class TaskFailure extends Error {
  constructor(
    readonly code: import('./protocol.js').ChildFailureCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Decode-and-re-encode with libvips, in two explicit stages.
 *
 * Stage 1 decodes to bounded raw pixels: materializing the bitmap is the
 * documented budget (w*h*4 bytes, capped by the request limits), and pixels
 * are the only thing that crosses into stage 2 — container structure,
 * metadata, ICC profiles, and appended bytes cannot survive the boundary.
 * Output is EXIF-oriented upright, resized inside the target box without
 * enlargement, and pinned to 8-bit sRGB.
 */
export async function normalizeWithSharp(
  request: ChildNormalizeRequest,
  expected: { readonly width: number; readonly height: number },
): Promise<Uint8Array> {
  const { output } = request;

  let pixels: { data: Buffer; info: OutputInfo };
  try {
    pixels = await sharp(request.bytes, {
      limitInputPixels: request.limits.maxPixels,
      sequentialRead: true,
      failOn: 'warning',
    })
      .rotate()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new TaskFailure(
      'DECODE_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }

  const { width, height } = pixels.info;
  if (
    width <= 0 ||
    height <= 0 ||
    width > request.limits.maxDimension ||
    height > request.limits.maxDimension ||
    width * height > request.limits.maxPixels
  ) {
    throw new TaskFailure(
      'DECODE_FAILED',
      `The decoded image is ${width}x${height}, beyond the decode budget.`,
    );
  }
  if (width !== expected.width || height !== expected.height) {
    throw new TaskFailure(
      'DECODE_FAILED',
      `The decoded image is ${width}x${height}, but the header declared ${expected.width}x${expected.height}.`,
    );
  }

  try {
    const encoder = encodePixels(pixels, output);
    const encoded = await encoder.toBuffer();
    if (encoded.length > output.maxOutputBytes) {
      throw new Error(
        `Encoded output exceeds the ${output.maxOutputBytes}-byte limit.`,
      );
    }
    return new Uint8Array(encoded);
  } catch (error) {
    throw new TaskFailure(
      'ENCODE_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function encodePixels(
  pixels: { data: Buffer; info: OutputInfo },
  output: ChildNormalizeRequest['output'],
): Sharp {
  const target = outputDimensions(pixels.info.width, pixels.info.height, output);
  const pipeline = sharp(pixels.data, {
    raw: {
      width: pixels.info.width,
      height: pixels.info.height,
      channels: pixels.info.channels,
    },
  }).resize({
    width: target.width,
    height: target.height,
    fit: 'inside',
    withoutEnlargement: true,
  });
  const quality = percent(output.quality);
  switch (output.format) {
    case 'jpeg':
      return pipeline.jpeg({ quality });
    case 'png':
      return pipeline.png();
    case 'webp':
      return pipeline.webp({ quality });
  }
}

function outputDimensions(
  width: number,
  height: number,
  output: ChildNormalizeRequest['output'],
): { readonly width: number; readonly height: number } {
  const scale = Math.min(
    1,
    output.maxWidth / width,
    output.maxHeight / height,
    Math.sqrt(output.maxOutputPixels / (width * height)),
  );
  let targetWidth = Math.max(1, Math.floor(width * scale));
  let targetHeight = Math.max(1, Math.floor(height * scale));
  if (targetWidth * targetHeight > output.maxOutputPixels) {
    if (targetWidth >= targetHeight) {
      targetWidth = Math.max(
        1,
        Math.floor(output.maxOutputPixels / targetHeight),
      );
    } else {
      targetHeight = Math.max(
        1,
        Math.floor(output.maxOutputPixels / targetWidth),
      );
    }
  }
  return { width: targetWidth, height: targetHeight };
}

function percent(quality: number): number {
  return Math.min(100, Math.max(1, Math.round(quality * 100)));
}

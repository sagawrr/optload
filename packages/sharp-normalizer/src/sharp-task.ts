import sharp from 'sharp';
import type { OutputInfo, Sharp } from 'sharp';
import type { ChildNormalizeRequest } from './protocol.js';

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
      .resize({
        width: output.maxWidth,
        height: output.maxHeight,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new TaskFailure(
      'DECODE_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    const encoder = encodePixels(pixels, output);
    const encoded = await encoder.toBuffer();
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
  const pipeline = sharp(pixels.data, {
    raw: {
      width: pixels.info.width,
      height: pixels.info.height,
      channels: pixels.info.channels,
    },
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

function percent(quality: number): number {
  return Math.min(100, Math.max(1, Math.round(quality * 100)));
}

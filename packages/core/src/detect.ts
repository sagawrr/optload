import {
  formatExtensions,
  formatMediaTypes,
  type ExifOrientation,
  type ImageFormat,
  type ImageInspection,
  type InspectionWarning,
} from './types.js';

interface DetectedHeader {
  readonly format: ImageFormat | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly frameCount: number | null;
  readonly animated: boolean | null;
  readonly hasAlpha: boolean | null;
  readonly orientation: ExifOrientation | null;
}

interface DetectContext {
  readonly fileSize: number;
  readonly fileName?: string;
  readonly declaredMediaType?: string;
  readonly headerWasTruncated?: boolean;
}

const jpegStartOfFrameMarkers = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
  0xcf,
]);

const heicBrands = new Set(['heic', 'heix']);
const heicSequenceBrands = new Set(['hevc', 'hevx']);
const heifBrands = new Set(['mif1']);
const heifSequenceBrands = new Set(['msf1']);
const avifBrands = new Set(['avif']);
const avifSequenceBrands = new Set(['avis']);

function byte(bytes: Uint8Array, offset: number): number {
  return bytes[offset] ?? 0;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let result = '';
  const end = Math.min(bytes.length, start + length);
  for (let index = start; index < end; index += 1) {
    result += String.fromCharCode(byte(bytes, index));
  }
  return result;
}

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => byte(bytes, offset + index) === value);
}

function u16be(bytes: Uint8Array, offset: number): number {
  return byte(bytes, offset) * 0x100 + byte(bytes, offset + 1);
}

function u16le(bytes: Uint8Array, offset: number): number {
  return byte(bytes, offset) + byte(bytes, offset + 1) * 0x100;
}

function u24le(bytes: Uint8Array, offset: number): number {
  return (
    byte(bytes, offset) +
    byte(bytes, offset + 1) * 0x100 +
    byte(bytes, offset + 2) * 0x1_0000
  );
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    byte(bytes, offset) * 0x1_000000 +
    byte(bytes, offset + 1) * 0x1_0000 +
    byte(bytes, offset + 2) * 0x100 +
    byte(bytes, offset + 3)
  );
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    byte(bytes, offset) +
    byte(bytes, offset + 1) * 0x100 +
    byte(bytes, offset + 2) * 0x1_0000 +
    byte(bytes, offset + 3) * 0x1_000000
  );
}

function i32le(bytes: Uint8Array, offset: number): number {
  const value = u32le(bytes, offset);
  return value > 0x7fff_ffff ? value - 0x1_0000_0000 : value;
}

function parseExifOrientation(
  bytes: Uint8Array,
  tiffStart: number,
  tiffEnd: number,
): ExifOrientation | null {
  if (tiffStart + 8 > tiffEnd) return null;

  const byteOrder = ascii(bytes, tiffStart, 2);
  const littleEndian = byteOrder === 'II';
  if (!littleEndian && byteOrder !== 'MM') return null;

  const read16 = (offset: number): number =>
    littleEndian ? u16le(bytes, offset) : u16be(bytes, offset);
  const read32 = (offset: number): number =>
    littleEndian ? u32le(bytes, offset) : u32be(bytes, offset);

  if (read16(tiffStart + 2) !== 42) return null;
  const ifdOffset = read32(tiffStart + 4);
  const ifdStart = tiffStart + ifdOffset;
  if (ifdStart + 2 > tiffEnd) return null;

  const entries = Math.min(read16(ifdStart), 256);
  for (let index = 0; index < entries; index += 1) {
    const entry = ifdStart + 2 + index * 12;
    if (entry + 12 > tiffEnd) return null;
    if (read16(entry) !== 0x0112) continue;
    if (read16(entry + 2) !== 3 || read32(entry + 4) < 1) return null;
    const orientation = read16(entry + 8);
    return orientation >= 1 && orientation <= 8
      ? (orientation as ExifOrientation)
      : null;
  }

  return null;
}

function detectJpeg(bytes: Uint8Array): DetectedHeader | null {
  if (!matches(bytes, 0, [0xff, 0xd8, 0xff])) return null;

  let width: number | null = null;
  let height: number | null = null;
  let orientation: ExifOrientation | null = null;
  let offset = 2;

  while (offset + 4 <= bytes.length) {
    while (byte(bytes, offset) === 0xff) offset += 1;
    const marker = byte(bytes, offset);
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;

    const segmentLength = u16be(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;

    const markerStart = offset - 2;
    if (jpegStartOfFrameMarkers.has(marker) && segmentLength >= 7) {
      height = u16be(bytes, markerStart + 5);
      width = u16be(bytes, markerStart + 7);
    }

    const payloadStart = offset + 2;
    if (
      marker === 0xe1 &&
      segmentLength >= 8 &&
      ascii(bytes, payloadStart, 6) === 'Exif\0\0'
    ) {
      orientation = parseExifOrientation(
        bytes,
        payloadStart + 6,
        offset + segmentLength,
      );
    }

    if (width !== null && orientation !== null) break;
    offset += segmentLength;
  }

  return {
    format: 'jpeg',
    width,
    height,
    frameCount: 1,
    animated: false,
    hasAlpha: false,
    orientation,
  };
}

function detectPng(bytes: Uint8Array): DetectedHeader | null {
  if (!matches(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10])) return null;

  const width = bytes.length >= 24 ? u32be(bytes, 16) : null;
  const height = bytes.length >= 24 ? u32be(bytes, 20) : null;
  const colorType = bytes.length >= 26 ? byte(bytes, 25) : null;
  let frameCount = 1;
  let animated = false;
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const next = offset + 12 + length;
    if (!Number.isSafeInteger(next) || next > bytes.length) break;
    if (type === 'acTL' && length >= 8) {
      frameCount = u32be(bytes, offset + 8);
      animated = frameCount > 1;
      break;
    }
    offset = next;
  }

  return {
    format: 'png',
    width,
    height,
    frameCount,
    animated,
    hasAlpha: colorType === 4 || colorType === 6,
    orientation: null,
  };
}

function detectGif(bytes: Uint8Array): DetectedHeader | null {
  const signature = ascii(bytes, 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;

  let frames = 0;
  for (let index = 13; index < bytes.length; index += 1) {
    if (byte(bytes, index) === 0x2c) frames += 1;
  }

  return {
    format: 'gif',
    width: bytes.length >= 10 ? u16le(bytes, 6) : null,
    height: bytes.length >= 10 ? u16le(bytes, 8) : null,
    frameCount: frames > 0 ? frames : null,
    animated: frames > 1 ? true : frames === 1 ? false : null,
    hasAlpha: true,
    orientation: null,
  };
}

function detectWebp(bytes: Uint8Array): DetectedHeader | null {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;

  let width: number | null = null;
  let height: number | null = null;
  let hasAlpha: boolean | null = null;
  let animated: boolean | null = false;
  let frames = 0;
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = u32le(bytes, offset + 4);
    const payload = offset + 8;
    const next = payload + length + (length % 2);
    if (!Number.isSafeInteger(next) || next > bytes.length) break;

    if (type === 'VP8X' && length >= 10) {
      const flags = byte(bytes, payload);
      hasAlpha = (flags & 0x10) !== 0;
      animated = (flags & 0x02) !== 0;
      width = u24le(bytes, payload + 4) + 1;
      height = u24le(bytes, payload + 7) + 1;
    } else if (type === 'VP8 ' && length >= 10) {
      if (matches(bytes, payload + 3, [0x9d, 0x01, 0x2a])) {
        width = u16le(bytes, payload + 6) & 0x3fff;
        height = u16le(bytes, payload + 8) & 0x3fff;
        hasAlpha ??= false;
      }
    } else if (type === 'VP8L' && length >= 5 && byte(bytes, payload) === 0x2f) {
      const bits = u32le(bytes, payload + 1) >>> 0;
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
      hasAlpha = ((bits >>> 28) & 1) === 1;
    } else if (type === 'ANMF') {
      frames += 1;
      animated = true;
    }

    offset = next;
  }

  return {
    format: 'webp',
    width,
    height,
    frameCount: animated ? (frames > 0 ? frames : null) : 1,
    animated,
    hasAlpha,
    orientation: null,
  };
}

const bmffContainerTypes = new Set([
  'meta',
  'iprp',
  'ipco',
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
]);

function findIspeDimensions(
  bytes: Uint8Array,
  start: number,
  end: number,
  depth = 0,
): { width: number; height: number } | null {
  if (depth > 8) return null;
  let offset = start;

  while (offset + 8 <= end && offset + 8 <= bytes.length) {
    let size = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    let headerSize = 8;

    if (size === 1) {
      if (offset + 16 > end || u32be(bytes, offset + 8) !== 0) return null;
      size = u32be(bytes, offset + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }

    if (size < headerSize || offset + size > end || offset + size > bytes.length) {
      return null;
    }

    if (type === 'ispe' && size >= headerSize + 12) {
      return {
        width: u32be(bytes, offset + headerSize + 4),
        height: u32be(bytes, offset + headerSize + 8),
      };
    }

    if (bmffContainerTypes.has(type)) {
      const childStart = offset + headerSize + (type === 'meta' ? 4 : 0);
      const found = findIspeDimensions(bytes, childStart, offset + size, depth + 1);
      if (found) return found;
    }

    offset += size;
  }

  return null;
}

function detectBmff(bytes: Uint8Array): DetectedHeader | null {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp') return null;
  const boxSize = u32be(bytes, 0);
  if (boxSize < 16 || boxSize > bytes.length) return null;

  const brands = new Set<string>([ascii(bytes, 8, 4)]);
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
    brands.add(ascii(bytes, offset, 4));
  }

  const hasBrand = (set: ReadonlySet<string>): boolean =>
    [...brands].some((brand) => set.has(brand));

  let format: ImageFormat | null = null;
  let animated: boolean | null = null;
  if (hasBrand(avifSequenceBrands)) {
    format = 'avif';
    animated = true;
  } else if (hasBrand(avifBrands)) {
    format = 'avif';
    animated = false;
  } else if (hasBrand(heicSequenceBrands)) {
    format = 'heic';
    animated = true;
  } else if (hasBrand(heicBrands)) {
    format = 'heic';
    animated = false;
  } else if (hasBrand(heifSequenceBrands)) {
    format = 'heif';
    animated = true;
  } else if (hasBrand(heifBrands)) {
    format = 'heif';
    animated = null;
  }

  if (!format) return null;
  const dimensions = findIspeDimensions(bytes, boxSize, bytes.length);

  return {
    format,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    frameCount: animated === false ? 1 : null,
    animated,
    hasAlpha: null,
    orientation: null,
  };
}

function detectBmp(bytes: Uint8Array): DetectedHeader | null {
  if (ascii(bytes, 0, 2) !== 'BM') return null;
  const width = bytes.length >= 26 ? Math.abs(i32le(bytes, 18)) : null;
  const height = bytes.length >= 26 ? Math.abs(i32le(bytes, 22)) : null;
  const bitsPerPixel = bytes.length >= 30 ? u16le(bytes, 28) : null;
  return {
    format: 'bmp',
    width,
    height,
    frameCount: 1,
    animated: false,
    hasAlpha: bitsPerPixel === 32,
    orientation: null,
  };
}

function detectTiff(bytes: Uint8Array): DetectedHeader | null {
  const byteOrder = ascii(bytes, 0, 2);
  const littleEndian = byteOrder === 'II';
  if (!littleEndian && byteOrder !== 'MM') return null;

  const read16 = (offset: number): number =>
    littleEndian ? u16le(bytes, offset) : u16be(bytes, offset);
  const read32 = (offset: number): number =>
    littleEndian ? u32le(bytes, offset) : u32be(bytes, offset);
  if (read16(2) !== 42 || bytes.length < 8) return null;

  const ifdStart = read32(4);
  if (ifdStart + 2 > bytes.length) {
    return {
      format: 'tiff', width: null, height: null, frameCount: null,
      animated: null, hasAlpha: null, orientation: null,
    };
  }

  let width: number | null = null;
  let height: number | null = null;
  const entries = Math.min(read16(ifdStart), 256);
  for (let index = 0; index < entries; index += 1) {
    const entry = ifdStart + 2 + index * 12;
    if (entry + 12 > bytes.length) break;
    const tag = read16(entry);
    if (tag !== 256 && tag !== 257) continue;
    const type = read16(entry + 2);
    const value = type === 3 ? read16(entry + 8) : type === 4 ? read32(entry + 8) : null;
    if (tag === 256) width = value;
    if (tag === 257) height = value;
  }

  return {
    format: 'tiff', width, height, frameCount: null,
    animated: null, hasAlpha: null, orientation: null,
  };
}

function detectSvg(bytes: Uint8Array): DetectedHeader | null {
  const text = ascii(bytes, 0, Math.min(bytes.length, 4096))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  if (!text.startsWith('<svg') && !/^<\?xml[\s\S]*?<svg[\s>]/.test(text)) return null;
  return {
    format: 'svg', width: null, height: null, frameCount: 1,
    animated: null, hasAlpha: true, orientation: null,
  };
}

function detectHeader(bytes: Uint8Array): DetectedHeader {
  return (
    detectJpeg(bytes) ??
    detectPng(bytes) ??
    detectWebp(bytes) ??
    detectGif(bytes) ??
    detectBmff(bytes) ??
    detectBmp(bytes) ??
    detectTiff(bytes) ??
    detectSvg(bytes) ?? {
      format: null,
      width: null,
      height: null,
      frameCount: null,
      animated: null,
      hasAlpha: null,
      orientation: null,
    }
  );
}

function extensionFromName(fileName: string | undefined): string | null {
  if (!fileName) return null;
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot < 0 || lastDot === fileName.length - 1) return null;
  return fileName.slice(lastDot + 1).toLowerCase();
}

export function inspectImageBytes(
  bytes: Uint8Array,
  context: DetectContext,
): ImageInspection {
  const detected = detectHeader(bytes);
  const extension = extensionFromName(context.fileName);
  const declaredMediaType = context.declaredMediaType?.toLowerCase() || null;
  const warnings: InspectionWarning[] = [];

  if (
    detected.format &&
    declaredMediaType &&
    declaredMediaType !== formatMediaTypes[detected.format]
  ) {
    warnings.push({
      code: 'declared_type_mismatch',
      message: `The file declares ${declaredMediaType}, but its bytes identify as ${formatMediaTypes[detected.format]}.`,
    });
  }

  if (
    detected.format &&
    extension &&
    !formatExtensions[detected.format].includes(extension)
  ) {
    warnings.push({
      code: 'extension_mismatch',
      message: `The .${extension} extension does not match the detected ${detected.format} format.`,
    });
  }

  if (detected.format && (detected.width === null || detected.height === null)) {
    warnings.push({
      code: 'dimensions_unknown',
      message: 'Dimensions could not be determined from the bounded header inspection.',
    });
  }

  if (detected.format && detected.animated === null) {
    warnings.push({
      code: 'animation_unknown',
      message: 'Animation could not be ruled out from the bounded header inspection.',
    });
  }

  if (context.headerWasTruncated) {
    warnings.push({
      code: 'header_truncated',
      message: 'Only a bounded prefix of the file was inspected.',
    });
  }

  const pixels =
    detected.width !== null && detected.height !== null
      ? detected.width * detected.height
      : null;

  return {
    format: detected.format,
    mediaType: detected.format ? formatMediaTypes[detected.format] : null,
    extension,
    declaredMediaType,
    fileName: context.fileName ?? null,
    fileSize: context.fileSize,
    bytesInspected: bytes.length,
    width: detected.width,
    height: detected.height,
    pixels,
    frameCount: detected.frameCount,
    animated: detected.animated,
    hasAlpha: detected.hasAlpha,
    orientation: detected.orientation,
    warnings,
  };
}


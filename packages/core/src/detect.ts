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
  /** The prefix declared the frame size more than once with conflicting values. */
  readonly dimensionConflict?: boolean;
  /** Bytes continue past the format's terminal marker within the inspected prefix. */
  readonly trailingData?: boolean;
  /** EXIF, XMP, ICC, or textual metadata chunks were seen in the prefix. */
  readonly hasMetadata?: boolean;
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

function isJpegStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

function skipFillBytes(bytes: Uint8Array, offset: number): number {
  while (byte(bytes, offset) === 0xff) offset += 1;
  return offset;
}

interface JpegSofState {
  width: number | null;
  height: number | null;
  count: number;
  conflict: boolean;
}

/**
 * A well-formed JPEG has exactly one SOF. When a prefix hides several, policy
 * must judge the largest frame any marker declares: a decoy small SOF in
 * front of an oversized one is the double-SOF bomb shape.
 */
function noteJpegSof(state: JpegSofState, width: number, height: number): void {
  if (state.count === 0) {
    state.width = width;
    state.height = height;
  } else {
    if (width !== state.width || height !== state.height) state.conflict = true;
    if (width > (state.width ?? 0)) state.width = width;
    if (height > (state.height ?? 0)) state.height = height;
  }
  state.count += 1;
}

function jpegSegmentMetadata(
  bytes: Uint8Array,
  marker: number,
  payloadStart: number,
  segmentLength: number,
): { orientation: ExifOrientation | null; metadata: boolean } {
  if (marker === 0xe1 && segmentLength >= 8) {
    if (ascii(bytes, payloadStart, 6) === 'Exif\0\0') {
      return {
        orientation: parseExifOrientation(
          bytes,
          payloadStart + 6,
          payloadStart - 2 + segmentLength,
        ),
        metadata: true,
      };
    }
    if (
      segmentLength >= 31 &&
      ascii(bytes, payloadStart, 28) === 'http://ns.adobe.com/xap/1.0'
    ) {
      return { orientation: null, metadata: true };
    }
  }
  if (
    marker === 0xe2 &&
    segmentLength >= 14 &&
    ascii(bytes, payloadStart, 11) === 'ICC_PROFILE' &&
    byte(bytes, payloadStart + 11) === 0
  ) {
    return { orientation: null, metadata: true };
  }
  return { orientation: null, metadata: false };
}

function detectJpeg(bytes: Uint8Array): DetectedHeader | null {
  if (!matches(bytes, 0, [0xff, 0xd8, 0xff])) return null;

  const sof: JpegSofState = { width: null, height: null, count: 0, conflict: false };
  let orientation: ExifOrientation | null = null;
  let trailingData = false;
  let hasMetadata = false;
  let offset = 2;

  while (offset + 4 <= bytes.length) {
    offset = skipFillBytes(bytes, offset);
    const marker = byte(bytes, offset);
    offset += 1;
    if (marker === 0xd9) {
      // Entropy data after SOS is opaque to a segment walk, but bytes after
      // EOI are not part of any JPEG structure; they are a classic polyglot
      // and data-leak channel (re-encoding drops them).
      trailingData = offset < bytes.length;
      break;
    }
    if (marker === 0xda) break;
    if (isJpegStandaloneMarker(marker)) continue;
    if (offset + 2 > bytes.length) break;

    const segmentLength = u16be(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;

    const markerStart = offset - 2;
    if (jpegStartOfFrameMarkers.has(marker) && segmentLength >= 7) {
      noteJpegSof(
        sof,
        u16be(bytes, markerStart + 7),
        u16be(bytes, markerStart + 5),
      );
    }

    const segment = jpegSegmentMetadata(
      bytes,
      marker,
      offset + 2,
      segmentLength,
    );
    orientation = orientation ?? segment.orientation;
    hasMetadata = hasMetadata || segment.metadata;

    offset += segmentLength;
  }

  return {
    format: 'jpeg',
    width: sof.width,
    height: sof.height,
    frameCount: 1,
    animated: false,
    hasAlpha: false,
    orientation,
    dimensionConflict: sof.conflict,
    trailingData,
    hasMetadata,
  };
}

interface PngChunkWalk {
  readonly frameCount: number | null;
  readonly animated: boolean | null;
  readonly iendEnd: number | null;
  readonly hasMetadata: boolean;
}

const pngMetadataChunks = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);

function walkPngChunks(bytes: Uint8Array): PngChunkWalk {
  let frameCount: number | null = null;
  let animated: boolean | null = null;
  let iendEnd: number | null = null;
  let hasMetadata = false;
  let sawIdat = false;
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const next = offset + 12 + length;
    if (!Number.isSafeInteger(next) || next > bytes.length) break;
    if (type === 'acTL' && length >= 8 && frameCount === null) {
      frameCount = u32be(bytes, offset + 8);
      animated = frameCount > 1;
    } else if (type === 'IDAT') {
      // Reaching IDAT without a preceding acTL rules animation out; keep
      // walking so IEND and metadata chunks after the image data are seen.
      sawIdat = true;
    } else if (type === 'IEND') {
      iendEnd = next;
      break;
    } else if (pngMetadataChunks.has(type)) {
      hasMetadata = true;
    }
    offset = next;
  }

  if (frameCount === null && sawIdat) {
    frameCount = 1;
    animated = false;
  }

  return { frameCount, animated, iendEnd, hasMetadata };
}

function detectPng(bytes: Uint8Array): DetectedHeader | null {
  if (!matches(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10])) return null;

  const width = bytes.length >= 24 ? u32be(bytes, 16) : null;
  const height = bytes.length >= 24 ? u32be(bytes, 20) : null;
  const colorType = bytes.length >= 26 ? byte(bytes, 25) : null;
  const walk = walkPngChunks(bytes);

  return {
    format: 'png',
    width,
    height,
    frameCount: walk.frameCount,
    animated: walk.animated,
    hasAlpha: colorType === 4 || colorType === 6,
    orientation: null,
    // Anything after IEND is invisible to PNG decoders but survives verbatim
    // storage: it is the appended-payload channel of polyglot and
    // truncated-overwrite leaks.
    trailingData: walk.iendEnd !== null && walk.iendEnd < bytes.length,
    hasMetadata: walk.hasMetadata,
  };
}

function detectGif(bytes: Uint8Array): DetectedHeader | null {
  const signature = ascii(bytes, 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;

  // Frame bookkeeping walks bytes looking for image separators, so the global
  // color table must be skipped first: its palette entries can contain the
  // separator byte and would otherwise invent frames that do not exist.
  const packedField = bytes.length >= 10 ? byte(bytes, 10) : 0;
  const colorTableBytes =
    packedField & 0x80 ? 3 * (2 ** ((packedField & 0x07) + 1)) : 0;
  const scanStart = 13 + colorTableBytes;

  let frames = 0;
  for (let index = scanStart; index < bytes.length; index += 1) {
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

interface WebpHeader {
  width: number | null;
  height: number | null;
  hasAlpha: boolean | null;
  animated: boolean;
  frames: number;
  hasMetadata: boolean;
}

function applyWebpChunk(
  bytes: Uint8Array,
  type: string,
  payload: number,
  length: number,
  header: WebpHeader,
): void {
  if (type === 'EXIF' || type === 'XMP ') header.hasMetadata = true;
  if (type === 'VP8X' && length >= 10) {
    const flags = byte(bytes, payload);
    header.hasAlpha = (flags & 0x10) !== 0;
    header.animated = (flags & 0x02) !== 0;
    header.width = u24le(bytes, payload + 4) + 1;
    header.height = u24le(bytes, payload + 7) + 1;
    return;
  }
  if (type === 'VP8 ' && length >= 10) {
    if (matches(bytes, payload + 3, [0x9d, 0x01, 0x2a])) {
      header.width = u16le(bytes, payload + 6) & 0x3fff;
      header.height = u16le(bytes, payload + 8) & 0x3fff;
      header.hasAlpha ??= false;
    }
    return;
  }
  if (type === 'VP8L' && length >= 5 && byte(bytes, payload) === 0x2f) {
    const bits = u32le(bytes, payload + 1) >>> 0;
    header.width = (bits & 0x3fff) + 1;
    header.height = ((bits >>> 14) & 0x3fff) + 1;
    header.hasAlpha = ((bits >>> 28) & 1) === 1;
    return;
  }
  if (type === 'ANMF') {
    header.frames += 1;
    header.animated = true;
  }
}

function detectWebp(
  bytes: Uint8Array,
  fileSize: number,
): DetectedHeader | null {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;

  const header: WebpHeader = {
    width: null,
    height: null,
    hasAlpha: null,
    animated: false,
    frames: 0,
    hasMetadata: false,
  };
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = u32le(bytes, offset + 4);
    const payload = offset + 8;
    const next = payload + length + (length % 2);
    if (!Number.isSafeInteger(next) || next > bytes.length) break;

    applyWebpChunk(bytes, type, payload, length, header);
    offset = next;
  }

  // A non-zero RIFF size pins the container's end; anything the file carries
  // beyond it is appended data, not WebP structure.
  const declaredSize = u32le(bytes, 4);
  const declaredEnd = declaredSize + 8;
  const trailingData =
    declaredSize > 0 &&
    Number.isSafeInteger(declaredEnd) &&
    bytes.length >= declaredEnd &&
    fileSize > declaredEnd;

  return {
    format: 'webp',
    width: header.width,
    height: header.height,
    frameCount: header.animated ? (header.frames > 0 ? header.frames : null) : 1,
    animated: header.animated,
    hasAlpha: header.hasAlpha,
    orientation: null,
    trailingData,
    hasMetadata: header.hasMetadata,
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

interface BoxHeader {
  readonly size: number;
  readonly headerSize: number;
}

/** Reads a BMFF box length, resolving the 64-bit and to-end-of-stream forms. */
function readBoxHeader(
  bytes: Uint8Array,
  offset: number,
  end: number,
): BoxHeader | null {
  let size = u32be(bytes, offset);
  let headerSize = 8;

  if (size === 1) {
    if (offset + 16 > end || u32be(bytes, offset + 8) !== 0) return null;
    size = u32be(bytes, offset + 12);
    headerSize = 16;
  } else if (size === 0) {
    size = end - offset;
  }

  return { size, headerSize };
}

function findIspeDimensions(
  bytes: Uint8Array,
  start: number,
  end: number,
  flags: { exif: boolean },
  depth = 0,
): { width: number; height: number } | null {
  if (depth > 8) return null;
  let offset = start;

  while (offset + 8 <= end && offset + 8 <= bytes.length) {
    const header = readBoxHeader(bytes, offset, end);
    if (
      !header ||
      header.size < header.headerSize ||
      offset + header.size > end ||
      offset + header.size > bytes.length
    ) {
      return null;
    }

    const type = ascii(bytes, offset + 4, 4);
    if (type === 'Exif') flags.exif = true;
    if (type === 'ispe' && header.size >= header.headerSize + 12) {
      return {
        width: u32be(bytes, offset + header.headerSize + 4),
        height: u32be(bytes, offset + header.headerSize + 8),
      };
    }

    if (bmffContainerTypes.has(type)) {
      const childStart = offset + header.headerSize + (type === 'meta' ? 4 : 0);
      const found = findIspeDimensions(
        bytes,
        childStart,
        offset + header.size,
        flags,
        depth + 1,
      );
      if (found) return found;
    }

    offset += header.size;
  }

  return null;
}

function collectBrands(bytes: Uint8Array, boxSize: number): ReadonlySet<string> {
  const brands = new Set<string>([ascii(bytes, 8, 4)]);
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
    brands.add(ascii(bytes, offset, 4));
  }
  return brands;
}

interface BmffFormat {
  readonly format: ImageFormat;
  readonly animated: boolean | null;
}

function brandFormat(brands: ReadonlySet<string>): BmffFormat | null {
  const has = (set: ReadonlySet<string>): boolean =>
    [...brands].some((brand) => set.has(brand));

  if (has(avifSequenceBrands)) return { format: 'avif', animated: true };
  if (has(avifBrands)) return { format: 'avif', animated: false };
  if (has(heicSequenceBrands)) return { format: 'heic', animated: true };
  if (has(heicBrands)) return { format: 'heic', animated: false };
  if (has(heifSequenceBrands)) return { format: 'heif', animated: true };
  if (has(heifBrands)) return { format: 'heif', animated: null };
  return null;
}

function detectBmff(bytes: Uint8Array): DetectedHeader | null {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp') return null;
  const boxSize = u32be(bytes, 0);
  if (boxSize < 16 || boxSize > bytes.length) return null;

  const identified = brandFormat(collectBrands(bytes, boxSize));
  if (!identified) return null;
  // Best-effort EXIF sighting: the walk only crosses container boxes, so the
  // absence of the warning does not prove the file is metadata-free.
  const flags = { exif: false };
  const dimensions = findIspeDimensions(bytes, boxSize, bytes.length, flags);

  return {
    format: identified.format,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    frameCount: identified.animated === false ? 1 : null,
    animated: identified.animated,
    hasAlpha: null,
    orientation: null,
    hasMetadata: flags.exif,
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

function detectHeader(bytes: Uint8Array, fileSize: number): DetectedHeader {
  return (
    detectJpeg(bytes) ??
    detectPng(bytes) ??
    detectWebp(bytes, fileSize) ??
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

function identityWarnings(
  detected: DetectedHeader,
  extension: string | null,
  declaredMediaType: string | null,
): InspectionWarning[] {
  const warnings: InspectionWarning[] = [];
  const mediaType = detected.format ? formatMediaTypes[detected.format] : null;

  if (detected.format && declaredMediaType && declaredMediaType !== mediaType) {
    warnings.push({
      code: 'declared_type_mismatch',
      message: `The file declares ${declaredMediaType}, but its bytes identify as ${mediaType}.`,
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

  return warnings;
}

function structureWarnings(
  detected: DetectedHeader,
  headerWasTruncated: boolean | undefined,
): InspectionWarning[] {
  const warnings: InspectionWarning[] = [];

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

  if (detected.dimensionConflict) {
    warnings.push({
      code: 'inconsistent_dimensions',
      message:
        'The header declares conflicting frame sizes; the largest declared size was used for policy.',
    });
  }

  if (detected.trailingData) {
    warnings.push({
      code: 'trailing_data',
      message:
        `Bytes continue past the end of the ${detected.format ?? 'image'} structure; ` +
        'they are not part of the image and re-encoding drops them.',
    });
  }

  if (detected.hasMetadata) {
    warnings.push({
      code: 'metadata_present',
      message:
        'The file carries EXIF, XMP, ICC, or text metadata, which can include location data; ' +
        'local re-encoding strips it, a server fallback that stores the original does not.',
    });
  }

  if (headerWasTruncated) {
    warnings.push({
      code: 'header_truncated',
      message: 'Only a bounded prefix of the file was inspected.',
    });
  }

  return warnings;
}

function inspectionWarnings(
  detected: DetectedHeader,
  extension: string | null,
  declaredMediaType: string | null,
  headerWasTruncated: boolean | undefined,
): InspectionWarning[] {
  return [
    ...identityWarnings(detected, extension, declaredMediaType),
    ...structureWarnings(detected, headerWasTruncated),
  ];
}

export function inspectImageBytes(
  bytes: Uint8Array,
  context: DetectContext,
): ImageInspection {
  const detected = detectHeader(bytes, context.fileSize);
  const extension = extensionFromName(context.fileName);
  const declaredMediaType = context.declaredMediaType?.toLowerCase() || null;
  const warnings = inspectionWarnings(
    detected,
    extension,
    declaredMediaType,
    context.headerWasTruncated,
  );

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
    trailingData: detected.trailingData ?? null,
    warnings,
  };
}


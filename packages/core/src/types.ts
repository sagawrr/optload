export const imageFormats = [
  'jpeg',
  'png',
  'webp',
  'avif',
  'heic',
  'heif',
  'gif',
  'bmp',
  'tiff',
  'svg',
] as const;

export type ImageFormat = (typeof imageFormats)[number];

export type SupportedInputFormat =
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'avif'
  | 'heic'
  | 'heif';

export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface BlobLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FileLike {
  readonly size: number;
  readonly name?: string;
  readonly type?: string;
  slice(start?: number, end?: number): BlobLike;
}

export type InspectionWarningCode =
  | 'declared_type_mismatch'
  | 'extension_mismatch'
  | 'dimensions_unknown'
  | 'animation_unknown'
  | 'header_truncated'
  | 'inconsistent_dimensions'
  | 'trailing_data'
  | 'metadata_present';

export interface InspectionWarning {
  readonly code: InspectionWarningCode;
  readonly message: string;
}

export interface ImageInspection {
  readonly format: ImageFormat | null;
  readonly mediaType: string | null;
  readonly extension: string | null;
  readonly declaredMediaType: string | null;
  readonly fileName: string | null;
  readonly fileSize: number;
  readonly bytesInspected: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly pixels: number | null;
  readonly frameCount: number | null;
  readonly animated: boolean | null;
  readonly hasAlpha: boolean | null;
  readonly orientation: ExifOrientation | null;
  /** Bytes continue past the format's terminal marker; null when unknown. */
  readonly trailingData: boolean | null;
  readonly warnings: readonly InspectionWarning[];
}

export interface InspectImageOptions {
  /** Maximum prefix read while inspecting container metadata. */
  readonly maxHeaderBytes?: number;
}

export const formatMediaTypes: Readonly<Record<ImageFormat, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
};

export const formatExtensions: Readonly<Record<ImageFormat, readonly string[]>> = {
  jpeg: ['jpg', 'jpeg', 'jpe'],
  png: ['png'],
  webp: ['webp'],
  avif: ['avif'],
  heic: ['heic'],
  heif: ['heif', 'hif'],
  gif: ['gif'],
  bmp: ['bmp', 'dib'],
  tiff: ['tif', 'tiff'],
  svg: ['svg', 'svgz'],
};

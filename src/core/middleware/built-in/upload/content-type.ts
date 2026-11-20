// What a file is, read from its first bytes, for the upload middleware's
// `verifyContent` option. Covers the formats that have a signature and are
// commonly uploaded; text formats (HTML, SVG, CSV, JSON, ...) have none and
// are not detected here.

export type ContentSignature =
  | 'jpeg'
  | 'png'
  | 'gif'
  | 'webp'
  | 'bmp'
  | 'tiff'
  | 'ico'
  | 'avif'
  | 'heic'
  | 'pdf'
  | 'zip'
  | 'gzip'
  | 'mp4'
  | 'quicktime'
  | 'webm'
  | 'mp3'
  | 'wav'
  | 'ogg'
  | 'flac'
  | 'woff'
  | 'woff2';

const ZIP_BASED = [
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/epub+zip',
  'application/java-archive',
];

// The media types each signature may be declared as; the first is the one a
// stored file's extension is chosen from.
const TYPES: Record<ContentSignature, string[]> = {
  jpeg: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  png: ['image/png', 'image/apng'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  bmp: ['image/bmp', 'image/x-ms-bmp'],
  tiff: ['image/tiff'],
  ico: ['image/x-icon', 'image/vnd.microsoft.icon'],
  avif: ['image/avif'],
  heic: ['image/heic', 'image/heif'],
  pdf: ['application/pdf'],
  zip: ZIP_BASED,
  gzip: ['application/gzip', 'application/x-gzip'],
  mp4: ['video/mp4', 'audio/mp4', 'audio/x-m4a', 'video/x-m4v'],
  quicktime: ['video/quicktime'],
  webm: ['video/webm', 'audio/webm', 'video/x-matroska'],
  mp3: ['audio/mpeg', 'audio/mp3'],
  wav: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
  ogg: ['audio/ogg', 'video/ogg', 'application/ogg'],
  flac: ['audio/flac', 'audio/x-flac'],
  woff: ['font/woff', 'application/font-woff'],
  woff2: ['font/woff2', 'application/font-woff2'],
};

const SIGNATURES_BY_TYPE = new Map<string, ContentSignature[]>();
for (const [signature, types] of Object.entries(TYPES) as Array<[ContentSignature, string[]]>) {
  for (const type of types) {
    const list = SIGNATURES_BY_TYPE.get(type);
    if (list) list.push(signature);
    else SIGNATURES_BY_TYPE.set(type, [signature]);
  }
}
// An .m4a or .mov file may carry either ISO base media brand
SIGNATURES_BY_TYPE.get('video/quicktime')?.push('mp4');
SIGNATURES_BY_TYPE.get('video/mp4')?.push('quicktime');

/** The media type itself: parameters dropped, lower case. */
function mediaType(declared: string): string {
  const semi = declared.indexOf(';');
  return (semi === -1 ? declared : declared.slice(0, semi)).trim().toLowerCase();
}

/**
 * The signatures a file declared as `type` may carry, or undefined when the
 * type has none to check (text formats, unknown binary formats).
 */
export function signaturesForType(type: string): ContentSignature[] | undefined {
  return SIGNATURES_BY_TYPE.get(mediaType(type));
}

/** The media types a file carrying `signature` may be declared as. */
export function typesForSignature(signature: ContentSignature): string[] {
  return TYPES[signature];
}

function ascii(data: Buffer, offset: number, text: string): boolean {
  if (data.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (data[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function bytes(data: Buffer, offset: number, expected: number[]): boolean {
  if (data.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (data[offset + i] !== expected[i]) return false;
  }
  return true;
}

const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];

/** The format `data` starts as, or undefined when it has no known signature. */
export function contentSignature(data: Buffer): ContentSignature | undefined {
  if (!Buffer.isBuffer(data) || data.length < 2) return undefined;

  if (bytes(data, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (bytes(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (ascii(data, 0, 'GIF87a') || ascii(data, 0, 'GIF89a')) return 'gif';
  if (ascii(data, 0, 'RIFF')) {
    if (ascii(data, 8, 'WEBP')) return 'webp';
    if (ascii(data, 8, 'WAVE')) return 'wav';
    return undefined;
  }
  if (ascii(data, 0, '%PDF-')) return 'pdf';
  if (bytes(data, 0, [0x50, 0x4b, 0x03, 0x04]) || bytes(data, 0, [0x50, 0x4b, 0x05, 0x06])) {
    return 'zip';
  }
  if (bytes(data, 0, [0x1f, 0x8b, 0x08])) return 'gzip';
  // ISO base media: a box size, then `ftyp` and the major brand
  if (ascii(data, 4, 'ftyp')) {
    const brand = data.toString('latin1', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (HEIC_BRANDS.includes(brand)) return 'heic';
    if (brand === 'qt  ') return 'quicktime';
    return 'mp4';
  }
  if (bytes(data, 0, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  if (ascii(data, 0, 'OggS')) return 'ogg';
  if (ascii(data, 0, 'fLaC')) return 'flac';
  if (ascii(data, 0, 'wOFF')) return 'woff';
  if (ascii(data, 0, 'wOF2')) return 'woff2';
  if (bytes(data, 0, [0x49, 0x49, 0x2a, 0x00]) || bytes(data, 0, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'tiff';
  }
  if (bytes(data, 0, [0x00, 0x00, 0x01, 0x00])) return 'ico';
  if (ascii(data, 0, 'ID3')) return 'mp3';
  // An MPEG audio frame header: 11 sync bits, then a layer that is not 00
  if (
    data[0] === 0xff &&
    ((data[1] as number) & 0xe0) === 0xe0 &&
    ((data[1] as number) & 0x06) !== 0
  ) {
    return 'mp3';
  }
  if (ascii(data, 0, 'BM') && data.length >= 14) return 'bmp';
  return undefined;
}

// File extension to media type, for the helpers and middleware that serve
// files from disk by name (`staticFiles`, `res.sendRange`).

export const FILE_MIME_TYPES: Record<string, string> = {
  // Documents / text
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xhtml': 'application/xhtml+xml',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
  '.map': 'application/json',
  '.json': 'application/json',
  '.jsonld': 'application/ld+json',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  // Images
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  // Fonts
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  // Audio / video
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.weba': 'audio/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  // Archives
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
};

const TEXT_TYPES = [
  'text/',
  'application/json',
  'application/javascript',
  'application/xml',
  'application/yaml',
  'image/svg+xml',
];

/** `mimeType`, with `; charset=utf-8` when it is a text format. */
export function withTextCharset(mimeType: string): string {
  const needsCharset =
    TEXT_TYPES.some(type => mimeType.startsWith(type)) ||
    mimeType.endsWith('+json') ||
    mimeType.endsWith('+xml');
  return needsCharset ? `${mimeType}; charset=utf-8` : mimeType;
}

/**
 * The `Content-Type` for a file served under this name: by extension, with a
 * charset for text formats, and `application/octet-stream` for an extension
 * that is not in the table.
 */
export function contentTypeForFile(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const ext = dot > slash + 1 ? filePath.slice(dot).toLowerCase() : '';
  return withTextCharset(FILE_MIME_TYPES[ext] || 'application/octet-stream');
}

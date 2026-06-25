import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import path from 'path';

export const IMAGE_CONTENT_TYPES = new Map([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['bmp', 'image/bmp'],
]);

const IMAGE_CONTENT_TYPE_ALIASES = new Map([
  ['jpg', new Set(['image/jpeg', 'image/jpg', 'image/pjpeg'])],
  ['jpeg', new Set(['image/jpeg', 'image/jpg', 'image/pjpeg'])],
  ['png', new Set(['image/png', 'image/x-png'])],
  ['gif', new Set(['image/gif'])],
  ['webp', new Set(['image/webp'])],
  ['bmp', new Set(['image/bmp', 'image/x-ms-bmp'])],
]);

export function getAllowedImageExtension(filename) {
  if (!filename || typeof filename !== 'string') {
    return null;
  }

  const ext = path.extname(filename).replace('.', '').toLowerCase();
  return IMAGE_CONTENT_TYPES.has(ext) ? ext : null;
}

export function normalizeImageContentType(ext, contentType) {
  const defaultContentType = IMAGE_CONTENT_TYPES.get(ext);
  if (!defaultContentType) {
    return null;
  }

  if (contentType === undefined || contentType === null || contentType === '') {
    return defaultContentType;
  }

  if (typeof contentType !== 'string') {
    return null;
  }

  const normalized = contentType.split(';', 1)[0].trim().toLowerCase();
  if (!normalized.startsWith('image/')) {
    return null;
  }

  const aliases = IMAGE_CONTENT_TYPE_ALIASES.get(ext);
  return aliases?.has(normalized) ? defaultContentType : null;
}

export function buildPutObjectCommandInput(bucket, key) {
  return { Bucket: bucket, Key: key };
}

export async function generatePresignedUrls({ s3Client, bucket, key, contentType, expiresIn }) {
  const putUrl = await getSignedUrl(
    s3Client,
    new PutObjectCommand(buildPutObjectCommandInput(bucket, key)),
    { expiresIn }
  );
  const getUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn }
  );

  return {
    uploadUrl: putUrl,
    publicUrl: getUrl,
    uploadHeaders: { 'Content-Type': contentType },
  };
}

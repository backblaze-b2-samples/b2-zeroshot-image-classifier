import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import path from 'path';

const SUPPORTED_IMAGE_TYPES = [
  {
    extensions: ['jpg', 'jpeg'],
    contentType: 'image/jpeg',
    aliases: ['image/jpg', 'image/pjpeg'],
  },
  { extensions: ['png'], contentType: 'image/png', aliases: ['image/x-png'] },
  { extensions: ['gif'], contentType: 'image/gif', aliases: [] },
  { extensions: ['webp'], contentType: 'image/webp', aliases: [] },
  { extensions: ['bmp'], contentType: 'image/bmp', aliases: ['image/x-ms-bmp'] },
];

const IMAGE_CONTENT_TYPES = new Map(
  SUPPORTED_IMAGE_TYPES.flatMap(({ extensions, contentType }) =>
    extensions.map((ext) => [ext, contentType])
  )
);

const IMAGE_CONTENT_TYPE_ALIASES = new Map(
  SUPPORTED_IMAGE_TYPES.flatMap(({ extensions, contentType, aliases }) =>
    extensions.map((ext) => [ext, new Set([contentType, ...aliases])])
  )
);

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

export async function generatePresignedUrls({
  s3Client,
  bucket,
  key,
  contentType,
  expiresIn,
  signingDate,
}) {
  if (!contentType || typeof contentType !== 'string') {
    throw new Error('contentType is required for presigned uploads');
  }

  const signOptions = { expiresIn };
  if (signingDate) {
    signOptions.signingDate = signingDate;
  }

  const putUrl = await getSignedUrl(
    s3Client,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { ...signOptions, signableHeaders: new Set(['content-type']) }
  );
  const getUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    signOptions
  );

  return {
    uploadUrl: putUrl,
    publicUrl: getUrl,
    uploadHeaders: { 'Content-Type': contentType },
  };
}

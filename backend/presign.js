import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
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

function decodeBase64UrlJson(value) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function signPayload(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function signaturesMatch(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

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

export function validateUploadContentLength(contentLength, maxBytes) {
  const normalized =
    typeof contentLength === 'string' && contentLength.trim() !== ''
      ? Number(contentLength)
      : contentLength;

  if (
    !Number.isSafeInteger(normalized) ||
    normalized <= 0 ||
    normalized > maxBytes
  ) {
    return null;
  }

  return normalized;
}

export function createResultUploadGrant({
  fileId,
  secret,
  ttlSeconds,
  now = Date.now(),
  grantId = randomUUID(),
}) {
  if (
    !fileId ||
    !secret ||
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds <= 0
  ) {
    return null;
  }

  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      fileId,
      grantId,
      exp: Math.floor(now / 1000) + ttlSeconds,
    })
  ).toString('base64url');
  const signature = signPayload(payload, secret);
  return `${payload}.${signature}`;
}

export function verifyResultUploadGrant({
  grant,
  fileId,
  secret,
  now = Date.now(),
}) {
  if (!grant || typeof grant !== 'string' || !fileId || !secret) {
    return null;
  }

  const [payload, signature] = grant.split('.');
  if (!payload || !signature || grant.split('.').length !== 2) {
    return null;
  }

  const expectedSignature = signPayload(payload, secret);
  if (!signaturesMatch(signature, expectedSignature)) {
    return null;
  }

  const parsed = decodeBase64UrlJson(payload);
  if (
    !parsed ||
    parsed.v !== 1 ||
    parsed.fileId !== fileId ||
    !parsed.grantId ||
    parsed.exp <= Math.floor(now / 1000)
  ) {
    return null;
  }

  return parsed;
}

export async function generatePresignedUrls({
  s3Client,
  bucket,
  key,
  contentType,
  contentLength,
  expiresIn,
  signingDate,
}) {
  if (!contentType || typeof contentType !== 'string') {
    throw new Error('contentType is required for presigned uploads');
  }
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    throw new Error('contentLength is required for presigned uploads');
  }

  const signOptions = { expiresIn };
  if (signingDate) {
    signOptions.signingDate = signingDate;
  }

  const putUrl = await getSignedUrl(
    s3Client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    }),
    {
      ...signOptions,
      signableHeaders: new Set(['content-length', 'content-type']),
    }
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
    contentLength,
  };
}

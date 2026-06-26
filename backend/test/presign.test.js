import assert from 'node:assert/strict';
import { test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import {
  createResultUploadGrant,
  generatePresignedUrls,
  getAllowedImageExtension,
  normalizeImageContentType,
  validateUploadContentLength,
  verifyResultUploadGrant,
} from '../presign.js';

const SIGNING_DATE = new Date('2026-01-01T00:00:00Z');
const NOW = Date.parse('2026-01-01T00:00:00Z');
const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

function createClient() {
  return new S3Client({
    endpoint: 'https://s3.us-west-002.backblazeb2.com',
    region: 'us-west-002',
    credentials: {
      accessKeyId: 'dummy-key-id',
      secretAccessKey: 'dummy-application-key',
    },
    forcePathStyle: true,
  });
}

function getSignature(url) {
  return new URL(url).searchParams.get('X-Amz-Signature');
}

function getSignedHeaders(url) {
  return new URL(url).searchParams.get('X-Amz-SignedHeaders')?.split(';');
}

test('extracts allowed image extensions case-insensitively', () => {
  assert.equal(getAllowedImageExtension('photo.JPG'), 'jpg');
  assert.equal(getAllowedImageExtension('diagram.webp'), 'webp');
  assert.equal(getAllowedImageExtension('script.js'), null);
  assert.equal(getAllowedImageExtension(''), null);
});

test('normalizes image content types to the extension canonical type', () => {
  assert.equal(normalizeImageContentType('jpg', 'image/jpg'), 'image/jpeg');
  assert.equal(normalizeImageContentType('png', 'image/png; charset=utf-8'), 'image/png');
  assert.equal(normalizeImageContentType('bmp', 'image/x-ms-bmp'), 'image/bmp');
  assert.equal(normalizeImageContentType('gif'), 'image/gif');
});

test('rejects invalid or mismatched image content types', () => {
  assert.equal(normalizeImageContentType('jpg', 'text/plain'), null);
  assert.equal(normalizeImageContentType('jpg', 'image/png'), null);
  assert.equal(normalizeImageContentType('png', 42), null);
  assert.equal(normalizeImageContentType('svg', 'image/svg+xml'), null);
});

test('validates upload sizes before presigning', () => {
  assert.equal(validateUploadContentLength(1024, MAX_IMAGE_UPLOAD_BYTES), 1024);
  assert.equal(validateUploadContentLength('2048', MAX_IMAGE_UPLOAD_BYTES), 2048);
  assert.equal(validateUploadContentLength(0, MAX_IMAGE_UPLOAD_BYTES), null);
  assert.equal(
    validateUploadContentLength(MAX_IMAGE_UPLOAD_BYTES + 1, MAX_IMAGE_UPLOAD_BYTES),
    null
  );
});

test('result upload grants are tied to server-issued file IDs', () => {
  const secret = 'test-secret';
  const fileId = '11111111-1111-4111-8111-111111111111';
  const otherFileId = '22222222-2222-4222-8222-222222222222';
  const grant = createResultUploadGrant({
    fileId,
    secret,
    ttlSeconds: 3600,
    now: NOW,
    grantId: 'grant-id',
  });

  assert.equal(
    verifyResultUploadGrant({ grant: null, fileId, secret, now: NOW }),
    null
  );
  assert.equal(
    verifyResultUploadGrant({ grant, fileId: otherFileId, secret, now: NOW }),
    null
  );
  assert.equal(
    verifyResultUploadGrant({ grant: `${grant}x`, fileId, secret, now: NOW }),
    null
  );
  assert.equal(
    verifyResultUploadGrant({ grant, fileId, secret, now: NOW + 3601 * 1000 }),
    null
  );
  assert.equal(
    verifyResultUploadGrant({ grant, fileId, secret, now: NOW + 3600 * 1000 }),
    null
  );
  assert.equal(
    verifyResultUploadGrant({ grant, fileId, secret, now: NOW })?.grantId,
    'grant-id'
  );
});

test('presigned PUT URL signs the required upload headers', async () => {
  const { uploadUrl, publicUrl, uploadHeaders } = await generatePresignedUrls({
    s3Client: createClient(),
    bucket: 'bucket-name',
    key: 'images/id.jpg',
    contentType: 'image/jpeg',
    contentLength: 1024,
    expiresIn: 3600,
    signingDate: SIGNING_DATE,
  });

  assert.deepEqual(getSignedHeaders(uploadUrl), [
    'content-length',
    'content-type',
    'host',
  ]);
  assert.deepEqual(getSignedHeaders(publicUrl), ['host']);
  assert.deepEqual(uploadHeaders, { 'Content-Type': 'image/jpeg' });
});

test('mismatched PUT content type cannot reuse the presigned signature', async () => {
  const client = createClient();
  const allowedUploads = [
    { key: 'images/id.jpg', contentType: 'image/jpeg', contentLength: 1024 },
    { key: 'results/id.json', contentType: 'application/json', contentLength: 512 },
  ];

  for (const allowedUpload of allowedUploads) {
    const signedUpload = await generatePresignedUrls({
      s3Client: client,
      bucket: 'bucket-name',
      ...allowedUpload,
      expiresIn: 3600,
      signingDate: SIGNING_DATE,
    });
    const activeContentUpload = await generatePresignedUrls({
      s3Client: client,
      bucket: 'bucket-name',
      key: allowedUpload.key,
      contentType: 'text/html',
      contentLength: allowedUpload.contentLength,
      expiresIn: 3600,
      signingDate: SIGNING_DATE,
    });
    const oversizedUpload = await generatePresignedUrls({
      s3Client: client,
      bucket: 'bucket-name',
      key: allowedUpload.key,
      contentType: allowedUpload.contentType,
      contentLength: allowedUpload.contentLength + 1,
      expiresIn: 3600,
      signingDate: SIGNING_DATE,
    });

    assert.deepEqual(getSignedHeaders(signedUpload.uploadUrl), [
      'content-length',
      'content-type',
      'host',
    ]);
    assert.deepEqual(getSignedHeaders(signedUpload.publicUrl), ['host']);
    assert.notEqual(
      getSignature(signedUpload.uploadUrl),
      getSignature(activeContentUpload.uploadUrl)
    );
    assert.notEqual(
      getSignature(signedUpload.uploadUrl),
      getSignature(oversizedUpload.uploadUrl)
    );
  }
});

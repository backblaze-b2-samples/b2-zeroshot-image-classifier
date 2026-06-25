import assert from 'node:assert/strict';
import { test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import {
  generatePresignedUrls,
  getAllowedImageExtension,
  normalizeImageContentType,
} from '../presign.js';

const SIGNING_DATE = new Date('2026-01-01T00:00:00Z');

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

test('presigned PUT URL signs the required content-type header', async () => {
  const { uploadUrl, uploadHeaders } = await generatePresignedUrls({
    s3Client: createClient(),
    bucket: 'bucket-name',
    key: 'images/id.jpg',
    contentType: 'image/jpeg',
    expiresIn: 3600,
    signingDate: SIGNING_DATE,
  });

  assert.deepEqual(getSignedHeaders(uploadUrl), ['content-type', 'host']);
  assert.deepEqual(uploadHeaders, { 'Content-Type': 'image/jpeg' });
});

test('mismatched PUT content type cannot reuse the presigned signature', async () => {
  const client = createClient();
  const allowedUploads = [
    { key: 'images/id.jpg', contentType: 'image/jpeg' },
    { key: 'results/id.json', contentType: 'application/json' },
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
      expiresIn: 3600,
      signingDate: SIGNING_DATE,
    });

    assert.deepEqual(getSignedHeaders(signedUpload.uploadUrl), ['content-type', 'host']);
    assert.notEqual(getSignature(signedUpload.uploadUrl), getSignature(activeContentUpload.uploadUrl));
  }
});

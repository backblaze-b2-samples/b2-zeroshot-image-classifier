import assert from 'node:assert/strict';
import { test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import {
  buildPutObjectCommandInput,
  generatePresignedUrls,
  getAllowedImageExtension,
  normalizeImageContentType,
} from '../presign.js';

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

test('does not bind content-type into the signed PUT request', () => {
  assert.deepEqual(buildPutObjectCommandInput('bucket-name', 'images/id.jpg'), {
    Bucket: 'bucket-name',
    Key: 'images/id.jpg',
  });
});

test('presigned PUT URL omits content-type from signed headers', async () => {
  const client = new S3Client({
    endpoint: 'https://s3.us-west-002.backblazeb2.com',
    region: 'us-west-002',
    credentials: {
      accessKeyId: 'dummy-key-id',
      secretAccessKey: 'dummy-application-key',
    },
    forcePathStyle: true,
  });

  const { uploadUrl, uploadHeaders } = await generatePresignedUrls({
    s3Client: client,
    bucket: 'bucket-name',
    key: 'images/id.jpg',
    contentType: 'image/jpeg',
    expiresIn: 3600,
  });
  const signedUrl = new URL(uploadUrl);

  assert.equal(signedUrl.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.equal(signedUrl.searchParams.has('Content-Type'), false);
  assert.deepEqual(uploadHeaders, { 'Content-Type': 'image/jpeg' });
});

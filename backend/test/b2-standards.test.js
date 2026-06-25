import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { buildPublicUrl, createB2S3Client, getB2Config } from '../b2-config.js';

const MANAGED_ENV_KEYS = [
  'B2_APPLICATION_KEY_ID',
  'B2_APPLICATION_KEY',
  'B2_BUCKET_NAME',
  'B2_REGION',
  'B2_PUBLIC_URL_BASE',
  'B2_KEY_ID',
  'B2_APP_KEY',
  'B2_BUCKET',
  'B2_ENDPOINT',
  'AUTO_SETUP_CORS',
  'PORT',
];
const REGION_ONE = ['us', 'west', '002'].join('-');
const REGION_TWO = ['us', 'west', '004'].join('-');
const endpointForRegion = (region) => `https://s3.${region}.backblazeb2.com`;

process.env.B2_APPLICATION_KEY_ID = 'server-key-id';
process.env.B2_APPLICATION_KEY = 'server-application-key';
process.env.B2_BUCKET_NAME = 'server-bucket';
process.env.B2_REGION = REGION_ONE;
process.env.B2_PUBLIC_URL_BASE = 'https://cdn.example/classifier';
process.env.AUTO_SETUP_CORS = 'false';

const { app } = await import('../server.js');

async function withEnv(values, fn) {
  const previous = new Map(MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, values);

  try {
    return await fn();
  } finally {
    for (const key of MANAGED_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function assertNoPresignUrls(body) {
  assert.equal(body.uploadUrl, undefined);
  assert.equal(body.publicUrl, undefined);
}

test('B2 config accepts legacy env names during migration', async () => {
  await withEnv({
    B2_ENDPOINT: endpointForRegion(REGION_ONE),
    B2_KEY_ID: 'legacy-key-id',
    B2_APP_KEY: 'legacy-application-key',
    B2_BUCKET: 'legacy-bucket',
  }, () => {
    const config = getB2Config();
    assert.equal(config.applicationKeyId, 'legacy-key-id');
    assert.equal(config.applicationKey, 'legacy-application-key');
    assert.equal(config.bucketName, 'legacy-bucket');
    assert.equal(config.region, REGION_ONE);
    assert.equal(config.endpoint, endpointForRegion(REGION_ONE));
  });
});

test('B2 config gives standardized env names precedence', async () => {
  await withEnv({
    B2_APPLICATION_KEY_ID: 'new-key-id',
    B2_APPLICATION_KEY: 'new-application-key',
    B2_BUCKET_NAME: 'new-bucket',
    B2_REGION: REGION_TWO,
    B2_KEY_ID: 'legacy-key-id',
    B2_APP_KEY: 'legacy-application-key',
    B2_BUCKET: 'legacy-bucket',
    B2_ENDPOINT: endpointForRegion(REGION_ONE),
  }, () => {
    const config = getB2Config();
    assert.equal(config.applicationKeyId, 'new-key-id');
    assert.equal(config.applicationKey, 'new-application-key');
    assert.equal(config.bucketName, 'new-bucket');
    assert.equal(config.region, REGION_TWO);
    assert.equal(config.endpoint, endpointForRegion(REGION_TWO));
  });
});

test('B2 client sends the Backblaze sample user-agent marker', async () => {
  let observedUserAgent = '';
  const captureServer = http.createServer((req, res) => {
    observedUserAgent = req.headers['user-agent'] || '';
    res.writeHead(200);
    res.end();
  });

  captureServer.listen(0, '127.0.0.1');
  await once(captureServer, 'listening');

  try {
    const { port } = captureServer.address();
    const { s3Client } = createB2S3Client({
      endpoint: `http://127.0.0.1:${port}`,
      region: REGION_ONE,
      applicationKeyId: 'key-id',
      applicationKey: 'application-key',
      bucketName: 'bucket-name',
      publicUrlBase: '',
    });

    await s3Client.send(new HeadBucketCommand({ Bucket: 'bucket-name' }));
    assert.match(observedUserAgent, /\(backblaze-b2-samples\)/);
  } finally {
    captureServer.close();
    await once(captureServer, 'close');
  }
});

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  server.close();
  await once(server, 'close');
});

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

async function issueImageToken(filename = 'photo.jpg') {
  const response = await postJson('/api/presign-image', {
    filename,
    contentType: 'image/jpeg',
  });
  assert.equal(response.status, 200);
  assert.match(response.body.fileId, /^[0-9a-f-]{36}$/);
  assert.equal(typeof response.body.resultUploadToken, 'string');
  return response.body;
}

test('presign-result rejects an unknown result upload token', async () => {
  const response = await postJson('/api/presign-result', {
    fileId: '00000000-0000-4000-8000-000000000000',
    resultUploadToken: 'not-issued',
  });

  assert.equal(response.status, 403);
  assertNoPresignUrls(response.body);
});

test('presign-result rejects a token issued for another fileId', async () => {
  const first = await issueImageToken('first.jpg');
  const second = await issueImageToken('second.jpg');
  const response = await postJson('/api/presign-result', {
    fileId: second.fileId,
    resultUploadToken: first.resultUploadToken,
  });

  assert.equal(response.status, 403);
  assertNoPresignUrls(response.body);
});

test('presign-result accepts a valid signed result upload token', async () => {
  const image = await issueImageToken();
  const success = await postJson('/api/presign-result', {
    fileId: image.fileId,
    resultUploadToken: image.resultUploadToken,
  });

  assert.equal(success.status, 200);
  assert.equal(success.body.urlType, 'public');
  assert.equal(success.body.expiresIn, null);
  assert.deepEqual(success.body.uploadHeaders, { 'If-None-Match': '*' });
  assert.match(success.body.uploadUrl, /^https:\/\//);
  assert.equal(success.body.publicUrl, `${buildPublicUrl('https://cdn.example/classifier', `results/${image.fileId}.json`)}`);
});

test('presign-result rejects a tampered signed result upload token', async () => {
  const image = await issueImageToken();
  const lastCharacter = image.resultUploadToken.at(-1);
  const replacement = lastCharacter === 'a' ? 'b' : 'a';
  const tamperedToken = `${image.resultUploadToken.slice(0, -1)}${replacement}`;

  const response = await postJson('/api/presign-result', {
    fileId: image.fileId,
    resultUploadToken: tamperedToken,
  });

  assert.equal(response.status, 403);
  assertNoPresignUrls(response.body);
});

test('presign-result rejects tokens with extra segments', async () => {
  const image = await issueImageToken();
  const response = await postJson('/api/presign-result', {
    fileId: image.fileId,
    resultUploadToken: `${image.resultUploadToken}.extra`,
  });

  assert.equal(response.status, 403);
  assertNoPresignUrls(response.body);
});

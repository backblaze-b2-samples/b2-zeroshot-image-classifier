import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  'CORS_ORIGIN',
  'MAX_RESULT_UPLOAD_TOKENS',
  'PRESIGN_RATE_LIMIT_MAX',
  'PRESIGN_RATE_LIMIT_WINDOW_MS',
  'PORT',
];
const REGION_ONE = ['us', 'west', '002'].join('-');
const REGION_TWO = ['us', 'west', '004'].join('-');
const IMAGE_CONTENT_LENGTH = 1024;
const RESULT_CONTENT_LENGTH = 512;
const endpointForRegion = (region) => `https://s3.${region}.backblazeb2.com`;

process.env.B2_APPLICATION_KEY_ID = 'server-key-id';
process.env.B2_APPLICATION_KEY = 'server-application-key';
process.env.B2_BUCKET_NAME = 'server-bucket';
process.env.B2_REGION = REGION_ONE;
process.env.B2_PUBLIC_URL_BASE = 'https://cdn.example/classifier';
process.env.AUTO_SETUP_CORS = 'false';

const { createApp } = await import('../server.js');

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

test('server module imports without configured B2 env', () => {
  const env = { ...process.env };
  for (const key of MANAGED_ENV_KEYS) {
    delete env[key];
  }

  const result = spawnSync(
    process.execPath,
    ['-e', "import('./server.js').then(() => process.stdout.write('ok'))"],
    { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ok');
});

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
    assert.equal((observedUserAgent.match(/backblaze-b2-samples/g) || []).length, 1);
  } finally {
    captureServer.close();
    await once(captureServer, 'close');
  }
});

let server;
let baseUrl;
let app;
let s3Server;
let testB2;
const grantMarkers = new Map();

test.before(async () => {
  s3Server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const pathParts = requestUrl.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const grantPrefixIndex = pathParts.indexOf('_result-upload-grants');
    const keyParts = grantPrefixIndex >= 0 ? pathParts.slice(grantPrefixIndex) : pathParts.slice(1);
    const key = keyParts.join('/');

    function send(status, headers = {}) {
      req.resume();
      res.writeHead(status, headers);
      res.end();
    }

    if (key.startsWith('_result-upload-grants/')) {
      if (req.method === 'HEAD') {
        const metadata = grantMarkers.get(key);
        if (!metadata) {
          send(404);
          return;
        }
        send(200, Object.fromEntries(
          Object.entries(metadata).map(([metadataKey, value]) => [`x-amz-meta-${metadataKey}`, String(value)])
        ));
        return;
      }

      if (req.method === 'PUT') {
        if (grantMarkers.has(key)) {
          send(412);
          return;
        }

        const metadata = Object.fromEntries(
          Object.entries(req.headers)
            .filter(([header]) => header.startsWith('x-amz-meta-'))
            .map(([header, value]) => [header.replace('x-amz-meta-', ''), value])
        );
        grantMarkers.set(key, metadata);
        send(200);
        return;
      }
    }

    send(200);
  });
  s3Server.listen(0, '127.0.0.1');
  await once(s3Server, 'listening');
  const { port: s3Port } = s3Server.address();
  testB2 = createB2S3Client({
    endpoint: `http://127.0.0.1:${s3Port}`,
    region: REGION_ONE,
    applicationKeyId: 'server-key-id',
    applicationKey: 'server-application-key',
    bucketName: 'server-bucket',
    publicUrlBase: 'https://cdn.example/classifier',
  });
  app = createApp({ b2: testB2 });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  server.close();
  await once(server, 'close');
  s3Server.close();
  await once(s3Server, 'close');
});

async function postJson(path, body) {
  return postJsonTo(baseUrl, path, body);
}

async function postJsonTo(targetBaseUrl, path, body) {
  const response = await fetch(`${targetBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

async function optionsTo(targetBaseUrl, path, origin) {
  return fetch(`${targetBaseUrl}${path}`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
    },
  });
}

async function withStartedApp(testApp, fn) {
  const testServer = testApp.listen(0, '127.0.0.1');
  await once(testServer, 'listening');
  const { port } = testServer.address();

  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    testServer.close();
    await once(testServer, 'close');
  }
}

test('CORS denies cross-origin requests by default', async () => {
  await withEnv({ CORS_ORIGIN: '' }, async () => {
    await withStartedApp(createApp({ b2: testB2 }), async (targetBaseUrl) => {
      const response = await optionsTo(targetBaseUrl, '/api/presign-image', 'https://app.example');

      assert.equal(response.headers.get('access-control-allow-origin'), null);
    });
  });
});

test('CORS allows only configured origins', async () => {
  await withEnv({
    CORS_ORIGIN: 'https://app.example, https://admin.example, javascript:alert(1)',
  }, async () => {
    await withStartedApp(createApp({ b2: testB2 }), async (targetBaseUrl) => {
      const allowed = await optionsTo(targetBaseUrl, '/api/presign-image', 'https://app.example');
      const denied = await optionsTo(targetBaseUrl, '/api/presign-image', 'https://evil.example');

      assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example');
      assert.equal(denied.headers.get('access-control-allow-origin'), null);
    });
  });
});

test('presign endpoints are rate-limited', async () => {
  await withStartedApp(createApp({
    b2: testB2,
    presignRateLimitMax: 1,
    presignRateLimitWindowMs: 60 * 1000,
  }), async (targetBaseUrl) => {
    const first = await postJsonTo(targetBaseUrl, '/api/presign-result', {
      fileId: 'invalid',
      contentLength: RESULT_CONTENT_LENGTH,
    });
    const second = await postJsonTo(targetBaseUrl, '/api/presign-result', {
      fileId: 'invalid',
      contentLength: RESULT_CONTENT_LENGTH,
    });

    assert.equal(first.status, 400);
    assert.equal(second.status, 429);
    assert.deepEqual(second.body, { error: 'Too many presign requests' });
  });
});

async function issueImageToken(filename = 'photo.jpg') {
  const response = await postJson('/api/presign-image', {
    filename,
    contentType: 'image/jpeg',
    contentLength: IMAGE_CONTENT_LENGTH,
  });
  assert.equal(response.status, 200);
  assert.match(response.body.fileId, /^[0-9a-f-]{36}$/);
  assert.equal(typeof response.body.resultUploadToken, 'string');
  assert.deepEqual(response.body.uploadHeaders, { 'Content-Type': 'image/jpeg' });
  assert.equal(response.body.contentLength, IMAGE_CONTENT_LENGTH);
  return response.body;
}

test('presign-image rejects active or mismatched image content types', async () => {
  const svgResponse = await postJson('/api/presign-image', {
    filename: 'photo.jpg',
    contentType: 'image/svg+xml',
  });
  const mismatchResponse = await postJson('/api/presign-image', {
    filename: 'photo.jpg',
    contentType: 'image/png',
  });

  assert.equal(svgResponse.status, 400);
  assert.equal(mismatchResponse.status, 400);
  assertNoPresignUrls(svgResponse.body);
  assertNoPresignUrls(mismatchResponse.body);
});

test('presign-result rejects an unknown result upload token', async () => {
  const response = await postJson('/api/presign-result', {
    fileId: '00000000-0000-4000-8000-000000000000',
    resultUploadToken: 'not-issued',
    contentLength: RESULT_CONTENT_LENGTH,
  });

  assert.equal(response.status, 403);
  assertNoPresignUrls(response.body);
});

test('presign-result rejects an unknown legacy fileId-only request', async () => {
  const response = await postJson('/api/presign-result', {
    fileId: '00000000-0000-4000-8000-000000000000',
    contentLength: RESULT_CONTENT_LENGTH,
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
    contentLength: RESULT_CONTENT_LENGTH,
  });

  assert.equal(response.status, 403);
  assertNoPresignUrls(response.body);
});

test('presign-result accepts a valid signed result upload token', async () => {
  const image = await issueImageToken();
  const success = await postJson('/api/presign-result', {
    fileId: image.fileId,
    resultUploadToken: image.resultUploadToken,
    contentLength: RESULT_CONTENT_LENGTH,
  });

  assert.equal(success.status, 200);
  assert.equal(success.body.urlType, 'public');
  assert.equal(success.body.expiresIn, null);
  assert.deepEqual(success.body.uploadHeaders, { 'Content-Type': 'application/json' });
  assert.equal(success.body.contentLength, RESULT_CONTENT_LENGTH);
  assert.match(success.body.key, new RegExp(`^results/${image.fileId}/[0-9a-f-]{36}\\.json$`));
  assert.match(success.body.uploadUrl, /^https?:\/\//);
  assert.equal(success.body.publicUrl, `${buildPublicUrl('https://cdn.example/classifier', success.body.key)}`);
});

test('presign-result accepts token grants across app instances', async () => {
  const image = await issueImageToken();

  await withStartedApp(createApp({ b2: testB2 }), async (targetBaseUrl) => {
    const success = await postJsonTo(targetBaseUrl, '/api/presign-result', {
      fileId: image.fileId,
      resultUploadToken: image.resultUploadToken,
      contentLength: RESULT_CONTENT_LENGTH,
    });

    assert.equal(success.status, 200);
    assert.match(success.body.key, new RegExp(`^results/${image.fileId}/[0-9a-f-]{36}\\.json$`));
  });
});

test('presign-result accepts a legacy fileId-only request once', async () => {
  const image = await issueImageToken();
  const success = await postJson('/api/presign-result', {
    fileId: image.fileId,
    contentLength: RESULT_CONTENT_LENGTH,
  });
  const replay = await postJson('/api/presign-result', {
    fileId: image.fileId,
    contentLength: RESULT_CONTENT_LENGTH,
  });
  const tokenReplay = await postJson('/api/presign-result', {
    fileId: image.fileId,
    resultUploadToken: image.resultUploadToken,
    contentLength: RESULT_CONTENT_LENGTH,
  });

  assert.equal(success.status, 200);
  assert.equal(success.body.key, `results/${image.fileId}.json`);
  assert.equal(success.body.deprecation, 'resultUploadToken will be required in a future release');
  assert.equal(grantMarkers.has(`_result-upload-grants/file-used/${image.fileId}.json`), true);
  assert.equal(replay.status, 403);
  assert.equal(tokenReplay.status, 403);
  assertNoPresignUrls(replay.body);
  assertNoPresignUrls(tokenReplay.body);
});

test('presign-result accepts legacy grants across app instances', async () => {
  const image = await issueImageToken();

  await withStartedApp(createApp({ b2: testB2 }), async (targetBaseUrl) => {
    const success = await postJsonTo(targetBaseUrl, '/api/presign-result', {
      fileId: image.fileId,
      contentLength: RESULT_CONTENT_LENGTH,
    });

    assert.equal(success.status, 200);
    assert.equal(success.body.key, `results/${image.fileId}.json`);
  });
});

test('presign-result rejects replayed result upload tokens', async () => {
  const image = await issueImageToken();
  const first = await postJson('/api/presign-result', {
    fileId: image.fileId,
    resultUploadToken: image.resultUploadToken,
    contentLength: RESULT_CONTENT_LENGTH,
  });
  const second = await postJson('/api/presign-result', {
    fileId: image.fileId,
    resultUploadToken: image.resultUploadToken,
    contentLength: RESULT_CONTENT_LENGTH,
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 403);
  assert.deepEqual(first.body.uploadHeaders, { 'Content-Type': 'application/json' });
  assertNoPresignUrls(second.body);
  assert.match(first.body.key, new RegExp(`^results/${image.fileId}/[0-9a-f-]{36}\\.json$`));
});

test('presign-result rejects a tampered signed result upload token', async () => {
  const image = await issueImageToken();
  const lastCharacter = image.resultUploadToken.at(-1);
  const replacement = lastCharacter === 'a' ? 'b' : 'a';
  const tamperedToken = `${image.resultUploadToken.slice(0, -1)}${replacement}`;

  const response = await postJson('/api/presign-result', {
    fileId: image.fileId,
    resultUploadToken: tamperedToken,
    contentLength: RESULT_CONTENT_LENGTH,
  });

  assert.equal(response.status, 403);
  assertNoPresignUrls(response.body);
});

test('presign-result rejects tokens with extra segments', async () => {
  const image = await issueImageToken();
  const response = await postJson('/api/presign-result', {
    fileId: image.fileId,
    resultUploadToken: `${image.resultUploadToken}.extra`,
    contentLength: RESULT_CONTENT_LENGTH,
  });

  assert.equal(response.status, 403);
  assertNoPresignUrls(response.body);
});

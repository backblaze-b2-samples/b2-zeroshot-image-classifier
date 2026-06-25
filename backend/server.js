import express from 'express';
import cors from 'cors';
import { PutObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { buildPublicUrl, createB2S3Client } from './b2-config.js';
import { setupCORS } from './setup-cors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const DEFAULT_URL_EXPIRY = parseInt(process.env.URL_EXPIRY, 10) || 3600;
const RESULT_GRANT_PREFIX = '_result-upload-grants';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_MIME_BY_EXT = new Map([
  ['jpg', ['image/jpeg']],
  ['jpeg', ['image/jpeg']],
  ['png', ['image/png']],
  ['gif', ['image/gif']],
  ['webp', ['image/webp']],
  ['bmp', ['image/bmp']],
]);

function readAutoSetupCors() {
  return !['false', '0', 'no'].includes((process.env.AUTO_SETUP_CORS || '').toLowerCase());
}

function logB2ConfigError(error) {
  console.error(error.message);
  console.error('Copy .env.example to .env and fill in your B2 credentials.');
}

function normalizeImageContentType(ext, contentType) {
  const allowedMimeTypes = IMAGE_MIME_BY_EXT.get(ext);
  if (!allowedMimeTypes) {
    return null;
  }

  if (!contentType) {
    return allowedMimeTypes[0];
  }

  const normalized = String(contentType).split(';', 1)[0].trim().toLowerCase();
  return allowedMimeTypes.includes(normalized) ? normalized : null;
}

export function createApp({
  b2: initialB2,
  urlExpiry = DEFAULT_URL_EXPIRY,
  autoSetupCors = readAutoSetupCors(),
} = {}) {
  const app = express();
  let b2 = initialB2;

  function getB2() {
    if (!b2) {
      b2 = createB2S3Client();
    }
    return b2;
  }

  function issueResultUploadToken(fileId) {
    // HMAC uses the B2 application key as the sample's shared server secret;
    // rotating that key intentionally invalidates in-flight result tokens.
    const exp = Date.now() + urlExpiry * 1000;
    const nonce = randomBytes(16).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ fileId, exp, nonce })).toString('base64url');
    const signature = createHmac('sha256', getB2().applicationKey).update(payload).digest('base64url');

    return `${payload}.${signature}`;
  }

  function verifyResultUploadToken(fileId, resultUploadToken) {
    if (!resultUploadToken || typeof resultUploadToken !== 'string') {
      return null;
    }

    const tokenParts = resultUploadToken.split('.');
    if (tokenParts.length !== 2) {
      return null;
    }

    const [payload, signature] = tokenParts;
    if (!payload || !signature) {
      return null;
    }

    const expectedSignature = createHmac('sha256', getB2().applicationKey).update(payload).digest('base64url');
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
      return null;
    }

    try {
      const tokenPayload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const validPayload = tokenPayload.fileId === fileId &&
        typeof tokenPayload.nonce === 'string' &&
        Number.isFinite(tokenPayload.exp) &&
        tokenPayload.exp > Date.now();
      return validPayload ? tokenPayload : null;
    } catch {
      return null;
    }
  }

  function legacyActiveGrantKey(fileId) {
    return `${RESULT_GRANT_PREFIX}/legacy-active/${fileId}.json`;
  }

  function fileUsedGrantKey(fileId) {
    return `${RESULT_GRANT_PREFIX}/file-used/${fileId}.json`;
  }

  function isMissingObjectError(error) {
    return error?.$metadata?.httpStatusCode === 404 ||
      error?.name === 'NotFound' ||
      error?.Code === 'NotFound' ||
      error?.Code === 'NoSuchKey';
  }

  function isPreconditionFailed(error) {
    return error?.$metadata?.httpStatusCode === 412 ||
      error?.name === 'PreconditionFailed' ||
      error?.Code === 'PreconditionFailed';
  }

  async function getGrantMarkerMetadata(key) {
    const { s3Client, bucketName: bucket } = getB2();
    try {
      const response = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return response.Metadata || {};
    } catch (error) {
      if (isMissingObjectError(error)) {
        return null;
      }
      throw error;
    }
  }

  async function createGrantMarker(key, metadata) {
    const { s3Client, bucketName: bucket } = getB2();
    try {
      await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: 'application/json',
        Body: JSON.stringify(metadata),
        Metadata: Object.fromEntries(
          Object.entries(metadata).map(([metadataKey, value]) => [metadataKey, String(value)])
        ),
        IfNoneMatch: '*',
      }));
      return true;
    } catch (error) {
      if (isPreconditionFailed(error)) {
        return false;
      }
      throw error;
    }
  }

  async function generatePresignedUrls(key, contentType) {
    const { s3Client, bucketName: bucket, publicUrlBase } = getB2();
    const putObjectParams = { Bucket: bucket, Key: key, ContentType: contentType };

    const putUrl = await getSignedUrl(
      s3Client,
      new PutObjectCommand(putObjectParams),
      { expiresIn: urlExpiry }
    );
    const publicUrl = buildPublicUrl(publicUrlBase, key);
    if (publicUrl) {
      return { uploadUrl: putUrl, publicUrl, urlType: 'public', expiresIn: null };
    }

    const signedUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: urlExpiry }
    );
    return { uploadUrl: putUrl, publicUrl: signedUrl, urlType: 'signed', expiresIn: urlExpiry };
  }

  app.locals.getB2 = getB2;
  app.locals.autoSetupCors = autoSetupCors;

  // Configurable CORS origin
  app.use(cors({ origin: process.env.CORS_ORIGIN || true }));

  // Limit request body size (presign payloads are tiny)
  app.use(express.json({ limit: '1kb' }));

  // Serve frontend files
  app.use(express.static(path.join(__dirname, '../frontend')));

  // Generate pre-signed PUT URL for image upload
  app.post('/api/presign-image', async (req, res) => {
    try {
      const { filename, contentType } = req.body;

      // Input validation
      if (!filename || typeof filename !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid filename' });
      }
      const ext = path.extname(filename).replace('.', '').toLowerCase();
      const normalizedContentType = normalizeImageContentType(ext, contentType);
      if (!normalizedContentType) {
        return res.status(400).json({ error: 'Unsupported image format or content type' });
      }

      const fileId = randomUUID();
      const resultUploadToken = issueResultUploadToken(fileId);
      const key = `images/${fileId}.${ext}`;
      const { uploadUrl, publicUrl, urlType, expiresIn } = await generatePresignedUrls(key, normalizedContentType);
      const legacyGrantCreated = await createGrantMarker(legacyActiveGrantKey(fileId), {
        fileId,
        exp: Date.now() + urlExpiry * 1000,
        createdAt: new Date().toISOString(),
      });
      if (!legacyGrantCreated) {
        return res.status(409).json({ error: 'File ID collision, please retry' });
      }

      res.json({
        uploadUrl,
        publicUrl,
        urlType,
        expiresIn,
        key,
        fileId,
        resultUploadToken,
        resultUploadTokenExpiresIn: urlExpiry,
      });
    } catch (error) {
      console.error('Error generating image presigned URL:', error);
      res.status(500).json({ error: 'Failed to generate presigned URL' });
    }
  });

  // Generate pre-signed PUT URL for result upload
  app.post('/api/presign-result', async (req, res) => {
    try {
      const { fileId, resultUploadToken } = req.body;

      // Validate fileId is a UUID
      if (!fileId || !UUID_RE.test(fileId)) {
        return res.status(400).json({ error: 'Invalid file ID' });
      }

      // Legacy fileId-only grants remain during migration. Their HEAD-then-PUT
      // marker flow has a narrow TOCTOU window, accepted only for this
      // deprecated path; signed resultUploadToken grants avoid this race.
      const tokenPayload = resultUploadToken ? verifyResultUploadToken(fileId, resultUploadToken) : null;
      const legacy = !resultUploadToken;
      const legacyMetadata = legacy ? await getGrantMarkerMetadata(legacyActiveGrantKey(fileId)) : null;
      if (!legacy && !tokenPayload) {
        return res.status(403).json({ error: 'Invalid, expired, or already used result upload token' });
      }
      if (legacy && (!legacyMetadata || Number(legacyMetadata.exp) <= Date.now())) {
        return res.status(403).json({ error: 'Invalid, expired, or already used result upload token' });
      }

      const key = legacy ? `results/${fileId}.json` : `results/${fileId}/${randomUUID()}.json`;
      const { uploadUrl, publicUrl, urlType, expiresIn } = await generatePresignedUrls(key, 'application/json');
      const finalized = legacy
        ? await createGrantMarker(fileUsedGrantKey(fileId), { fileId, usedAt: new Date().toISOString() })
        : await createGrantMarker(fileUsedGrantKey(fileId), {
          fileId,
          nonce: tokenPayload.nonce,
          exp: tokenPayload.exp,
          usedAt: new Date().toISOString(),
        });
      if (!finalized) {
        return res.status(403).json({ error: 'Invalid, expired, or already used result upload token' });
      }

      if (legacy) {
        res.set('Deprecation', 'true');
      }

      res.json({
        uploadUrl,
        publicUrl,
        urlType,
        expiresIn,
        key,
        ...(legacy ? { deprecation: 'resultUploadToken will be required in a future release' } : {}),
      });
    } catch (error) {
      console.error('Error generating result presigned URL:', error);
      res.status(500).json({ error: 'Failed to generate presigned URL' });
    }
  });

  // Health check with B2 connectivity verification
  app.get('/health', async (req, res) => {
    try {
      const { s3Client, bucketName: bucket } = getB2();
      await s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
      res.json({ status: 'ok' });
    } catch (error) {
      console.error('Health check failed:', error);
      res.status(503).json({ status: 'degraded' });
    }
  });

  return app;
}

export const app = createApp();

const PORT = process.env.PORT || 3000;

// Auto-setup CORS on startup
export async function startServer({ serverApp = app, port = PORT, exitOnConfigError = false } = {}) {
  try {
    serverApp.locals.getB2();
  } catch (error) {
    logB2ConfigError(error);
    if (exitOnConfigError) {
      process.exit(1);
    }
    throw error;
  }

  if (serverApp.locals.autoSetupCors) {
    console.log('Checking B2 CORS configuration...');
    try {
      await setupCORS(true);
      console.log('B2 CORS is configured');
    } catch (error) {
      if (error.Code === 'InvalidRequest' && error.message.includes('B2 Native CORS rules')) {
        console.warn('\nYour bucket has B2 Native CORS rules (not S3 API rules)');
        console.warn('You need to manually update CORS in B2 Web Console:\n');
        console.warn('1. Go to: https://secure.backblaze.com/b2_buckets.htm');
        console.warn('2. Click on your bucket > Bucket Settings');
        console.warn('3. Find CORS Rules section');
        console.warn('4. DELETE the existing B2 Native rule');
        console.warn('5. Add NEW rule for "S3 Compatible API":');
        console.warn('   - Allowed Origins: *');
        console.warn('   - Allowed Operations: s3_get, s3_head, s3_put');
        console.warn('   - Allowed Headers: *');
        console.warn('   - Max Age: 3600');
        console.warn('6. Save and restart this server\n');
      } else {
        console.warn('Could not verify/setup CORS automatically');
        console.warn('Error:', error.message);
      }
    }
  }

  // Graceful shutdown
  const server = serverApp.listen(port, () => {
    console.log(`\nServer running on http://localhost:${port}\n`);
  });

  function shutdown() {
    console.log('Shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer({ exitOnConfigError: true });
}

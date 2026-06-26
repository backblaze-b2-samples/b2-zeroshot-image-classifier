import express from 'express';
import cors from 'cors';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupCORS } from './setup-cors.js';
import {
  createResultUploadGrant,
  generatePresignedUrls as createPresignedUrls,
  getAllowedImageExtension,
  normalizeImageContentType,
  validateUploadContentLength,
  verifyResultUploadGrant,
} from './presign.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// Validate required env vars at startup
const REQUIRED_ENV = ['B2_ENDPOINT', 'B2_KEY_ID', 'B2_APP_KEY', 'B2_BUCKET'];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy backend/.env.example to backend/.env and fill in your credentials.');
  process.exit(1);
}

const app = express();

// Configurable CORS origin
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));

// Limit request body size (presign payloads are tiny)
app.use(express.json({ limit: '1kb' }));

// Serve frontend files
app.use(express.static(path.join(__dirname, '../frontend')));

const s3Client = new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region: process.env.B2_REGION || 'us-west-002',
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APP_KEY,
  },
  forcePathStyle: true,
  customUserAgent: "b2ai-clip-classifier",
});

const BUCKET = process.env.B2_BUCKET;

function getPositiveIntEnv(name, fallback) {
  const parsed = parseInt(process.env[name], 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Configurable upload policy
const URL_EXPIRY = getPositiveIntEnv('URL_EXPIRY', 3600);
const MAX_IMAGE_UPLOAD_BYTES = getPositiveIntEnv(
  'MAX_IMAGE_UPLOAD_BYTES',
  10 * 1024 * 1024
);
const MAX_RESULT_UPLOAD_BYTES = getPositiveIntEnv(
  'MAX_RESULT_UPLOAD_BYTES',
  1024 * 1024
);
const PRESIGN_RATE_LIMIT_WINDOW_MS = getPositiveIntEnv(
  'PRESIGN_RATE_LIMIT_WINDOW_MS',
  60 * 1000
);
const PRESIGN_RATE_LIMIT_MAX = getPositiveIntEnv('PRESIGN_RATE_LIMIT_MAX', 60);
const RESULT_GRANT_SECRET = process.env.RESULT_GRANT_SECRET || process.env.B2_APP_KEY;

// Robust boolean parsing for AUTO_SETUP_CORS
const AUTO_SETUP_CORS = !['false', '0', 'no'].includes(
  (process.env.AUTO_SETUP_CORS || '').toLowerCase()
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createRateLimiter({ windowMs, maxRequests }) {
  const clients = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
    const current = clients.get(clientKey);

    if (!current || current.resetAt <= now) {
      clients.set(clientKey, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (current.count >= maxRequests) {
      return res.status(429).json({ error: 'Too many presign requests' });
    }

    current.count += 1;
    return next();
  };
}

const presignRateLimiter = createRateLimiter({
  windowMs: PRESIGN_RATE_LIMIT_WINDOW_MS,
  maxRequests: PRESIGN_RATE_LIMIT_MAX,
});

// Shared presign helper
async function generatePresignedUrls(key, contentType, contentLength) {
  return createPresignedUrls({
    s3Client,
    bucket: BUCKET,
    key,
    contentType,
    contentLength,
    expiresIn: URL_EXPIRY,
  });
}

// Generate pre-signed PUT URL for image upload
app.post('/api/presign-image', presignRateLimiter, async (req, res) => {
  try {
    const { filename, contentType, contentLength } = req.body;

    // Input validation
    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid filename' });
    }
    const ext = getAllowedImageExtension(filename);
    if (!ext) {
      return res.status(400).json({ error: 'Unsupported image format' });
    }

    const uploadContentType = normalizeImageContentType(ext, contentType);
    if (!uploadContentType) {
      return res.status(400).json({ error: 'Invalid content type' });
    }
    const uploadContentLength = validateUploadContentLength(
      contentLength,
      MAX_IMAGE_UPLOAD_BYTES
    );
    if (!uploadContentLength) {
      return res.status(400).json({ error: 'Invalid or oversized image upload' });
    }

    const fileId = randomUUID();
    const key = `images/${fileId}.${ext}`;
    const { uploadUrl, publicUrl, uploadHeaders } = await generatePresignedUrls(
      key,
      uploadContentType,
      uploadContentLength
    );
    const resultUploadGrant = createResultUploadGrant({
      fileId,
      secret: RESULT_GRANT_SECRET,
      ttlSeconds: URL_EXPIRY,
    });
    if (!resultUploadGrant) {
      return res.status(500).json({ error: 'Failed to create result upload grant' });
    }

    res.json({
      uploadUrl,
      publicUrl,
      uploadHeaders,
      contentLength: uploadContentLength,
      key,
      fileId,
      resultUploadGrant,
      maxUploadBytes: MAX_IMAGE_UPLOAD_BYTES,
    });
  } catch (error) {
    console.error('Error generating image presigned URL:', error);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

// Generate pre-signed PUT URL for result upload
app.post('/api/presign-result', presignRateLimiter, async (req, res) => {
  try {
    const { fileId, resultUploadGrant, contentLength } = req.body;

    // Validate fileId is a UUID
    if (!fileId || !UUID_RE.test(fileId)) {
      return res.status(400).json({ error: 'Invalid file ID' });
    }
    const grant = verifyResultUploadGrant({
      grant: resultUploadGrant,
      fileId,
      secret: RESULT_GRANT_SECRET,
    });
    if (!grant) {
      return res.status(403).json({ error: 'Invalid result upload grant' });
    }
    const uploadContentLength = validateUploadContentLength(
      contentLength,
      MAX_RESULT_UPLOAD_BYTES
    );
    if (!uploadContentLength) {
      return res.status(400).json({ error: 'Invalid or oversized result upload' });
    }

    const key = `results/${fileId}.json`;
    const { uploadUrl, publicUrl, uploadHeaders } = await generatePresignedUrls(
      key,
      'application/json',
      uploadContentLength
    );

    res.json({
      uploadUrl,
      publicUrl,
      uploadHeaders,
      contentLength: uploadContentLength,
      key,
      maxUploadBytes: MAX_RESULT_UPLOAD_BYTES,
    });
  } catch (error) {
    console.error('Error generating result presigned URL:', error);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

// Health check with B2 connectivity verification
app.get('/health', async (req, res) => {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: BUCKET }));
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ status: 'degraded' });
  }
});

const PORT = process.env.PORT || 3000;

// Auto-setup CORS on startup
async function startServer() {
  if (AUTO_SETUP_CORS) {
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
  const server = app.listen(PORT, () => {
    console.log(`\nServer running on http://localhost:${PORT}\n`);
  });

  function shutdown() {
    console.log('Shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer();

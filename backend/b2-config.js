import { S3Client } from '@aws-sdk/client-s3';

const REQUIRED_B2_ENV = [
  'B2_APPLICATION_KEY_ID',
  'B2_APPLICATION_KEY',
  'B2_BUCKET_NAME',
  'B2_REGION',
];

const PLACEHOLDER_VALUES = new Set([
  'your_application_key_id',
  'your_application_key',
  'your-bucket-name',
  'your_b2_region',
  'your_region',
]);

const SAMPLE_USER_AGENT = 'b2ai-clip-classifier/1.0.0 (backblaze-b2-samples)';

function cleanEnv(key) {
  return (process.env[key] || '').trim();
}

export function validateB2Env() {
  const missing = REQUIRED_B2_ENV.filter((key) => !cleanEnv(key));
  if (missing.length > 0) {
    throw new Error(`Missing required B2 environment variables: ${missing.join(', ')}`);
  }

  const placeholders = REQUIRED_B2_ENV.filter((key) => PLACEHOLDER_VALUES.has(cleanEnv(key)));
  if (placeholders.length > 0) {
    throw new Error(`B2 environment variables still have placeholder values: ${placeholders.join(', ')}`);
  }
}

export function getB2Config() {
  validateB2Env();

  const region = cleanEnv('B2_REGION');
  const publicUrlBase = cleanEnv('B2_PUBLIC_URL_BASE').replace(/\/+$/, '');

  return {
    endpoint: `https://s3.${region}.backblazeb2.com`,
    region,
    applicationKeyId: cleanEnv('B2_APPLICATION_KEY_ID'),
    applicationKey: cleanEnv('B2_APPLICATION_KEY'),
    bucketName: cleanEnv('B2_BUCKET_NAME'),
    publicUrlBase,
  };
}

export function createB2S3Client() {
  const config = getB2Config();

  return {
    ...config,
    s3Client: new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.applicationKeyId,
        secretAccessKey: config.applicationKey,
      },
      forcePathStyle: true,
      customUserAgent: SAMPLE_USER_AGENT,
    }),
  };
}

export function buildPublicUrl(publicUrlBase, key) {
  if (!publicUrlBase) {
    return null;
  }

  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${publicUrlBase.replace(/\/+$/, '')}/${encodedKey}`;
}

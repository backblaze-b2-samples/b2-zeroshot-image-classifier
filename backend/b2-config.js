import { S3Client } from '@aws-sdk/client-s3';

const B2_ENV_VARS = [
  { key: 'applicationKeyId', name: 'B2_APPLICATION_KEY_ID', legacyName: 'B2_KEY_ID' },
  { key: 'applicationKey', name: 'B2_APPLICATION_KEY', legacyName: 'B2_APP_KEY' },
  { key: 'bucketName', name: 'B2_BUCKET_NAME', legacyName: 'B2_BUCKET' },
  { key: 'region', name: 'B2_REGION' },
];

const PLACEHOLDER_VALUES = new Set([
  'your_application_key_id',
  'your_application_key',
  'your_key_id_here',
  'your_app_key_here',
  'your-bucket-name',
  'your_b2_region',
  'your_region',
]);

const SAMPLE_USER_AGENT_MARKER = '(backblaze-b2-samples)';
const SAMPLE_USER_AGENT = 'b2ai-clip-classifier/1.0.0';
const LEGACY_ENDPOINT_ENV = 'B2_ENDPOINT';
// Module-scoped on purpose: warn once per Node process, including repeated
// app/client creation in tests. Restart the process to reset deprecation logs.
const warnedEnvVars = new Set();

function cleanEnv(key) {
  return (process.env[key] || '').trim();
}

function warnOnce(message) {
  if (warnedEnvVars.has(message)) {
    return;
  }
  warnedEnvVars.add(message);
  console.warn(message);
}

function readEnv({ name, legacyName }) {
  const value = cleanEnv(name);
  const legacyValue = legacyName ? cleanEnv(legacyName) : '';

  if (value) {
    if (legacyValue && legacyValue !== value) {
      warnOnce(
        `Both ${name} and deprecated ${legacyName} are set; using ${name}. Keep both during rolling migration, then remove ${legacyName}.`
      );
    }
    return value;
  }

  if (legacyValue) {
    warnOnce(
      `${legacyName} is deprecated; set ${name} as well during migration. ${name} takes precedence when both are set.`
    );
    return legacyValue;
  }

  return '';
}

function parseRegionFromEndpoint(endpoint) {
  try {
    const hostname = new URL(endpoint).hostname;
    const match = hostname.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

export function validateB2Env() {
  const missing = B2_ENV_VARS.filter(({ name, legacyName }) => !readEnv({ name, legacyName }))
    .map(({ name }) => name);

  if (missing.includes('B2_REGION') && cleanEnv(LEGACY_ENDPOINT_ENV)) {
    const parsedRegion = parseRegionFromEndpoint(cleanEnv(LEGACY_ENDPOINT_ENV));
    if (parsedRegion) {
      missing.splice(missing.indexOf('B2_REGION'), 1);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required B2 environment variables: ${missing.join(', ')}`);
  }

  const placeholders = B2_ENV_VARS.filter(({ name, legacyName }) =>
    PLACEHOLDER_VALUES.has(readEnv({ name, legacyName }))
  ).map(({ name }) => name);

  if (placeholders.length > 0) {
    throw new Error(`B2 environment variables still have placeholder values: ${placeholders.join(', ')}`);
  }
}

export function getB2Config() {
  validateB2Env();

  const values = Object.fromEntries(B2_ENV_VARS.map(({ key, name, legacyName }) => [key, readEnv({ name, legacyName })]));
  const legacyEndpoint = cleanEnv(LEGACY_ENDPOINT_ENV);
  const region = values.region || parseRegionFromEndpoint(legacyEndpoint);
  const endpoint = region ? `https://s3.${region}.backblazeb2.com` : legacyEndpoint;
  const publicUrlBase = cleanEnv('B2_PUBLIC_URL_BASE').replace(/\/+$/, '');

  if (legacyEndpoint) {
    warnOnce(
      `${LEGACY_ENDPOINT_ENV} is deprecated; set B2_REGION and let the app derive the S3-compatible endpoint during migration.`
    );
  }

  return {
    endpoint,
    region,
    applicationKeyId: values.applicationKeyId,
    applicationKey: values.applicationKey,
    bucketName: values.bucketName,
    publicUrlBase,
  };
}

function addBackblazeUserAgentMarker(s3Client) {
  s3Client.middlewareStack.addRelativeTo(
    (next) => async (args) => {
      const { request } = args;
      if (request?.headers) {
        // AWS SDK customUserAgent sanitizes parentheses, so append the marker after the SDK builds the header.
        const userAgent = request.headers['user-agent'] || '';
        if (!userAgent.includes(SAMPLE_USER_AGENT_MARKER)) {
          request.headers['user-agent'] = `${userAgent} ${SAMPLE_USER_AGENT_MARKER}`.trim();
        }
      }
      return next(args);
    },
    {
      name: 'backblazeSampleUserAgentMarkerMiddleware',
      relation: 'after',
      toMiddleware: 'getUserAgentMiddleware',
      step: 'build',
      override: true,
    }
  );
}

export function createB2S3Client(config = getB2Config()) {
  const s3Client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.applicationKeyId,
      secretAccessKey: config.applicationKey,
    },
    forcePathStyle: true,
    customUserAgent: SAMPLE_USER_AGENT,
  });

  addBackblazeUserAgentMarker(s3Client);

  return { ...config, s3Client };
}

export function buildPublicUrl(publicUrlBase, key) {
  if (!publicUrlBase) {
    return null;
  }

  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${publicUrlBase.replace(/\/+$/, '')}/${encodedKey}`;
}

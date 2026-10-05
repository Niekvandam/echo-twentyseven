import { issueSignedToken, presignUrl } from '@vercel/blob';
import { authorized } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  if (!authorized(req.headers.authorization, process.env.ECHO_JOBS_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { key, operation, contentType, expires = 3600, maxBytes = 2147483648 } = req.body ?? {};
  if (typeof key !== 'string' || !key || key.includes('..') || key.startsWith('/') ||
      !['get', 'head', 'put', 'delete'].includes(operation) ||
      !Number.isSafeInteger(expires) || expires < 1 || expires > 3600 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2147483648) {
    return res.status(400).json({ error: 'Invalid storage request' });
  }
  const pathname = `echo/${key}`;
  try {
    const signed = await issueSignedToken({
      pathname,
      operations: [operation],
      validUntil: Date.now() + expires * 1000,
      ...(operation === 'put' ? { maximumSizeInBytes: maxBytes, allowedContentTypes: contentType ? [contentType] : undefined } : {}),
    });
    const { presignedUrl } = await presignUrl(signed, {
      operation, pathname, access: 'private',
      ...(operation === 'put' ? { contentType, addRandomSuffix: false, allowOverwrite: true } : {}),
    });
    res.status(200).json({ url: presignedUrl });
  } catch {
    res.status(503).json({ error: 'Storage unavailable' });
  }
}

import { spawn } from 'node:child_process';

const connection = process.env.DATABASE_URL;
const secret = process.env.DIRECTUS_SECRET;
if (!connection || !secret) {
  throw new Error('DATABASE_URL and DIRECTUS_SECRET are required');
}

const child = spawn('node', ['--import', '/directus/register-storage.mjs', 'cli.js', 'start'], {
  cwd: '/directus',
  stdio: 'inherit',
  env: {
    ...process.env,
    DB_CONNECTION_STRING: connection,
    SECRET: secret,
    SESSION_COOKIE_SECURE: 'true',
    SESSION_COOKIE_SAME_SITE: 'lax',
    REFRESH_TOKEN_COOKIE_SECURE: 'true',
    REFRESH_TOKEN_COOKIE_SAME_SITE: 'lax',
  },
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code ?? 1));

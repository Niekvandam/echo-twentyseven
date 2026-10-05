// This integration is pinned to Directus 11.13.4. Its storage alias registry
// is the same registry used for built-in drivers, before storage initializes.
import { _aliasMap } from '/directus/node_modules/@directus/api/dist/storage/get-storage-driver.js';
_aliasMap.vercel_blob = 'file:///directus/blob-driver.mjs';

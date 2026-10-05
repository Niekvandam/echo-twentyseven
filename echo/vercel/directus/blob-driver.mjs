import { Readable } from 'node:stream';

// The gateway keeps Blob credentials out of the Directus runtime.
export default class BlobDriver {
  async request(filepath, operation, body, options) {
    const signing = await fetch(`${process.env.VERCEL_JOBS_URL}/api/storage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ECHO_JOBS_SECRET}` },
      body: JSON.stringify({ key: `directus/${filepath}`, operation }),
      signal: AbortSignal.timeout(30000),
    });
    if (!signing.ok) throw new Error(`Storage signing failed (${signing.status})`);
    const { url } = await signing.json();
    const range = options?.range;
    const headers = range ? { Range: `bytes=${range.start ?? 0}-${range.end ?? ''}` } : {};
    const response = await fetch(url, {
      method: operation.toUpperCase(), headers, body,
      ...(body ? { duplex: 'half' } : {}),
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok) {
      const error = new Error(`Storage ${operation} failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response;
  }
  async read(filepath, options) {
    const response = await this.request(filepath, 'get', undefined, options);
    return Readable.fromWeb(response.body);
  }
  async write(filepath, content) { await this.request(filepath, 'put', content); }
  async delete(filepath) { await this.request(filepath, 'delete'); }
  async stat(filepath) {
    const response = await this.request(filepath, 'head');
    return { size: Number(response.headers.get('content-length')), modified: new Date(response.headers.get('last-modified') || Date.now()) };
  }
  async exists(filepath) {
    try { await this.stat(filepath); return true; }
    catch (error) { if (error.status === 404) return false; throw error; }
  }
  async copy(src, dest) { await this.write(dest, await this.read(src)); }
  async move(src, dest) { await this.copy(src, dest); await this.delete(src); }
  async *list() { throw new Error('Blob listing is managed through Directus file records'); }
}

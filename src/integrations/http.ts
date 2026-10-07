import { z } from 'zod';
export class ProviderHttpError extends Error {
  constructor(readonly status: number) { super(`Connector provider request failed (${status})`); }
}
// Fixed hosts, no redirects, a time limit, and a streamed size limit apply to every provider request.
export async function providerJson<T>(fetcher: typeof globalThis.fetch, url: string, options: RequestInit, schema: z.ZodType<T>): Promise<T> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['api.github.com', 'github.com', 'api.notion.com'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw new Error('Invalid connector provider endpoint');
  let response: Response;
  try { response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(options.signal ? [options.signal] : [])]) }); }
  catch { throw new Error('Connector provider request failed'); }
  if (!response.ok) throw new ProviderHttpError(response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Connector provider returned an empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 2_000_000) { await reader.cancel(); throw new Error('response size'); }
      chunks.push(next.value);
    }
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch { throw new Error('Connector provider returned an invalid response'); }
  finally { reader.releaseLock(); }
}

export interface KVNamespace {
  get(key: string, options?: { type?: "text" | "json" | "arrayBuffer" | "stream" }): Promise<any>;
  put(key: string, value: string | ArrayBuffer | ReadableStream, options?: { expiration?: number; expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export class EdgeKvCache {
  constructor(private readonly kv?: KVNamespace) {}

  // Advisory per-key counter. KV is eventually consistent and allows roughly one write per
  // second per key, so concurrent requests can both read the same value and both write
  // count + 1. It bounds sustained abuse; it does not enforce a hard cap, and a hard cap
  // is not available on KV. A KV outage returns allowed so the bot stays up.
  //
  // The limit must stay well under what one KV key can absorb in the window. At 600 per
  // minute a single chat can outrun the write rate, so the counter saturates and the limit
  // stops binding long before it is reached.
  async checkRateLimit(
    key: string,
    limit: number,
    windowSeconds = 60
  ): Promise<{ allowed: boolean; remaining: number }> {
    if (!this.kv) {
      return { allowed: true, remaining: limit };
    }
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const kvKey = `rate:${key}:${bucket}`;
    try {
      const raw = await this.kv.get(kvKey, { type: "text" });
      const parsed = Number(raw ?? 0);
      const count = Number.isFinite(parsed) ? parsed : 0;
      if (count >= limit) {
        return { allowed: false, remaining: 0 };
      }
      // Cloudflare KV enforces a minimum expirationTtl of 60 seconds
      await this.kv.put(kvKey, String(count + 1), { expirationTtl: Math.max(60, windowSeconds * 2) });
      return { allowed: true, remaining: limit - count - 1 };
    } catch {
      return { allowed: true, remaining: limit };
    }
  }
}

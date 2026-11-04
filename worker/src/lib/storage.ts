// File storage abstraction. Uses R2 when bound (FILES); otherwise falls back to Workers KV (FILES_KV),
// which is available on the Free plan without a payment method. Both expose the same R2-like interface.
import type { Env, R2Like } from './core';

export interface KVLike {
  put(key: string, value: ArrayBuffer | Uint8Array | string, opts?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
}

export function kvStorage(kv: KVLike): R2Like {
  return {
    async put(key, value, opts?: any) {
      // Message attachments expire with their message (24 h); KV TTL is a backstop if the purge job is delayed.
      const ttl = key.startsWith('msg/') ? 26 * 3600 : undefined;
      await kv.put(key, value as any, ttl ? { expirationTtl: ttl, metadata: opts?.httpMetadata } : { metadata: opts?.httpMetadata });
    },
    async get(key) {
      const buf = await kv.get(key, 'arrayBuffer');
      if (!buf) return null;
      return { body: new Blob([buf]).stream(), arrayBuffer: async () => buf };
    },
    async delete(key) {
      for (const k of Array.isArray(key) ? key : [key]) await kv.delete(k);
    },
  };
}

/** Resolves env.FILES once per request: R2 if present, else KV, else undefined (feature disabled). */
export function withStorage<E extends Env>(env: E): E {
  if (env.FILES || !(env as any).FILES_KV) return env;
  return { ...env, FILES: kvStorage((env as any).FILES_KV) };
}

// Web Push (standard, no Firebase SDK): service worker registration + subscribe/unsubscribe.
import { get, post } from './api';

const b64uToBytes = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export function registerServiceWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* best effort */ });
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try { const reg = await navigator.serviceWorker.ready; return await reg.pushManager.getSubscription(); } catch { return null; }
}

/** Returns 'on' | 'denied' | 'unavailable'. Must be called from a user gesture (permission prompt). */
export async function enablePush(): Promise<'on' | 'denied' | 'unavailable'> {
  if (!pushSupported()) return 'unavailable';
  const cfg = await get('/api/push/config');
  if (!cfg.public_key) return 'unavailable';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(cfg.public_key) as BufferSource });
  await post('/api/push/subscribe', sub.toJSON());
  return 'on';
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  try { await post('/api/push/unsubscribe', { endpoint: sub.endpoint }); } catch { /* ignore */ }
  await sub.unsubscribe();
}

// Realtime hub: one Durable Object per company. Uses the WebSocket Hibernation API so idle
// connections cost nothing. Events carry only IDs (never message content): clients re-fetch
// through the normal authorized API, so permissions stay enforced in one place.
import type { Env, Session } from './lib/core';

interface DOState {
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

export class RealtimeHub {
  constructor(private state: DOState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/notify' && req.method === 'POST') {
      const ev = (await req.json()) as { conversation_id: string; helper_id: string };
      const payload = JSON.stringify({ type: 'message', conversation_id: ev.conversation_id });
      const targets = new Set([...this.state.getWebSockets('staff'), ...this.state.getWebSockets(`helper:${ev.helper_id}`)]);
      for (const ws of targets) { try { ws.send(payload); } catch { /* closed */ } }
      return new Response(JSON.stringify({ delivered: targets.size }));
    }
    if (req.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const role = req.headers.get('x-hcm-role'), helper = req.headers.get('x-hcm-helper');
    const tags = role === 'helper' && helper ? [`helper:${helper}`] : ['staff'];
    const pair = new (globalThis as any).WebSocketPair();
    const [client, server] = Object.values(pair) as WebSocket[];
    this.state.acceptWebSocket(server, tags);
    return new Response(null, { status: 101, webSocket: client } as any);
  }

  // Hibernation callbacks
  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) { if (msg === 'ping') ws.send('pong'); }
  webSocketClose(ws: WebSocket, code: number) { try { ws.close(code, 'closed'); } catch { /* already closed */ } }
}

/** Opens the WebSocket for an authenticated session (company and role come from the session, not the client). */
export function connectRealtime(env: Env, s: Session, req: Request) {
  if (!env.REALTIME) return new Response(JSON.stringify({ error: 'realtime_not_configured' }), { status: 503 });
  const headers = new Headers(req.headers);
  headers.set('x-hcm-role', s.role);
  headers.set('x-hcm-helper', s.helperId || '');
  return env.REALTIME.get(env.REALTIME.idFromName(s.companyId)).fetch(new Request('https://realtime/connect', { headers }));
}

/** Best-effort notification; messaging never fails because realtime is unavailable (clients also poll). */
export async function notifyRealtime(env: Env, companyId: string, ev: { conversation_id: string; helper_id: string }) {
  if (!env.REALTIME) return;
  try {
    await env.REALTIME.get(env.REALTIME.idFromName(companyId)).fetch(new Request('https://realtime/notify', { method: 'POST', body: JSON.stringify(ev) }));
  } catch { /* ignore */ }
}

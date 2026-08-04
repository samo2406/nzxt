/**
 * The config window and the hidden Kraken window share an origin but nothing
 * else, so localStorage is the only channel between them. BroadcastChannel is
 * used for instant delivery and the `storage` event as the fallback; both fire
 * in the receiving window, hence the seen-id dedupe.
 */

const CHANNEL = 'kraken-lcd';
const STORAGE_KEY = 'kraken-lcd:bus';
const SEEN_LIMIT = 64;

export interface BusMessage {
  type: string;
  payload?: unknown;
}

interface Envelope extends BusMessage {
  id: string;
}

type Handler = (msg: BusMessage) => void;

const senderId = crypto.randomUUID();
const handlers = new Set<Handler>();
const seen: string[] = [];
let seq = 0;

let channel: BroadcastChannel | null = null;
try {
  channel = new BroadcastChannel(CHANNEL);
} catch {
  channel = null;
}

function isDuplicate(id: string): boolean {
  if (seen.includes(id)) return true;
  seen.push(id);
  if (seen.length > SEEN_LIMIT) seen.shift();
  return false;
}

function deliver(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const env = raw as Envelope;
  if (typeof env.id !== 'string' || typeof env.type !== 'string') return;
  if (isDuplicate(env.id)) return;
  for (const handler of handlers) {
    try {
      handler({ type: env.type, payload: env.payload });
    } catch (err) {
      console.error('[bus] handler failed', err);
    }
  }
}

channel?.addEventListener('message', (ev) => deliver(ev.data));

window.addEventListener('storage', (ev) => {
  if (ev.key !== STORAGE_KEY || !ev.newValue) return;
  try {
    deliver(JSON.parse(ev.newValue));
  } catch {
    /* another tab wrote something unparseable; ignore */
  }
});

export function publish(msg: BusMessage): void {
  const env: Envelope = { ...msg, id: `${senderId}:${seq++}` };
  channel?.postMessage(env);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(env));
  } catch {
    /* private mode or quota; BroadcastChannel may still have carried it */
  }
  // Neither channel notifies the window that sent the message, so the config
  // window's own live preview would otherwise miss its own changes.
  deliver(env);
}

export function subscribe(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

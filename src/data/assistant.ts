/**
 * Link to the local voice agent (agent/ in this repo). The agent pushes face
 * states and the speech envelope; the page only ever sends telemetry back.
 * The display must work without the agent, so a missing agent is a quiet,
 * slow retry — never an error on screen.
 */

export type FaceState = 'sleeping' | 'listening' | 'thinking' | 'speaking' | 'offline' | 'error' | 'alarm';

export type AssistantMessage =
  | { type: 'state'; state: FaceState; at?: number; text?: string; followUp?: boolean; reason?: string }
  | { type: 'mouth'; offset: number; env: string }
  | { type: 'status'; mic: string | null; online?: boolean };

export interface AssistantSource {
  onMessage(fn: (msg: AssistantMessage) => void): () => void;
  onConnection(fn: (connected: boolean) => void): () => void;
  sendTelemetry(data: Record<string, number>): void;
  start(): void;
  stop(): void;
}

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 10_000;

export class AssistantLink implements AssistantSource {
  private ws: WebSocket | null = null;
  private retryMs = RETRY_MIN_MS;
  private timer = 0;
  private running = false;
  private messages = new Set<(msg: AssistantMessage) => void>();
  private connections = new Set<(connected: boolean) => void>();
  connected = false;

  constructor(private port: number) {}

  setPort(port: number): void {
    if (port === this.port) return;
    this.port = port;
    if (this.running) {
      this.stop();
      this.start();
    }
  }

  onMessage(fn: (msg: AssistantMessage) => void): () => void {
    this.messages.add(fn);
    return () => this.messages.delete(fn);
  }

  onConnection(fn: (connected: boolean) => void): () => void {
    this.connections.add(fn);
    return () => this.connections.delete(fn);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this.setConnected(false);
  }

  sendTelemetry(data: Record<string, number>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'telemetry', ...data }));
    }
  }

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = RETRY_MIN_MS;
      this.setConnected(true);
    };
    ws.onmessage = (ev) => {
      let msg: AssistantMessage;
      try {
        msg = JSON.parse(String(ev.data)) as AssistantMessage;
      } catch {
        return;
      }
      for (const fn of this.messages) {
        try {
          fn(msg);
        } catch (err) {
          console.error('[assistant] listener failed', err);
        }
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.setConnected(false);
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }

  private setConnected(connected: boolean): void {
    if (connected === this.connected) return;
    this.connected = connected;
    for (const fn of this.connections) fn(connected);
  }
}

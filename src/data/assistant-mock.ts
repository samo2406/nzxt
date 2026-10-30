import type { AssistantMessage, AssistantSource, Emotion, FaceState } from './assistant';

/**
 * `?mock=1` stand-in for the voice agent: emits exactly the messages the
 * agent's WebSocket sends, so Piťu can be built without a mic or CAM.
 *
 * Keys: 1 sleeping · 2 listening · 3 thinking · 4 speaking · 5 offline
 *       6 alarm · 7 error · 8 shutdown countdown · 9 restart countdown
 *       e next emotion · c info card · w a whole conversation turn
 */

const FRAME_MS = 20;

const EMOTIONS: Emotion[] = [
  'happy', 'laugh', 'confused', 'surprised', 'sad', 'annoyed', 'thinking', 'excited', 'wink', 'sleepy', 'neutral',
];

const CARDS = [
  { icon: 'rain', value: '12 °C', label: 'Nitra, zajtra' },
  { icon: 'cpu', value: '61 °C', label: 'Procesor' },
  { icon: 'timer', value: '9:41', label: 'Pizza' },
  { icon: 'music', value: 'Elán', label: 'Kaskadér' },
];

/** Syllable-ish loudness bumps with word gaps, one byte per 20 ms. */
function syntheticEnvelope(seconds: number): Uint8Array {
  const n = Math.round((seconds * 1000) / FRAME_MS);
  const env = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    const len = 5 + Math.floor(Math.random() * 7);
    const peak = 120 + Math.random() * 135;
    for (let k = 0; k < len && i + k < n; k++) {
      env[i + k] = Math.round(peak * Math.sin((Math.PI * (k + 0.5)) / len));
    }
    i += len;
    if (Math.random() < 0.18) i += 6 + Math.floor(Math.random() * 10);
  }
  return env;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export class MockAssistant implements AssistantSource {
  private messages = new Set<(msg: AssistantMessage) => void>();
  private timers: number[] = [];
  private emotionIndex = 0;
  private cardIndex = 0;
  private readonly onKey = (ev: KeyboardEvent): void => this.handleKey(ev);

  onMessage(fn: (msg: AssistantMessage) => void): () => void {
    this.messages.add(fn);
    return () => this.messages.delete(fn);
  }

  onConnection(fn: (connected: boolean) => void): () => void {
    fn(true);
    return () => {};
  }

  sendTelemetry(): void {}

  start(): void {
    window.addEventListener('keydown', this.onKey);
  }

  stop(): void {
    window.removeEventListener('keydown', this.onKey);
    this.clear();
  }

  private emit(msg: AssistantMessage): void {
    for (const fn of this.messages) fn(msg);
  }

  private state(state: FaceState, extra: Partial<Extract<AssistantMessage, { type: 'state' }>> = {}): void {
    this.emit({ type: 'state', state, ...extra });
  }

  private speak(seconds: number): void {
    const env = syntheticEnvelope(seconds);
    // The agent sends envelope chunks as Azure synthesises, ahead of playback.
    const chunk = 25;
    for (let off = 0; off < env.length; off += chunk) {
      this.emit({ type: 'mouth', offset: off, env: toBase64(env.subarray(off, off + chunk)) });
    }
    this.state('speaking', { at: Date.now() + 150 });
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(window.setTimeout(fn, ms));
  }

  private clear(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private turn(): void {
    this.clear();
    this.state('listening');
    this.later(1800, () => this.state('thinking'));
    this.later(3000, () => {
      // Cues go out with the envelope, before playback starts, timed in frames like the mouth.
      this.emit({ type: 'emotion', name: 'confused', offset: 0 });
      this.emit({ type: 'card', ...CARDS[0], offset: 60 });
      this.emit({ type: 'emotion', name: 'happy', offset: 110 });
      this.speak(3.2);
    });
    this.later(6600, () => this.state('listening', { followUp: true }));
    this.later(9000, () => this.state('sleeping'));
  }

  private handleKey(ev: KeyboardEvent): void {
    const target = ev.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    switch (ev.key) {
      case '1':
        this.clear();
        this.state('sleeping');
        break;
      case '2':
        this.clear();
        this.state('listening');
        break;
      case '3':
        this.clear();
        this.state('thinking');
        break;
      case '4':
        this.clear();
        this.speak(3);
        break;
      case '5':
        this.clear();
        this.state('offline', { reason: 'offline' });
        break;
      case '6':
        this.clear();
        this.state('alarm');
        break;
      case '7':
        this.clear();
        this.state('error', { reason: 'broken' });
        break;
      case '8':
      case '9':
        this.clear();
        this.state('countdown', { until: Date.now() + 10_000, restart: ev.key === '9' });
        break;
      case 'e':
        this.emit({ type: 'emotion', name: EMOTIONS[this.emotionIndex++ % EMOTIONS.length], offset: null });
        break;
      case 'c':
        this.emit({ type: 'card', ...CARDS[this.cardIndex++ % CARDS.length], offset: null });
        break;
      case 'w':
        this.turn();
        break;
      default:
        break;
    }
  }
}

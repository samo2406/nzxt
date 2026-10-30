import { getSettings, updateSettings } from '../data/settings';
import { beginAuth, completeAuth, disconnect, isConnected, onAuthChange } from '../data/spotify';
import { formatSeconds, rangeField, toggleField } from './controls';
import { el, section } from './dom';

export class SpotifyPanel {
  readonly el: HTMLElement;
  private readonly status: HTMLElement;
  private readonly action: HTMLButtonElement;
  private readonly clientInput: HTMLInputElement;
  private readonly unsubscribe: () => void;
  private notice = '';

  constructor() {
    this.clientInput = el('input', {
      class: 'text-input',
      type: 'text',
      placeholder: '32-znakový Client ID zo Spotify Dashboard',
      spellcheck: 'false',
      autocomplete: 'off',
    }) as HTMLInputElement;
    this.clientInput.value = getSettings().spotify.clientId;
    this.clientInput.addEventListener('change', () => {
      updateSettings({ spotify: { clientId: this.clientInput.value.trim() } });
      this.render();
    });

    this.status = el('span', { class: 'status' });
    this.action = el('button', { class: 'btn', type: 'button' }) as HTMLButtonElement;
    this.action.addEventListener('click', () => void this.toggleConnection());

    const s = getSettings().spotify;
    this.el = section(
      'Spotify',
      'Prihlásenie prebieha len v tomto okne (PKCE, bez client secret). Obrazovka na chladiči sa nikdy nepresmerúva.',
      el('label', { class: 'field field--stack' }, el('span', { class: 'field__label', text: 'Client ID' }), this.clientInput),
      el('div', { class: 'row' }, this.action, this.status),
      rangeField(
        'Návrat na prezentáciu',
        { min: 5000, max: 120_000, step: 5000, value: s.fallbackMs, format: formatSeconds },
        (fallbackMs) => updateSettings({ spotify: { fallbackMs } }),
      ),
      rangeField(
        'Rýchlosť otáčania',
        { min: 1, max: 40, step: 1, value: s.rotationRpm, format: (v) => `${v} ot./min` },
        (rotationRpm) => updateSettings({ spotify: { rotationRpm } }),
      ),
      toggleField('Text piesne (LRCLIB)', s.lyrics, (lyrics) => updateSettings({ spotify: { lyrics } })),
    );

    this.unsubscribe = onAuthChange(() => this.render());
    this.render();
    void this.consumeRedirect();
  }

  private async consumeRedirect(): Promise<void> {
    const outcome = await completeAuth();
    if (outcome.status === 'failed') this.notice = `Prihlásenie zlyhalo: ${outcome.reason}`;
    else if (outcome.status === 'ok') this.notice = '';
    this.render();
  }

  private async toggleConnection(): Promise<void> {
    if (isConnected()) {
      disconnect();
      this.notice = '';
      this.render();
      return;
    }

    const clientId = this.clientInput.value.trim();
    if (!clientId) {
      this.notice = 'Najprv vyplňte Client ID.';
      this.render();
      return;
    }
    updateSettings({ spotify: { clientId } });
    try {
      await beginAuth(clientId);
    } catch (err) {
      this.notice = `Nepodarilo sa spustiť prihlásenie: ${err instanceof Error ? err.message : err}`;
      this.render();
    }
  }

  private render(): void {
    const connected = isConnected();
    this.action.textContent = connected ? 'Odpojiť' : 'Pripojiť Spotify';
    this.status.dataset.tone = this.notice ? 'warn' : connected ? 'ok' : 'idle';
    this.status.textContent = this.notice || (connected ? 'Pripojené' : 'Nepripojené');
  }

  destroy(): void {
    this.unsubscribe();
  }
}

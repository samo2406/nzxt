import { redirectUri } from '../data/spotify';
import '../styles/config.css';
import { el, section } from './dom';

function copyField(value: string): HTMLElement {
  const input = el('input', { class: 'copy__value', readonly: true, spellcheck: 'false' });
  input.value = value;

  const button = el('button', { class: 'btn', type: 'button', text: 'Kopírovať' });
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    button.textContent = 'Skopírované';
    setTimeout(() => (button.textContent = 'Kopírovať'), 1600);
  });

  input.addEventListener('focus', () => input.select());
  return el('div', { class: 'copy' }, input, button);
}

export function mountConfig(host: HTMLElement): void {
  const page = el(
    'main',
    { class: 'page' },
    el(
      'header',
      { class: 'page__head' },
      el('h1', { class: 'page__title', text: 'Kraken LCD' }),
      el('p', {
        class: 'page__sub',
        text: 'Nastavenia obrazovky pre NZXT Kraken Elite V2.',
      }),
    ),
    section(
      'Presmerovacia adresa pre Spotify',
      'Skopírujte ju do Spotify Developer Dashboard → Redirect URIs. Musí sedieť úplne presne, vrátane lomky na konci.',
      copyField(redirectUri()),
    ),
  );

  host.append(page);
}

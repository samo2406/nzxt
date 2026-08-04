import { getSettings, updateSettings } from '../data/settings';
import { redirectUri } from '../data/spotify';
import '../styles/config.css';
import { formatSeconds, rangeField, toggleField } from './controls';
import { el, section } from './dom';
import { PhotoPanel } from './photos-panel';

function copyField(value: string): HTMLElement {
  const input = el('input', { class: 'copy__value', readonly: true, spellcheck: 'false' }) as HTMLInputElement;
  input.value = value;

  const button = el('button', { class: 'btn', type: 'button', text: 'Kopírovať' });
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = 'Skopírované';
      setTimeout(() => (button.textContent = 'Kopírovať'), 1600);
    } catch {
      input.select();
    }
  });

  input.addEventListener('focus', () => input.select());
  return el('div', { class: 'copy' }, input, button);
}

function slideshowPanel(): HTMLElement {
  const s = getSettings().slideshow;
  return section(
    'Prezentácia',
    'Predvolený režim obrazovky, keď nič nehrá.',
    rangeField(
      'Interval',
      { min: 5000, max: 120_000, step: 5000, value: s.intervalMs, format: formatSeconds },
      (intervalMs) => updateSettings({ slideshow: { intervalMs } }),
    ),
    rangeField(
      'Prelínanie',
      { min: 200, max: 3000, step: 100, value: s.crossfadeMs, format: formatSeconds },
      (crossfadeMs) => updateSettings({ slideshow: { crossfadeMs } }),
    ),
    toggleField('Náhodné poradie', s.shuffle, (shuffle) => updateSettings({ slideshow: { shuffle } })),
    toggleField('Pomalý pohyb (Ken Burns)', s.kenBurns, (kenBurns) => updateSettings({ slideshow: { kenBurns } })),
  );
}

export function mountConfig(host: HTMLElement): void {
  const page = el(
    'main',
    { class: 'page' },
    el(
      'header',
      { class: 'page__head' },
      el('h1', { class: 'page__title', text: 'Kraken LCD' }),
      el('p', { class: 'page__sub', text: 'Nastavenia obrazovky pre NZXT Kraken Elite V2.' }),
    ),
    section(
      'Presmerovacia adresa pre Spotify',
      'Skopírujte ju do Spotify Developer Dashboard → Redirect URIs. Musí sedieť úplne presne, vrátane lomky na konci.',
      copyField(redirectUri()),
    ),
    new PhotoPanel().el,
    slideshowPanel(),
  );

  host.append(page);
}

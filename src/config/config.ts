import { getSettings, updateSettings } from '../data/settings';
import { redirectUri } from '../data/spotify';
import { geocode } from '../data/weather';
import '../styles/config.css';
import { formatSeconds, rangeField, toggleField } from './controls';
import { el, section } from './dom';
import { PhotoPanel } from './photos-panel';
import { PreviewPanel } from './preview-panel';
import { SpotifyPanel } from './spotify-panel';

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

function telemetryPanel(): HTMLElement {
  const t = getSettings().telemetry;
  const degrees = (v: number) => `${v} °C`;
  return section(
    'Teploty',
    'CPU a GPU pod hodinami v hornej časti, len v režime prezentácie. Nad prahom sa hodnota zvýrazní.',
    toggleField('Zobrazovať teploty', t.enabled, (enabled) => updateSettings({ telemetry: { enabled } })),
    rangeField('Prah CPU', { min: 50, max: 100, step: 1, value: t.cpuWarnC, format: degrees }, (cpuWarnC) =>
      updateSettings({ telemetry: { cpuWarnC } }),
    ),
    rangeField('Prah GPU', { min: 50, max: 100, step: 1, value: t.gpuWarnC, format: degrees }, (gpuWarnC) =>
      updateSettings({ telemetry: { gpuWarnC } }),
    ),
  );
}

function weatherPanel(): HTMLElement {
  const input = el('input', {
    class: 'text-input',
    type: 'text',
    placeholder: 'napr. Bratislava',
    spellcheck: 'false',
  }) as HTMLInputElement;
  input.value = getSettings().weather.place;

  const status = el('span', { class: 'status' });
  const search = el('button', { class: 'btn', type: 'button', text: 'Nastaviť' });
  const clear = el('button', { class: 'btn', type: 'button', text: 'Vypnúť' });

  const render = (): void => {
    const w = getSettings().weather;
    status.dataset.tone = w.place ? 'ok' : 'idle';
    status.textContent = w.place ? `Zobrazuje sa počasie pre ${w.place}` : 'Vypnuté';
  };

  search.addEventListener('click', async () => {
    const place = input.value.trim();
    if (!place) return;
    status.dataset.tone = 'idle';
    status.textContent = 'Hľadám…';
    try {
      const hit = await geocode(place);
      if (!hit) {
        status.dataset.tone = 'warn';
        status.textContent = 'Miesto sa nenašlo.';
        return;
      }
      updateSettings({ weather: { place: hit.name, lat: hit.lat, lon: hit.lon } });
      input.value = hit.name;
      render();
    } catch {
      status.dataset.tone = 'warn';
      status.textContent = 'Vyhľadávanie zlyhalo, skúste znova.';
    }
  });

  clear.addEventListener('click', () => {
    updateSettings({ weather: { place: '', lat: 0, lon: 0 } });
    input.value = '';
    render();
  });

  render();
  return section(
    'Počasie',
    'Vonkajšia teplota pod hodinami, z Open-Meteo (bez API kľúča). Stačí zadať mesto.',
    el('label', { class: 'field field--stack' }, el('span', { class: 'field__label', text: 'Mesto' }), input),
    el('div', { class: 'row' }, search, clear, status),
  );
}

function setupPanel(): HTMLElement {
  const steps = [
    'V CAM otvorte Lighting → Kraken → LCD Display.',
    'Zvoľte režim Web Integration → Custom.',
    'Vložte adresu tejto stránky a potvrďte.',
    'Cez tlačidlo Configure sa vráti toto okno s nastaveniami.',
  ];
  return section(
    'Nastavenie v NZXT CAM',
    'Adresa je rovnaká ako presmerovacia — CAM si k nej sám pridá ?kraken=1 pre okno, ktoré streamuje na displej.',
    el('ol', { class: 'steps' }, ...steps.map((text) => el('li', { text }))),
    copyField(redirectUri()),
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
    new PreviewPanel().el,
    section(
      'Presmerovacia adresa pre Spotify',
      'Skopírujte ju do Spotify Developer Dashboard → Redirect URIs. Musí sedieť úplne presne, vrátane lomky na konci.',
      copyField(redirectUri()),
    ),
    new SpotifyPanel().el,
    new PhotoPanel().el,
    slideshowPanel(),
    telemetryPanel(),
    weatherPanel(),
    setupPanel(),
  );

  host.append(page);
}

import { el } from './dom';

export interface RangeSpec {
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
}

export function rangeField(label: string, spec: RangeSpec, onChange: (value: number) => void): HTMLElement {
  const input = el('input', {
    class: 'range__input',
    type: 'range',
    min: spec.min,
    max: spec.max,
    step: spec.step,
  }) as HTMLInputElement;
  input.value = String(spec.value);

  const readout = el('span', { class: 'range__value', text: spec.format(spec.value) });

  input.addEventListener('input', () => {
    const value = Number(input.value);
    readout.textContent = spec.format(value);
    onChange(value);
  });

  return el(
    'label',
    { class: 'field field--range' },
    el('span', { class: 'field__label', text: label }),
    el('span', { class: 'range' }, input, readout),
  );
}

export function toggleField(label: string, value: boolean, onChange: (value: boolean) => void): HTMLElement {
  const input = el('input', { class: 'toggle__input', type: 'checkbox' }) as HTMLInputElement;
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));

  return el(
    'label',
    { class: 'field field--toggle' },
    el('span', { class: 'field__label', text: label }),
    el('span', { class: 'toggle' }, input, el('span', { class: 'toggle__track' })),
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} kB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1).replace('.', ',')} MB`;
  return `${(mb / 1024).toFixed(1).replace('.', ',')} GB`;
}

export function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? `${s} s` : `${s.toFixed(1).replace('.', ',')} s`;
}

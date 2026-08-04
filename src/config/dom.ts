type Props = Record<string, string | number | boolean>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('data-')) node.setAttribute(key, String(value));
    else if (typeof value === 'boolean') node.toggleAttribute(key, value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export function section(title: string, hint?: string, ...children: Child[]): HTMLElement {
  return el(
    'section',
    { class: 'card' },
    el('h2', { class: 'card__title', text: title }),
    hint ? el('p', { class: 'card__hint', text: hint }) : null,
    ...children,
  );
}

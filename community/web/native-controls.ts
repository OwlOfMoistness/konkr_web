import type { Difficulty } from '../shared/contracts.ts';

type AtlasFrame = { filename: string; rotated: boolean; trimmed: boolean; frame: { x: number; y: number; w: number; h: number } };
type Atlas = { textures: { image: string; size: { w: number; h: number }; frames: AtlasFrame[] }[] };
const pending = new WeakMap<Document, Promise<void>>();
const WOOD_TEXT = 0x583922;

/** Extract the same pinned frames used by BoxTextures/woodenPrimaryButton (35725/25027).
 * This derives browser-only image URLs; it never edits the original atlas or release.
 */
export function initializeNativeAssets(doc: Document = document): Promise<void> {
  const existing = pending.get(doc);
  if (existing) return existing;
  const operation = (async () => {
    const view = doc.defaultView;
    if (!view) throw new Error('Native game controls need a browser document.');
    const atlasRequest = view.fetch('/assets/atlas.json', { credentials: 'same-origin' }).then(async response => {
      if (!response.ok) throw new Error('The original game controls could not be loaded. Please reload.');
      return response.json() as Promise<Atlas>;
    });
    const image = new view.Image();
    const imageReady = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('The original game control artwork could not be loaded. Please reload.'));
    });
    image.src = '/assets/atlas.png';
    const [atlas] = await Promise.all([atlasRequest, imageReady]);
    const texture = atlas.textures.find(texture => texture.image === 'atlas.png');
    if (!texture || image.naturalWidth !== texture.size.w || image.naturalHeight !== texture.size.h) throw new Error('The game control atlas does not match its metadata.');
    const crop = (name: string, tint?: number) => {
      const entry = texture.frames.find(frame => frame.filename === name);
      if (!entry || entry.rotated || entry.trimmed) throw new Error(`The original game control frame is unavailable: ${name}`);
      const { x, y, w, h } = entry.frame;
      if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > image.naturalWidth || y + h > image.naturalHeight) throw new Error('Invalid game control frame bounds.');
      const canvas = doc.createElement('canvas'); canvas.width = w; canvas.height = h;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The original game controls could not be prepared.');
      context.drawImage(image, x, y, w, h, 0, 0, w, h);
      if (tint !== undefined) {
        // Match Phaser's per-channel multiplicative tint, preserving atlas alpha and shading.
        const pixels = context.getImageData(0, 0, w, h);
        const channels = [tint >> 16 & 255, tint >> 8 & 255, tint & 255];
        for (let i = 0; i < pixels.data.length; i += 4) for (let channel = 0; channel < 3; channel++) pixels.data[i + channel] = Math.round(pixels.data[i + channel] * channels[channel] / 255);
        context.putImageData(pixels, 0, 0);
      }
      return `url("${canvas.toDataURL('image/png')}")`;
    };
    const frames: Record<string, string> = {
      '--konkr-native-button': crop('ui/box/dialog-button'),
      '--konkr-native-button-down': crop('ui/box/dialog-button-down'),
      '--konkr-native-button-green': crop('ui/box/dialog-button', 0x7fcf72),
      '--konkr-native-button-green-down': crop('ui/box/dialog-button-down', 0x7fcf72),
      '--konkr-native-button-red': crop('ui/box/dialog-button', 0xff9578),
      '--konkr-native-button-red-down': crop('ui/box/dialog-button-down', 0xff9578),
      '--konkr-native-toggle': crop('glass-ui/flat-box-button', WOOD_TEXT),
      '--konkr-native-trophy-normal': crop('ui/level-icons/silver'),
      '--konkr-native-trophy-hard': crop('ui/level-icons/gold'),
      '--konkr-native-back': crop('ui/wood-icons/arrow-left'),
    };
    for (const [name, value] of Object.entries(frames)) doc.documentElement.style.setProperty(name, value);
    doc.documentElement.dataset.nativeControls = 'ready';
  })();
  pending.set(doc, operation);
  void operation.catch(() => pending.delete(doc));
  return operation;
}

export function createNativeButton(label: string, doc: Document = document): HTMLButtonElement {
  const button = doc.createElement('button'); button.type = 'button'; button.className = 'konkr-native-button'; button.textContent = label;
  return button;
}

/** Original full-color silver/gold victory artwork; the original difficulty toggle scales it to 50%. */
export function trophy(difficulty: Difficulty, label?: string, doc: Document = document): HTMLSpanElement {
  const icon = doc.createElement('span'); icon.className = `konkr-trophy konkr-trophy-${difficulty}`;
  if (label) { icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', label); }
  else icon.setAttribute('aria-hidden', 'true');
  return icon;
}

/** Accessible DOM counterpart of DifficultyToggle (22093) and Toggle (62564).
 * Returns a radiogroup with data-value plus ordinary Normal/Hard radio buttons.
 */
export function createDifficultyToggle(modes: readonly Difficulty[], value: Difficulty, onChange: (value: Difficulty) => void, doc: Document = document): HTMLDivElement {
  const available = [...new Set(modes)];
  const group = doc.createElement('div'); group.className = 'konkr-difficulty'; group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', 'Play difficulty');
  group.style.setProperty('--difficulty-count', String(Math.max(1, available.length)));
  const highlight = doc.createElement('span'); highlight.className = 'konkr-difficulty-highlight'; highlight.setAttribute('aria-hidden', 'true'); group.append(highlight);
  const buttons: HTMLButtonElement[] = [];
  let selected = available.includes(value) ? value : available[0];
  const select = (mode: Difficulty, notify: boolean) => {
    selected = mode; group.dataset.value = mode; group.dataset.difficulty = mode;
    group.style.setProperty('--difficulty-index', String(available.indexOf(mode)));
    for (const button of buttons) { const checked = button.dataset.value === selected; button.setAttribute('aria-checked', String(checked)); button.tabIndex = checked ? 0 : -1; }
    if (notify) onChange(mode);
  };
  for (const mode of available) {
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'konkr-difficulty-option'; button.setAttribute('role', 'radio'); button.dataset.value = mode;
    const text = doc.createElement('span'); text.textContent = mode === 'normal' ? 'Normal' : 'Hard'; button.append(trophy(mode, undefined, doc), text);
    button.addEventListener('click', () => { if (selected !== mode) select(mode, true); });
    button.addEventListener('keydown', event => {
      const index = available.indexOf(mode);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % available.length : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index + available.length - 1) % available.length : -1;
      if (next < 0) return;
      event.preventDefault(); buttons[next].focus(); if (selected !== available[next]) select(available[next], true);
    });
    buttons.push(button); group.append(button);
  }
  if (selected) select(selected, false);
  else { group.setAttribute('aria-disabled', 'true'); highlight.hidden = true; }
  return group;
}

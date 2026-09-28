import type { ReferenceModuleLoader } from './bootstrap.ts';

type NativeObject = Record<string, any>;
type Binding = {
  target: HTMLElement;
  object: NativeObject;
  width: number;
  height: number;
  cleanup: (() => void)[];
  mask: NativeObject;
  graphics: NativeObject;
};
let nextSceneId = 0;

/** Render the pinned game's actual controls over accessible HTML anchors.
 * DOM events enter the original button controllers, including their pressed
 * frames and audio. The existing DOM handlers remain the only action owners.
 * The caller keeps the main canvas visible and the surrounding DOM transparent.
 */
export function bindCatalogControls(loader: ReferenceModuleLoader, root: HTMLElement): { refresh(): void; destroy(): void } {
  const { app } = loader(55151);
  const { inject } = loader(32070);
  const Phaser = loader(82260);
  const { UiBuilder } = loader(48041);
  const { DifficultyToggle } = loader(22093);
  const { ToggleThemes } = loader(62564);
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const key = `CommunityCatalogControls-${++nextSceneId}`;
  const bindings = new Map<HTMLElement, Binding>();
  let ready = false;
  let destroyed = false;
  let structureChanged = true;
  let forwarding = false;
  const selector = '.catalog-back, .catalog-primary, .catalog-detail-actions button, .konkr-difficulty';
  const resumeDifficulty = (target: HTMLElement) => target.closest('.catalog-detail-actions') && (target.dataset.difficulty === 'normal' || target.dataset.difficulty === 'hard') ? target.dataset.difficulty : undefined;
  const caption = (target: HTMLElement) => resumeDifficulty(target) ? 'RESUME' : (target.textContent ?? '').trim().toUpperCase();

  // These rules only remove the proxy's paint. The visible artwork, typography,
  // layout and interaction states come from original Phaser GameObjects.
  const style = doc.createElement('style');
  style.textContent = `
    .catalog-phaser-control { box-sizing:border-box!important; flex-shrink:0!important; padding:0!important; border:0!important; border-image:none!important; background:transparent!important; color:transparent!important; box-shadow:none!important; text-shadow:none!important; transform:none!important; }
    .catalog-phaser-control::before,.catalog-phaser-control::after { display:none!important; }
    .catalog-phaser-control > * { opacity:0!important; }
    .catalog-phaser-control.konkr-difficulty { display:grid!important; grid-template-columns:1fr 1fr!important; padding:4px!important; }
    .catalog-phaser-control.konkr-difficulty > [data-value=normal] { grid-column:1; }
    .catalog-phaser-control.konkr-difficulty > [data-value=hard] { grid-column:2; }
    .catalog-phaser-control.konkr-difficulty > [role=radio] { grid-row:1; height:100%!important; }
    .catalog-phaser-control:focus-visible { outline:3px solid #f4d072!important; outline-offset:3px; }
    .catalog-phaser-control.konkr-difficulty:focus-within { outline:3px solid #f4d072!important; outline-offset:3px; }
  `;
  doc.head.append(style);

  const emit = (object: NativeObject, name: string, event?: Event) => {
    forwarding = true;
    try { object.emit(name, event); } finally { forwarding = false; }
  };
  const wire = (target: HTMLButtonElement, object: NativeObject, cleanup: (() => void)[]) => {
    let releaseFeedback = false;
    const on = (name: string, listener: EventListener) => {
      target.addEventListener(name, listener, true);
      cleanup.push(() => target.removeEventListener(name, listener, true));
    };
    on('pointerenter', event => emit(object, 'pointerover', event));
    on('pointerleave', event => { releaseFeedback = false; emit(object, 'pointerout', event); });
    on('pointerdown', event => { releaseFeedback = false; emit(object, 'pointerdown', event); });
    on('pointerup', event => {
      releaseFeedback = object.controller.getState() === 'down';
      emit(object, 'pointerup', event);
    });
    on('pointercancel', event => { releaseFeedback = false; emit(object, 'pointerout', event); });
    on('blur', event => { releaseFeedback = false; emit(object, 'pointerout', event); });
    on('keydown', event => {
      const keyboard = event as KeyboardEvent;
      if ((keyboard.key === ' ' || keyboard.key === 'Enter') && !keyboard.repeat) { releaseFeedback = false; emit(object, 'pointerdown', event); }
    });
    on('keyup', event => {
      const keyboard = event as KeyboardEvent;
      if (keyboard.key === ' ' || keyboard.key === 'Enter') {
        releaseFeedback = object.controller.getState() === 'down';
        emit(object, 'pointerup', event);
      }
    });
    on('click', event => {
      if (target.disabled || target.closest('[inert]')) return;
      if (!releaseFeedback) {
        if (object.controller.getState() !== 'down') emit(object, 'pointerdown', event);
        emit(object, 'pointerup', event);
      }
      releaseFeedback = false;
    });
  };

  const remove = (binding: Binding) => {
    binding.cleanup.forEach(cleanup => cleanup());
    binding.target.classList.remove('catalog-phaser-control');
    binding.object.clearMask(); binding.mask.destroy(); binding.graphics.destroy(); binding.object.destroy();
    bindings.delete(binding.target);
  };
  const attach = (target: HTMLElement) => {
    const cleanup: (() => void)[] = [];
    const difficulty = target.matches('.konkr-difficulty');
    const width = difficulty ? 200 : target.matches('.catalog-back') ? 120 : 180;
    const height = difficulty ? 42 : 46;
    const resume = resumeDifficulty(target);
    const ui = UiBuilder.for(scene);
    const object = difficulty ? new DifficultyToggle(scene, {
      styles: ToggleThemes.oceanDark, height,
      onSelected: (value: string) => {
        if (forwarding) return false;
        target.querySelector<HTMLButtonElement>(`[role=radio][data-value="${value}"]`)?.click();
        return false; // DOM selection is reflected by refresh(); never write native user preferences.
      },
    }) : ui.wood.primaryButton({
      text: caption(target), width,
      icon: resume ? `ui/level-icons/${resume === 'hard' ? 'gold' : 'silver'}` : target.matches('.catalog-back') ? 'ui/wood-icons/arrow-left' : 'ui/wood-icons/arrow-right',
      iconPlacement: target.matches('.catalog-back') ? 'left' : 'right',
      onClicked: () => { if (!forwarding) (target as HTMLButtonElement).click(); },
    });
    if (resume) { object.content.props.tintIcon = false; object.content.icon.setScale(.5); }
    scene.add.existing(object);
    if (difficulty) {
      for (const [index, value] of ['normal', 'hard'].entries()) {
        const button = target.querySelector<HTMLButtonElement>(`[role=radio][data-value="${value}"]`);
        if (button) wire(button, object.buttons[index], cleanup);
      }
    } else wire(target as HTMLButtonElement, object, cleanup);
    const previousStyle = target.getAttribute('style');
    cleanup.push(() => { if (previousStyle === null) target.removeAttribute('style'); else target.setAttribute('style', previousStyle); });
    const graphics = scene.make.graphics({ add: false });
    const mask = graphics.createGeometryMask(); object.setMask(mask);
    target.classList.add('catalog-phaser-control');
    bindings.set(target, { target, object, width, height, cleanup, graphics, mask });
  };
  const observer = new MutationObserver(() => { structureChanged = true; });
  observer.observe(root, { childList: true, subtree: true });

  function refresh() {
    if (!ready || destroyed) return;
    if (structureChanged) {
      structureChanged = false;
      for (const binding of bindings.values()) if (!root.contains(binding.target) || !binding.target.matches(selector)) remove(binding);
      for (const target of root.querySelectorAll<HTMLElement>(selector)) if (!bindings.has(target)) attach(target);
    }
    const canvas = app.game.canvas as HTMLCanvasElement;
    const canvasRect = canvas.getBoundingClientRect();
    const xScale = canvasRect.width / app.game.scale.gameSize.width;
    const yScale = canvasRect.height / app.game.scale.gameSize.height;
    const uiScale = inject.ui.scale();
    scene.cameras.main.setZoom(uiScale).setOrigin(0, 0).setRoundPixels(true);
    scene.cameras.main.setSize(app.game.scale.gameSize.width, app.game.scale.gameSize.height);
    const rootVisible = root.isConnected && !root.closest('[hidden]') && root.getClientRects().length > 0 && xScale > 0 && yScale > 0;
    scene.scene.setVisible(rootVisible);
    if (!rootVisible) return;
    for (const binding of bindings.values()) {
      const { target, object, width, height, graphics } = binding;
      for (const [property, value] of Object.entries({ width: `${width * uiScale * xScale}px`, height: `${height * uiScale * yScale}px`, minWidth: `${width * uiScale * xScale}px`, minHeight: `${height * uiScale * yScale}px`, maxWidth: `${width * uiScale * xScale}px`, maxHeight: `${height * uiScale * yScale}px` })) {
        if (target.style[property as 'width'] !== value) target.style[property as 'width'] = value;
      }
      const rect = target.getBoundingClientRect();
      const clip = { left: Math.max(rect.left, canvasRect.left), right: Math.min(rect.right, canvasRect.right), top: Math.max(rect.top, canvasRect.top), bottom: Math.min(rect.bottom, canvasRect.bottom) };
      let alpha = 1;
      let shown = target.getClientRects().length > 0;
      for (let ancestor: HTMLElement | null = target; ancestor && ancestor !== doc.body; ancestor = ancestor.parentElement) {
        const computed = win.getComputedStyle(ancestor);
        alpha *= Number(computed.opacity);
        if (computed.visibility === 'hidden' || computed.display === 'none') shown = false;
        if (ancestor === target) continue;
        const bounds = ancestor.getBoundingClientRect();
        if (/auto|scroll|hidden|clip/.test(computed.overflowX)) { clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right); }
        if (/auto|scroll|hidden|clip/.test(computed.overflowY)) { clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom); }
      }
      shown &&= clip.right > clip.left && clip.bottom > clip.top;
      object.setVisible(shown).setAlpha(alpha);
      if (!shown) continue;
      object.setPosition((rect.left - canvasRect.left) / xScale / uiScale, (rect.top - canvasRect.top) / yScale / uiScale);
      graphics.clear().fillStyle(0xffffff).fillRect((clip.left - canvasRect.left) / xScale / uiScale, (clip.top - canvasRect.top) / yScale / uiScale, (clip.right - clip.left) / xScale / uiScale, (clip.bottom - clip.top) / yScale / uiScale);
      const inert = !!target.closest('[inert]');
      if (target.matches('.konkr-difficulty')) {
        for (const [index, value] of ['normal', 'hard'].entries()) {
          const button = target.querySelector<HTMLButtonElement>(`[role=radio][data-value="${value}"]`);
          object.buttons[index].setEnabled(!!button && !button.disabled && !inert);
        }
        const selected = target.dataset.value;
        if (selected === 'normal' || selected === 'hard') object.setValue(selected, false);
        object.selectionRectangle.setVisible(selected === 'normal' || selected === 'hard');
        object.applyTheme(inject.theme.getCurrent());
      } else {
        object.content.setText(caption(target));
        object.setEnabled(!(target as HTMLButtonElement).disabled && !inert);
      }
      object.preUpdate();
    }
  }
  class CatalogControlsScene extends Phaser.Scene {
    constructor() { super({ key }); }
    create() { ready = true; this.input.enabled = false; refresh(); }
    update() { refresh(); }
  }
  const scene = new CatalogControlsScene();
  app.game.scene.add(key, scene, true);
  return {
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true; observer.disconnect();
      for (const binding of bindings.values()) remove(binding);
      style.remove();
      app.game.scene.remove(key);
      UiBuilder._instances.delete(key);
    },
  };
}

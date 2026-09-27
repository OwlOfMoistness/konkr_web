import type { ReferenceModuleLoader } from './bootstrap.ts';

let nextSceneId = 0;

/** Original Expedition artwork, aligned with the loaded board's moving camera.
 * An addon scene lets us crossfade without changing native sprites or game state.
 */
export function createCatalogMiniature(loader: ReferenceModuleLoader) {
  const { app } = loader(55151);
  const Phaser = loader(82260);
  const world = app.scene.worldMap;
  const key = `CommunityCatalogMiniature-${++nextSceneId}`;
  let preview: any;
  let state: unknown;
  let originalAlpha: number | undefined;
  let destroyed = false;
  const blend = { value: 0 };
  let tween: any;
  let complete: (() => void) | undefined;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  class MiniatureScene extends Phaser.Scene {
    constructor() { super({ key }); }
    create() { this.input.enabled = false; this.scene.setVisible(false); ready(); }
  }
  const scene = new MiniatureScene();
  app.game.scene.add(key, scene, true);

  const sync = () => {
    if (!preview || destroyed) return;
    const source = world.cameras.main, camera = scene.cameras.main;
    camera.setViewport(source.x, source.y, source.width, source.height);
    camera.setOrigin(source.originX, source.originY).setScroll(source.scrollX, source.scrollY);
    camera.setZoom(source.zoomX, source.zoomY).setRotation(source.rotation).setRoundPixels(source.roundPixels);
    camera.setAlpha(blend.value);
    source.setAlpha(originalAlpha! * (1 - blend.value));
    scene.scene.setVisible(world.scene.isVisible() && blend.value > 0);
  };
  app.game.events.on('poststep', sync);
  const stop = () => { tween?.stop(); tween = undefined; complete?.(); complete = undefined; };
  const clear = () => {
    stop();
    if (originalAlpha !== undefined) world.cameras.main.setAlpha(originalAlpha);
    originalAlpha = undefined; blend.value = 0; state = undefined;
    preview?.destroy(); preview = undefined;
    if (scene.sys.isActive()) scene.scene.setVisible(false);
  };

  return {
    async prepare(gameState: unknown) {
      await started;
      if (destroyed || state === gameState) return;
      preview?.destroy(); preview = undefined;
      // Recreate: the original render texture's dimensions are fixed at construction.
      preview = new (loader(80461).IslandPreview)(scene, {
        gameState, levelStatus: loader(80252).LevelStatus.Replaying,
        selected: false, showGameState: true,
      });
      scene.add.existing(preview);
      // Native miniature painters use world coordinates divided by four.
      preview.setPosition(0, 0).setScale(4);
      preview.renderTexture.disableInteractive(); preview.visibility.setTo(1);
      app.game.scene.moveAbove(world.sys.settings.key, key);
      originalAlpha ??= world.cameras.main.alpha;
      state = gameState; sync();
    },
    fadeTo(value: number, milliseconds: number): Promise<void> {
      stop();
      if (!preview || !milliseconds || blend.value === value) {
        blend.value = value; sync(); return Promise.resolve();
      }
      return new Promise(resolve => {
        complete = resolve;
        tween = scene.tweens.add({ targets: blend, value, duration: milliseconds, ease: 'Sine.easeInOut',
          onComplete() { tween = undefined; complete = undefined; sync(); resolve(); } });
      });
    },
    clear,
    destroy() {
      if (destroyed) return;
      clear(); destroyed = true; ready();
      app.game.events.off('poststep', sync);
      app.game.scene.remove(key);
      loader(48041).UiBuilder._instances.delete(key);
    },
  };
}

import { ArenaEngine } from './ArenaEngine.js';

export class ArenaAdapter {
  constructor(container, options = {}) {
    if (!container) throw new Error('ArenaAdapter requires a container element.');
    this.container = container;
    this.options = options;
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    this.canvas.style.background = '#05070d';
    this.container.innerHTML = '';
    this.container.appendChild(this.canvas);

    const engineOptions = { canvas: this.canvas, ...(options.engineOptions ?? {}) };
    this.engine = new ArenaEngine(engineOptions);
    this.stateListeners = new Set();
    this._state = {};
    this._ticker = null;
    this._eventUnsubs = [];
  }

  async init() {
    await this.engine.init();
    this.engine.start();
    this._scheduleStatePoll();
  }

  dispose() {
    cancelAnimationFrame(this._ticker);
    this.engine?.stop();
    this._eventUnsubs.forEach((fn) => fn?.());
    this._eventUnsubs.length = 0;
    this.container?.removeChild?.(this.canvas);
    this.stateListeners.clear();
  }

  triggerAttack(actorId = 'player', kind = 'LIGHT') {
    this.engine?.triggerAttack(actorId, kind);
  }

  triggerBlock(actorId = 'player') {
    this.engine?.triggerBlock(actorId);
  }

  triggerDodge(actorId = 'player') {
    this.engine?.triggerDodge(actorId);
  }

  setMoveIntent(actorId, vector) {
    this.engine?.setActorMoveIntent(actorId, vector);
  }

  setActorTransform(actorId, position, yaw) {
    this.engine?.setActorTransform(actorId, position, yaw);
  }

  setControlMode(actorId, mode, options = {}) {
    this.engine?.setActorControlMode?.(actorId, mode, options);
  }

  setLowFX(enabled) {
    this.engine?.setLowFX?.(enabled);
  }

  setCameraFollow(actorId, offset) {
    this.engine?.setCameraFollow(actorId, offset);
  }

  setLockOn(state) {
    this.engine?.setLockOn?.(state);
  }

  toggleLockOn() {
    this.engine?.toggleLockOn?.();
  }

  shakeCamera(strength = 0.15, duration = 0.2) {
    this.engine?.applyCameraShake?.(strength, duration);
  }

  getState(actorId = 'player') {
    return this._state[actorId] || this.engine?.getState(actorId) || null;
  }

  getController(actorId = 'player') {
    return this.engine?.getController?.(actorId) ?? null;
  }

  onStateChange(callback) {
    if (typeof callback !== 'function') return () => {};
    this.stateListeners.add(callback);
    callback(this._state);
    return () => this.stateListeners.delete(callback);
  }

  onEvent(event, handler) {
    if (!this.engine || typeof handler !== 'function') return () => {};
    const unsub = this.engine.on(event, handler);
    this._eventUnsubs.push(unsub);
    return () => {
      unsub?.();
      const idx = this._eventUnsubs.indexOf(unsub);
      if (idx >= 0) this._eventUnsubs.splice(idx, 1);
    };
  }

  _scheduleStatePoll() {
    const tick = () => {
      this._state = this.engine?.getAllStates?.() || {};
      this.stateListeners.forEach((cb) => {
        try { cb(this._state); } catch (err) { console.error('[ArenaAdapter] listener error', err); }
      });
      this._ticker = requestAnimationFrame(tick);
    };
    this._ticker = requestAnimationFrame(tick);
  }
}

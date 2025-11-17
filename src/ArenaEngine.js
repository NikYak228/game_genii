import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CharacterController } from './CharacterController.js';
import { Physics } from './Physics.js';
import { RootMotionExtractor, diagnoseAnimationClips } from './RootMotionExtractor.js';
import { MOVE_LIBRARY } from './combat/constants.js';
import { VFXManager } from './VFXManager.js';
import { AIController } from './AIController.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

const DEFAULT_MODEL = './Pro Sword and Shield Pack/real man.fbx';
const DEFAULT_ROOT_BONE = 'mixamorig:Hips';
const DEFAULT_FIXED_STEP = 1 / 60;
const DEFAULT_CLIPS = [
  { name: 'Idle', url: './Pro Sword and Shield Pack/sword and shield idle.fbx' },
  { name: 'Run', url: './Pro Sword and Shield Pack/sword and shield run.fbx' },
  { name: 'Attack', url: './Pro Sword and Shield Pack/sword and shield slash.fbx' },
  { name: 'AttackHeavy', url: './Pro Sword and Shield Pack/sword and shield attack.fbx' },
  { name: 'BlockIdle', url: './Pro Sword and Shield Pack/sword and shield block idle.fbx' },
  { name: 'BlockStart', url: './Pro Sword and Shield Pack/sword and shield block (2).fbx' },
  { name: 'BlockHit', url: './Pro Sword and Shield Pack/sword and shield crouch block idle.fbx' },
  { name: 'HitStun', url: './Pro Sword and Shield Pack/sword and shield impact.fbx' },
  { name: 'Death', url: './Pro Sword and Shield Pack/sword and shield death.fbx' },
];
const DEFAULT_ACTORS = [
  {
    id: 'player',
    control: 'keyboard',
    tint: 0x60a5fa,
    position: new THREE.Vector3(0, 0, 0),
    modelUrl: DEFAULT_MODEL,
    clipSources: DEFAULT_CLIPS,
    rootBoneName: DEFAULT_ROOT_BONE,
    targetId: 'enemy',
  },
  {
    id: 'enemy',
    control: 'proxy',
    tint: 0xef4444,
    position: new THREE.Vector3(6, 0, 6),
    modelUrl: DEFAULT_MODEL,
    clipSources: DEFAULT_CLIPS,
    rootBoneName: DEFAULT_ROOT_BONE,
    targetId: 'player',
  },
];

export class ArenaEngine {
  constructor({
    canvas,
    actors = DEFAULT_ACTORS,
    enableOrbitControls = true,
    characterOptions = {},
    lowFX = false,
  } = {}) {
    if (!canvas) throw new Error('ArenaEngine requires a canvas element.');

    this.canvas = canvas;
    this.characterOptions = characterOptions;
    this.actorsConfig = actors;
    this.actorSlots = new Map();
    this.lowFX = !!lowFX;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.physicallyCorrectLights = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.setPixelRatio(this.lowFX ? 1 : Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1119);
    this.scene.fog = new THREE.Fog(0x0b1119, 20, 120);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
    this.camera.position.set(0, 2, 6);

    this.controls = enableOrbitControls ? new OrbitControls(this.camera, this.renderer.domElement) : null;
    if (this.controls) {
      this.controls.target.set(0, 1, 0);
      this.controls.enableDamping = true;
    }

    this.fixedDelta = DEFAULT_FIXED_STEP;
    this.physics = new Physics({ fixedTimeStep: this.fixedDelta });

    addLights(this.scene);

    this.clock = new THREE.Clock();
    this.accumulator = 0;

    this.loader = new FBXLoader();
    this.running = false;
    this.eventListeners = new Map();
    this.followActorId = null;
    this.cameraFollowOffsetLocal = new THREE.Vector3(0, 2.6, -6.5);
    this.cameraFollowOffsetWorld = new THREE.Vector3();
    this.cameraFollowLookOffset = new THREE.Vector3(0, 1.6, 0);
    this.cameraFollowTarget = new THREE.Vector3();
    this.cameraFollowTightnessPos = 3.2;
    this.cameraFollowTightnessTarget = 5.5;
    this.boundsRadius = Math.max(0, characterOptions.boundsRadius ?? 38);
    this._boundsScratch = new THREE.Vector3();
    this.vfx = new VFXManager(this.scene);
    this.vfx.setLowFX(this.lowFX);

    this.lastAlpha = 0;
    this.isLockedOn = false;
    this.lockOnTargetId = 'enemy';
    this.cameraRaycaster = new THREE.Raycaster();
    this.cameraCollisionObjects = [];
    this._tmpCamVec = new THREE.Vector3();
    this._desiredCameraPos = new THREE.Vector3();
    this._cameraLookPos = new THREE.Vector3();
    this._lockOnOffset = new THREE.Vector3();
    this._cameraShakeOffset = new THREE.Vector3();
    this.cameraShakeState = { intensity: 0, duration: 0, timer: 0 };
    window.addEventListener('resize', this.#handleResize);
    this.#handleResize();
  }

  async init() {
    await this.physics.waitForReady();
    addGround(this.scene);
    const ground = this.scene.getObjectByName('Ground');
    if (ground) {
      this.cameraCollisionObjects.push(ground);
    }
    this.vfx.setActorResolver((actorId) => this.actorSlots.get(actorId));
    await Promise.all(this.actorsConfig.map((config) => this.#spawnActor(config)));
    const enemySlot = this.actorSlots.get('enemy');
    const playerSlot = this.actorSlots.get('player');
    if (enemySlot && playerSlot && enemySlot.controller) {
      enemySlot.controller.setLockOn(true, playerSlot.model);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.renderer.setAnimationLoop(this.#animate);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  getState(actorId = 'player') {
    const slot = this.actorSlots.get(actorId);
    if (!slot) return null;
    return buildActorState(slot, this.lastAlpha);
  }

  getAllStates() {
    const states = {};
    for (const [id, slot] of this.actorSlots.entries()) {
      states[id] = buildActorState(slot, this.lastAlpha);
    }
    return states;
  }

  getController(actorId = 'player') {
    return this.actorSlots.get(actorId)?.controller ?? null;
  }

  triggerAttack(actorId = 'player', kind = 'LIGHT') {
    const slot = this.actorSlots.get(actorId);
    slot?.input.queueAttack(kind);
  }

  triggerBlock(actorId = 'player') {
    const slot = this.actorSlots.get(actorId);
    slot?.controller.requestBlock();
  }

  triggerDodge(actorId = 'player') {
    const slot = this.actorSlots.get(actorId);
    slot?.controller.requestDodge();
  }

  on(event, handler) {
    if (typeof handler !== 'function') return () => {};
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    const set = this.eventListeners.get(event);
    set.add(handler);
    return () => set.delete(handler);
  }

  setActorMoveIntent(actorId, vector) {
    const slot = this.actorSlots.get(actorId);
    slot?.input.setMoveVector?.(vector);
  }

  setActorControlMode(actorId, mode = 'keyboard', options = {}) {
    const slot = this.actorSlots.get(actorId);
    if (!slot) return false;
    if (slot.config.control === mode && mode !== 'proxy') {
      return true;
    }
    slot.input?.dispose?.();
    let input;
    let aiAgent = null;
    if (mode === 'proxy') {
      input = new ProxyInputManager();
      aiAgent = new AIController({
        actorId,
        controller: slot.controller,
        input,
        mesh: slot.model,
        studentProfile: options.studentProfile || slot.config.studentProfile || {},
        getTargetSlot: () => this.actorSlots.get(options.targetId || (actorId === 'player' ? 'enemy' : 'player')),
      });
    } else {
      input = new KeyboardInputManager();
    }
    slot.controller.setInputManager(input);
    slot.input = input;
    slot.ai = aiAgent;
    slot.config.control = mode;
    if (options.studentProfile) {
      slot.config.studentProfile = options.studentProfile;
    }
    return true;
  }

  setLowFX(enabled) {
    const next = !!enabled;
    if (this.lowFX === next) return;
    this.lowFX = next;
    const ratio = this.lowFX ? 1 : Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(ratio);
    this.vfx?.setLowFX?.(this.lowFX);
  }

  setActorTransform(actorId, position, yaw = null) {
    const slot = this.actorSlots.get(actorId);
    if (!slot || !position) return;
    let quat = null;
    if (typeof yaw === 'number') {
      slot.controller.yaw = yaw;
      slot.model.rotation.y = yaw;
      quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    }
    slot.physics.teleport(slot.physicsId, position, quat);
    slot.model.position.copy(position);
    slot.controller.syncMeshWithPhysics();
  }

  setCameraFollow(actorId = 'player', options = {}) {
    this.followActorId = actorId || null;
    if (options.offset) {
      this.cameraFollowOffsetLocal.copy(options.offset);
    }
    if (typeof options.height === 'number') {
      this.cameraFollowOffsetLocal.y = options.height;
    }
    if (typeof options.distance === 'number') {
      const sign = Math.sign(this.cameraFollowOffsetLocal.z) || -1;
      this.cameraFollowOffsetLocal.z = -Math.abs(options.distance) * sign;
    }
    if (typeof options.lookOffset === 'number') {
      this.cameraFollowLookOffset.set(0, options.lookOffset, 0);
    }
    if (typeof options.positionTightness === 'number') {
      this.cameraFollowTightnessPos = Math.max(0.5, options.positionTightness);
    }
    if (typeof options.targetTightness === 'number') {
      this.cameraFollowTightnessTarget = Math.max(0.5, options.targetTightness);
    }
    if (this.controls) {
      this.controls.enabled = !this.followActorId && !this.isLockedOn;
    }
  }

  setLockOn(state) {
    this.isLockedOn = !!state;
    if (this.controls) {
      this.controls.enabled = !this.isLockedOn && !this.followActorId;
    }
  }

  toggleLockOn() {
    this.setLockOn(!this.isLockedOn);
  }

  applyCameraShake(strength = 0.15, duration = 0.2) {
    if (!this.cameraShakeState) return;
    const state = this.cameraShakeState;
    state.intensity = Math.max(state.intensity, Math.max(0, strength));
    state.duration = Math.max(state.duration, Math.max(0.05, duration));
    state.timer = Math.max(state.timer, state.duration);
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this.#handleResize);
    this.controls?.dispose();
    this.renderer.dispose();
    for (const slot of this.actorSlots.values()) {
      this.scene.remove(slot.model);
    }
    this.actorSlots.clear();
  }

  #handleResize = () => {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  #animate = () => {
    if (!this.running) return;
    const delta = this.clock.getDelta();
    this.accumulator += delta;

    const playerSlot = this.actorSlots.get('player');
    const enemySlot = this.actorSlots.get(this.lockOnTargetId);
    if (playerSlot && playerSlot.controller) {
      if (this.isLockedOn && enemySlot) {
        playerSlot.controller.setLockOn(true, enemySlot.model);
      } else {
        playerSlot.controller.setLockOn(false, null);
      }
    }

    while (this.accumulator >= this.fixedDelta) {
      for (const slot of this.actorSlots.values()) {
        if (slot.config?.control === 'proxy') {
          slot.ai?.update(this.fixedDelta);
        }
        slot.controller.update(this.fixedDelta);
      }
      this.physics.step();
      this.accumulator -= this.fixedDelta;
    }

    if (this.boundsRadius > 0) {
      for (const slot of this.actorSlots.values()) {
        this.#clampActorToBounds(slot);
      }
    }

    const alpha = this.accumulator / this.fixedDelta;
    this.lastAlpha = alpha;
    for (const slot of this.actorSlots.values()) {
      slot.controller.syncMeshWithPhysics(alpha);
      slot.mixer.update(delta);
    }

    this.#updateCameraFollow(delta);
    this.vfx.update(delta);
    this.renderer.render(this.scene, this.camera);
  };

  #emit(event, payload) {
    this.vfx?.handleEvent?.(event, payload);
    const listeners = this.eventListeners.get(event);
    if (!listeners || listeners.size === 0) return;
    for (const cb of listeners) {
      try {
        cb(payload);
      } catch (err) {
        console.error('[ArenaEngine] Event handler error', event, err);
      }
    }
  }

  #getTargetsFor(actorId) {
    const targets = [];
    for (const [id, slot] of this.actorSlots.entries()) {
      if (id === actorId || !slot?.model) continue;
      targets.push({
        actorId: id,
        mesh: slot.model,
        radius: slot.config?.hitRadius ?? 0.6,
      });
    }
    return targets;
  }

  #clampActorToBounds(slot) {
    if (!slot?.physics?.getPosition || this.boundsRadius <= 0) return;
    const position = slot.physics.getPosition(slot.physicsId, 1);
    if (!position) return;
    this._boundsScratch.copy(position);
    const planarLen = Math.hypot(this._boundsScratch.x, this._boundsScratch.z);
    if (planarLen <= this.boundsRadius) return;
    const clampFactor = this.boundsRadius / Math.max(planarLen, 0.0001);
    this._boundsScratch.x *= clampFactor;
    this._boundsScratch.z *= clampFactor;
    slot.physics.teleport(slot.physicsId, this._boundsScratch);
    slot.controller?.syncMeshWithPhysics?.();
  }

  #updateCameraFollow(delta) {
    if (!this.isLockedOn && !this.followActorId) {
      this.controls?.update();
      return;
    }

    const followId = this.followActorId || 'player';
    const slot = this.actorSlots.get(followId);
    if (!slot) return;

    const targetSmoothing = 1 - Math.exp(-delta * this.cameraFollowTightnessTarget);
    const posSmoothing = 1 - Math.exp(-delta * this.cameraFollowTightnessPos);
    const desiredPos = this._desiredCameraPos;
    const lookAtPos = this._cameraLookPos;

    if (this.isLockedOn) {
      const enemySlot = this.actorSlots.get(this.lockOnTargetId);
      if (!enemySlot) {
        this.setLockOn(false);
        return;
      }

      this._tmpCamVec.lerpVectors(slot.model.position, enemySlot.model.position, 0.5);
      this.cameraFollowTarget.lerp(this._tmpCamVec, targetSmoothing);
      lookAtPos.copy(this.cameraFollowTarget).add(this.cameraFollowLookOffset);

      const toPlayer = this._tmpCamVec.copy(slot.model.position).sub(enemySlot.model.position);
      toPlayer.y = 0;
      let dist = toPlayer.length();
      if (dist > 0.0001) {
        toPlayer.normalize();
      } else {
        toPlayer.set(0, 0, 1);
        dist = 1;
      }
      dist = Math.max(2.0, dist);

      const perpendicular = this.cameraFollowOffsetWorld.set(toPlayer.z, 0, -toPlayer.x).normalize();
      const offset = this._lockOnOffset;
      const lateral = this.cameraFollowOffsetLocal.x + (Math.sign(this.cameraFollowOffsetLocal.x || 1) * dist * 0.15);
      offset.copy(perpendicular).multiplyScalar(lateral);
      offset.addScaledVector(toPlayer, this.cameraFollowOffsetLocal.z - dist * 0.5);
      offset.y = this.cameraFollowOffsetLocal.y;
      desiredPos.copy(this.cameraFollowTarget).add(offset);
    } else {
      const targetPos = slot.model.position;
      this.cameraFollowTarget.lerp(targetPos, targetSmoothing);
      lookAtPos.copy(this.cameraFollowTarget).add(this.cameraFollowLookOffset);

      const yaw = slot.controller?.yaw ?? slot.model.rotation?.y ?? 0;
      this.cameraFollowOffsetWorld.copy(this.cameraFollowOffsetLocal);
      this.cameraFollowOffsetWorld.applyAxisAngle(WORLD_UP, yaw);
      desiredPos.copy(this.cameraFollowTarget).add(this.cameraFollowOffsetWorld);
    }

    const rayDir = this._tmpCamVec.copy(desiredPos).sub(lookAtPos);
    const rayLen = rayDir.length();
    if (rayLen > 0.01) {
      rayDir.multiplyScalar(1 / rayLen);
      this.cameraRaycaster.set(lookAtPos, rayDir);
      this.cameraRaycaster.far = rayLen;
      const intersects = this.cameraRaycaster.intersectObjects(this.cameraCollisionObjects, false);
      if (intersects.length > 0) {
        desiredPos.copy(intersects[0].point).addScaledVector(rayDir, -0.3);
      }
    }

    const shakeOffset = this.#updateCameraShake(delta);
    desiredPos.add(shakeOffset);
    lookAtPos.addScaledVector(shakeOffset, 0.3);

    this.camera.position.lerp(desiredPos, posSmoothing);
    this.camera.lookAt(lookAtPos);
  }

  #updateCameraShake(delta) {
    if (!this.cameraShakeState) {
      return this._cameraShakeOffset.set(0, 0, 0);
    }
    const state = this.cameraShakeState;
    if (state.timer <= 0) {
      state.intensity = 0;
      state.duration = 0;
      return this._cameraShakeOffset.set(0, 0, 0);
    }
    state.timer = Math.max(0, state.timer - delta);
    const normalized = state.duration > 0 ? state.timer / state.duration : 0;
    const falloff = normalized * normalized;
    const intensity = state.intensity * falloff;
    this._cameraShakeOffset.set(
      (Math.random() - 0.5) * intensity,
      (Math.random() - 0.5) * intensity * 0.35,
      (Math.random() - 0.5) * intensity,
    );
    if (state.timer <= 0) {
      state.intensity = 0;
      state.duration = 0;
    }
    return this._cameraShakeOffset;
  }

  async #spawnActor(config) {
    const overrides = this.characterOptions?.actorProfiles?.[config.id];
    if (overrides) {
      Object.assign(config, overrides);
    }
    const modelUrl = config.modelUrl ?? DEFAULT_MODEL;
    const clipSources = config.clipSources ?? DEFAULT_CLIPS;
    const rootBoneName = config.rootBoneName ?? DEFAULT_ROOT_BONE;

    const model = await this.loader.loadAsync(modelUrl);
    const animations = await collectAnimations(model, this.loader, clipSources);
    const lightsToRemove = [];
    model.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        if (config.tint && child.material?.color) {
          child.material = Array.isArray(child.material) ? child.material.map((m) => m.clone()) : child.material.clone();
          const tintColor = new THREE.Color(config.tint);
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.forEach((mat) => {
            if (mat.color) mat.color.lerp(tintColor, 0.35);
          });
          if (Array.isArray(child.material) && child.material.length === 1) child.material = child.material[0];
        }
      }
      if (child.isLight) lightsToRemove.push(child);
    });
    lightsToRemove.forEach((light) => light.parent?.remove(light));
    model.scale.setScalar(config.scale ?? this.characterOptions.scale ?? 0.01);
    if (config.position) model.position.copy(config.position);
    this.scene.add(model);

    const mixer = new THREE.AnimationMixer(model);
    const rootBone = resolveRootBoneName(model, rootBoneName, animations);
    diagnoseAnimationClips(animations, rootBone);

    const processedActions = new Map();
    const rootMotionData = new Map();
    for (const clip of animations) {
      const result = RootMotionExtractor.extract(model, clip, rootBone);
      const action = mixer.clipAction(result.inPlaceClip);
      action.enabled = true;
      processedActions.set(clip.name, action);
      if (result.hasRootMotion) rootMotionData.set(clip.name, result);
    }

    await this.physics.createCharacterController(model, {
      halfHeight: config.halfHeight ?? 0.9,
      radius: config.radius ?? 0.35,
      offset: config.offset ?? 0.02,
      actorId: config.id,
    });

    const controlOverride = this.characterOptions?.controlOverrides?.[config.id];
    const controlMode = controlOverride ?? config.control ?? 'proxy';
    const input = controlMode === 'keyboard' ? new KeyboardInputManager() : new ProxyInputManager();

    const idleClip = selectClip(processedActions, ['Idle', 'idle']);
    const runClip = selectClip(processedActions, ['Run', 'Walk', 'run', 'walk']);
    const attackClip = selectClip(processedActions, ['Attack', 'attack', 'AttackLight']);
    const attackHeavyClip = selectClip(processedActions, ['AttackHeavy', 'Heavy', 'attack_heavy']);
    const blockIdleClip = selectClip(processedActions, ['BlockIdle', 'block', 'sword and shield block idle.fbx']);
    const blockStartClip = selectClip(processedActions, ['BlockStart', 'sword and shield block (2).fbx', 'BlockIdle']);
    const blockHitClip = selectClip(processedActions, ['BlockHit', 'sword and shield crouch block idle.fbx', 'BlockIdle']);
    const hitStunClip = selectClip(processedActions, ['HitStun', 'Impact', 'sword and shield impact.fbx']);
    const deathClip = selectClip(processedActions, ['Death', 'sword and shield death.fbx']);
    const dodgeClip = selectClip(processedActions, ['Dodge', 'Roll', 'Strafe', 'Run']);

    const controller = new CharacterController(
      model,
      mixer,
      this.physics,
      processedActions,
      rootMotionData,
      {
        inputManager: input,
        camera: config.control === 'keyboard' ? this.camera : null,
        moveSpeed: config.moveSpeed ?? this.characterOptions.moveSpeed ?? 4.5,
        states: {
          Idle: idleClip,
          Run: runClip,
          Attack: attackClip,
          AttackLight: attackClip,
          AttackHeavy: attackHeavyClip,
          BlockStart: blockStartClip || blockIdleClip,
          BlockIdle: blockIdleClip || idleClip,
          BlockHit: blockHitClip || hitStunClip || blockIdleClip,
          Dodge: dodgeClip || runClip,
          HitStun: hitStunClip || attackHeavyClip,
          Death: deathClip || hitStunClip || idleClip,
          Special_FireBlade: attackHeavyClip || attackClip,
          Special_PowerPush: attackHeavyClip || attackClip,
        },
        actorId: config.id,
        emitEvent: (event, data) => this.#emit(event, { actorId: config.id, ...data }),
        moveLibrary: this.characterOptions.moveLibrary ?? MOVE_LIBRARY,
        targetProvider: () => this.#getTargetsFor(config.id),
        resolveActor: (actorId) => this.actorSlots.get(actorId)?.controller ?? null,
      },
    );

    controller.syncMeshWithPhysics();

    let aiAgent = null;
    if (controlMode === 'proxy') {
      const targetId = config.targetId ?? (config.id === 'enemy' ? 'player' : 'enemy');
      aiAgent = new AIController({
        actorId: config.id,
        controller,
        input,
        mesh: model,
        studentProfile: config.studentProfile ?? {},
        getTargetSlot: () => this.actorSlots.get(targetId),
      });
    }

    this.actorSlots.set(config.id, {
      config: { ...config, control: controlMode },
      model,
      mixer,
      controller,
      physics: this.physics,
      physicsId: config.id,
      input,
      ai: aiAgent,
    });
  }
}

class KeyboardInputManager {
  constructor() {
    this.keys = new Set();
    this.attackQueued = null;
    this.blockQueued = false;
    this.dodgeQueued = false;
    this.blockHeld = false;
    this.mouseButtons = new Set();
    this.moveVector = new THREE.Vector3();
    this.worldDirection = new THREE.Vector3();
    this.forward = new THREE.Vector3();
    this.right = new THREE.Vector3();

    this._onKeyDown = (event) => {
      this.keys.add(event.code);
      if (event.code === 'KeyJ') {
        this.attackQueued = 'LIGHT';
      }
      if (event.code === 'KeyK') {
        this.attackQueued = 'HEAVY';
      }
      if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
        this.blockQueued = true;
        this.blockHeld = true;
      }
      if (event.code === 'Space') {
        this.dodgeQueued = true;
      }
    };
    this._onKeyUp = (event) => {
      this.keys.delete(event.code);
      if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
        this.blockHeld = false;
      }
    };
    this._onMouseDown = (event) => {
      this.mouseButtons.add(event.button);
      if (event.button === 0) {
        this.attackQueued = 'LIGHT';
      } else if (event.button === 2) {
        this.attackQueued = 'HEAVY';
      }
    };
    this._onMouseUp = (event) => {
      this.mouseButtons.delete(event.button);
    };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
  }

  getMoveVector(camera) {
    const horizontal = (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0)
      - (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0);
    const vertical = (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0)
      - (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0);

    this.moveVector.set(horizontal, 0, vertical);

    if (this.moveVector.lengthSq() === 0) {
      return this.moveVector;
    }

    if (camera) {
      camera.getWorldDirection(this.forward);
      this.forward.y = 0;
      if (this.forward.lengthSq() === 0) {
        this.forward.set(0, 0, -1);
      } else {
        this.forward.normalize();
      }
      this.right.set(this.forward.z, 0, -this.forward.x).normalize();
      this.worldDirection.set(0, 0, 0);
      this.worldDirection.addScaledVector(this.forward, -vertical);
      this.worldDirection.addScaledVector(this.right, horizontal);
      if (this.worldDirection.lengthSq() > 0) {
        this.worldDirection.normalize();
        this.moveVector.copy(this.worldDirection);
      }
    } else {
      this.moveVector.normalize();
    }

    return this.moveVector;
  }

  consumeAttack() {
    const queued = this.attackQueued;
    this.attackQueued = null;
    return queued;
  }

  consumeBlock() {
    const queued = this.blockQueued;
    this.blockQueued = false;
    return queued;
  }

  consumeDodge() {
    const queued = this.dodgeQueued;
    this.dodgeQueued = false;
    return queued;
  }

  queueAttack(kind = 'LIGHT') {
    const normalized = typeof kind === 'string' ? kind : String(kind || 'LIGHT');
    this.attackQueued = normalized.toUpperCase();
  }

  queueBlock() {
    this.blockQueued = true;
    this.blockHeld = true;
  }

  queueDodge() {
    this.dodgeQueued = true;
  }

  isBlockHeld() {
    return this.blockHeld;
  }
}

class ProxyInputManager {
  constructor() {
    this.intent = new THREE.Vector3();
    this.attackQueued = null;
    this.blockQueued = false;
    this.dodgeQueued = false;
  }

  dispose() {}

  setMoveVector(vector) {
    if (!vector) {
      this.intent.set(0, 0, 0);
      return;
    }
    this.intent.copy(vector);
    if (this.intent.lengthSq() > 1) {
      this.intent.normalize();
    }
  }

  getMoveVector() {
    return this.intent;
  }

  consumeAttack() {
    const queued = this.attackQueued;
    this.attackQueued = null;
    return queued;
  }

  consumeBlock() {
    const queued = this.blockQueued;
    this.blockQueued = false;
    return queued;
  }

  consumeDodge() {
    const queued = this.dodgeQueued;
    this.dodgeQueued = false;
    return queued;
  }

  queueAttack(kind = 'LIGHT') {
    const normalized = typeof kind === 'string' ? kind : String(kind || 'LIGHT');
    this.attackQueued = normalized.toUpperCase();
  }

  queueBlock() {
    this.blockQueued = true;
  }

  queueDodge() {
    this.dodgeQueued = true;
  }
}

function buildActorState(slot, alpha = 1) {
  if (!slot) return null;
  const position = slot.physics?.getPosition?.(slot.physicsId, alpha)?.clone?.() || slot.model.position.clone();
  return {
    position,
    velocity: slot.physics?.getLinearVelocity?.(slot.physicsId)?.clone?.() || null,
    yaw: slot.controller.yaw,
    state: slot.controller.currentState,
  };
}

async function collectAnimations(model, loader, clipSources) {
  const clips = [];
  if (Array.isArray(model.animations)) {
    clips.push(...model.animations);
  }
  for (const source of clipSources) {
    try {
      const asset = await loader.loadAsync(source.url);
      if (!asset.animations?.length) continue;
      const clip = asset.animations[0].clone();
      clip.name = source.name;
      clips.push(clip);
    } catch (err) {
      console.warn('[ArenaEngine] Failed to load clip', source.url, err);
    }
  }
  return clips;
}

function resolveRootBoneName(model, fallback, clips) {
  if (model.getObjectByName(fallback)) return fallback;
  const names = new Set();
  for (const clip of clips || []) {
    for (const track of clip.tracks || []) {
      if (!track.name?.endsWith('.position')) continue;
      const token = track.name.replace(/\.position$/, '').split(/[/.]/).pop();
      if (token) names.add(token);
    }
  }
  for (const name of names) {
    if (model.getObjectByName(name)) return name;
  }
  return fallback;
}

function selectClip(actionMap, priorityNames) {
  if (!actionMap || actionMap.size === 0) return null;
  const lookup = new Map();
  for (const key of actionMap.keys()) lookup.set(key.toLowerCase(), key);
  for (const candidate of priorityNames || []) {
    if (!candidate) continue;
    const resolved = lookup.get(candidate.toLowerCase());
    if (resolved) return resolved;
  }
  return actionMap.keys().next().value ?? null;
}

function addLights(scene) {
  const hemi = new THREE.HemisphereLight(0xcfe2ff, 0x0a0c12, 0.75);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffe8c5, 1.1);
  dir.position.set(8, 14, 10);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  scene.add(dir);
  const fill = new THREE.DirectionalLight(0x9ab8ff, 0.75);
  fill.position.set(-8, 6, -10);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xb9f1ff, 0.52);
  rim.position.set(0, 8, -12);
  scene.add(rim);
  const ambient = new THREE.AmbientLight(0x1b2433, 0.32);
  scene.add(ambient);
  const spot = new THREE.SpotLight(0xfff4da, 0.85, 42, THREE.MathUtils.degToRad(36), 0.55, 1.15);
  spot.position.set(0, 18, 6);
  spot.target.position.set(0, 0, 0);
  spot.castShadow = true;
  scene.add(spot);
  scene.add(spot.target);
}

function addGround(scene) {
  const groundGeometry = new THREE.PlaneGeometry(120, 120);
  const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x0f141f, roughness: 0.82, metalness: 0.03 });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = 'Ground';
  scene.add(ground);
}

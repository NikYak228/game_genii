import * as THREE from 'three';
import {
  BLOCK_TIME,
  COSTS,
  DODGE_TIME,
  FO_MAX,
  FO_REGEN,
  GUARD_BREAK_STUN,
  GUARD_MAX,
  GUARD_REGEN_DELAY,
  GUARD_REGEN_RATE,
  HP_MAX,
  IFRAME_TIME,
  MELEE_RADIUS,
  MELEE_RANGE,
  MOVE_LIBRARY,
  ST_MAX,
  ST_REGEN,
} from './combat/constants.js';

const DEFAULT_FADE = 0.25;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const clampValue = (value, min, max) => Math.min(Math.max(value, min), max);
const STUN_DECAY = 0.75;
const STUN_MAX = 0.7;
const COMBO_WINDOW = 1.5;
const SPECIAL_BUFFER_LATCH = 0.2;

const DEFAULT_SPECIALS = Object.freeze({
  FIRE_BLADE: {
    id: 'FIRE_BLADE',
    name: 'Огненное лезвие',
    pattern: ['LIGHT', 'LIGHT', 'HEAVY'],
    focusCostPct: 0.5,
    cooldown: 6,
    animation: 'Special_FireBlade',
    move: {
      id: 'FIRE_BLADE',
      damage: 32,
      guardDamage: 48,
      chipPercent: 0.2,
      focusGain: 10,
      pushBack: 1.6,
      blockPush: 1.2,
      startup: 0.32,
      active: 0.28,
      recovery: 0.65,
      hitStun: 1.1,
      blockStun: 0.52,
      hitStop: { onHit: 0.08, onBlock: 0.04 },
      range: MELEE_RANGE + 0.25,
      radius: MELEE_RADIUS + 0.05,
    },
    buff: { id: 'FIRE_BLADE_BUFF', type: 'damage', damageBonus: 0.25, duration: 5 },
  },
  POWER_PUSH: {
    id: 'POWER_PUSH',
    name: 'Силовой толчок',
    pattern: ['BLOCK', 'LIGHT'],
    focusCostPct: 0.3,
    cooldown: 5,
    animation: 'Special_PowerPush',
    move: {
      id: 'POWER_PUSH',
      damage: 18,
      guardDamage: 60,
      pushBack: 2.2,
      blockPush: 1.8,
      startup: 0.25,
      active: 0.2,
      recovery: 0.55,
      hitStun: 1.35,
      blockStun: 0.75,
      hitStop: { onHit: 0.09, onBlock: 0.05 },
      ignoreInvuln: true,
    },
  },
});

export class CharacterController {
  constructor(mesh, mixer, physics, actions, rootMotionData = new Map(), options = {}) {
    if (!mesh || !mixer || !physics) {
      throw new Error('CharacterController requires a mesh, mixer and physics instance.');
    }

    this.mesh = mesh;
    this.mixer = mixer;
    this.physics = physics;
    this.actions = actions ?? new Map();
    this.rootMotionData = rootMotionData;
    this.input = options.inputManager ?? null;
    this.camera = options.camera ?? null;
    this.params = {
      moveSpeed: options.moveSpeed ?? 4.5,
      rotationSpeed: options.rotationSpeed ?? 8.0,
      fadeDuration: options.fadeDuration ?? DEFAULT_FADE,
    };

    this.stateActions = {
      Idle: options.states?.Idle ?? 'Idle',
      Run: options.states?.Run ?? 'Run',
      AttackLight: options.states?.AttackLight ?? options.states?.Attack ?? 'Attack',
      AttackHeavy: options.states?.AttackHeavy ?? options.states?.Attack ?? 'Attack',
      BlockStart: options.states?.BlockStart ?? options.states?.Block ?? null,
      BlockIdle: options.states?.BlockIdle ?? options.states?.Block ?? null,
      BlockHit: options.states?.BlockHit ?? options.states?.Block ?? null,
      Dodge: options.states?.Dodge ?? options.states?.Run ?? 'Run',
      HitStun: options.states?.HitStun ?? null,
      Death: options.states?.Death ?? null,
      Special_FireBlade: options.states?.Special_FireBlade ?? options.states?.Special ?? null,
      Special_PowerPush: options.states?.Special_PowerPush ?? options.states?.Special ?? null,
    };

    this.currentState = null;
    this.currentAction = null;
    this.yaw = mesh.rotation?.y ?? 0;
    this.tmpVec = new THREE.Vector3();
    this.tmpQuat = new THREE.Quaternion();
    this.tmpScale = new THREE.Vector3();
    this.actorId = options.actorId ?? 'actor';
    this.emitEvent = typeof options.emitEvent === 'function' ? options.emitEvent : () => {};
    this.isLockedOn = false;
    this.lockOnTarget = null;
    this._lockOnDir = new THREE.Vector3();
    this._attackDir = new THREE.Vector3();
    this._hitCheckOrigin = new THREE.Vector3();
    this.moveLibrary = options.moveLibrary ?? MOVE_LIBRARY;
    this.targetProvider = typeof options.targetProvider === 'function' ? options.targetProvider : () => [];
    this.actorResolver = typeof options.resolveActor === 'function' ? options.resolveActor : () => null;
    this.specialMoves = options.specialMoves ?? DEFAULT_SPECIALS;
    this.inputBuffer = [];
    this.comboWindow = options.comboWindow ?? COMBO_WINDOW;
    this.bufferClock = 0;
    this.comboLatch = new Map();
    this.specialCooldowns = new Map();
    this.activeBuffs = new Map();
    this.blockState = null;
    this.blockStateTimer = 0;
    this.dodgeAnimTimer = 0;
    this._wasStunned = false;
    this.actionRequests = { attack: null, block: false, dodge: false, special: null };

    const maxHp = options.maxHp ?? HP_MAX;
    const maxStamina = options.maxStamina ?? ST_MAX;
    const guardMax = options.guardMax ?? GUARD_MAX;
    const maxFocus = options.maxFocus ?? FO_MAX;

    this.combatParams = {
      staminaRegen: options.staminaRegen ?? ST_REGEN,
      focusRegen: options.focusRegen ?? FO_REGEN,
      guardRegenRate: options.guardRegenRate ?? GUARD_REGEN_RATE,
      guardRegenDelay: options.guardRegenDelay ?? GUARD_REGEN_DELAY,
      guardBreakStun: options.guardBreakStun ?? GUARD_BREAK_STUN,
      guardMax,
      blockDuration: options.blockDuration ?? BLOCK_TIME,
      dodgeDuration: options.dodgeDuration ?? DODGE_TIME,
      iframeDuration: options.iframeDuration ?? IFRAME_TIME,
      hitRadius: options.hitRadius ?? MELEE_RADIUS,
    };

    this.combatState = {
      hp: Math.min(maxHp, options.hp ?? maxHp),
      maxHp,
      stamina: Math.min(maxStamina, options.stamina ?? maxStamina),
      maxStamina,
      focus: Math.min(maxFocus, options.focus ?? 0),
      maxFocus,
      guardGauge: Math.min(guardMax, options.guardGauge ?? guardMax),
      guardMax,
      guardRegenDelay: 0,
      blockTimer: 0,
      dodgeTimer: 0,
      invulnTimer: 0,
      hitStopTimer: 0,
      stunTimer: 0,
    };

    this.attackState = {
      active: false,
      phase: null,
      phaseTimer: 0,
      currentMove: null,
      hasHit: false,
      clipName: null,
      kind: null,
      remainingTotal: 0,
    };

    this.setState('Idle');
  }

  setInputManager(inputManager) {
    this.input = inputManager;
  }

  setCamera(camera) {
    this.camera = camera;
  }

  update(delta) {
    if (!this.input) return;

    this.bufferClock += delta;
    this.#pruneInputBuffer();
    this.#tickSpecialCooldowns(delta);
    this.#updateBuffs(delta);
    this.#tickCombat(delta);

    const inHitStop = this.combatState.hitStopTimer > 0;
    if (this.mixer) {
      this.mixer.timeScale = inHitStop ? 0 : 1;
    }

    if (this.combatState.hp <= 0) {
      if (this.currentState !== 'Death') {
        this.setState('Death');
      }
      return;
    }

    if (inHitStop) {
      return;
    }

    if (this.attackState.active) {
      this.#updateAttack(delta);
    }

    const attackActive = this.attackState.active;
    const stunned = this.combatState.stunTimer > 0;
    const blocking = this.combatState.blockTimer > 0;
    const dodging = this.combatState.dodgeTimer > 0;
    const canMove = !attackActive && !stunned && !blocking && !dodging;

    if (stunned && !this._wasStunned) {
      this.emitEvent('stunStart', { actorId: this.actorId, duration: this.combatState.stunTimer });
    } else if (!stunned && this._wasStunned) {
      this.emitEvent('stunEnd', { actorId: this.actorId });
    }
    this._wasStunned = stunned;

    const moveIntent = this.input.getMoveVector?.(this.camera) ?? this.tmpVec.set(0, 0, 0);
    const isMoving = moveIntent.lengthSq() > 0.0001;

    if (this.isLockedOn && this.lockOnTarget) {
      this._lockOnDir.copy(this.lockOnTarget.position).sub(this.mesh.position);
      this.#rotateTowards(this._lockOnDir, delta);
    } else if (isMoving && canMove) {
      this.#rotateTowards(moveIntent, delta);
    }

    if (canMove) {
      this.setState(isMoving ? 'Run' : 'Idle');

      const currentClipName = this.stateActions[this.currentState] || null;
      const rootMotion = currentClipName ? this.rootMotionData.get(currentClipName) : null;
      let movedWithRootMotion = false;

      if (rootMotion?.hasRootMotion) {
        let rootSpeed = rootMotion.rootMotionVelocity.length();
        if (rootSpeed > 0.01 && this.mesh?.getWorldScale) {
          const scale = this.mesh.getWorldScale(this.tmpScale).x;
          if (Number.isFinite(scale) && scale > 0) {
            rootSpeed *= scale;
          }
        } else if (rootSpeed > 0.01 && this.mesh?.scale) {
          const scale = this.mesh.scale.x ?? 1;
          if (Number.isFinite(scale) && scale > 0) {
            rootSpeed *= scale;
          }
        }

        if (rootSpeed > 0.01 && isMoving) {
          const displacement = moveIntent.clone().normalize().multiplyScalar(rootSpeed * delta);
          this.physics.move(displacement, this.actorId);
          movedWithRootMotion = true;
        }
      }

      if (!movedWithRootMotion && isMoving) {
        const displacement = moveIntent.clone().setY(0).normalize().multiplyScalar(this.params.moveSpeed * delta);
        this.physics.move(displacement, this.actorId);
      }
    } else if (!attackActive && !stunned && !blocking && !dodging && this.currentState !== 'Idle') {
      this.setState('Idle');
    }

    this.#updateBlockState(delta, blocking);

    if (!blocking && !dodging && !stunned && typeof this.input?.isBlockHeld === 'function') {
      if (this.input.isBlockHeld() && this.combatState.blockTimer <= 0.1) {
        this.requestBlock();
      }
    }

    if (this.dodgeAnimTimer > 0) {
      this.dodgeAnimTimer = Math.max(0, this.dodgeAnimTimer - delta);
    }
    if (dodging) {
      if (this.currentState !== 'Dodge') {
        this.setState('Dodge');
      }
    } else if (this.dodgeAnimTimer <= 0 && this.currentState === 'Dodge') {
      this.setState(isMoving ? 'Run' : 'Idle');
    }

    const requestedBlock = this.actionRequests.block || this.input?.consumeBlock?.();
    if (requestedBlock) {
      this.requestBlock();
      this.actionRequests.block = false;
    }

    const requestedDodge = this.actionRequests.dodge || this.input?.consumeDodge?.();
    if (requestedDodge) {
      this.requestDodge();
      this.actionRequests.dodge = false;
    }

    const pendingSpecial = this.actionRequests.special;
    if (pendingSpecial) {
      if (this.requestSpecial(pendingSpecial, { queue: false })) {
        this.actionRequests.special = null;
      }
    }

    const requestedAttack = this.actionRequests.attack || this.input?.consumeAttack?.();
    if (requestedAttack && this.#canPerformAttack()) {
      this.setState('Attack', { kind: requestedAttack });
      this.actionRequests.attack = null;
    }
  }

  syncMeshWithPhysics(alpha = 1) {
    const pos = this.physics.getPosition(this.actorId, alpha);
    const rot = this.physics.getRotation(this.actorId, alpha);
    if (pos) this.mesh.position.copy(pos);
    if (rot) this.mesh.quaternion.copy(rot);
  }

  setLockOn(isLocked, targetMesh) {
    this.isLockedOn = !!isLocked;
    this.lockOnTarget = targetMesh || null;
  }

  requestBlock(options = {}) {
    return this.#tryStartBlock(options);
  }

  requestDodge(options = {}) {
    return this.#tryStartDodge(options);
  }

  requestAttack(kind = 'LIGHT') {
    if (!this.#canPerformAttack()) return false;
    const normalized = typeof kind === 'string' ? kind : String(kind || 'LIGHT');
    this.actionRequests.attack = normalized.toUpperCase();
    return true;
  }

  requestSpecial(definition, options = {}) {
    const resolved = this.#resolveSpecial(definition);
    if (!resolved || !resolved.move) return false;
    const cooldown = this.specialCooldowns.get(resolved.id) ?? 0;
    if (cooldown > 0 && !options.force) {
      if (options.queue !== false) {
        this.actionRequests.special = resolved;
      }
      return false;
    }
    if (!this.#canPerformAttack() && !options.force) {
      if (options.queue !== false) {
        this.actionRequests.special = resolved;
      }
      return false;
    }
    const focusCost = this.#getSpecialFocusCost(resolved);
    if (focusCost > 0 && !this.#consumeFocus(focusCost, options.force)) {
      return false;
    }
    const specialCooldown = Math.max(0, resolved.cooldown ?? 0);
    if (specialCooldown > 0) {
      this.specialCooldowns.set(resolved.id, specialCooldown);
    }
    if (resolved.buff) {
      const buff = { ...resolved.buff };
      buff.duration = buff.duration ?? 0;
      buff.remaining = buff.duration;
      this.activeBuffs.set(buff.id ?? resolved.id, buff);
      this.emitEvent('specialBuffStart', { actorId: this.actorId, id: resolved.id, buff });
    }
    this.actionRequests.special = null;
    this.setState('Special', { special: resolved });
    this.emitEvent('specialStart', { actorId: this.actorId, id: resolved.id, definition: resolved });
    return true;
  }

  setState(newState, params = {}) {
    if (!newState || this.currentState === newState) return;
    const prevState = this.currentState;

    if (newState === 'Attack') {
      const rawKind = params.kind || 'LIGHT';
      const kind = (typeof rawKind === 'string' ? rawKind : String(rawKind)).toUpperCase();
      const moveDef = this.moveLibrary?.[kind];
      if (!moveDef) {
        console.warn(`[CC] No move definition found for ${kind}`);
        return;
      }
      const clipName = kind === 'HEAVY' ? this.stateActions.AttackHeavy : this.stateActions.AttackLight;
      if (!clipName || !this.actions.has(clipName)) {
        console.warn(`[CC] No attack clip found for ${kind} (clip: ${clipName})`);
        this.setState(prevState !== 'Idle' ? 'Idle' : 'Run');
        return;
      }
      const cost = moveDef.staminaCost ?? COSTS[kind] ?? COSTS.LIGHT;
      if (!this.#consumeStamina(cost, params.force)) {
        return;
      }
      if (!this.#activateAttackState({ kind, moveDef, clipName, stateLabel: newState })) {
        return;
      }
      this.#recordInput(kind);
      return;
    }

    if (newState === 'Special') {
      const def = params.special ?? this.#resolveSpecial(params.kind || params.id);
      if (!def || !def.move) {
        console.warn('[CC] No special definition provided');
        return;
      }
      const clipName = this.#resolveSpecialClip(def);
      this.#activateAttackState({ kind: def.id, moveDef: def.move, clipName, stateLabel: newState });
      return;
    }

    const nextAction = this.#getActionForState(newState);
    if (this.currentAction && this.currentAction !== nextAction) {
      this.currentAction.fadeOut(this.params.fadeDuration);
    }
    if (nextAction && this.currentAction !== nextAction) {
      nextAction.reset().fadeIn(this.params.fadeDuration).play();
      this.currentAction = nextAction;
    } else if (!nextAction) {
      this.currentAction = null;
    }
    this.currentState = newState;
    this.emitEvent('stateChange', { actorId: this.actorId, state: newState, previousState: prevState });
    if (this.attackState.active) {
      this.#resetAttackState(true);
    }
  }

  #getActionForState(state) {
    const clipName = this.stateActions[state];
    if (!clipName) return null;
    return this.actions.get(clipName) ?? null;
  }

  #updateAttack(delta) {
    const state = this.attackState;
    if (!state.active) return;
    if (!state.currentMove) {
      this.#resetAttackState(true);
      return;
    }

    state.remainingTotal = Math.max(0, state.remainingTotal - delta);
    this.#applyAttackRootMotion(delta);

    switch (state.phase) {
      case 'startup': {
        state.phaseTimer -= delta;
        if (state.phaseTimer <= 0) {
          state.phase = 'active';
          state.phaseTimer = Math.max(0, state.currentMove.active ?? 0);
        }
        break;
      }
      case 'active': {
        if (!state.hasHit || state.currentMove.multiHit) {
          const hitTarget = this.#checkHit(state.currentMove);
          if (hitTarget) {
            state.hasHit = !state.currentMove.multiHit;
            const damageConfig = this.#buildDamagePayload(state.currentMove, hitTarget.actorId);
            this.emitEvent('hit', {
              attackerId: this.actorId,
              target: hitTarget.actorId,
              moveDef: state.currentMove,
              damageConfig,
            });
          }
        }
        state.phaseTimer -= delta;
        if (state.phaseTimer <= 0) {
          state.phase = 'recovery';
          state.phaseTimer = Math.max(0, state.currentMove.recovery ?? 0);
        }
        break;
      }
      case 'recovery':
      default: {
        state.phaseTimer -= delta;
        if (state.phaseTimer <= 0) {
          this.emitEvent('attackEnd', {
            actorId: this.actorId,
            kind: state.kind,
            clip: state.clipName,
            move: state.currentMove,
          });
          this.#resetAttackState(false, true);
          const moveIntent = this.input.getMoveVector(this.camera);
          this.setState(moveIntent.lengthSq() > 0.0001 ? 'Run' : 'Idle');
        }
        break;
      }
    }
  }

  #activateAttackState({ kind, moveDef, clipName, stateLabel }) {
    if (!clipName || !this.actions.has(clipName)) {
      console.warn(`[CC] No clip found for ${kind} (clip: ${clipName})`);
      return false;
    }
    const action = this.actions.get(clipName);
    if (this.currentAction && this.currentAction !== action) {
      this.currentAction.fadeOut(this.params.fadeDuration);
    }
    action.reset().fadeIn(this.params.fadeDuration).play();
    this.currentAction = action;

    this.attackState.active = true;
    this.attackState.kind = kind;
    this.attackState.clipName = clipName;
    this.attackState.currentMove = moveDef;
    this.attackState.phase = 'startup';
    this.attackState.phaseTimer = Math.max(0, moveDef.startup ?? 0);
    this.attackState.hasHit = false;
    const duration = (moveDef.startup ?? 0) + (moveDef.active ?? 0) + (moveDef.recovery ?? 0);
    this.attackState.remainingTotal = duration;

    const prevState = this.currentState;
    this.currentState = stateLabel;
    this.emitEvent('stateChange', { actorId: this.actorId, state: stateLabel, previousState: prevState });
    this.emitEvent('attackStart', { actorId: this.actorId, kind, clip: clipName, move: moveDef, duration, state: stateLabel });
    return true;
  }

  #resolveSpecialClip(definition) {
    if (!definition) {
      return this.stateActions.AttackHeavy ?? this.stateActions.AttackLight ?? null;
    }
    if (definition.animation && this.stateActions[definition.animation]) {
      return this.stateActions[definition.animation];
    }
    const key = `Special_${definition.id}`;
    if (this.stateActions[key]) {
      return this.stateActions[key];
    }
    return this.stateActions.AttackHeavy ?? this.stateActions.AttackLight ?? null;
  }

  #applyAttackRootMotion(delta) {
    const clip = this.attackState.clipName;
    if (!clip) return;
    const attackData = this.rootMotionData.get(clip);
    if (!attackData?.rootMotionVelocity) return;
    this.tmpVec.copy(attackData.rootMotionVelocity);
    let scale = 1;
    if (this.mesh?.getWorldScale) {
      scale = this.mesh.getWorldScale(this.tmpScale).x || 1;
    } else if (this.mesh?.scale) {
      scale = this.mesh.scale.x ?? 1;
    }
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    this.tmpVec.multiplyScalar(scale * delta);
    this.physics.move(this.tmpVec, this.actorId);
  }

  #applyDodgeImpulse() {
    this._attackDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).normalize();
    const dodgeDistance = this.params.moveSpeed * Math.max(0.35, this.combatParams.dodgeDuration);
    this.tmpVec.copy(this._attackDir).multiplyScalar(dodgeDistance * 0.6);
    this.physics.move(this.tmpVec, this.actorId);
  }

  #resetAttackState(interrupted = false, suppressEvent = false) {
    if (this.attackState.active && !suppressEvent) {
      this.emitEvent('attackEnd', {
        actorId: this.actorId,
        kind: this.attackState.kind,
        clip: this.attackState.clipName,
        interrupted,
      });
    }
    this.attackState.active = false;
    this.attackState.phase = null;
    this.attackState.phaseTimer = 0;
    this.attackState.currentMove = null;
    this.attackState.hasHit = false;
    this.attackState.clipName = null;
    this.attackState.kind = null;
    this.attackState.remainingTotal = 0;
  }

  #buildDamagePayload(moveDef, targetId) {
    const payload = {
      targetId,
      moveDef,
      damage: moveDef.damage ?? 0,
      guardDamage: moveDef.guardDamage ?? 0,
      chipPercent: moveDef.chipPercent ?? 0,
      hitStun: moveDef.hitStun ?? 0,
      blockStun: moveDef.blockStun ?? 0.2,
      pushBack: moveDef.pushBack ?? 0,
      blockPush: moveDef.blockPush ?? Math.max(0, (moveDef.pushBack ?? 0) * 0.6),
      focusGain: moveDef.focusGain ?? 0,
      hitStop: moveDef.hitStop ?? null,
      attackerYaw: this.yaw,
      attackerId: this.actorId,
      unblockable: !!moveDef.unblockable,
      disableParry: !!moveDef.disableParry,
      ignoreInvuln: !!moveDef.ignoreInvuln,
      staminaOnBlock: moveDef.staminaOnBlock ?? (moveDef.id === 'HEAVY' ? 20 : 10),
    };
    return this.#applyDamageBuffs(payload);
  }

  #applyDamageBuffs(payload) {
    if (!this.activeBuffs.size) return payload;
    let damage = payload.damage ?? 0;
    let guardDamage = payload.guardDamage ?? 0;
    for (const buff of this.activeBuffs.values()) {
      if (buff?.type === 'damage' && buff.damageBonus) {
        const scale = 1 + buff.damageBonus;
        damage *= scale;
        guardDamage *= scale;
      }
    }
    payload.damage = Math.round(damage);
    payload.guardDamage = Math.round(guardDamage);
    return payload;
  }

  #checkHit(moveDef) {
    const targets = typeof this.targetProvider === 'function' ? this.targetProvider() ?? [] : [];
    if (!targets.length) return null;
    const range = moveDef.range ?? MELEE_RANGE;
    const radius = moveDef.radius ?? MELEE_RADIUS;
    this._attackDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).normalize();
    this._hitCheckOrigin.copy(this.mesh.position).addScaledVector(this._attackDir, range);
    let closest = null;
    let minDist = Infinity;
    for (const target of targets) {
      if (!target?.mesh) continue;
      const dist = this._hitCheckOrigin.distanceTo(target.mesh.position);
      const targetRadius = target.radius ?? 0.6;
      if (dist <= radius + targetRadius && dist < minDist) {
        minDist = dist;
        closest = target;
      }
    }
    return closest;
  }

  #tickCombat(delta) {
    const combat = this.combatState;
    if (!combat) return;
    combat.hitStopTimer = Math.max(0, combat.hitStopTimer - delta);
    combat.blockTimer = Math.max(0, combat.blockTimer - delta);
    combat.dodgeTimer = Math.max(0, combat.dodgeTimer - delta);
    combat.invulnTimer = Math.max(0, combat.invulnTimer - delta);
    combat.stunTimer = Math.max(0, combat.stunTimer - delta);

    combat.stamina = Math.min(combat.maxStamina, combat.stamina + this.combatParams.staminaRegen * delta);
    combat.focus = Math.min(combat.maxFocus, combat.focus + this.combatParams.focusRegen * delta);

    if (combat.guardRegenDelay > 0) {
      combat.guardRegenDelay = Math.max(0, combat.guardRegenDelay - delta);
    } else {
      const regenFactor = combat.blockTimer > 0 ? 0.35 : 1;
      combat.guardGauge = Math.min(
        combat.guardMax,
        combat.guardGauge + this.combatParams.guardRegenRate * regenFactor * delta,
      );
    }
  }

  #updateBlockState(delta, blocking) {
    if (blocking) {
      this.blockStateTimer = Math.max(0, this.blockStateTimer - delta);
      if (!this.blockState) {
        this.blockState = 'BlockStart';
        this.blockStateTimer = 0.18;
        this.setState('BlockStart');
      } else if (this.blockState === 'BlockStart' && this.blockStateTimer <= 0) {
        this.blockState = 'BlockIdle';
        this.setState('BlockIdle');
      } else if (this.blockState === 'BlockHit' && this.blockStateTimer <= 0) {
        this.blockState = 'BlockIdle';
        this.setState('BlockIdle');
      }
    } else if (this.blockState) {
      this.blockState = null;
      this.blockStateTimer = 0;
      if (this.currentState && this.currentState.startsWith('Block')) {
        this.setState('Idle');
      }
    }
  }

  #tickSpecialCooldowns(delta) {
    if (!this.specialCooldowns.size) return;
    for (const [id, value] of this.specialCooldowns.entries()) {
      const next = Math.max(0, value - delta);
      if (next <= 0) {
        this.specialCooldowns.delete(id);
        this.emitEvent('specialReady', { actorId: this.actorId, id });
      } else {
        this.specialCooldowns.set(id, next);
      }
    }
  }

  #updateBuffs(delta) {
    if (!this.activeBuffs.size) return;
    for (const [id, buff] of this.activeBuffs.entries()) {
      buff.remaining = Math.max(0, (buff.remaining ?? buff.duration ?? 0) - delta);
      if (buff.remaining <= 0) {
        this.activeBuffs.delete(id);
        this.emitEvent('specialBuffEnd', { actorId: this.actorId, id, buff });
      }
    }
  }

  #onBlockImpact(parry = false) {
    this.blockState = 'BlockHit';
    this.blockStateTimer = parry ? 0.18 : 0.35;
    this.setState('BlockHit');
    this.emitEvent('blockImpact', { actorId: this.actorId, parry });
  }

  #canPerformAttack() {
    return (
      !this.attackState.active
      && this.combatState.stunTimer <= 0
      && this.combatState.blockTimer <= 0
      && this.combatState.dodgeTimer <= 0
      && this.combatState.hitStopTimer <= 0
    );
  }

  #consumeStamina(cost = 0, force = false) {
    if (!cost) return true;
    if (force) {
      this.combatState.stamina = Math.max(0, this.combatState.stamina - cost);
      return true;
    }
    if (this.combatState.stamina < cost) {
      return false;
    }
    this.combatState.stamina -= cost;
    return true;
  }

  #tryStartBlock({ force = false } = {}) {
    if (this.combatState.blockTimer > 0 || this.combatState.stunTimer > 0) return false;
    if (!this.#consumeStamina(COSTS.BLOCK, force)) return false;
    this.combatState.blockTimer = this.combatParams.blockDuration;
    this.combatState.guardRegenDelay = Math.max(this.combatState.guardRegenDelay, 0.35);
    this.emitEvent('blockStart', { actorId: this.actorId });
    this.blockState = 'BlockStart';
    this.blockStateTimer = Math.min(0.25, this.combatParams.blockDuration * 0.5);
    this.setState('BlockStart');
    this.#recordInput('BLOCK');
    return true;
  }

  #tryStartDodge({ force = false } = {}) {
    if (this.combatState.dodgeTimer > 0 || this.combatState.stunTimer > 0) return false;
    if (!this.#consumeStamina(COSTS.DODGE, force)) return false;
    this.combatState.dodgeTimer = this.combatParams.dodgeDuration;
    this.combatState.invulnTimer = Math.max(this.combatState.invulnTimer, this.combatParams.iframeDuration);
    this.emitEvent('dodgeStart', { actorId: this.actorId });
    this.dodgeAnimTimer = this.combatParams.dodgeDuration;
    this.setState('Dodge');
    this.#applyDodgeImpulse();
    this.#recordInput('DODGE');
    return true;
  }

  #resolveSpecial(definition) {
    if (!definition) return null;
    if (typeof definition === 'string') {
      return this.specialMoves?.[definition] ?? null;
    }
    return definition;
  }

  #getSpecialFocusCost(definition) {
    if (!definition) return 0;
    if (typeof definition.focusCost === 'number') {
      return definition.focusCost;
    }
    if (typeof definition.focusCostPct === 'number') {
      return Math.round((definition.focusCostPct || 0) * (this.combatState.maxFocus ?? FO_MAX));
    }
    return 0;
  }

  #consumeFocus(amount = 0, force = false) {
    if (!amount) return true;
    if (force) {
      this.combatState.focus = Math.max(0, this.combatState.focus - amount);
      return true;
    }
    if (this.combatState.focus < amount) {
      return false;
    }
    this.combatState.focus -= amount;
    return true;
  }

  #applyPushback(distance = 0, attackerYaw = this.yaw) {
    if (!distance) return;
    this._attackDir.set(Math.sin(attackerYaw), 0, Math.cos(attackerYaw)).normalize().multiplyScalar(distance);
    this.physics.move(this._attackDir, this.actorId);
  }

  #resolveStunDuration(value = 0) {
    if (!value || value <= 0) return 0;
    const scaled = value * STUN_DECAY;
    return Math.min(Math.max(scaled, 0.05), STUN_MAX);
  }

  receiveHit(amountOrConfig = {}) {
    const config = typeof amountOrConfig === 'number' ? { damage: amountOrConfig } : { ...amountOrConfig };
    const combat = this.combatState;
    const maxHp = combat.maxHp;
    const impact = {
      hit: false,
      blocked: false,
      parry: false,
      chip: 0,
      damage: 0,
      hp: combat.hp,
      guard: combat.guardGauge,
    };

    if (combat.invulnTimer > 0 && !config.ignoreInvuln) {
      return impact;
    }

    const comboScale = config.comboScale ?? 1;
    const damage = Math.max(0, config.damage ?? config.moveDef?.damage ?? 0);
    const guardDamage = config.guardDamage ?? config.moveDef?.guardDamage ?? 0;
    const chipPercent = config.chipPercent ?? config.moveDef?.chipPercent ?? 0;
    const hitStun = config.hitStun ?? config.moveDef?.hitStun ?? 0;
    const blockStun = config.blockStun ?? config.moveDef?.blockStun ?? 0.2;
    const pushBack = config.pushBack ?? config.moveDef?.pushBack ?? 0;
    const blockPush = config.blockPush ?? config.moveDef?.blockPush ?? pushBack * 0.6;
    const hitStopOnHit = config.hitStop?.onHit ?? 0;
    const hitStopOnBlock = config.hitStop?.onBlock ?? 0;
    const blocking = combat.blockTimer > 0 && !config.unblockable;

    if (blocking) {
      const parryThreshold = this.combatParams.blockDuration - 0.15;
      const isParry = combat.blockTimer >= parryThreshold && !config.disableParry;
      impact.blocked = true;
      if (isParry) {
        impact.parry = true;
        const attacker = typeof this.actorResolver === 'function' ? this.actorResolver(config.attackerId) : null;
        attacker?.applyStun?.(0.55);
      } else {
        const guardScale = 0.65 + comboScale * 0.35;
        const scaledGuardDamage = guardDamage ? guardDamage * guardScale : 0;
        combat.guardGauge = Math.max(0, combat.guardGauge - scaledGuardDamage);
        combat.guardRegenDelay = Math.max(combat.guardRegenDelay, this.combatParams.guardRegenDelay);
        const newStun = this.#resolveStunDuration(blockStun);
        if (newStun > 0) {
          combat.stunTimer = Math.max(combat.stunTimer, newStun);
        }
        const staminaCost = config.staminaOnBlock ?? 10;
        combat.stamina = Math.max(0, combat.stamina - staminaCost);
        if (chipPercent > 0 && damage > 0) {
          const chip = Math.max(1, Math.round(damage * chipPercent));
          combat.hp = Math.max(0, combat.hp - chip);
          impact.chip = chip;
        }
        // Pushback disabled; legacy scene handles reactions via animation only.
        if (combat.guardGauge <= 0) {
          combat.guardGauge = combat.guardMax;
          combat.stunTimer = Math.max(combat.stunTimer, this.combatParams.guardBreakStun);
          this.emitEvent('guardBreak', { actorId: this.actorId, attackerId: config.attackerId });
        }
    }
      this.#onBlockImpact(isParry);
    if (hitStopOnBlock) {
      this.applyHitStop(hitStopOnBlock);
    }
    impact.hp = combat.hp;
    impact.guard = combat.guardGauge;
      return impact;
    }

    const finalDamage = Math.max(0, Math.round(damage * comboScale));
    combat.hp = Math.max(0, combat.hp - finalDamage);
    combat.guardRegenDelay = Math.max(combat.guardRegenDelay, this.combatParams.guardRegenDelay);
    const resolvedStun = this.#resolveStunDuration(hitStun);
    if (resolvedStun > 0) {
      combat.stunTimer = Math.max(combat.stunTimer, resolvedStun);
    }
    // Pushback disabled to avoid teleporting legacy actors.
    impact.hit = true;
    impact.damage = finalDamage;
    if (hitStopOnHit) {
      this.applyHitStop(hitStopOnHit);
    }
    impact.hp = combat.hp;
    impact.guard = combat.guardGauge;
    if (combat.hp <= 0) {
      combat.hp = 0;
      this.setState('Death');
      this.emitEvent('death', { actorId: this.actorId });
    } else {
      this.setState('HitStun');
    }
    return impact;
  }

  applyHitStop(duration = 0) {
    if (duration <= 0) return;
    this.combatState.hitStopTimer = Math.max(this.combatState.hitStopTimer, duration);
  }

  applyStun(duration = 0) {
    if (duration <= 0) return;
    this.combatState.stunTimer = Math.max(this.combatState.stunTimer, duration);
  }

  applyOffensiveResult(result = {}, moveDef = null) {
    if (!moveDef) return;
    if (result.hit && moveDef.focusGain) {
      this.combatState.focus = Math.min(
        this.combatState.maxFocus,
        this.combatState.focus + (moveDef.focusGain ?? 0),
      );
    }
    const hitStopValue = result.blocked ? moveDef.hitStop?.onBlock : moveDef.hitStop?.onHit;
    if (hitStopValue) {
      this.applyHitStop(hitStopValue);
    }
  }

  #recordInput(kind) {
    if (!kind) return;
    this.inputBuffer.push({ kind, time: this.bufferClock });
    this.#pruneInputBuffer();
    this.#checkComboPatterns();
  }

  #pruneInputBuffer() {
    if (!this.inputBuffer.length) return;
    const cutoff = this.bufferClock - this.comboWindow;
    while (this.inputBuffer.length && this.inputBuffer[0].time < cutoff) {
      this.inputBuffer.shift();
    }
  }

  #checkComboPatterns() {
    if (!this.specialMoves) return;
    for (const def of Object.values(this.specialMoves)) {
      if (!def || !Array.isArray(def.pattern) || def.pattern.length === 0) continue;
      if (!this.#bufferMatchesPattern(def.pattern)) continue;
      const lastTrigger = this.comboLatch.get(def.id) ?? -Infinity;
      if (this.bufferClock - lastTrigger < SPECIAL_BUFFER_LATCH) continue;
      this.comboLatch.set(def.id, this.bufferClock);
      if (this.requestSpecial(def)) {
        this.inputBuffer.length = Math.max(0, this.inputBuffer.length - def.pattern.length);
        break;
      }
    }
  }

  #bufferMatchesPattern(pattern) {
    if (this.inputBuffer.length < pattern.length) return false;
    const start = this.inputBuffer.length - pattern.length;
    for (let i = 0; i < pattern.length; i += 1) {
      if (this.inputBuffer[start + i].kind !== pattern[i]) {
        return false;
      }
    }
    return true;
  }

  resetCombatState(overrides = {}) {
    const nextMaxHp = Math.max(1, overrides.maxHp ?? overrides.hpMax ?? this.combatState.maxHp ?? HP_MAX);
    const nextMaxStamina = Math.max(1, overrides.maxStamina ?? overrides.staminaMax ?? this.combatState.maxStamina ?? ST_MAX);
    const nextGuardMax = Math.max(1, overrides.guardMax ?? this.combatState.guardMax ?? GUARD_MAX);
    this.combatState.maxHp = nextMaxHp;
    this.combatState.hp = clampValue(overrides.hp ?? this.combatState.hp ?? nextMaxHp, 0, nextMaxHp);
    this.combatState.maxStamina = nextMaxStamina;
    this.combatState.stamina = clampValue(overrides.stamina ?? overrides.st ?? this.combatState.stamina ?? nextMaxStamina, 0, nextMaxStamina);
    this.combatState.maxFocus = overrides.maxFocus ?? this.combatState.maxFocus ?? FO_MAX;
    this.combatState.focus = clampValue(overrides.focus ?? overrides.fo ?? this.combatState.focus ?? 0, 0, this.combatState.maxFocus);
    this.combatState.guardMax = nextGuardMax;
    this.combatState.guardGauge = clampValue(overrides.guardGauge ?? this.combatState.guardGauge ?? nextGuardMax, 0, nextGuardMax);
    this.combatState.guardRegenDelay = overrides.guardRegenDelay ?? 0;
    this.combatState.blockTimer = 0;
    this.combatState.dodgeTimer = 0;
    this.combatState.invulnTimer = 0;
    this.combatState.hitStopTimer = 0;
    this.combatState.stunTimer = 0;
    this.#resetAttackState(true, true);
    this.specialCooldowns.clear();
    this.activeBuffs.clear();
    this.inputBuffer.length = 0;
    this.comboLatch.clear();
    this.actionRequests.attack = null;
    this.actionRequests.special = null;
  }

  getCombatState() {
    return { ...this.combatState };
  }

  getStatusSnapshot() {
    const buffs = [];
    for (const buff of this.activeBuffs.values()) {
      buffs.push({
        id: buff.id,
        type: buff.type,
        remaining: Math.max(0, buff.remaining ?? buff.duration ?? 0),
        duration: buff.duration ?? buff.remaining ?? 0,
      });
    }
    const specials = [];
    for (const [id, remaining] of this.specialCooldowns.entries()) {
      specials.push({ id, remaining });
    }
    return { buffs, specials };
  }

  getAttackSnapshot() {
    if (!this.attackState.active) {
      return { active: false, phase: null, phaseTimer: 0, totalRemaining: 0, kind: null };
    }
    return {
      active: true,
      phase: this.attackState.phase,
      phaseTimer: this.attackState.phaseTimer,
      totalRemaining: this.attackState.remainingTotal,
      kind: this.attackState.kind,
    };
  }

  #rotateTowards(direction, delta) {
    this.tmpVec.copy(direction).setY(0).normalize();
    if (this.tmpVec.lengthSq() === 0) return;
    const targetYaw = Math.atan2(this.tmpVec.x, this.tmpVec.z);
    const diff = THREE.MathUtils.euclideanModulo(targetYaw - this.yaw + Math.PI, Math.PI * 2) - Math.PI;
    const step = Math.sign(diff) * Math.min(Math.abs(diff), this.params.rotationSpeed * delta);
    this.yaw += step;
    this.tmpQuat.setFromAxisAngle(WORLD_UP, this.yaw);
    this.physics.rotate(this.tmpQuat, this.actorId);
  }
}

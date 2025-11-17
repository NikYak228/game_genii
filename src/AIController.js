import * as THREE from 'three';

const CLOSE_DIST = 3.0;
const ENEMY_ENGAGE_DIST = 16;
const PLAYER_SPEED = 6.0;

export class AIController {
  constructor({ actorId, controller, input, mesh, studentProfile = {}, getTargetSlot }) {
    if (!controller || !input || !mesh) {
      throw new Error('AIController requires controller, input manager and mesh references.');
    }
    this.actorId = actorId;
    this.controller = controller;
    this.input = input;
    this.mesh = mesh;
    this.profile = studentProfile;
    this.getTargetSlot = typeof getTargetSlot === 'function' ? getTargetSlot : () => null;
    this.state = {
      strategy: 'ENGAGED',
      actionQueue: [],
      currentActionTimer: 0,
      strafeTimer: 0,
      strafeDir: 1,
      decisionTimer: 0,
    };
    this.decisionInterval = 0.18;
    this.tmpMove = new THREE.Vector3();
    this.tmpDir = new THREE.Vector3();
    this.tmpPerp = new THREE.Vector3();
  }

  update(dt) {
    const targetSlot = this.getTargetSlot();
    if (!targetSlot || !targetSlot.controller || !targetSlot.model) {
      this.input.setMoveVector?.(null);
      return;
    }

    const actorData = this.#snapshotCombat(this.controller);
    const targetData = this.#snapshotCombat(targetSlot.controller);

    if (actorData.hitStop > 0 || actorData.stun > 0) {
      this.input.setMoveVector?.(null);
      return;
    }

    this.#updateStrategy(actorData);
    this.#updateMovement(dt, targetSlot, actorData);
    this.#updateActions(dt, actorData, targetData, targetSlot);
  }

  #updateStrategy(actorData) {
    const hpPct = actorData.hp > 0 ? actorData.hp / actorData.maxHp : 0;
    const stPct = actorData.stamina > 0 ? actorData.stamina / actorData.maxStamina : 0;
    if (this.state.strategy === 'ENGAGED' && hpPct < 0.3 && stPct < 0.25) {
      this.state.strategy = 'RETREAT';
    } else if (this.state.strategy === 'RETREAT' && (hpPct > 0.55 || stPct > 0.6)) {
      this.state.strategy = 'ENGAGED';
    }
  }

  #updateMovement(dt, targetSlot, actorData) {
    const targetPos = targetSlot.model.position;
    const toTarget = this.tmpDir.copy(targetPos).sub(this.mesh.position).setY(0);
    const distance = toTarget.length();
    if (distance > 0.0001) {
      toTarget.normalize();
    }

    const psv = this.profile.psv || {};
    let engageDistance = typeof psv.mean_engagement_distance === 'number'
      ? THREE.MathUtils.clamp(psv.mean_engagement_distance, CLOSE_DIST * 0.6, ENEMY_ENGAGE_DIST)
      : CLOSE_DIST * 1.2;

    if (this.state.strategy === 'RETREAT') {
      engageDistance = Math.max(engageDistance, CLOSE_DIST * 1.8);
    }

    this.state.strafeTimer -= dt;
    if (this.state.strafeTimer <= 0) {
      this.state.strafeTimer = 0.3 + Math.random() * 0.4;
      this.state.strafeDir = Math.random() < 0.5 ? -1 : 1;
    }

    const moveVec = this.tmpMove.set(0, 0, 0);
    if (this.state.strategy === 'RETREAT') {
      moveVec.copy(toTarget).multiplyScalar(-PLAYER_SPEED * 0.85);
    } else if (distance > engageDistance * 1.05) {
      moveVec.copy(toTarget).multiplyScalar(PLAYER_SPEED);
    } else {
      this.tmpPerp.set(toTarget.z, 0, -toTarget.x);
      if (this.tmpPerp.lengthSq() === 0) {
        this.tmpPerp.set(0, 0, 1);
      }
      this.tmpPerp.normalize();
      moveVec.copy(this.tmpPerp).multiplyScalar(this.state.strafeDir * PLAYER_SPEED * 0.65);
      const pulse = Math.sin(Date.now() * 0.0025);
      moveVec.addScaledVector(toTarget, pulse * PLAYER_SPEED * 0.15);
    }

    if (moveVec.lengthSq() > 0) {
      moveVec.normalize();
      this.input.setMoveVector?.(moveVec);
    } else {
      this.input.setMoveVector?.(null);
    }
  }

  #updateActions(dt, actorData, targetData, targetSlot) {
    const attackSnapshot = this.controller.getAttackSnapshot?.();
    const busy = attackSnapshot?.active || actorData.stun > 0 || actorData.block > 0;
    if (busy) {
      this.state.actionQueue.length = 0;
      this.state.currentActionTimer = Math.max(this.state.currentActionTimer, 0.1);
      return;
    }

    this.state.currentActionTimer = Math.max(0, this.state.currentActionTimer - dt);
    this.state.decisionTimer = Math.max(0, this.state.decisionTimer - dt);

    if (this.state.actionQueue.length === 0 && this.state.currentActionTimer <= 0 && this.state.decisionTimer <= 0) {
      const situationKey = this.getSituationKey(actorData, targetData, this.mesh, targetSlot.model);
      const kbScores = this.getKBActionScores(this.profile, situationKey);
      const context = {
        dist: this.mesh.position.distanceTo(targetSlot.model.position),
        isOppAttacking: (targetData.attackTimer ?? 0) > 0,
        isOppBlocking: (targetData.block ?? 0) > 0,
        playerSt: actorData.stamina,
        playerFo: actorData.focus,
        playerHp: actorData.hp,
        enemyHp: targetData.hp,
      };
      const action = this.utilityAIChooseAction(this.profile.psv || {}, context, kbScores);
      if (action) {
        this.state.actionQueue.push(action);
      }
      this.state.decisionTimer = this.decisionInterval + Math.random() * 0.05;
    }

    if (this.state.actionQueue.length === 0) return;

    const action = this.state.actionQueue[0];
    const executed = this.#executeAction(action, targetSlot);
    if (executed) {
      this.state.actionQueue.shift();
      this.state.currentActionTimer = this.#actionCooldown(action);
    }
  }

  #executeAction(action, targetSlot) {
    switch (action) {
      case 'LIGHT':
      case 'HEAVY':
        return this.controller.requestAttack(action);
      case 'BLOCK':
        return this.controller.requestBlock();
      case 'DODGE':
        return this.controller.requestDodge();
      case 'SPECIAL': {
        const specials = Array.isArray(this.profile.learnedSpecials) ? this.profile.learnedSpecials : [];
        if (!specials.length) return false;
        const choice = specials[Math.floor(Math.random() * specials.length)];
        return this.controller.requestSpecial(choice);
      }
      case 'WAIT':
      default:
        return true;
    }
  }

  #actionCooldown(action) {
    switch (action) {
      case 'LIGHT':
        return 0.45;
      case 'HEAVY':
        return 0.75;
      case 'BLOCK':
        return 0.4;
      case 'DODGE':
        return 0.35;
      case 'SPECIAL':
        return 0.6;
      default:
        return 0.25;
    }
  }

  utilityAIChooseAction(psv, context, kbScores) {
    const actions = ['LIGHT', 'HEAVY', 'BLOCK', 'DODGE', 'WAIT', 'SPECIAL'];
    const scores = { LIGHT: 0, HEAVY: 0, BLOCK: 0, DODGE: 0, WAIT: 0.1, SPECIAL: 0 };
    const aggrRaw = psv?.aggression_ratio ?? 0.6;
    const aggr = aggrRaw / (aggrRaw + 1);
    const bvrRaw = psv?.block_vs_evade_ratio ?? 0.5;
    const bvr = bvrRaw / (bvrRaw + 1);
    const prefDist = typeof psv?.mean_engagement_distance === 'number' ? psv.mean_engagement_distance : CLOSE_DIST * 1.2;
    const distDelta = (context.dist ?? prefDist) - prefDist;

    scores.LIGHT += 0.4 + 0.8 * aggr;
    scores.HEAVY += 0.2 + 1.0 * aggr;
    scores.BLOCK += 0.3 + 0.9 * bvr;
    scores.DODGE += 0.25 + 0.8 * (1 - bvr);

    if (context.isOppAttacking) {
      scores.BLOCK += 0.8;
      scores.DODGE += 0.6;
    } else {
      scores.LIGHT += 0.3;
      scores.HEAVY += 0.2;
    }

    if ((context.playerSt ?? 0) < 15) {
      scores.BLOCK += 0.6;
      scores.DODGE += 0.4;
      scores.HEAVY -= 0.6;
      scores.WAIT += 0.7;
    }

    if (distDelta > 0.5) {
      scores.LIGHT -= 0.4;
      scores.HEAVY -= 0.6;
      scores.SPECIAL -= 0.8;
      scores.WAIT += 0.5;
    }

    if ((context.playerFo ?? 0) > 25) {
      scores.SPECIAL += 0.6;
    }

    if (kbScores) {
      for (const key of actions) {
        if (typeof kbScores[key] === 'number') {
          scores[key] += kbScores[key];
        }
      }
    }

    let best = 'WAIT';
    let bestScore = -Infinity;
    for (const key of actions) {
      if (scores[key] > bestScore) {
        bestScore = scores[key];
        best = key;
      }
    }
    return best;
  }

  getKBActionScores(profile, situationKey) {
    const out = { LIGHT: 0, HEAVY: 0, BLOCK: 0, DODGE: 0, WAIT: 0, SPECIAL: 0 };
    if (!profile || !profile.knowledgeBase || !situationKey) {
      return out;
    }
    const entries = profile.knowledgeBase[situationKey] || [];
    for (const entry of entries) {
      const first = entry.sequence?.[0];
      if (first && out[first] !== undefined) {
        out[first] += entry.effectiveness ?? 0;
      }
    }
    return out;
  }

  getSituationKey(actorData, targetData, actorMesh, targetMesh) {
    const distance = actorMesh.position.distanceTo(targetMesh.position);
    let distCategory = 'Дальняя';
    if (distance < CLOSE_DIST) distCategory = 'Близкая';
    else if (distance < ENEMY_ENGAGE_DIST) distCategory = 'Средняя';
    const targetState = (targetData.attackTimer > 0) ? 'Атакует' : ((targetData.block > 0) ? 'Блок' : 'Свободен');
    const staminaRatio = actorData.stamina / Math.max(1, actorData.maxStamina);
    const actorStamina = staminaRatio > 0.6 ? 'ST-выс' : (staminaRatio > 0.35 ? 'ST-сред' : 'ST-низ');
    const focusRatio = actorData.focus / Math.max(1, actorData.maxFocus ?? 50);
    const actorFocus = focusRatio > 0.66 ? 'FO-выс' : (focusRatio > 0.33 ? 'FO-сред' : 'FO-низ');
    return [distCategory, targetState, actorStamina, actorFocus].join('|');
  }

  #snapshotCombat(controller) {
    const combat = controller.getCombatState?.() || {};
    const attack = controller.getAttackSnapshot?.() || {};
    return {
      hp: combat.hp ?? 0,
      maxHp: combat.maxHp ?? 1,
      stamina: combat.stamina ?? 0,
      maxStamina: combat.maxStamina ?? 1,
      focus: combat.focus ?? 0,
      maxFocus: combat.maxFocus ?? 1,
      guard: combat.guardGauge ?? 0,
      block: combat.blockTimer ?? 0,
      dodge: combat.dodgeTimer ?? 0,
      stun: combat.stunTimer ?? 0,
      hitStop: combat.hitStopTimer ?? 0,
      attackTimer: attack.totalRemaining ?? 0,
    };
  }
}

import * as THREE from 'three';

const DEFAULT_SHOCK_COLOR = 0x7dd3fc;
const DEFAULT_SLASH_COLOR = 0xfca5a5;
const DEFAULT_SPARK_COLOR = 0xfff08a;

export class VFXManager {
  constructor(scene) {
    this.scene = scene;
    this.effects = new Set();
    this.actorResolver = null;
    this.energyShields = new Map();
    this.weaponFlames = new Map();
    this.stunEffects = new Map();
    this.tmpVec = new THREE.Vector3();
    this.effectPools = new Map();
    this.lowFX = false;
  }

  setActorResolver(resolver) {
    this.actorResolver = resolver;
  }

  setLowFX(enabled) {
    const next = !!enabled;
    if (this.lowFX === next) return;
    this.lowFX = next;
    if (this.lowFX) {
      for (const effect of Array.from(this.effects)) {
        if (effect.poolKey && ['slash', 'trail', 'shard'].includes(effect.poolKey)) {
          this.removeEffect(effect);
        }
      }
      for (const actorId of Array.from(this.weaponFlames.keys())) {
        this.#disposeFlame(actorId);
      }
    }
  }

  update(delta) {
    if (this.effects.size) {
      for (const effect of Array.from(this.effects)) {
        effect.time += delta;
        const t = effect.life > 0 ? effect.time / effect.life : 1;
        if (effect.update) {
          effect.update(t, delta);
        }
        if (effect.time >= effect.life) {
          this.removeEffect(effect);
        }
      }
    }

    for (const shield of this.energyShields.values()) {
      shield.timer = Math.max(0, shield.timer - delta);
      const targetOpacity = shield.timer > 0 ? 0.6 : 0;
      shield.material.opacity += (targetOpacity - shield.material.opacity) * Math.min(1, delta * 6);
      shield.mesh.visible = shield.material.opacity > 0.05;
      if (!shield.mesh.visible && shield.timer <= 0) {
        shield.parent.remove(shield.mesh);
        shield.mesh.geometry.dispose();
        shield.mesh.material.dispose();
        this.energyShields.delete(shield.actorId);
      }
    }

    for (const flame of this.weaponFlames.values()) {
      flame.timer = Math.max(0, flame.timer - delta);
      const slot = this.#resolveActor(flame.actorId);
      if (!slot) {
        this.#disposeFlame(flame.actorId);
        continue;
      }
      flame.material.opacity = 0.4 + Math.abs(Math.sin(Date.now() * 0.005)) * 0.25;
      this.#positionFlameMesh(flame.mesh, slot);
      if (flame.timer <= 0) {
        this.#disposeFlame(flame.actorId);
      }
    }

    for (const effect of Array.from(this.stunEffects.values())) {
      effect.timer -= delta;
      const slot = this.#resolveActor(effect.actorId);
      if (!slot || !slot.model || effect.timer <= 0) {
        this.#disposeStun(effect.actorId);
        continue;
      }
      effect.mesh.rotation.y += delta * 4;
      effect.mesh.position.copy(slot.model.position).setY(slot.model.position.y + 1.8);
    }
  }

  handleEvent(event, payload = {}) {
    switch (event) {
      case 'attackStart':
        this.#handleAttackStart(payload);
        break;
      case 'hit':
        this.#handleHit(payload);
        break;
      case 'blockStart':
        this.#ensureShield(payload.actorId);
        break;
      case 'blockImpact':
        this.#pulseShield(payload.actorId, payload.parry);
        break;
      case 'specialStart':
        this.#handleSpecialStart(payload);
        break;
      case 'specialBuffEnd':
        if (payload.id === 'FIRE_BLADE') {
          this.#disposeFlame(payload.actorId);
        }
        break;
      case 'stunStart':
        this.#ensureStunEffect(payload.actorId, payload.duration);
        break;
      case 'stunEnd':
        this.#disposeStun(payload.actorId);
        break;
      case 'guardBreak':
        this.#handleGuardBreak(payload);
        break;
      case 'death':
        this.#disposeFlame(payload.actorId);
        this.#removeShield(payload.actorId);
        this.#disposeStun(payload.actorId);
        break;
      default:
        break;
    }
  }

  spawnShockwave(position, color = DEFAULT_SHOCK_COLOR) {
    const resource = this.#acquireFromPool('shockwave', () => {
      const geometry = new THREE.RingGeometry(0.1, 0.2, 32);
      const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      return { mesh, material };
    });
    const { mesh, material } = resource;
    mesh.visible = true;
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.setScalar(1);
    material.opacity = 0.9;
    material.color.set(color);
    mesh.position.copy(position).setY(0.02);
    if (!mesh.parent) this.scene.add(mesh);
    const effect = {
      mesh,
      life: 0.6,
      time: 0,
      poolKey: 'shockwave',
      poolResource: resource,
      update: (t) => {
        mesh.scale.setScalar(THREE.MathUtils.lerp(1, 6, t));
        material.opacity = 0.9 * (1 - t);
      },
    };
    this.effects.add(effect);
  }

  spawnSlashArc(actorId, color = DEFAULT_SLASH_COLOR) {
    if (this.lowFX) return;
    const slot = this.#resolveActor(actorId);
    if (!slot?.model) return;
    const yaw = slot.controller?.yaw ?? slot.model.rotation?.y ?? 0;
    const resource = this.#acquireFromPool('slash', () => {
      const geometry = new THREE.RingGeometry(0.6, 0.85, 32, 1, -Math.PI / 3, (Math.PI * 2) / 3);
      const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, material);
      return { mesh, material };
    });
    const { mesh, material } = resource;
    const forward = this.tmpVec.set(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
    mesh.visible = true;
    mesh.scale.setScalar(1);
    mesh.rotation.set(0, yaw, 0);
    material.opacity = 0.85;
    material.color.set(color);
    mesh.position.copy(slot.model.position).addScaledVector(forward, 0.8).setY(slot.model.position.y + 1);
    if (!mesh.parent) this.scene.add(mesh);
    const effect = {
      mesh,
      life: 0.25,
      time: 0,
      poolKey: 'slash',
      poolResource: resource,
      update: (t, delta) => {
        mesh.position.y += delta * 2;
        mesh.scale.setScalar(THREE.MathUtils.lerp(1, 1.4, t));
        material.opacity = 0.85 * (1 - t);
      },
    };
    this.effects.add(effect);
  }

  spawnHitSpark(position, color = DEFAULT_SPARK_COLOR) {
    const resource = this.#acquireFromPool('spark', () => {
      const geometry = new THREE.SphereGeometry(0.06, 8, 8);
      const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
      const mesh = new THREE.Mesh(geometry, material);
      return { mesh, material };
    });
    const { mesh, material } = resource;
    mesh.visible = true;
    mesh.scale.setScalar(1);
    material.opacity = 1;
    material.color.set(color);
    mesh.position.copy(position);
    if (!mesh.parent) this.scene.add(mesh);
    const effect = {
      mesh,
      life: 0.2,
      time: 0,
      poolKey: 'spark',
      poolResource: resource,
      update: (t) => {
        mesh.position.y += 0.6 * t;
        material.opacity = 1 - t;
      },
    };
    this.effects.add(effect);
  }

  spawnTrailParticle(position, color = DEFAULT_SPARK_COLOR) {
    if (this.lowFX) return;
    const resource = this.#acquireFromPool('trail', () => {
      const geometry = new THREE.SphereGeometry(0.05, 5, 5);
      const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
      const mesh = new THREE.Mesh(geometry, material);
      return { mesh, material };
    });
    const { mesh, material } = resource;
    mesh.visible = true;
    const randomScale = Math.random() * 0.5 + 0.8;
    mesh.scale.setScalar(randomScale);
    material.opacity = 1;
    material.color.set(color ?? DEFAULT_SPARK_COLOR);
    mesh.position.copy(position);
    mesh.position.x += (Math.random() - 0.5) * 0.2;
    mesh.position.z += (Math.random() - 0.5) * 0.2;
    if (!mesh.parent) this.scene.add(mesh);
    const vel = new THREE.Vector3(0, 0.6, 0);
    const effect = {
      mesh,
      life: Math.random() * 0.5 + 0.3,
      time: 0,
      velocity: vel,
      poolKey: 'trail',
      poolResource: resource,
      update: (t, delta) => {
        mesh.position.addScaledVector(vel, delta);
        vel.y -= 2.2 * delta;
        material.opacity = 1 - t;
        mesh.scale.setScalar(randomScale * (1 - t));
      },
    };
    this.effects.add(effect);
  }

  spawnShardBurst(position, color = 0x9ddcff) {
    const shards = this.lowFX ? 3 : 6;
    for (let i = 0; i < shards; i += 1) {
      const resource = this.#acquireFromPool('shard', () => {
        const geometry = new THREE.ConeGeometry(0.08, 0.25, 6);
        const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
        const mesh = new THREE.Mesh(geometry, material);
        return { mesh, material };
      });
      const { mesh, material } = resource;
      mesh.visible = true;
      mesh.scale.setScalar(1);
      material.opacity = 1;
      material.color.set(color);
      mesh.position.copy(position);
      mesh.position.x += (Math.random() - 0.5) * 0.4;
      mesh.position.z += (Math.random() - 0.5) * 0.4;
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      if (!mesh.parent) this.scene.add(mesh);
      const velocity = new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 2 + 1.2, (Math.random() - 0.5) * 4);
      const effect = {
        mesh,
        life: 0.45,
        time: 0,
        velocity,
        poolKey: 'shard',
        poolResource: resource,
        update: (t, delta) => {
          mesh.position.addScaledVector(velocity, delta);
          velocity.y -= 6 * delta;
          mesh.rotation.x += delta * 8;
          mesh.rotation.y += delta * 6;
          material.opacity = 1 - t;
        },
      };
      this.effects.add(effect);
    }
  }

  removeEffect(effect) {
    if (!this.effects.has(effect)) return;
    this.effects.delete(effect);
    if (effect.poolKey && effect.poolResource) {
      this.#releaseToPool(effect.poolKey, effect.poolResource);
    } else if (effect.mesh) {
      effect.mesh.parent?.remove(effect.mesh);
      effect.mesh.geometry?.dispose?.();
      effect.mesh.material?.dispose?.();
    }
  }

  #handleAttackStart(payload) {
    if (!payload || !payload.actorId) return;
    if (payload.kind === 'LIGHT' || payload.kind === 'HEAVY') {
      this.spawnSlashArc(payload.actorId);
    }
  }

  #handleHit(payload) {
    const slot = this.#resolveActor(payload?.target);
    if (!slot?.model) return;
    const position = slot.model.position.clone();
    position.y += 1.2;
    this.spawnHitSpark(position);
  }

  #handleGuardBreak(payload) {
    const slot = this.#resolveActor(payload?.actorId);
    if (!slot?.model) return;
    const origin = slot.model.position.clone();
    origin.y += 1.2;
    this.spawnShockwave(origin, 0x9ddcff);
    this.spawnShardBurst(origin, 0x9ddcff);
  }

  #handleSpecialStart(payload) {
    if (!payload?.actorId) return;
    if (payload.id === 'FIRE_BLADE') {
      if (!this.lowFX) {
        this.#attachWeaponFlame(payload.actorId);
      }
    } else if (payload.id === 'POWER_PUSH') {
      const slot = this.#resolveActor(payload.actorId);
      if (slot?.model) {
        this.spawnShockwave(slot.model.position);
      }
    }
  }

  #ensureShield(actorId) {
    if (this.energyShields.has(actorId)) {
      const shield = this.energyShields.get(actorId);
      shield.timer = 0.4;
      return;
    }
    const slot = this.#resolveActor(actorId);
    if (!slot?.model) return;
    const geometry = new THREE.RingGeometry(0.6, 0.95, 48);
    const material = new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.6, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    slot.model.add(mesh);
    mesh.position.set(0, 1.0, 0);
    this.energyShields.set(actorId, { actorId, mesh, material, timer: 0.4, parent: slot.model });
  }

  #pulseShield(actorId, parry = false) {
    const shield = this.energyShields.get(actorId);
    if (!shield) {
      this.#ensureShield(actorId);
      return;
    }
    shield.timer = parry ? 0.5 : 0.3;
    shield.material.color.set(parry ? 0xfef08a : 0x60a5fa);
    shield.material.opacity = parry ? 0.9 : 0.7;
  }

  #removeShield(actorId) {
    const shield = this.energyShields.get(actorId);
    if (!shield) return;
    shield.parent.remove(shield.mesh);
    shield.mesh.geometry.dispose();
    shield.mesh.material.dispose();
    this.energyShields.delete(actorId);
  }

  #attachWeaponFlame(actorId) {
    if (this.lowFX) return;
    if (this.weaponFlames.has(actorId)) {
      const flame = this.weaponFlames.get(actorId);
      flame.timer = 6;
      return;
    }
    const slot = this.#resolveActor(actorId);
    if (!slot?.model) return;
    const geometry = new THREE.ConeGeometry(0.1, 0.45, 16, 1, true);
    const material = new THREE.MeshBasicMaterial({ color: 0xff7a33, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = Math.PI / 2;
    this.scene.add(mesh);
    const flame = { actorId, mesh, material, timer: 6 };
    this.weaponFlames.set(actorId, flame);
    this.#positionFlameMesh(mesh, slot);
  }

  #positionFlameMesh(mesh, slot) {
    if (!slot?.model) return;
    const yaw = slot.controller?.yaw ?? slot.model.rotation?.y ?? 0;
    const forward = this.tmpVec.set(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
    mesh.position.copy(slot.model.position).addScaledVector(forward, 0.45).setY(slot.model.position.y + 1.15);
    mesh.rotation.y = yaw;
  }

  #disposeFlame(actorId) {
    const flame = this.weaponFlames.get(actorId);
    if (!flame) return;
    flame.mesh.parent?.remove(flame.mesh);
    flame.mesh.geometry.dispose();
    flame.mesh.material.dispose();
    this.weaponFlames.delete(actorId);
  }

  #ensureStunEffect(actorId, duration = 0.5) {
    if (!actorId) return;
    const existing = this.stunEffects.get(actorId);
    if (existing) {
      existing.timer = Math.max(existing.timer, duration);
      return;
    }
    const slot = this.#resolveActor(actorId);
    if (!slot?.model) return;
    const geometry = new THREE.RingGeometry(0.25, 0.45, 24);
    const material = new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.copy(slot.model.position).setY(slot.model.position.y + 1.8);
    this.scene.add(mesh);
    this.stunEffects.set(actorId, { actorId, mesh, timer: Math.max(duration, 0.4) });
  }

  #disposeStun(actorId) {
    const entry = this.stunEffects.get(actorId);
    if (!entry) return;
    entry.mesh.parent?.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    entry.mesh.material.dispose();
    this.stunEffects.delete(actorId);
  }

  #acquireFromPool(type, factory) {
    if (!this.effectPools.has(type)) {
      this.effectPools.set(type, []);
    }
    const pool = this.effectPools.get(type);
    return pool.length ? pool.pop() : factory();
  }

  #releaseToPool(type, resource) {
    if (!resource) return;
    if (!this.effectPools.has(type)) {
      this.effectPools.set(type, []);
    }
    resource.mesh.visible = false;
    resource.mesh.parent?.remove(resource.mesh);
    resource.mesh.position.set(0, 0, 0);
    resource.mesh.rotation.set(0, 0, 0);
    resource.mesh.scale.setScalar(1);
    if (resource.material) {
      resource.material.opacity = 1;
    }
    this.effectPools.get(type).push(resource);
  }

  #resolveActor(actorId) {
    if (typeof this.actorResolver === 'function') {
      return this.actorResolver(actorId);
    }
    return null;
  }
}

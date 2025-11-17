import * as THREE from 'three';

const DEFAULT_RAPIER_URL = 'https://cdn.skypack.dev/@dimforge/rapier3d-compat?min';

export class Physics {
  constructor(options = {}) {
    this.options = {
      gravity: options.gravity ?? new THREE.Vector3(0, -9.81, 0),
      rapierUrl: options.rapierUrl ?? DEFAULT_RAPIER_URL,
      enableSnap: options.enableSnap ?? true,
      snapHeight: options.snapHeight ?? 0.4,
      fixedTimeStep: options.fixedTimeStep ?? 1 / 60,
    };
    this.RAPIER = null;
    this.world = null;
    this.actors = new Map();
    this._initPromise = this.#init();
  }

  async #init() {
    const rapierModule = await import(this.options.rapierUrl);
    const RAPIER = rapierModule.default || rapierModule;
    await RAPIER.init();
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World({
      x: this.options.gravity.x,
      y: this.options.gravity.y,
      z: this.options.gravity.z,
    });
    this.world.timestep = this.options.fixedTimeStep;
  }

  async waitForReady() {
    return this._initPromise;
  }

  async createCharacterController(mesh, options = {}) {
    await this.waitForReady();
    if (!this.world) throw new Error('Physics world is not initialised.');

    const R = this.RAPIER;
    const halfHeight = options.halfHeight ?? 0.9;
    const radius = options.radius ?? 0.35;
    const offset = options.offset ?? 0.01;

    const bodyDesc = R.RigidBodyDesc.kinematicPositionBased()
      .setCanSleep(false)
      .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z);
    const body = this.world.createRigidBody(bodyDesc);

    const colliderDesc = R.ColliderDesc.capsule(halfHeight, radius)
      .setFriction(options.friction ?? 0.0)
      .setRestitution(options.restitution ?? 0.0);
    const collider = this.world.createCollider(colliderDesc, body);

    const controller = this.world.createCharacterController(offset);
    if (this.options.enableSnap && controller.enableSnapToGround) {
      controller.enableSnapToGround(options.snapHeight ?? this.options.snapHeight);
    }

    const actorId = options.actorId ?? mesh.uuid ?? `actor_${this.actors.size}`;
    const record = {
      id: actorId,
      body,
      collider,
      controller,
      previousPosition: mesh.position.clone(),
      currentPosition: mesh.position.clone(),
      previousRotation: mesh.quaternion.clone(),
      currentRotation: mesh.quaternion.clone(),
      scratchPosition: new THREE.Vector3(),
      scratchQuaternion: new THREE.Quaternion(),
      scratchVelocity: new THREE.Vector3(),
    };
    this.actors.set(actorId, record);

    return actorId;
  }

  #getActor(actorId) {
    if (!actorId) throw new Error('Physics actorId is required.');
    const record = this.actors.get(actorId);
    if (!record) throw new Error(`Physics actor "${actorId}" not found.`);
    return record;
  }

  move(displacement, actorId) {
    const actor = this.#getActor(actorId);
    if (!displacement) return;
    const R = this.RAPIER;
    const translation = new R.Vector3(displacement.x, displacement.y, displacement.z);
    actor.controller.computeColliderMovement(actor.collider, translation);
    const safeMovement = actor.controller.computedMovement();

    const bodyTranslation = actor.body.translation();
    actor.body.setNextKinematicTranslation({
      x: bodyTranslation.x + safeMovement.x,
      y: bodyTranslation.y + safeMovement.y,
      z: bodyTranslation.z + safeMovement.z,
    });
  }

  rotate(quaternion, actorId) {
    if (!quaternion) return;
    const actor = this.#getActor(actorId);
    actor.body.setNextKinematicRotation({
      x: quaternion.x,
      y: quaternion.y,
      z: quaternion.z,
      w: quaternion.w,
    });
  }

  teleport(actorId, position, quaternion = null) {
    if (!position) return;
    const actor = this.#getActor(actorId);
    actor.body.setNextKinematicTranslation({
      x: position.x,
      y: position.y,
      z: position.z,
    });
    actor.currentPosition.copy(position);
    actor.previousPosition.copy(position);
    if (quaternion) {
      actor.body.setNextKinematicRotation({
        x: quaternion.x,
        y: quaternion.y,
        z: quaternion.z,
        w: quaternion.w,
      });
      actor.currentRotation.copy(quaternion);
      actor.previousRotation.copy(quaternion);
    }
  }

  step() {
    if (!this.world) return;
    for (const actor of this.actors.values()) {
      actor.previousPosition.copy(actor.currentPosition);
      actor.previousRotation.copy(actor.currentRotation);
    }
    this.world.step();
    for (const actor of this.actors.values()) {
      const translation = actor.body.translation();
      const rotation = actor.body.rotation();
      actor.currentPosition.set(translation.x, translation.y, translation.z);
      actor.currentRotation.set(rotation.x, rotation.y, rotation.z, rotation.w);
    }
  }

  getPosition(actorId, alpha = 1) {
    const actor = this.#getActor(actorId);
    return actor.scratchPosition.copy(actor.previousPosition).lerp(actor.currentPosition, THREE.MathUtils.clamp(alpha, 0, 1));
  }

  getRotation(actorId, alpha = 1) {
    const actor = this.#getActor(actorId);
    return actor.scratchQuaternion.copy(actor.previousRotation).slerp(actor.currentRotation, THREE.MathUtils.clamp(alpha, 0, 1));
  }

  getLinearVelocity(actorId) {
    const actor = this.#getActor(actorId);
    const vel = actor.body.linvel();
    return actor.scratchVelocity.set(vel.x, vel.y, vel.z);
  }
}

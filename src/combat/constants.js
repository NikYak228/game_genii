export const HP_MAX = 100;
export const ST_MAX = 100;
export const FO_MAX = 50;

export const ST_REGEN = 12; // per second
export const FO_REGEN = 5;  // per second

export const BLOCK_TIME = 0.6;
export const DODGE_TIME = 0.25;
export const IFRAME_TIME = 0.18;

export const MELEE_RANGE = 1.75;
export const MELEE_RADIUS = 0.9;

export const GUARD_MAX = 120;
export const GUARD_REGEN_RATE = 32;
export const GUARD_REGEN_DELAY = 1.2;
export const GUARD_BREAK_STUN = 1.15;

export const COSTS = Object.freeze({
  LIGHT: 8,
  HEAVY: 18,
  BLOCK: 5,
  DODGE: 12,
});

export const DMG = Object.freeze({
  LIGHT: 12,
  HEAVY: 22,
  FIRE_BLADE: 20,
});

export const MOVE_LIBRARY = Object.freeze({
  LIGHT: {
    id: 'LIGHT',
    label: 'Быстрый разрез',
    staminaCost: COSTS.LIGHT,
    damage: DMG.LIGHT,
    guardDamage: 24,
    chipPercent: 0.07,
    focusGain: 4,
    pushBack: 0.85,
    blockPush: 0.55,
    startup: 0.12,
    active: 0.16,
    recovery: 0.26,
    hitStun: 0.52,
    blockStun: 0.28,
    hitStop: { onHit: 0.045, onBlock: 0.025 },
    range: MELEE_RANGE,
    radius: MELEE_RADIUS,
    cancelRoutes: ['LIGHT', 'HEAVY'],
  },
  HEAVY: {
    id: 'HEAVY',
    label: 'Тяжёлый рассекатель',
    staminaCost: COSTS.HEAVY,
    damage: DMG.HEAVY,
    guardDamage: 36,
    chipPercent: 0.12,
    focusGain: 8,
    pushBack: 1.35,
    blockPush: 0.9,
    startup: 0.22,
    active: 0.22,
    recovery: 0.48,
    hitStun: 0.85,
    blockStun: 0.36,
    hitStop: { onHit: 0.065, onBlock: 0.032 },
    armorWindow: 0.08,
    range: MELEE_RANGE + 0.15,
    radius: MELEE_RADIUS + 0.05,
    cancelRoutes: ['BLOCK'],
  },
});

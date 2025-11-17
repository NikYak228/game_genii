  import * as THREE from 'three';
  import { FBXLoader } from '../libs/three-r125/examples/jsm/loaders/FBXLoader.js';
  import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
  import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
  import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
  import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
  import { LuminosityHighPassShader } from 'three/addons/shaders/LuminosityHighPassShader.js';
  import { ArenaAdapter } from './ArenaAdapter.js';
  import {
    BLOCK_TIME,
    COSTS,
    DMG,
    DODGE_TIME,
    FO_MAX,
    FO_REGEN,
    GUARD_BREAK_STUN,
    GUARD_MAX,
    GUARD_REGEN_DELAY,
    GUARD_REGEN_RATE,
    HP_MAX,
    IFRAME_TIME,
    MELEE_RANGE,
    MELEE_RADIUS,
    ST_MAX,
    ST_REGEN,
  } from './combat/constants.js';

const USE_NEW_CHARACTER_CONTROLLER = true;

const uiRootEl = document.getElementById('uiRoot');
const hudRoot = document.getElementById('hud');
const hintPanel = document.getElementById('hintFeed');
const hintTitleEl = hintPanel?.querySelector('h4');
const hintListEl = document.getElementById('hintList');
const mainMenuEl = document.getElementById('mainMenu');
const settingsOverlayEl = document.getElementById('settingsOverlay');
const loadingOverlayEl = document.getElementById('loadingOverlay');
const loadingTextEl = document.getElementById('loadingText');
const specialTrayEl = document.getElementById('specialTray');
const buffTrayEl = document.getElementById('buffTray');
const enemyBuffTrayEl = document.getElementById('enemyBuffTray');
const combatFeedEl = document.getElementById('combatFeed');
const hudContextLabelEl = document.getElementById('hudContextLabel');
const menuNewGameBtn = document.getElementById('menuNewGame');
const menuContinueBtn = document.getElementById('menuContinue');
const menuSettingsBtn = document.getElementById('menuSettings');
const menuExitBtn = document.getElementById('menuExit');
const settingsCloseBtn = document.getElementById('settingsClose');
const cameraShakeToggle = document.getElementById('settingCameraShake');
const combatHintsToggle = document.getElementById('settingCombatHints');
const lowFxToggle = document.getElementById('settingLowFX');

if (USE_NEW_CHARACTER_CONTROLLER) {
  hudRoot?.classList.add('hidden');
  hintPanel?.classList.add('hidden');
}

let ARENA = null;
let arenaBootPromise = null;
  let latestArenaState = {};
  const prevArenaPosition = {
    player: null,
    enemy: null,
  };
  let arenaEventsBound = false;
  const ENABLE_LEGACY_SCENE = !USE_NEW_CHARACTER_CONTROLLER;
  let arenaHostDetached = false;
  let arenaFullscreenContainer = null;

  function ensureArenaHost(){
    const screen = document.getElementById('screen');
    if (!screen){
      console.error('[Arena] #screen container not found');
      return null;
    }
    if (getComputedStyle(screen).position === 'static'){
      screen.style.position = 'relative';
    }
    let host = document.getElementById('arenaCanvasHost');
    if (!host){
      host = document.createElement('div');
      host.id = 'arenaCanvasHost';
      host.style.position = 'absolute';
      host.style.inset = '0';
      host.style.zIndex = '0';
      host.style.pointerEvents = 'none';
      host.style.background = 'transparent';
    } else if (arenaHostDetached){
      return host;
    } else if (host.parentElement !== screen){
      host.remove();
    }
    if (!host.parentElement && !arenaHostDetached){
      screen.prepend(host);
    }
    return host;
  }

  function getArenaFullscreenContainer(){
    if (arenaFullscreenContainer) return arenaFullscreenContainer;
    arenaFullscreenContainer = document.createElement('div');
    arenaFullscreenContainer.id = 'arenaFullscreenHost';
    arenaFullscreenContainer.style.position = 'fixed';
    arenaFullscreenContainer.style.inset = '0';
    arenaFullscreenContainer.style.zIndex = '5';
    arenaFullscreenContainer.style.background = '#05070d';
    arenaFullscreenContainer.style.pointerEvents = 'auto';
    arenaFullscreenContainer.style.display = 'none';
    document.body.appendChild(arenaFullscreenContainer);
    return arenaFullscreenContainer;
  }

  function setArenaFullscreen(enabled){
    if (!USE_NEW_CHARACTER_CONTROLLER) return;
    const host = document.getElementById('arenaCanvasHost') || ensureArenaHost();
    if (!host) return;
    arenaHostDetached = !!enabled;
    if (enabled){
      const container = getArenaFullscreenContainer();
      container.style.display = 'block';
      container.appendChild(host);
    } else {
      const container = getArenaFullscreenContainer();
      container.style.display = 'none';
      const screen = document.getElementById('screen');
      if (screen){
        screen.prepend(host);
      }
    }
  }

  function setRenderCanvasVisible(show, options = {}){
    const interactive = !!options.interactive;
    const host = document.getElementById('arenaCanvasHost');
    if (ENABLE_LEGACY_SCENE && renderer){
      renderer.domElement.style.display = show ? 'block' : 'none';
      if (host) host.style.display = 'none';
      return;
    }
    if (!host) return;
    host.style.display = show ? 'block' : 'none';
    host.style.pointerEvents = interactive ? 'auto' : 'none';
    const canvas = ARENA?.canvas;
    if (canvas){
      canvas.style.display = show ? 'block' : 'none';
      canvas.style.pointerEvents = interactive ? 'auto' : 'none';
    }
  }

  function getActiveScene(){
    if (!ENABLE_LEGACY_SCENE && ARENA?.engine?.scene){
      return ARENA.engine.scene;
    }
    return scene;
  }

  function clearScreen(){
    if (!screen) return;
    const host = document.getElementById('arenaCanvasHost');
    Array.from(screen.childNodes).forEach((child) => {
      if (child === host) return;
      screen.removeChild(child);
    });
    if (USE_NEW_CHARACTER_CONTROLLER && !ENABLE_LEGACY_SCENE){
      if (!host){
        ensureArenaHost();
      } else if (!arenaHostDetached && !host.parentElement){
        screen.prepend(host);
      }
    }
  }

  // --- Constants ---
  const ARENA_RADIUS = 40;
  const ARENA_Y_OFFSET = 1.0;
  const PLAYER_SPEED = 6.0; // m/s
  const ROT_SPEED = 2.5;    // rad/s for A/D
  const DODGE_SPEED = 14.0; // burst
  // timing constants imported from combat config
  const JUMP_POWER = 8.0;   // jump impulse
  const GRAVITY = -20.0;    // gravity accel (m/s^2)
  const GROUND_ACCEL = 20.0;
  const GROUND_DECEL = 14.0;
  const ENEMY_ENGAGE_DIST = 16;
  const CLOSE_DIST = 3.0;
  const LEARNING_RATE = 0.25; // style learning speed per training
  const ENABLE_BLOOM = false; // keep off for reliability; toggle to true to enable bloom
  const COMBO_WINDOW = 1.2; // seconds
  const INPUT_BUFFER_TIME = 0.3; // seconds to remember queued attacks
  const PACK_BASE_PATH = './Pro Sword and Shield Pack';
  const CHARACTER_MODEL_PATH = 'real man.fbx';
  const CAMERA_TARGET_HEIGHT = 2.1;
  const CAMERA_DEFAULT_PITCH = THREE.MathUtils.degToRad(20);
  const CAMERA_DEFAULT_DISTANCE = 8.2;
  const CAMERA_DEFAULT_PAN_Y = 0;
  const HAND_BONE_NAMES = ['mixamorigRightHand', 'RightHand', 'Hand_R', 'HandR', 'r_hand'];
  const ROOT_BONE_HINTS = ['mixamorig:hips', 'mixamorighips', 'hips', 'root', 'pelvis'];
  const SPECIALS = {
    FIRE_BLADE: { name: 'Огненное лезвие', pattern: ['LIGHT','LIGHT','HEAVY'], focusPct: 0.5, cooldown: 4.0 },
    POWER_PUSH: { name: 'Силовой толчок', pattern: ['BLOCK','LIGHT'], focusPct: 0.3, cooldown: 4.0 },
  };
  // Knowledge base sequence length (situational tactics)
  const KB_SEQ_LEN = 4;
  const ATTACK_CLIPS = {
    LIGHT: ['sword and shield slash.fbx', 'sword and shield slash (2).fbx', 'sword and shield slash (3).fbx', 'sword and shield slash (4).fbx'],
    HEAVY: ['sword and shield attack.fbx', 'sword and shield attack (2).fbx', 'sword and shield attack (3).fbx', 'sword and shield attack (4).fbx']
  };
  const STATE_CLIP_VARIANTS = {
    idle: ['sword and shield idle.fbx', 'sword and shield idle (2).fbx', 'sword and shield idle (3).fbx', 'sword and shield idle (4).fbx'],
    move: ['sword and shield run.fbx', 'sword and shield run (2).fbx'],
    block: ['sword and shield block idle.fbx', 'sword and shield block (2).fbx', 'sword and shield crouch block idle.fbx'],
    dodge: ['sword and shield run.fbx', 'sword and shield run (2).fbx'],
    stun: ['sword and shield impact.fbx', 'sword and shield impact (2).fbx', 'sword and shield impact (3).fbx'],
    death: ['sword and shield death.fbx', 'sword and shield death (2).fbx']
  };
  const LOCOMOTION_CLIPS = {
    forward: 'sword and shield run.fbx',
    backward: 'sword and shield walk.fbx',
    strafeLeft: 'sword and shield strafe (2).fbx',
    strafeRight: 'sword and shield strafe.fbx'
  };
  const PRACTICE_HIDDEN_POS = new THREE.Vector3(0, -200, 0);
  const DEFAULT_ATTACK_CLIP = 'sword and shield slash.fbx';
  const FIGHTER_RADIUS = 0.55;
  const MIN_SEPARATION = FIGHTER_RADIUS * 1.9;
  const OVERLAP_CORRECTION_SPEED = 9.5;
const COMBO_DROP_TIME = 1.4;
const KB_VERSION = 2;

const SAVE_KEY = 'blade_school_save_v1';
const SETTINGS_KEY = 'blade_school_settings_v1';

function defaultSettings(){
  return {
    cameraShake: true,
    combatHints: true,
    lowFX: false,
    tutorialEnabled: true,
  };
}

function loadSettings(){
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw);
    return { ...defaultSettings(), ...(parsed || {}) };
  } catch (err) {
    console.warn('[Settings] Failed to load settings', err);
    return defaultSettings();
  }
}

  function persistSettings(){
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(App.settings));
    } catch (err) {
      console.warn('[Settings] Failed to save settings', err);
    }
  }

  function createSaveBackend(){
    const bridge = typeof window !== 'undefined' ? window.__bladeSave : null;
    if (bridge && typeof bridge.save === 'function' && typeof bridge.load === 'function'){
      return {
        hasExisting: () => {
          try { return !!bridge.has?.(); } catch (err) { console.warn('[Save] Native has() failed', err); return false; }
        },
        load: () => {
          try { return bridge.load(); } catch (err) { console.warn('[Save] Native load failed', err); return null; }
        },
        save: (data) => {
          try { bridge.save(data); } catch (err) { console.warn('[Save] Native save failed', err); }
        },
        remove: () => {
          try { bridge.remove?.(); } catch (err) { console.warn('[Save] Native remove failed', err); }
        },
      };
    }
    return {
      hasExisting: () => !!localStorage.getItem(SAVE_KEY),
      load: () => {
        const raw = localStorage.getItem(SAVE_KEY);
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch (err) {
          console.warn('[Save] Failed to parse save', err);
          localStorage.removeItem(SAVE_KEY);
          return null;
        }
      },
      save: (data) => {
        localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      },
      remove: () => {
        localStorage.removeItem(SAVE_KEY);
      },
    };
  }

  const saveBackend = createSaveBackend();

  // --- App State (School Sim) ---
  const App = {
    mode: 'menu', // menu | hub | student | training | meditation | tournaments | tournamentVis
    renderEnabled: false,
    activeStudentId: null,
    school: null,
    settings: loadSettings(),
    started: false,
  };

  const runtimeState = {
    hasExistingSave: false,
  };

  function refreshSaveAvailability(){
    let available = false;
    if (saveBackend && typeof saveBackend.hasExisting === 'function'){
      try {
        available = !!saveBackend.hasExisting();
      } catch (err) {
        console.warn('[Save] hasExisting failed', err);
      }
    }
    runtimeState.hasExistingSave = available;
    updateContinueButton();
    return available;
  }

  function showMainMenu(){
    uiRootEl?.classList.add('hidden');
    mainMenuEl?.classList.remove('hidden');
  }

  function hideMainMenu(){
    mainMenuEl?.classList.add('hidden');
  }

  function updateContinueButton(){
    if (menuContinueBtn){
      menuContinueBtn.disabled = !runtimeState.hasExistingSave;
    }
  }

  function showSettings(){
    settingsOverlayEl?.classList.add('show');
  }

  function hideSettings(){
    settingsOverlayEl?.classList.remove('show');
  }

  function syncSettingsUI(){
    if (cameraShakeToggle) cameraShakeToggle.checked = !!App.settings.cameraShake;
    if (combatHintsToggle) combatHintsToggle.checked = !!App.settings.combatHints;
    if (lowFxToggle) lowFxToggle.checked = !!App.settings.lowFX;
  }

  function bindSettingsUI(){
    if (cameraShakeToggle){
      cameraShakeToggle.addEventListener('change', ()=>{
        App.settings.cameraShake = !!cameraShakeToggle.checked;
        persistSettings();
      });
    }
    if (combatHintsToggle){
      combatHintsToggle.addEventListener('change', ()=>{
        App.settings.combatHints = !!combatHintsToggle.checked;
        persistSettings();
        renderHintPanel({ force: true });
      });
    }
    if (lowFxToggle){
      lowFxToggle.addEventListener('change', ()=>{
        App.settings.lowFX = !!lowFxToggle.checked;
        persistSettings();
        applyLowFXSetting();
      });
    }
    settingsCloseBtn?.addEventListener('click', hideSettings);
  }

  function bindMenuButtons(){
    menuNewGameBtn?.addEventListener('click', handleNewGame);
    menuContinueBtn?.addEventListener('click', handleContinue);
    menuSettingsBtn?.addEventListener('click', showSettings);
    menuExitBtn?.addEventListener('click', handleExitGame);
  }

  function handleNewGame(){
    if (runtimeState.hasExistingSave && !window.confirm('Начать новую игру? Текущее сохранение будет перезаписано.')){
      return;
    }
    App.school = defaultSchool();
    runtimeState.hasExistingSave = true;
    saveGame({ silent: true });
    enterHub('hub');
  }

  function handleContinue(){
    const hasSave = refreshSaveAvailability();
    if (!hasSave){
      flashSpecial('Сохранение не найдено');
      return;
    }
    if (!App.school){
      const ok = loadGame({ fallbackToDefault: false });
      if (!ok){
        flashSpecial('Сохранение повреждено');
        return;
      }
    }
    enterHub('hub');
  }

  function handleExitGame(){
    if (typeof window !== 'undefined' && typeof window.close === 'function'){
      window.close();
    } else {
      flashSpecial('Закройте вкладку, чтобы выйти');
    }
  }

  function enterHub(mode = 'hub'){
    if (!App.school){
      App.school = defaultSchool();
    }
    App.started = true;
    App.mode = mode;
    hideMainMenu();
    uiRootEl?.classList.remove('hidden');
    refreshAll();
    navigate(mode);
  }

  function showLoadingOverlay(text = 'Загрузка...'){
    if (loadingTextEl && text) loadingTextEl.textContent = text;
    loadingOverlayEl?.classList.add('show');
  }

  function hideLoadingOverlay(){
    loadingOverlayEl?.classList.remove('show');
  }

  async function withLoadingOverlay(message, task, options = {}){
    const minDuration = options.minDuration ?? 250;
    const start = performance.now();
    showLoadingOverlay(message);
    try {
      await task();
      const elapsed = performance.now() - start;
      if (elapsed < minDuration){
        await new Promise((resolve) => setTimeout(resolve, minDuration - elapsed));
      }
    } finally {
      hideLoadingOverlay();
    }
  }



  function defaultSpecials(){
    return [
      { id: 'FIRE_BLADE', name: 'Огненное лезвие', pattern: ['LIGHT','LIGHT','HEAVY'], focusCost: Math.ceil(FO_MAX*0.5), cooldown: 4.0, effect: { type: 'damage_buff', bonus: 8, duration: 5 } },
      { id: 'POWER_PUSH', name: 'Силовой толчок', pattern: ['BLOCK','LIGHT'], focusCost: Math.ceil(FO_MAX*0.3), cooldown: 4.0, effect: { type: 'stun_push', stun: 1.5, push: 0.6 } },
    ];
  }

  function makeStudent(name){
    const id = 's' + Math.random().toString(36).slice(2,8);
    return {
      id, name,
      level: 1, xp: 0, nextXp: 100,
      attrs: { str: 5, end: 5, con: 5 },
      attr_xp: { str: 0, end: 0, con: 0 },
      attr_next: { str: 100, end: 100, con: 100 },
      trait: ['Агрессор','Защитник','Технарь'][Math.floor(Math.random()*3)],
      // Expanded style profile
      style: {
        aggression: 0.5, // Light/Heavy tendency
        defense: 0.5,    // Block tendency
        evasion: 0.5,    // Dodge tendency
        comboFocus: 0.5, // Special usage tendency
        engagement: 0.5, // Close-in vs retreat tendency
        mobility: 0.5,   // Strafe movement tendency
      },
      // Knowledge base for situational tactics (plain object for persistence)
      knowledgeBase: {}, // key -> [{sequence:[...], effectiveness: 0}]
      kbVersion: KB_VERSION,
      actionQueue: [],
      currentActionTimer: 0,
      equipment: { weapon: null, armor: null },
      learnedSpecials: [],
      mastery: {}, // specialId -> 0..100
    };
  }

  function ensureEnemyProfile(){
    if (enemyData.studentProfile) return;
    const profile = makeStudent('Враг');
    profile.psv = profile.psv || { aggression_ratio: 1.5, block_vs_evade_ratio: 0.85, mean_engagement_distance: 1.5 };
    if (!Array.isArray(profile.learnedSpecials) || profile.learnedSpecials.length === 0){
      profile.learnedSpecials = ['FIRE_BLADE', 'POWER_PUSH'];
    }
    profile.knowledgeBase = profile.knowledgeBase || {};
    profile.kbVersion = KB_VERSION;
    enemyData.studentProfile = profile;
  }

  function defaultSchool(){
    return {
      version: 1,
      name: 'Школа Клинка',
      money: 120,
      fame: 0,
      buildings: { hall: 1, library: 1, dorms: 1 },
      styleBook: defaultSpecials(),
      students: [ makeStudent('Новичок') ],
      inventory: [
        { id: 'sw_basic', type: 'weapon', name: 'Простой клинок', bonus: { str: 1 }, cost: 40 },
        { id: 'sw_fine', type: 'weapon', name: 'Тонкий меч', bonus: { str: 2 }, cost: 90 },
        { id: 'ar_padded', type: 'armor', name: 'Подбитая куртка', bonus: { end: 1 }, cost: 40 },
        { id: 'ar_chain', type: 'armor', name: 'Кольчуга', bonus: { end: 2 }, cost: 100 },
      ],
      flags: { tutorialComplete: false },
    };
  }

  function saveGame(options = {}){
    const { silent = false } = options;
    if (!App.school) return;
    saveBackend.save(App.school);
    if (!silent){
      flashSpecial('Сохранено');
    }
    runtimeState.hasExistingSave = true;
    updateContinueButton();
  }

  function loadGame(options = {}){
    const { fallbackToDefault = true } = options;
    const hasExisting = refreshSaveAvailability();
    let data = null;
    if (hasExisting){
      data = saveBackend.load();
    }
    App.school = data || null;
    if (!App.school && fallbackToDefault && !hasExisting){
      App.school = defaultSchool();
    }
    if (App.school){
      migrateSaveSchema();
    }
    return !!data;
  }

  function migrateSaveSchema(){
    // Ensure students have expanded style keys
    try {
      App.school.flags = App.school.flags || {};
      if (typeof App.school.flags.tutorialComplete !== 'boolean'){
        App.school.flags.tutorialComplete = false;
      }
      (App.school.students||[]).forEach(st=>{
        st.style = st.style || {};
        if (typeof st.style.aggression !== 'number'){
          st.style.aggression = (typeof st.style.aggr==='number'? st.style.aggr : 0.5);
        }
        if (typeof st.style.defense !== 'number'){
          st.style.defense = (typeof st.style.defense==='number'? st.style.defense : 0.5);
        }
        if (typeof st.style.evasion !== 'number'){
          st.style.evasion = (typeof st.style.dodge==='number'? st.style.dodge : 0.5);
        }
        if (typeof st.style.comboFocus !== 'number'){
          st.style.comboFocus = 0.5;
        }
        if (typeof st.style.engagement !== 'number') st.style.engagement = 0.5;
        if (typeof st.style.mobility !== 'number') st.style.mobility = 0.5;
        if (!st.attr_xp) st.attr_xp = { str:0, end:0, con:0 };
        if (!st.attr_next) st.attr_next = { str:100, end:100, con:100 };
        ensureStudentKnowledgeBase(st);
        if (!Array.isArray(st.actionQueue)) st.actionQueue = [];
        if (typeof st.currentActionTimer !== 'number') st.currentActionTimer = 0;
        st.learnedSpecials = st.learnedSpecials || [];
        st.mastery = st.mastery || {};
      });
    } catch (e) {}
  }

  // --- Three.js setup ---
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(App.settings?.lowFX ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x0b1119, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (ENABLE_LEGACY_SCENE) {
    document.body.appendChild(renderer.domElement);
  }

  function applyLowFXSetting(){
    if (ENABLE_LEGACY_SCENE && renderer){
      const ratio = App.settings?.lowFX ? 1 : Math.min(window.devicePixelRatio, 2);
      renderer.setPixelRatio(ratio);
    }
    if (ARENA && typeof ARENA.setLowFX === 'function'){
      ARENA.setLowFX(App.settings.lowFX);
    }
  }

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0b1119, 40, 140);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(-8, 5, 10);

  const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x0f1018, 0.5);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xfef6ef, 0.95);
  dir.position.set(12, 16, 6);
  dir.castShadow = true;
  dir.shadow.mapSize.width = 2048;
  dir.shadow.mapSize.height = 2048;
  dir.shadow.camera.near = 0.5;
  dir.shadow.camera.far = 50;
  dir.shadow.camera.left = -ARENA_RADIUS;
  dir.shadow.camera.right = ARENA_RADIUS;
  dir.shadow.camera.top = ARENA_RADIUS;
  dir.shadow.camera.bottom = -ARENA_RADIUS;
  scene.add(dir);

  const fillLight = new THREE.DirectionalLight(0x90a7ff, 0.45);
  fillLight.position.set(-8, 10, -5);
  scene.add(fillLight);
  const rimLight = new THREE.DirectionalLight(0xffb48c, 0.35);
  rimLight.position.set(4, 12, -12);
  scene.add(rimLight);
  const ambient = new THREE.AmbientLight(0x616d8c, 0.18);
  scene.add(ambient);

  // Ground
  const groundGeo = new THREE.CircleGeometry(ARENA_RADIUS, 64);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x1d2536, roughness: 0.85, metalness: 0.02 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  // Ring
  const ringGeo = new THREE.RingGeometry(ARENA_RADIUS - 0.6, ARENA_RADIUS, 64, 1);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x374151, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  scene.add(ring);
  // Guiding grid
  const grid = new THREE.GridHelper(60, 60, 0x222a39, 0x222a39);
  grid.position.y = 0.01;
  scene.add(grid);

  const fbxLoader = new FBXLoader();
  const clipCache = new Map();

  // --- Post-processing (Bloom) ---
  let composer;
  if (ENABLE_BLOOM){
    try {
      const renderPass = new RenderPass(scene, camera);
      const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.2, 0.6, 0.85);
      bloomPass.threshold = 0.85;
      bloomPass.strength = 1.2;
      bloomPass.radius = 0.6;
      composer = new EffectComposer(renderer);
      composer.addPass(renderPass);
      composer.addPass(bloomPass);
    } catch (e) {
      console.warn('Bloom unavailable', e);
      composer = null;
    }
  }

  // --- Helpers ---
  function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
  function lerp(a, b, t){ return a + (b - a) * t; }
  function lerpAngle(a, b, t){
    const diff = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    return a + diff * clamp(t, 0, 1);
  }
  function now(){ return performance.now() / 1000; }
  const cameraState = {
    yaw: 0,
    pitch: CAMERA_DEFAULT_PITCH,
    distance: CAMERA_DEFAULT_DISTANCE,
    minDistance: 5.5,
    maxDistance: 14,
    dragging: false,
    mode: 'orbit',
    lastX: 0,
    lastY: 0,
    pan: new THREE.Vector2(0, CAMERA_DEFAULT_PAN_Y),
  };

  function applyModelTint(node, tintHex){
    if (!node || !tintHex) return;
    const tint = new THREE.Color(tintHex);
    node.traverse(child => {
      if (child.isMesh){
        child.castShadow = true;
        child.receiveShadow = true;
        if (child.material && typeof child.material === 'object'){
          const mat = Array.isArray(child.material) ? child.material : [child.material];
          child.material = mat.map(m=>{
            if (!m || typeof m.clone !== 'function') return m;
            const clone = m.clone();
            if (clone.color){
              clone.color.lerp(tint, 0.35);
            }
            return clone;
          });
          if (child.material.length === 1) child.material = child.material[0];
        }
      }
    });
  }

  function activateRigAction(rig, clipName, options = {}){
    if (!rig) return;
    const { fade = 0.25, once = false, force = false } = options;
    if (!rig.mixer || !rig.actions || !rig.actions[clipName]){
      rig.pendingState = { name: clipName, options };
      return;
    }
    const action = rig.actions[clipName];
    if (!action) return;
    if (!force && rig.currentActionName === clipName && !once) return;
    if (force && rig.currentActionName === clipName){
      action.stop();
    }
    if (rig.activeAction && rig.activeAction !== action){
      rig.activeAction.fadeOut(fade);
    }
    action.reset();
    if (once){
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
    }
    action.setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(fade).play();
    rig.activeAction = action;
    rig.currentActionName = clipName;
  }

  window.addEventListener('contextmenu', (e)=>{ if (e.button === 2) e.preventDefault(); });
  window.addEventListener('wheel', (e)=>{
    cameraState.distance = clamp(cameraState.distance + Math.sign(e.deltaY) * 0.6, cameraState.minDistance, cameraState.maxDistance);
  }, { passive: true });
  window.addEventListener('mousedown', (e)=>{
    if (e.button === 2){
      cameraState.dragging = true;
      cameraState.mode = e.shiftKey ? 'pan' : 'orbit';
      cameraState.lastX = e.clientX;
      cameraState.lastY = e.clientY;
      document.body.style.cursor = cameraState.mode === 'pan' ? 'move' : 'grabbing';
      e.preventDefault();
    }
  });
  window.addEventListener('mouseup', ()=>{
    if (cameraState.dragging){
      cameraState.dragging = false;
      document.body.style.cursor = '';
    }
  });
  window.addEventListener('mousemove', (e)=>{
    if (!cameraState.dragging) return;
    const dx = e.clientX - cameraState.lastX;
    const dy = e.clientY - cameraState.lastY;
    cameraState.lastX = e.clientX;
    cameraState.lastY = e.clientY;
    if (cameraState.mode === 'pan'){
      cameraState.pan.x = clamp(cameraState.pan.x - dx * 0.003, -3, 3);
      cameraState.pan.y = clamp(cameraState.pan.y + dy * 0.003, -1.5, 3.5);
    } else {
      cameraState.yaw -= dx * 0.004;
      cameraState.pitch = clamp(cameraState.pitch - dy * 0.003, THREE.MathUtils.degToRad(-5), THREE.MathUtils.degToRad(50));
    }
  });
  window.addEventListener('keydown', (e)=>{
    if (e.code === 'KeyR'){
      cameraState.yaw = 0;
      cameraState.pitch = CAMERA_DEFAULT_PITCH;
      cameraState.distance = CAMERA_DEFAULT_DISTANCE;
      cameraState.pan.set(0, CAMERA_DEFAULT_PAN_Y);
    }
  });

  function packUrl(rel){
    return encodeURI(`${PACK_BASE_PATH}/${rel}`);
  }

  function stripEmbeddedLights(model){
    const toRemove = [];
    model.traverse(child=>{ if (child.isLight) toRemove.push(child); });
    toRemove.forEach(light=> light.parent && light.parent.remove(light));
  }

  function addSwordToHand(model){
    if (!model) return;
    let hand = null;
    for (const name of HAND_BONE_NAMES){
      hand = model.getObjectByName(name);
      if (hand) break;
    }
    if (!hand) return;
    const swordGeom = new THREE.BoxGeometry(0.12, 0.12, 1.7);
    const swordMat = new THREE.MeshStandardMaterial({ color: 0xc9d6ff, roughness: 0.15, metalness: 0.9 });
    const sword = new THREE.Mesh(swordGeom, swordMat);
    sword.position.set(0, 0.05, 0.85);
    sword.rotation.x = THREE.MathUtils.degToRad(90);
    sword.castShadow = true;
    hand.add(sword);
  }

  function makePrimitiveFighter(tint){
    const root = new THREE.Group();
    const model = new THREE.Group();
    root.add(model);
    const bodyMat = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.6, metalness: 0.15, flatShading: true });
    const steel = new THREE.MeshStandardMaterial({ color: 0xf4f4f5, roughness: 0.25, metalness: 1.0, flatShading: true });
    const torsoGeom = THREE.CapsuleGeometry ? new THREE.CapsuleGeometry(0.28, 0.7, 6, 12) : new THREE.CylinderGeometry(0.28, 0.28, 1.0, 12);
    const torso = new THREE.Mesh(torsoGeom, bodyMat);
    torso.position.set(0, 1.2, 0);
    model.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 16), bodyMat);
    head.position.set(0, 1.65, 0);
    model.add(head);

    function buildLimb(side){
      const sign = side === 'left' ? -1 : 1;
      const shoulder = new THREE.Group();
      shoulder.position.set(0.35 * sign, 1.28, 0);
      model.add(shoulder);
      const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.48, 10), bodyMat);
      upper.position.y = -0.24;
      shoulder.add(upper);
      const elbow = new THREE.Group();
      elbow.position.y = -0.48;
      shoulder.add(elbow);
      const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.10, 0.48, 10), bodyMat);
      fore.position.y = -0.24;
      elbow.add(fore);
      const hand = new THREE.Group();
      hand.position.y = -0.48;
      elbow.add(hand);
      return { shoulder, elbow, hand };
    }
    const armR = buildLimb('right');
    const armL = buildLimb('left');

    function buildLeg(side){
      const sign = side === 'left' ? -1 : 1;
      const hip = new THREE.Group();
      hip.position.set(0.18 * sign, 0.9, 0);
      model.add(hip);
      const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.50, 10), bodyMat);
      thigh.position.y = -0.25;
      hip.add(thigh);
      const knee = new THREE.Group();
      knee.position.y = -0.5;
      hip.add(knee);
      const calf = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.11, 0.52, 10), bodyMat);
      calf.position.y = -0.26;
      knee.add(calf);
      return { hip, knee };
    }
    const legR = buildLeg('right');
    const legL = buildLeg('left');

    const sword = new THREE.Group();
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.03), steel); sword.add(guard);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 1.1), steel); blade.position.z = 0.56; sword.add(blade);
    sword.position.set(0, 0, 0);
    sword.rotation.x = 0.0;
    armR.hand.add(sword);

    model.traverse(o=>{ if (o.isMesh){ o.castShadow = true; } });

    const rig = {
      mixer: null,
      actions: null,
      activeAction: null,
      currentActionName: null,
      model,
      torso,
      head,
      shoulderR: armR.shoulder,
      elbowR: armR.elbow,
      handR: armR.hand,
      shoulderL: armL.shoulder,
      elbowL: armL.elbow,
      handL: armL.hand,
      hipR: legR.hip,
      kneeR: legR.knee,
      hipL: legL.hip,
      kneeL: legL.knee,
      sword,
      blade
    };
    rig.manual = rig;
    rig.owner = root;
    rig.modelBasePos = model.position.clone();
    return { mesh: root, rig };
  }

  // --- Entity factory: FBX hero ---
  function stripRootMotion(clip){
    if (!clip || !Array.isArray(clip.tracks)) return clip;
    clip.tracks.forEach(track=>{
      if (!track || typeof track.name !== 'string' || typeof track.getValueSize !== 'function') return;
      if (!track.name.endsWith('.position')) return;
      const node = track.name.split('.')[0].toLowerCase();
      const isRoot = ROOT_BONE_HINTS.some(hint=> node.includes(hint));
      if (!isRoot) return;
      const stride = track.getValueSize();
      if (stride !== 3 || !track.values || track.values.length < 3) return;
      const baseX = track.values[0];
      const baseY = track.values[1];
      const baseZ = track.values[2];
      for (let i = 0; i < track.values.length; i += stride){
        track.values[i] = baseX;
        track.values[i + 1] = baseY;
        track.values[i + 2] = baseZ;
      }
    });
    if (typeof clip.optimize === 'function'){
      clip.optimize();
    }
    return clip;
  }

  function loadClip(path){
    if (!clipCache.has(path)){
      clipCache.set(path, new Promise((resolve)=>{
        fbxLoader.load(packUrl(path), (fbx)=>{
          const clip = (fbx.animations && fbx.animations[0]) ? fbx.animations[0] : null;
          if (clip){
            clip.name = path;
            // stripRootMotion(clip); // legacy root-motion clamp disabled to avoid double-handling
          }
          resolve(clip);
        }, undefined, (err)=>{
          console.warn('Failed to load animation clip', path, err);
          resolve(null);
        });
      }));
    }
    return clipCache.get(path);
  }

  const CORE_CLIP_PATHS = new Set();
  Object.values(ATTACK_CLIPS).forEach(arr=> arr.forEach(name=> CORE_CLIP_PATHS.add(name)));
  Object.values(STATE_CLIP_VARIANTS).forEach(arr=> arr.forEach(name=> CORE_CLIP_PATHS.add(name)));
  Object.values(LOCOMOTION_CLIPS).forEach(name=> CORE_CLIP_PATHS.add(name));
  const STATE_CLIP_NAMES = {
    idle: STATE_CLIP_VARIANTS.idle[0],
    move: STATE_CLIP_VARIANTS.move[0],
    block: STATE_CLIP_VARIANTS.block[0],
    dodge: STATE_CLIP_VARIANTS.dodge[0],
    stun: STATE_CLIP_VARIANTS.stun[0],
    death: STATE_CLIP_VARIANTS.death[0]
  };
  Object.values(STATE_CLIP_NAMES).forEach(name=> CORE_CLIP_PATHS.add(name));

  function stripRootTranslation(clip){
    if (!clip || !clip.tracks) return;
    clip.tracks.forEach(track=>{
      const name = (track.name || '').toLowerCase();
      const targetsRoot = ROOT_BONE_HINTS.some(h=> name.includes(h));
      if (!targetsRoot || name.indexOf('.position') === -1) return;
      const values = track.values;
      if (!values) return;
      if (name.endsWith('.position')){
        for (let i=0; i<values.length; i+=3){
          // zero X/Z, keep Y for jumps
          values[i] = 0;
          if (i+2 < values.length) values[i+2] = 0;
        }
      } else if (name.endsWith('.position.x') || name.endsWith('.position.z')){
        for (let i=0; i<values.length; i++){
          values[i] = 0;
        }
      }
    });
  }

  function registerClipOnRig(rig, clipName){
    loadClip(clipName).then(clip=>{
      if (!clip || !rig.mixer) return;
      // stripRootTranslation(clip); // disabled to avoid double root-motion handling
      rig.actions = rig.actions || {};
      rig.actions[clipName] = rig.mixer.clipAction(clip);
      const pending = rig.pendingState;
      if (pending && pending.name === clipName){
        rig.pendingState = null;
        activateRigAction(rig, clipName, pending.options);
      }
    });
  }

  function findRigRootBone(model){
    if (!model) return null;
    let hinted = null;
    let fallback = null;
    model.traverse(child=>{
      if (!child || !child.isBone) return;
      const name = child.name ? child.name.toLowerCase() : '';
      if (!hinted && name && ROOT_BONE_HINTS.some(hint=> name.includes(hint))){
        hinted = child;
      }
      if (!fallback && (!child.parent || !child.parent.isBone)){
        fallback = child;
      }
    });
    return hinted || fallback || null;
  }

  function lockRigRootHorizontal(rig, owner, data){
    if (!rig || !rig.rootBone || !rig.rootBasePos) return;
    const bone = rig.rootBone;
    const base = rig.rootBasePos;

    const dx = bone.position.x - base.x;
    const dz = bone.position.z - base.z;
    if (owner && (Math.abs(dx) > 1e-5 || Math.abs(dz) > 1e-5)){
      const yaw = (data && typeof data.yaw === 'number') ? data.yaw : ((owner.rotation && owner.rotation.y) || 0);
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      const worldX = dx * cos + dz * sin;
      const worldZ = dz * cos - dx * sin;
      owner.position.x += worldX;
      owner.position.z += worldZ;
      if (data){
        data.rootMotionDelta = data.rootMotionDelta || new THREE.Vector2();
        data.rootMotionDelta.set(worldX, worldZ);
      }
    }

    bone.position.x = base.x;
    bone.position.z = base.z;
    if (rig.model && rig.modelBasePos){
      rig.model.position.x = rig.modelBasePos.x;
      rig.model.position.z = rig.modelBasePos.z;
    }
  }

  function makeFbxFighter(tint){
    const root = new THREE.Group();
    const rig = { mixer: null, actions: {}, activeAction: null, currentActionName: null, pendingState: null, model: null, manual: null, owner: root };
    const attachFallback = ()=>{
      if (rig.manual) return;
      const fallback = makePrimitiveFighter(tint);
      fallback.mesh.position.set(0,0,0);
      root.add(fallback.mesh);
      Object.assign(rig, fallback.rig);
      rig.manual = rig;
      rig.owner = root;
    };
    fbxLoader.load(packUrl(CHARACTER_MODEL_PATH), (fbx)=>{
      const model = fbx;
      model.scale.setScalar(0.01);
      applyModelTint(model, tint);
      root.add(model);
      stripEmbeddedLights(model);
      addSwordToHand(model);
      rig.model = model;
      rig.modelBasePos = model.position.clone();
      rig.rootBone = findRigRootBone(model);
      rig.rootBasePos = rig.rootBone ? rig.rootBone.position.clone() : null;
      rig.mixer = new THREE.AnimationMixer(model);
      CORE_CLIP_PATHS.forEach(name=> registerClipOnRig(rig, name));
      activateRigAction(rig, STATE_CLIP_NAMES.idle, { fade: 0.2 });
    }, undefined, (err)=>{
      console.warn('Failed to load FBX fighter', err);
      attachFallback();
    });
    return { mesh: root, rig };
  }

  function makeFighter(tint){
    return makeFbxFighter(tint);
  }

  function determineLocomotionClip(data){
    if (!data || !data.vel) return null;
    const vx = data.vel.x || 0;
    const vz = data.vel.z || 0;
    const speed = Math.hypot(vx, vz);
    if (speed < 0.15) return null;
    const forward = tmpVec3.set(Math.sin(data.yaw || 0), 0, Math.cos(data.yaw || 0)).normalize();
    const right = tmpVec4.set(-forward.z, 0, forward.x);
    const vel = tmpVec.set(vx, 0, vz);
    const fwdDot = vel.dot(forward);
    const rightDot = vel.dot(right);
    if (Math.abs(fwdDot) >= Math.abs(rightDot) * 1.25){
      return fwdDot >= 0 ? LOCOMOTION_CLIPS.forward : LOCOMOTION_CLIPS.backward;
    }
    return rightDot >= 0 ? LOCOMOTION_CLIPS.strafeRight : LOCOMOTION_CLIPS.strafeLeft;
  }

  // Player
  const playerObj = makeFighter(0x60a5fa);
  const player = playerObj.mesh;
  const playerRig = playerObj.rig;
  scene.add(player);
  player.position.set(0, 1.0, 0);
  const playerData = {
    hp: HP_MAX, st: ST_MAX, fo: 0,
    yaw: 0,
    aiControlled: false,
    guardGauge: GUARD_MAX,
    guardMax: GUARD_MAX,
    guardRegenDelay: 0,
    vel: new THREE.Vector3(),
    groundVel: new THREE.Vector3(),
    manualMoveIntent: new THREE.Vector3(),
    isGrounded: true,
    invuln: 0,
    block: 0,
    dodge: 0,
    attackTimer: 0,
    attackActive: 0,
    attackKind: null,
    lastHitTime: 0,
    combo: [], // {type:'LIGHT'|'HEAVY'|'BLOCK'|'DODGE', t: seconds}
    specialsCD: { FIRE_BLADE: 0, POWER_PUSH: 0 },
    specialCooldowns: [],
    activeBuffs: [],
    stun: 0,
    attackAnimTag: 0,
    hitStop: 0,
    currentMove: null,
    comboCounter: 0,
    comboTimer: 0,
  };
  // Block shield FX (after data exists)
  // Enemy
  const enemyObj = makeFighter(0xef4444);
  const enemy = enemyObj.mesh;
  const enemyRig = enemyObj.rig;
  scene.add(enemy);
  enemy.position.set(6, 1.0, 6);
  const enemyData = {
    hp: HP_MAX, st: ST_MAX, fo: 0,
    yaw: Math.PI * 0.75,
    guardGauge: GUARD_MAX,
    guardMax: GUARD_MAX,
    guardRegenDelay: 0,
    vel: new THREE.Vector3(),
    groundVel: new THREE.Vector3(),
    isGrounded: true,
    invuln: 0,
    block: 0,
    dodge: 0,
    attackTimer: 0,
    attackActive: 0,
    attackKind: null,
    lastHitTime: 0,
    combo: [],
    specialsCD: { FIRE_BLADE: 0, POWER_PUSH: 0 }, // not used by AI
    specialCooldowns: [],
    activeBuffs: [],
    ai: { thinkCD: 0, state: 'idle', strafeDir: 1, strafeTimer: 0, strategy: 'ENGAGED' },
    stun: 0,
    attackAnimTag: 0,
    hitStop: 0,
    currentMove: null,
    comboCounter: 0,
    comboTimer: 0,
  };
  // Enemy shield FX (after data exists)

  // Nameplates (simple)
  function makeBillboardLabel(text, color=0xffffff){
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.clearRect(0,0,c.width,c.height);
    ctx.font = '28px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0,0,c.width,c.height);
    ctx.fillStyle = '#'+color.toString(16).padStart(6,'0');
    ctx.fillText(text, c.width/2, c.height/2);
    const tex = new THREE.CanvasTexture(c);
    try {
      tex.anisotropy = (renderer.capabilities.getMaxAnisotropy && renderer.capabilities.getMaxAnisotropy()) || 1;
    } catch(e){ tex.anisotropy = 1; }
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(2.5, 0.6, 1);
    return spr;
  }
  const playerLabel = makeBillboardLabel('Игрок', 0x60a5fa);
  const enemyLabel = makeBillboardLabel('Враг', 0xef4444);
  player.add(playerLabel); enemy.add(enemyLabel);
  playerLabel.position.set(0, 1.5, 0); enemyLabel.position.set(0, 1.5, 0);

  // --- Input ---
  window.addEventListener('keydown', (e)=>{
    if (typeof pushMeditationActionByKey==='function' && App && App.mode==='meditation') {
      pushMeditationActionByKey(e.code);
    }
    if (e.code === 'Tab') {
      e.preventDefault();
      ARENA?.toggleLockOn?.();
    }
  });
  window.addEventListener('contextmenu', (e)=> e.preventDefault());

  // --- UI ---
  let practiceMode = false;
  let practiceBtn = null;
  const hpFill = document.getElementById('hpFill');
  const stFill = document.getElementById('stFill');
  const foFill = document.getElementById('foFill');
  const guardFill = document.getElementById('guardFill');
  const resetBtn = document.getElementById('resetBtn');
  const godBtn = document.getElementById('godBtn');
  practiceBtn = document.getElementById('practiceBtn');
  const specialLog = document.getElementById('specialLog');
  const enemyHpFill = document.getElementById('enemyHpFill');
  const enemyGuardFill = document.getElementById('enemyGuardFill');
  let specialLogTimer = 0;

  resetBtn.addEventListener('click', resetArena);
  godBtn.addEventListener('click', ()=>{ playerData.fo = FO_MAX; flashSpecial('Focus: MAX'); });
  if (practiceBtn){
    practiceBtn.addEventListener('click', ()=> setPracticeMode(!practiceMode));
  }
  updatePracticeUI();

  function flashSpecial(text){
    specialLog.textContent = 'Special: ' + text;
    specialLog.style.opacity = '1';
    specialLogTimer = 1.5;
  }

  function ensureGuardValues(data){
    if (!data) return;
    if (!Number.isFinite(data.guardMax) || data.guardMax <= 0){
      data.guardMax = GUARD_MAX;
    }
    if (!Number.isFinite(data.guardGauge)){
      data.guardGauge = data.guardMax;
    } else {
      data.guardGauge = clamp(data.guardGauge, 0, data.guardMax);
      if (data.guardGauge <= 0 && (data.hp ?? 0) >= ((data.maxHp ?? HP_MAX) - 0.001)){
        data.guardGauge = data.guardMax;
      }
    }
  }

  function updateBars(){
    ensureGuardValues(playerData);
    const hpPct = clamp(playerData.hp / HP_MAX, 0, 1);
    const stPct = clamp(playerData.st / ST_MAX, 0, 1);
    const foPct = clamp(playerData.fo / FO_MAX, 0, 1);
    hpFill.style.width = (hpPct * 100) + '%';
    stFill.style.width = (stPct * 100) + '%';
    foFill.style.width = (foPct * 100) + '%';
    if (guardFill){
      const guardMax = playerData.guardMax || GUARD_MAX;
      const guardGauge = playerData.guardGauge ?? guardMax;
      const guardPct = clamp(guardGauge / Math.max(1, guardMax), 0, 1);
      guardFill.style.width = (guardPct * 100) + '%';
    }
    updateSpecialTray();
    updateBuffTrayFor('player', buffTrayEl, playerData);
  }

  function updateEnemyBar(){
    if (!enemyHpFill) return;
    const enemyHud = document.getElementById('enemy-hud');
    if (enemyHud){ enemyHud.style.display = practiceMode ? 'none' : ''; }
    if (practiceMode){
      enemyHpFill.style.width = '0%';
      if (enemyGuardFill){ enemyGuardFill.style.width = '0%'; }
      updateBuffTrayFor('enemy', enemyBuffTrayEl, { activeBuffs: [] });
      return;
    }
    ensureGuardValues(enemyData);
    const enemyMaxHp = enemyData.maxHp || HP_MAX;
    const enemyHpPct = clamp(enemyData.hp / Math.max(1, enemyMaxHp), 0, 1);
    enemyHpFill.style.width = (enemyHpPct * 100) + '%';
    if (enemyGuardFill){
      const guardMax = enemyData.guardMax || GUARD_MAX;
      const guardGauge = enemyData.guardGauge ?? guardMax;
      const guardPct = clamp(guardGauge / Math.max(1, guardMax), 0, 1);
      enemyGuardFill.style.width = (guardPct * 100) + '%';
    }
    updateBuffTrayFor('enemy', enemyBuffTrayEl, enemyData);
  }

  const BUFF_ICON_MAP = {
    FIRE_BLADE_BUFF: { label: 'FB', className: 'fire' },
  };

  function describeActor(actorId){
    return actorId === 'player' ? 'Вы' : 'Противник';
  }

  const combatFeedHistory = [];

  function pushCombatEvent(type, text){
    if (!combatFeedEl || !text) return;
    const entry = document.createElement('div');
    entry.className = ['combat-event', type].filter(Boolean).join(' ');
    entry.textContent = text;
    combatFeedEl.prepend(entry);
    combatFeedHistory.push(entry);
    while (combatFeedHistory.length > 4){
      const old = combatFeedHistory.shift();
      old?.remove();
    }
    setTimeout(()=>{
      entry.classList.add('fade');
      setTimeout(()=> entry.remove(), 320);
    }, 2400);
  }

  function currentPlayerProfile(){
    if (!App.started) return null;
    return playerData.studentProfile || activeStudent() || App.school?.students?.[0] || null;
  }

  function getPlayerSpecialIds(){
    if (!App.started) return [];
    const profile = currentPlayerProfile();
    if (profile?.learnedSpecials?.length){
      return profile.learnedSpecials.slice();
    }
    const book = Array.isArray(App.school?.styleBook) ? App.school.styleBook : [];
    if (book.length) return book.map(sp => sp.id);
    return Object.keys(SPECIALS);
  }

  function resolveSpecialDefinition(id){
    const book = Array.isArray(App.school?.styleBook) ? App.school.styleBook : [];
    return book.find(sp => sp.id === id) || SPECIALS[id] || { id, name: id };
  }

  function abbreviateSpecial(def){
    const name = (def?.name || def?.id || '').trim();
    if (!name) return (def?.id || '??').slice(0, 2).toUpperCase();
    const tokens = name.split(/\s+/).filter(Boolean);
    if (tokens.length === 1) return tokens[0].slice(0, 3).toUpperCase();
    return (tokens[0][0] + tokens[1][0]).toUpperCase();
  }

  function updateSpecialTray(){
    if (!specialTrayEl) return;
    if (!App.started){
      if (specialTrayEl.childElementCount){
        specialTrayEl.innerHTML = '';
      }
      return;
    }
    const ids = getPlayerSpecialIds();
    const cooldownSource = USE_NEW_CHARACTER_CONTROLLER
      ? (playerData.specialCooldowns || [])
      : Object.entries(playerData.specialsCD || {}).map(([id, remaining]) => ({ id, remaining }));
    const cooldownMap = new Map(cooldownSource.map(item => [item.id, item.remaining]));
    const existing = new Set(ids);
    specialTrayEl.querySelectorAll('[data-special-id]').forEach((node)=>{
      if (!existing.has(node.dataset.specialId)){
        node.remove();
      }
    });
    ids.forEach((id)=>{
      let node = specialTrayEl.querySelector(`[data-special-id="${id}"]`);
      if (!node){
        node = document.createElement('div');
        node.className = 'special-icon';
        node.dataset.specialId = id;
        const label = document.createElement('span');
        label.className = 'abbr';
        label.textContent = abbreviateSpecial(resolveSpecialDefinition(id));
        const cooldown = document.createElement('div');
        cooldown.className = 'cooldown hidden';
        node.append(label, cooldown);
        specialTrayEl.appendChild(node);
      }
      const cooldownEl = node.querySelector('.cooldown');
      const remaining = cooldownMap.get(id) ?? 0;
      if (remaining > 0.05){
        cooldownEl.textContent = Math.ceil(remaining).toString();
        cooldownEl.classList.remove('hidden');
        node.classList.remove('active');
      } else {
        cooldownEl.classList.add('hidden');
        node.classList.add('active');
      }
    });
  }

  const buffIconCache = {
    player: new Map(),
    enemy: new Map(),
  };

  function getBuffDisplay(buff){
    return BUFF_ICON_MAP[buff?.id] || { label: (buff?.id || 'BUF').slice(0, 3).toUpperCase(), className: '' };
  }

  function updateBuffTrayFor(actorKey, trayEl, data){
    if (!trayEl) return;
    if (!App.started){
      if (trayEl.childElementCount){
        trayEl.innerHTML = '';
      }
      buffIconCache[actorKey]?.clear?.();
      return;
    }
    const buffs = data?.activeBuffs || [];
    const cache = buffIconCache[actorKey] || new Map();
    buffIconCache[actorKey] = cache;
    const keep = new Set();
    buffs.forEach((buff)=>{
      const key = `${actorKey}-${buff.id}`;
      keep.add(key);
      let node = cache.get(key);
      if (!node){
        node = document.createElement('div');
        node.className = 'buff-icon';
        node.dataset.buffKey = key;
        const label = document.createElement('span');
        label.className = 'abbr';
        const timer = document.createElement('span');
        timer.className = 'timer';
        node.append(label, timer);
        trayEl.appendChild(node);
        cache.set(key, node);
      }
      const desc = getBuffDisplay(buff);
      node.querySelector('.abbr').textContent = desc.label;
      node.classList.toggle('fire', desc.className === 'fire');
      const timerEl = node.querySelector('.timer');
      const remaining = Math.max(0, buff.remaining ?? 0);
      timerEl.textContent = remaining > 0 ? `${remaining.toFixed(1)}с` : '';
    });
    for (const [key, node] of cache.entries()){
      if (!keep.has(key)){
        node.remove();
        cache.delete(key);
      }
    }
  }

  function updateHudContextLabel(){
    if (!hudContextLabelEl) return;
    if (!App.started){
      hudContextLabelEl.textContent = '—';
      return;
    }
    let label = 'Арена';
    if (App.mode === 'hub') label = 'Хаб';
    else if (App.mode === 'student') label = 'Досье';
    else if (App.mode === 'training') label = practiceMode ? 'Практика' : 'Спарринг';
    else if (App.mode === 'tournamentVis') label = 'Турнир';
    else if (App.mode === 'meditation') label = 'Медитация';
    hudContextLabelEl.textContent = label;
  }

  // --- Camera follow ---
  const camTarget = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const arenaCamDir = new THREE.Vector3();
  function updateCamera(dt){
    if (cameraState.dragging){
      // dragging handled via mousemove
    }
    camTarget.copy(player.position);
    camTarget.x += cameraState.pan.x;
    camTarget.y = CAMERA_TARGET_HEIGHT + cameraState.pan.y;
    camTarget.z += cameraState.pan.y * 0.1;
    const cosPitch = Math.cos(cameraState.pitch);
    const sinPitch = Math.sin(cameraState.pitch);
    camDir.set(
      Math.sin(cameraState.yaw) * cosPitch,
      -sinPitch,
      Math.cos(cameraState.yaw) * cosPitch
    );
    camForwardXZ.copy(camDir).multiplyScalar(-1);
    camForwardXZ.y = 0;
    if (camForwardXZ.lengthSq() < 0.0001){ camForwardXZ.set(0, 0, 1); }
    else { camForwardXZ.normalize(); }
    camRightXZ.set(camForwardXZ.z, 0, -camForwardXZ.x).normalize();
    camPos.copy(camTarget).sub(camDir.multiplyScalar(cameraState.distance));
    camera.position.lerp(camPos, 1 - Math.pow(0.0025, dt));
    camera.lookAt(camTarget);
  }

  function updateInputBasisFromActiveCamera(){
    if (!USE_NEW_CHARACTER_CONTROLLER) return;
    const arenaCam = ARENA?.engine?.camera;
    if (!arenaCam) return;
    arenaCam.getWorldDirection(arenaCamDir);
    arenaCamDir.y = 0;
    if (arenaCamDir.lengthSq() < 0.0001){
      arenaCamDir.set(0, 0, -1);
    } else {
      arenaCamDir.normalize();
    }
    camForwardXZ.copy(arenaCamDir);
    camRightXZ.set(camForwardXZ.z, 0, -camForwardXZ.x).normalize();
  }

  // --- Actions / Combat ---
  function addComboEntry(data, type){
    const t = now();
    data.combo.push({ type, t });
    // Drop old entries beyond window
    data.combo = data.combo.filter(e => t - e.t <= COMBO_WINDOW);
    checkCombos(data);
  }

  function tryJump(data, actor){
    if (!data || !data.isGrounded || data.stun > 0) return;
    data.vel.y = JUMP_POWER;
    data.isGrounded = false;
    addComboEntry(data, 'JUMP');
  }

  function checkPatternTail(list, pattern){
    if (list.length < pattern.length) return false;
    for (let i = 0; i < pattern.length; i++){
      const a = list[list.length - pattern.length + i];
      if (a.type !== pattern[i]) return false;
    }
    return true;
  }

  function checkCombos(data){
    if (!App || !App.school) return;
    const styleBook = App.school.styleBook;
    for (const sp of styleBook){
      if (checkPatternTail(data.combo, sp.pattern)){
        if (!data.specialsCD[sp.id]) data.specialsCD[sp.id] = 0;
        const need = sp.focusCost;
        if (data.fo >= need && data.specialsCD[sp.id] <= 0){
          data.fo -= need;
          data.specialsCD[sp.id] = sp.cooldown || 4.0;
          data.combo.length = 0; // clear
          flashSpecial(sp.name);
          onSpecialActivated(data, sp);
        }
      }
    }
  }

  const pushTemp = new THREE.Vector3();
  function pushActor(mesh, data, distance, yaw){
    if (!mesh || !distance) return;
    const dir = pushTemp.set(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
    mesh.position.addScaledVector(dir, distance);
    const limit = ARENA_RADIUS - 0.5;
    const planar = Math.hypot(mesh.position.x, mesh.position.z);
    if (planar > limit && planar > 0.0001){
      const scale = limit / planar;
      mesh.position.x *= scale;
      mesh.position.z *= scale;
    }
    if (data && data.vel){
      data.vel.addScaledVector(dir, distance * 4);
    }
  }

  function regenGuardGauge(data, delta){
    if (!data) return;
    data.guardRegenDelay = Math.max(0, (data.guardRegenDelay || 0) - delta);
    if (data.guardRegenDelay <= 0){
      const regenFactor = data.block > 0 ? 0.35 : 1.0;
      const maxVal = data.guardMax || GUARD_MAX;
      data.guardGauge = clamp((data.guardGauge || 0) + GUARD_REGEN_RATE * regenFactor * delta, 0, maxVal);
    }
  }

  function registerComboHit(data){
    if (!data) return;
    const t = now();
    if (!data.comboTimer || (t - data.comboTimer) > COMBO_DROP_TIME){
      data.comboCounter = 0;
    }
    data.comboCounter = (data.comboCounter || 0) + 1;
    data.comboTimer = t;
  }

  function queueBufferedAttack(data, kind){
    if (!data) return;
    data.inputBuffer = { kind, expires: now() + INPUT_BUFFER_TIME };
  }

  function consumeBufferedAttack(attacker, attackerData, target, targetData){
    if (!attackerData || !attackerData.inputBuffer) return;
    if (now() > attackerData.inputBuffer.expires){
      attackerData.inputBuffer = null;
      return;
    }
    if (attackerData.attackTimer > 0 || attackerData.stun > 0 || attackerData.block > 0) return;
    const kind = attackerData.inputBuffer.kind;
    attackerData.inputBuffer = null;
    if (!USE_NEW_CHARACTER_CONTROLLER || !ARENA?.triggerAttack) return;
    const actorId = attackerData === playerData ? 'player' : (attackerData === enemyData ? 'enemy' : null);
    if (actorId){
      ARENA.triggerAttack(actorId, kind);
    }
  }

  function sphereHitCheck(attacker, target, attackerYaw, range = MELEE_RANGE, radius = MELEE_RADIUS){
    const center = new THREE.Vector3(Math.sin(attackerYaw), 0, Math.cos(attackerYaw)).multiplyScalar(range).add(attacker.position);
    const dist = center.distanceTo(target.position);
    const targetRadius = 0.6;
    return dist <= (radius + targetRadius);
  }

  function pickAttackClip(data, kind){
    const list = ATTACK_CLIPS[kind] || ATTACK_CLIPS.LIGHT;
    if (!Array.isArray(list) || list.length===0) return DEFAULT_ATTACK_CLIP;
    data.attackClipCursor = (data.attackClipCursor || 0) + 1;
    const idx = data.attackClipCursor % list.length;
    return list[idx] || DEFAULT_ATTACK_CLIP;
  }

  function pickStateClip(desired, data, forceNext = false){
    const list = STATE_CLIP_VARIANTS[desired];
    if (!list || list.length===0) return STATE_CLIP_NAMES[desired] || DEFAULT_ATTACK_CLIP;
    data.stateClipCursor = data.stateClipCursor || {};
    data.stateClipChoice = data.stateClipChoice || {};
    if (forceNext || !data.stateClipChoice[desired]){
      const nextIdx = ( (data.stateClipCursor[desired] ?? -1) + 1 ) % list.length;
      data.stateClipCursor[desired] = nextIdx;
      data.stateClipChoice[desired] = list[nextIdx];
    }
    return data.stateClipChoice[desired];
  }

  function trySpecialFireBlade(attacker, target, targetData){
    const attackerData = attacker === player ? playerData : enemyData;
    const yaw = attackerData.yaw;
    const attackerId = attacker === player ? 'player' : 'enemy';
    const targetId = attackerId === 'player' ? 'enemy' : 'player';
    if (!sphereHitCheck(attacker, target, yaw, MELEE_RANGE + 0.4, MELEE_RADIUS)) return;
    if (USE_NEW_CHARACTER_CONTROLLER && ARENA?.getController){
      const targetController = ARENA.getController(targetId);
      const attackerController = ARENA.getController(attackerId);
      if (!targetController?.receiveHit) return;
      const damageConfig = {
        damage: DMG.FIRE_BLADE + (attackerData.dmgBuff || 0),
        guardDamage: 40,
        chipPercent: 0.18,
        hitStun: 0.9,
        blockStun: 0.45,
        focusGain: 10,
        pushBack: 1.1,
        moveDef: { id: 'FIRE_BLADE', hitStop: { onHit: 0.08, onBlock: 0.08 }, focusGain: 10 },
        attackerId,
        attackerYaw: yaw,
      };
      const result = targetController.receiveHit(damageConfig);
      attackerController?.applyOffensiveResult?.(result, damageConfig.moveDef);
      if (result?.hit){
        registerComboHit(attackerData);
        if (typeof onHitDamage === 'function'){
          onHitDamage(targetId);
        }
      }
      syncCombatFromController(targetId);
      syncCombatFromController(attackerId);
      updateBars();
      updateEnemyBar();
      return;
    }
  }

  function trySpecialPush(attacker, target, targetData){
    const attackerData = attacker === player ? playerData : enemyData;
    const yaw = attackerData.yaw;
    if (sphereHitCheck(attacker, target, yaw, MELEE_RANGE + 0.2, MELEE_RADIUS)){
      // Stun and a small knockback
      targetData.stun = Math.max(targetData.stun, 1.5);
      pushActor(target === player ? player : enemy, targetData, 0.9, yaw);
    }
  }

  // --- Specials Framework (dynamic) ---
  function applyDamageBuff(data, amount, duration){
    data.dmgBuff = Math.max(data.dmgBuff||0, amount);
    data.dmgBuffTime = Math.max(data.dmgBuffTime||0, duration);
  }

  let lastPlayerSpecial = null;
  function onSpecialActivated(data, sp){
    const attacker = (data === playerData) ? player : enemy;
    const target = (data === playerData) ? enemy : player;
    const targetData = (data === playerData) ? enemyData : playerData;
    if (data === playerData){
      lastPlayerSpecial = { id: sp.id, time: now(), effectType: (sp.effect && sp.effect.type) };
      // count special usage during training and grant con XP
      if (trainingSession.active){ trainingSession.usage.SPECIAL = (trainingSession.usage.SPECIAL||0) + 1; }
      if (combatStats){ combatStats.con += 25; }
    }
    if (!sp.effect) return;
    switch (sp.effect.type){
      case 'damage_buff':
        applyDamageBuff(data, sp.effect.bonus||8, sp.effect.duration||5);
        break;
      case 'stun_push':
        // Apply push/stun with custom values reusing trySpecialPush distances
        const yaw = data.yaw;
        if (sphereHitCheck(attacker, target, yaw, MELEE_RANGE + 0.2, MELEE_RADIUS)){
          targetData.stun = Math.max(targetData.stun, sp.effect.stun||1.5);
          const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
          target.position.addScaledVector(dir, sp.effect.push||0.6);
          onSpecialHit(data===playerData?'player':'enemy', sp.id);
        }
        break;
    }
  }

  function onSpecialHit(who, id){
    if (who==='player' && trainingSession.active && App.activeStudentId){
      registerMasteryHit(App.activeStudentId, id);
    }
  }

  function onHitDamage(whoGotHit){
    if (whoGotHit==='enemy' && trainingSession.active && lastPlayerSpecial && (now() - lastPlayerSpecial.time) < 1.0){
      registerMasteryHit(App.activeStudentId, lastPlayerSpecial.id);
    }
  }

  // --- Situational learning (training) and tactical execution (tournaments) ---
let playerActionSequence = [];
let lastSituationKey = '';
const lastSeqBySituation = {}; // remembers last recorded/executed sequence per situation

  function ensureStudentKnowledgeBase(student){
    if (!student) return null;
    if (student.kbVersion !== KB_VERSION || typeof student.knowledgeBase !== 'object'){
      student.knowledgeBase = {};
      student.kbVersion = KB_VERSION;
    }
    return student.knowledgeBase;
  }

  function getSituationKey(actorData, targetData, actorMesh, targetMesh){
    const distance = actorMesh.position.distanceTo(targetMesh.position);
    let distCategory = 'Дальняя';
    if (distance < CLOSE_DIST) distCategory = 'Близкая'; else if (distance < ENEMY_ENGAGE_DIST) distCategory = 'Средняя';
    const targetState = (targetData.attackTimer>0) ? 'Атакует' : ((targetData.block>0) ? 'Блок' : 'Свободен');
    const staminaValue = actorData.st ?? actorData.stamina ?? ST_MAX;
    const staminaMax = actorData.stMax ?? actorData.maxStamina ?? ST_MAX;
    const staminaRatio = staminaValue / Math.max(1, staminaMax);
    const actorStamina = staminaRatio > 0.6 ? 'ST-выс' : (staminaRatio > 0.35 ? 'ST-сред' : 'ST-низ');
    const focusValue = actorData.fo ?? actorData.focus ?? 0;
    const focusMax = actorData.foMax ?? actorData.maxFocus ?? FO_MAX;
    const focusRatio = focusValue / Math.max(1, focusMax);
    const actorFocus = focusRatio > 0.66 ? 'FO-выс' : (focusRatio > 0.33 ? 'FO-сред' : 'FO-низ');
    return [distCategory, targetState, actorStamina, actorFocus].join('|');
  }

  function recordPlayerAction(student, actionType){
    if (!student) return;
    const VALID = { LIGHT:1, HEAVY:1, BLOCK:1, DODGE:1, JUMP:1, WAIT:1, SPECIAL:1 };
    if (actionType && VALID[actionType]){
      playerActionSequence.push(actionType);
    }
    // flush when enough actions gathered
    if (playerActionSequence.length >= KB_SEQ_LEN){
      const situationKey = lastSituationKey;
      if (situationKey){
        const kb = ensureStudentKnowledgeBase(student);
        if (!kb) return;
        const list = (kb[situationKey] ||= []);
        const seqStr = JSON.stringify(playerActionSequence);
        let found = list.find(item => JSON.stringify(item.sequence) === seqStr);
        if (!found) { list.push({ sequence: playerActionSequence.slice(), effectiveness: 0 }); }
        lastSeqBySituation[situationKey] = playerActionSequence.slice();
      }
      playerActionSequence = [];
    }
  }

  // --- Player update ---
  const tmpVec = new THREE.Vector3();
  const tmpVec2 = new THREE.Vector3();
  const tmpVec3 = new THREE.Vector3();
  const tmpVec4 = new THREE.Vector3();
  const aiToTarget = new THREE.Vector3();
  const aiPerp = new THREE.Vector3();
  const aiMoveVec = new THREE.Vector3();
  const aiIntentVec = new THREE.Vector3();
  const tmpSep = new THREE.Vector3();
  const tmpClamp = new THREE.Vector3();
  const spacingVec = new THREE.Vector3();
  const spacingPlayerTarget = new THREE.Vector3();
  const spacingEnemyTarget = new THREE.Vector3();
  const inputVec = new THREE.Vector3();
  const inputAxis = new THREE.Vector3();
  const camForwardXZ = new THREE.Vector3(0, 0, 1);
  const camRightXZ = new THREE.Vector3(1, 0, 0);
  let lastTime = now();
  let dt = 0.016;
  let fxList = [];

  function spawnShockwave(pos, color=0x7dd3fc){
    const g = new THREE.RingGeometry(0.1, 0.2, 32);
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, m);
    mesh.rotation.x = -Math.PI/2; mesh.position.copy(pos).setY(0.02);
    getActiveScene().add(mesh);
    fxList.push({ kind:'shock', mesh, t:0, life:0.6 });
  }

  function spawnSlashArc(attacker, yaw, color=0xfca5a5){
    const g = new THREE.RingGeometry(0.6, 0.85, 32, 1, -Math.PI/3, Math.PI*2/3);
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(attacker.position).add(new THREE.Vector3(Math.sin(yaw)*0.8, 1.0, Math.cos(yaw)*0.8));
    mesh.rotation.y = yaw;
    getActiveScene().add(mesh);
    fxList.push({ kind:'slash', mesh, t:0, life:0.25 });
  }

  function spawnHitSpark(pos, color=0xfff08a){
    const g = new THREE.SphereGeometry(0.06, 8, 8);
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(pos);
    getActiveScene().add(mesh);
    fxList.push({ kind:'spark', mesh, t:0, life:0.18 });
  }

  // Trail particle for magic sword trails
  function spawnTrailParticle(position, color){
    const g = new THREE.SphereGeometry(Math.random()*0.06 + 0.03, 5, 5);
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.copy(position);
    mesh.position.x += (Math.random()-0.5)*0.2;
    mesh.position.z += (Math.random()-0.5)*0.2;
    getActiveScene().add(mesh);
    const life = Math.random()*0.5 + 0.3;
    fxList.push({ kind:'particle', mesh, t:0, life, initialVel: new THREE.Vector3(0, 0.6, 0) });
  }

  function updateFX(dt){
    for (let i=fxList.length-1;i>=0;i--){
      const fx = fxList[i]; fx.t += dt; const k = fx.t / fx.life;
      if (fx.kind==='shock'){
        fx.mesh.scale.setScalar(lerp(1, 6, k)); fx.mesh.material.opacity = 0.9*(1-k);
      } else if (fx.kind==='slash'){
        fx.mesh.position.y += dt*2.0; fx.mesh.scale.setScalar(lerp(1, 1.4, k)); fx.mesh.material.opacity = 0.85*(1-k);
      } else if (fx.kind==='spark'){
        fx.mesh.position.y += dt*1.2; fx.mesh.material.opacity = 1.0*(1-k);
      } else if (fx.kind==='particle'){
        fx.mesh.position.addScaledVector(fx.initialVel, dt);
        fx.initialVel.y -= 2.2*dt; // gravity
        fx.mesh.material.opacity = 1.0*(1-k);
        fx.mesh.scale.setScalar(1-k);
      }
      if (k>=1){ fx.mesh.parent?.remove(fx.mesh); fx.mesh.geometry.dispose?.(); fx.mesh.material.dispose?.(); fxList.splice(i,1); }
    }
  }

  function updatePlayer(dt){
    // Timers
    playerData.invuln = Math.max(0, playerData.invuln - dt);
    playerData.block = Math.max(0, playerData.block - dt);
    playerData.dodge = Math.max(0, playerData.dodge - dt);
    playerData.stun = Math.max(0, playerData.stun - dt);
    // Specials CD and buffs
    for (const k in playerData.specialsCD){ playerData.specialsCD[k] = Math.max(0, playerData.specialsCD[k] - dt); }
    if (playerData.dmgBuffTime){ playerData.dmgBuffTime = Math.max(0, playerData.dmgBuffTime - dt); if (playerData.dmgBuffTime<=0) { playerData.dmgBuff=0; } }

    // Regen
    if (playerData.stun <= 0){
      playerData.st = clamp(playerData.st + ST_REGEN * dt, 0, ST_MAX);
      playerData.fo = clamp(playerData.fo + FO_REGEN * dt, 0, FO_MAX);
    }
    regenGuardGauge(playerData, dt);
    playerData.hitStop = Math.max(0, playerData.hitStop - dt);
    if (playerData.hitStop > 0){
      return;
    }

    const wasGrounded = playerData.isGrounded;

    if (App.mode !== 'tournamentVis'){
      if (USE_NEW_CHARACTER_CONTROLLER){
        updateInputBasisFromActiveCamera();
      }
      let manualIntent = playerData.manualMoveIntent;
      if (!manualIntent){
        manualIntent = inputVec;
        manualIntent.set(0, 0, 0);
      }
      const canManualMove = playerData.stun <= 0 && wasGrounded && playerData.dodge <= 0;
      const hasIntent = manualIntent.lengthSq() > 0.0001;
      if (trainingSession.active && hasIntent){
        const forwardDot = manualIntent.dot(camForwardXZ);
        const strafeDot = manualIntent.dot(camRightXZ);
        if (forwardDot > 0.25){ trainingSession.usage.forwardTime += dt; }
        else if (forwardDot < -0.25){ trainingSession.usage.backwardTime += dt; }
        if (Math.abs(strafeDot) > 0.2){ trainingSession.usage.strafeTime += dt; }
      }
      if (USE_NEW_CHARACTER_CONTROLLER){
        const shouldSend = !playerData.aiControlled && canManualMove && hasIntent;
        pushArenaMoveIntent('player', shouldSend ? manualIntent : null);
      } else if (canManualMove && hasIntent){
        const moveSpeed = playerData.dodge > 0 ? DODGE_SPEED : PLAYER_SPEED;
        const vy = playerData.vel.y || 0;
        const desiredGroundVel = tmpVec3.copy(manualIntent).setY(0);
        const intentLen = desiredGroundVel.length();
        if (intentLen > 0.0001){
          desiredGroundVel.multiplyScalar(1 / intentLen);
        }
        desiredGroundVel.multiplyScalar(moveSpeed);
        const accel = hasIntent ? GROUND_ACCEL : GROUND_DECEL;
        const blend = 1 - Math.exp(-accel * dt);
        playerData.groundVel.lerp(desiredGroundVel, blend);
        playerData.vel.x = playerData.groundVel.x;
        playerData.vel.z = playerData.groundVel.z;
        playerData.vel.y = vy;
      }
      if (!USE_NEW_CHARACTER_CONTROLLER){
        if (!playerData.isGrounded){ playerData.vel.y += GRAVITY * dt; }
        player.position.addScaledVector(playerData.vel, dt);
        if (player.position.y <= 1.0){
          player.position.y = 1.0;
          playerData.isGrounded = true;
          playerData.vel.y = 0;
        } else {
          playerData.isGrounded = false;
        }
        clampActorToArena(player, playerData);
        if (playerData.stun <= 0 && hasIntent){
          const desiredYaw = Math.atan2(manualIntent.x, manualIntent.z);
          const turnRate = playerData.attackTimer > 0 ? 6 : 12;
          playerData.yaw = lerpAngle(playerData.yaw, desiredYaw, 1 - Math.exp(-turnRate * dt));
        }
        player.rotation.y = playerData.yaw;
      } else {
        playerData.groundVel.set(0, 0, 0);
      }
    } else if (USE_NEW_CHARACTER_CONTROLLER){
      playerData.groundVel.set(0, 0, 0);
      pushArenaMoveIntent('player', null);
    }
    animateRig(playerRig, playerData, dt);
    // Shield FX during block
    // shield FX removed
  }

  function updateEnemy(dt){
    enemyData.invuln = Math.max(0, enemyData.invuln - dt);
    enemyData.block = Math.max(0, enemyData.block - dt);
    enemyData.dodge = Math.max(0, enemyData.dodge - dt);
    enemyData.stun = Math.max(0, enemyData.stun - dt);
    for (const k in enemyData.specialsCD){ enemyData.specialsCD[k] = Math.max(0, enemyData.specialsCD[k] - dt); }
    if (enemyData.dmgBuffTime){ enemyData.dmgBuffTime = Math.max(0, enemyData.dmgBuffTime - dt); if (enemyData.dmgBuffTime<=0){ enemyData.dmgBuff=0; } }

    // Regen (slightly slower; adjust by optional multiplier)
    if (enemyData.stun <= 0){
      const stMul = (typeof enemyData.regenMul==='number') ? enemyData.regenMul : 0.9;
      const foMul = (typeof enemyData.regenMul==='number') ? Math.max(0.6, enemyData.regenMul) : 0.7;
      enemyData.st = clamp(enemyData.st + (ST_REGEN*stMul) * dt, 0, ST_MAX);
      enemyData.fo = clamp(enemyData.fo + (FO_REGEN*foMul) * dt, 0, FO_MAX);
    }
    regenGuardGauge(enemyData, dt);
    enemyData.hitStop = Math.max(0, enemyData.hitStop - dt);
    if (enemyData.hitStop > 0){
      return;
    }

    if (USE_NEW_CHARACTER_CONTROLLER && enemyData.groundVel){ enemyData.groundVel.set(0, 0, 0); }
    animateRig(enemyRig, enemyData, dt);
    // shield FX removed
  }

  const RIG_STATE_CLIPS = {
    idle: STATE_CLIP_NAMES.idle,
    move: STATE_CLIP_NAMES.move,
    attack: DEFAULT_ATTACK_CLIP,
    block: STATE_CLIP_NAMES.block,
    dodge: STATE_CLIP_NAMES.dodge,
    stun: STATE_CLIP_NAMES.stun,
    death: STATE_CLIP_NAMES.death,
  };
  // --- Rig animation ---
  function animateRig(rig, data, dt){
    if (!rig || !data) return;
    const speed = data.vel ? Math.hypot(data.vel.x || 0, data.vel.z || 0) : 0;
    if (rig.mixer){
      rig.mixer.update(dt);
      lockRigRootHorizontal(rig, rig.owner, data);
      let desired = 'idle';
      let overrideClip = null;
      let once = false;
      let force = false;
      let fade = 0.25;
      if (data.hp <= 0){
        desired = 'death';
        once = true;
        force = true;
        fade = 0.15;
      } else if (data.attackTimer > 0 && data.attackActive >= 0){
        desired = 'attack';
        once = true;
        force = true;
        fade = 0.1;
      } else if (data.block > 0){
        desired = 'block';
        fade = 0.15;
      } else if (data.dodge > 0){
        desired = 'dodge';
        once = true;
        fade = 0.08;
      } else if (data.stun > 0.25){
        desired = 'stun';
        once = true;
        fade = 0.12;
      } else {
        const locomotionClip = determineLocomotionClip(data);
        if (locomotionClip){
          desired = 'move';
          overrideClip = locomotionClip;
          fade = 0.18;
        }
      }
      const prevState = rig.stateKey ? rig.stateKey.split(':')[0] : null;
      const clipName = desired === 'attack'
        ? (data.attackAnimName || DEFAULT_ATTACK_CLIP)
        : (overrideClip || pickStateClip(desired, data, prevState !== desired));
      const stateKey = `${desired}:${clipName}`;
      if (rig.stateKey === stateKey) return;
      rig.stateKey = stateKey;
      const clip = clipName || (RIG_STATE_CLIPS[desired] || RIG_STATE_CLIPS.idle);
      activateRigAction(rig, clip, { fade, once, force });
      return;
    }
    const manual = rig.manual || rig;
    if (!manual || !manual.shoulderR) return;
    const manualMoving = (speed > 0.1);
    data.walkPhase = (data.walkPhase||0) + dt * (manualMoving ? 8.0 : 2.0);
    const sway = Math.sin(data.walkPhase) * (manualMoving ? 0.6 : 0.15);
    manual.shoulderR.rotation.z = THREE.MathUtils.degToRad(5 + sway*10);
    manual.shoulderL.rotation.z = THREE.MathUtils.degToRad(-5 - sway*10);
    manual.hipR.rotation.z = THREE.MathUtils.degToRad(-sway*8);
    manual.hipL.rotation.z = THREE.MathUtils.degToRad(sway*8);
    const kneeBend = (data.isGrounded ? 0 : THREE.MathUtils.degToRad(12));
    manual.kneeR.rotation.x = kneeBend;
    manual.kneeL.rotation.x = kneeBend;
    if (data.block > 0){
      manual.shoulderR.rotation.x = THREE.MathUtils.degToRad(-20);
      manual.elbowR.rotation.x = THREE.MathUtils.degToRad(-30);
    } else {
      manual.shoulderR.rotation.x = lerp(manual.shoulderR.rotation.x || 0, 0, dt * 8.0);
      manual.elbowR.rotation.x = lerp(manual.elbowR.rotation.x || 0, 0, dt * 8.0);
    }
    const lean = data.dodge>0 ? 0.25 : 0.0;
    manual.model.rotation.z = lerp(manual.model.rotation.z || 0, lean, dt * 6.0);
    if (data.animAttack && data.attackTimer > 0){
      const total = data.animAttack.total || 1;
      const prog = 1 - (data.attackTimer / total);
      const wind = data.animAttack.windup, act = data.animAttack.active, rec = data.animAttack.recovery;
      let tNorm = 0, angle = 0;
      if (prog < wind/total){
        tNorm = prog / (wind/total);
        angle = THREE.MathUtils.lerp(0, -1.2, tNorm);
      } else if (prog < (wind+act)/total){
        tNorm = (prog - wind/total) / (act/total);
        angle = THREE.MathUtils.lerp(-1.2, 1.0, tNorm);
      } else {
        tNorm = (prog - (wind+act)/total) / (rec/total);
        angle = THREE.MathUtils.lerp(1.0, 0.0, tNorm);
      }
      const swingBoost = (data.attackAnimName === 'Jump') ? 1.35 : (data.attackAnimName === 'Yes' ? 0.8 : 1.0);
      manual.shoulderR.rotation.y = angle * 0.25 * swingBoost;
      manual.shoulderR.rotation.x = angle * 0.65 * swingBoost;
      manual.elbowR.rotation.x = angle * -0.35 * swingBoost;
    } else {
      manual.shoulderR.rotation.y = lerp(manual.shoulderR.rotation.y || 0, 0, dt * 8.0);
    }
  }

  // --- Reset ---
  function resetData(d){
    d.hp = HP_MAX; d.st = ST_MAX; d.fo = 0;
    d.invuln = 0; d.block = 0; d.dodge = 0; d.stun = 0;
    d.attackTimer = 0; d.attackActive = 0; d.attackKind = null; d.combo = [];
    d.specialsCD = {};
    d.specialCooldowns = [];
    d.activeBuffs = [];
    d.isGrounded = true;
    d.inputBuffer = null;
    d.attackAnimTag = 0;
    d.attackClipCursor = 0;
    d.stateClipCursor = null;
    d.stateClipChoice = null;
    d.guardGauge = d.guardMax || GUARD_MAX;
    d.guardRegenDelay = 0;
    d.hitStop = 0;
    d.currentMove = null;
    d.comboCounter = 0;
    d.comboTimer = 0;
    d.animAttack = null;
    d.actionQueue = [];
    d.currentActionTimer = 0;
    if (d.vel){ d.vel.set(0,0,0); }
    if (d.groundVel){ d.groundVel.set(0,0,0); }
  }

  function updatePracticeUI(){
    if (practiceBtn){
      practiceBtn.textContent = practiceMode ? 'Практика: ON' : 'Практика: OFF';
      practiceBtn.classList.toggle('active', practiceMode);
    }
    updateHudContextLabel();
  }

  function applyPracticeState(){
    if (!enemy || !enemyData) return;
    if (practiceMode){
      enemy.visible = false;
      enemy.position.copy(PRACTICE_HIDDEN_POS);
      if (enemyData.vel) enemyData.vel.set(0,0,0);
      if (enemyData.groundVel) enemyData.groundVel.set(0,0,0);
      enemyData.attackTimer = 0;
      enemyData.block = 0;
      enemyData.dodge = 0;
      enemyData.stun = 0;
    } else {
      enemy.visible = true;
    }
    updatePracticeUI();
  }

  const tutorialGuide = {
    active: false,
    stageIndex: 0,
    stages: [],
    metrics: {},
    stageStartedAt: 0,
  };

  const hintRenderState = { lastMarkup: '', nextUpdateAt: 0 };

  function startTutorialGuide(){
    tutorialGuide.stages = buildTutorialStages();
    if (!tutorialGuide.stages.length){
      tutorialGuide.active = false;
      return;
    }
    tutorialGuide.active = true;
    tutorialGuide.stageIndex = 0;
    tutorialGuide.metrics = { blocks: 0 };
    tutorialGuide.stageStartedAt = now();
  }

  function stopTutorialGuide(){
    tutorialGuide.active = false;
    tutorialGuide.stageIndex = 0;
    tutorialGuide.stages = [];
    tutorialGuide.metrics = { blocks: 0 };
  }

  function buildTutorialStages(){
    const stages = [
      {
        id: 'move',
        title: 'Движение',
        text: 'Двигайтесь <span class="k">WASD</span> и держите врага в поле зрения как минимум 3 секунды.',
        condition: () => {
          const usage = trainingSession.usage || {};
          return ((usage.forwardTime || 0) + (usage.strafeTime || 0)) >= 3;
        },
      },
      {
        id: 'block',
        title: 'Блок',
        text: 'Зажмите <span class="k">Shift</span>, чтобы принять удар щитом и увидеть расход Guard.',
        condition: () => (tutorialGuide.metrics.blocks || 0) >= 1,
      },
      {
        id: 'heavy',
        title: 'Тяжёлый удар',
        text: 'Используйте тяжёлую атаку (<span class="k">K</span> или ПКМ), чтобы пробивать блок.',
        condition: () => (trainingSession.usage?.HEAVY || 0) >= 1,
      },
      {
        id: 'dodge',
        title: 'Перекат',
        text: 'Сделайте перекат (<span class="k">Shift</span> + направление), чтобы избежать урона.',
        condition: () => (trainingSession.usage?.DODGE || 0) >= 1,
      },
    ];
    const profile = currentPlayerProfile();
    if (profile?.learnedSpecials?.length){
      const specialId = profile.learnedSpecials[0];
      const special = resolveSpecialDefinition(specialId);
      const pattern = Array.isArray(special?.pattern) ? special.pattern.join(' → ') : 'L → L → H';
      stages.push({
        id: 'special',
        title: 'Спецприём',
        text: `Накопите Focus и выполните ${special?.name || 'спецприём'} (${pattern}).`,
        condition: () => (trainingSession.usage?.SPECIAL || 0) >= 1,
      });
    } else {
      stages.push({
        id: 'focus',
        title: 'Фокус',
        text: 'Заполните шкалу Focus хотя бы наполовину, атакуя сериями.',
        condition: () => (playerData.fo || 0) >= (playerData.maxFocus || FO_MAX) * 0.5,
      });
    }
    return stages;
  }

  function updateTutorialGuide(){
    if (!tutorialGuide.active || !trainingSession.active) return;
    const stage = tutorialGuide.stages[tutorialGuide.stageIndex];
    if (!stage){
      completeTutorialGuide();
      return;
    }
    if (stage.condition()){
      const finishedTitle = stage.title;
      tutorialGuide.stageIndex += 1;
      tutorialGuide.stageStartedAt = now();
      flashSpecial(`Шаг завершён: ${finishedTitle}`);
      if (tutorialGuide.stageIndex >= tutorialGuide.stages.length){
        completeTutorialGuide();
      }
    }
  }

  function completeTutorialGuide(){
    if (tutorialGuide.active) {
      tutorialGuide.active = false;
      flashSpecial('Туториал завершён');
    }
    if (App.school?.flags && !App.school.flags.tutorialComplete){
      App.school.flags.tutorialComplete = true;
      saveGame({ silent: true });
    }
  }

  function activeStageHint(){
    if (!tutorialGuide.active) return null;
    const stage = tutorialGuide.stages[tutorialGuide.stageIndex];
    if (!stage) return null;
    return `<strong>Шаг ${tutorialGuide.stageIndex + 1}/${tutorialGuide.stages.length}.</strong> ${stage.text}`;
  }

  function buildContextHints(){
    if (!App.settings?.combatHints) return [];
    if (!App.started || hudRoot?.classList.contains('hidden')) return [];
    const hints = [];
    const stMax = playerData.stMax || ST_MAX;
    if ((playerData.st || 0) < stMax * 0.3){
      hints.push('Мало выносливости — отступите или перекатитесь, чтобы восстановиться.');
    }
    if ((playerData.guardGauge || 0) < Math.max(8, (playerData.guardMax || GUARD_MAX) * 0.2)){
      hints.push('Гард почти разрушен — смените дистанцию и не блокируйте подряд.');
    }
    if ((enemyData.block || 0) > 0.1){
      hints.push('Враг держит блок — тяжёлый или спецприём быстрее ломает защиту.');
    }
    if ((enemyData.stun || 0) > 0.75){
      hints.push('Противник оглушён — проведите комбо для дополнительного урона.');
    }
    const foMax = playerData.maxFocus || FO_MAX;
    if ((playerData.fo || 0) > foMax * 0.8){
      const ids = getPlayerSpecialIds();
      if (ids.length){
        const special = resolveSpecialDefinition(ids[0]);
        const pattern = Array.isArray(special?.pattern) ? special.pattern.join(' → ') : 'L → L → H';
        hints.push(`Фокус готов — выполните ${special?.name || 'спецприём'} (${pattern}).`);
      } else {
        hints.push('Фокус готов — используйте тяжёлую атаку после лёгких для критического удара.');
      }
    }
    return hints;
  }

  function renderHintPanel(options = {}){
    if (!hintListEl) return;
    const force = !!options.force;
    const panelVisible = hintPanel && !hintPanel.classList.contains('hidden');
    const allowHints = tutorialGuide.active || !!App.settings?.combatHints;
    if (!panelVisible || !allowHints){
      if (hintRenderState.lastMarkup !== ''){
        hintRenderState.lastMarkup = '';
        hintListEl.innerHTML = '';
      }
      hintRenderState.nextUpdateAt = 0;
      return;
    }
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!force && nowMs < hintRenderState.nextUpdateAt){
      return;
    }
    hintRenderState.nextUpdateAt = nowMs + (tutorialGuide.active ? 140 : 260);
    const hints = [];
    const stageHint = activeStageHint();
    if (stageHint) hints.push(stageHint);
    hints.push(...buildContextHints());
    if (hintTitleEl){
      hintTitleEl.textContent = tutorialGuide.active ? 'Туториал' : 'Подсказки';
    }
    if (!hints.length){
      if (hintRenderState.lastMarkup !== ''){
        hintRenderState.lastMarkup = '';
        hintListEl.innerHTML = '';
      }
      return;
    }
    const markup = hints.map((text)=>`<li>${text}</li>`).join('');
    if (markup === hintRenderState.lastMarkup) return;
    hintRenderState.lastMarkup = markup;
    hintListEl.innerHTML = markup;
  }

  function syncCombatDataToControllers(){
    if (!USE_NEW_CHARACTER_CONTROLLER || !ARENA?.getController) return;
    const applyState = (actorId, data) => {
      ensureGuardValues(data);
      const controller = ARENA.getController(actorId);
      controller?.resetCombatState?.({
        hp: data.hp,
        maxHp: data.maxHp || HP_MAX,
        stamina: data.st,
        maxStamina: ST_MAX,
        focus: data.fo,
        guardGauge: data.guardGauge ?? data.guardMax ?? GUARD_MAX,
        guardMax: data.guardMax ?? GUARD_MAX,
      });
    };
    applyState('player', playerData);
    applyState('enemy', enemyData);
  }

  function setPracticeMode(enabled){
    if (practiceMode === enabled) return;
    practiceMode = enabled;
    resetArena({ silent: true });
    flashSpecial(enabled ? 'Practice Mode: ON' : 'Practice Mode: OFF');
    updatePracticeUI();
  }

  function clampActorToArena(mesh, data){
    if (USE_NEW_CHARACTER_CONTROLLER) return;
    if (!mesh) return;
    const limit = ARENA_RADIUS - 0.8;
    const r = Math.hypot(mesh.position.x, mesh.position.z);
    if (r > limit){
      tmpClamp.set(mesh.position.x, 0, mesh.position.z).normalize();
      const over = r - limit;
      mesh.position.addScaledVector(tmpClamp, -over);
      if (data?.vel){
        const proj = data.vel.dot(tmpClamp);
        if (proj > 0){
          data.vel.addScaledVector(tmpClamp, -proj);
        }
      }
    }
  }

  function resolvePositionalClash(){
    if (practiceMode || USE_NEW_CHARACTER_CONTROLLER) return;
    tmpSep.copy(player.position).sub(enemy.position);
    tmpSep.y = 0;
    let dist = tmpSep.length();
    if (dist < 0.0001){
      tmpSep.set(1, 0, 0);
      dist = 1;
    }
    if (dist >= MIN_SEPARATION) {
      clampActorToArena(player, playerData);
      clampActorToArena(enemy, enemyData);
      return;
    }
    const normal = tmpSep.multiplyScalar(1 / dist);
    const correction = (MIN_SEPARATION - dist) * 0.5;
    player.position.addScaledVector(normal, correction);
    enemy.position.addScaledVector(normal, -correction);
    if (playerData.vel){
      playerData.vel.addScaledVector(normal, OVERLAP_CORRECTION_SPEED * correction);
    }
    if (enemyData.vel){
      enemyData.vel.addScaledVector(normal, -OVERLAP_CORRECTION_SPEED * correction);
    }
    playerData.yaw = lerpAngle(playerData.yaw, Math.atan2(normal.x, normal.z), 0.25);
    enemyData.yaw = lerpAngle(enemyData.yaw, Math.atan2(-normal.x, -normal.z), 0.25);
    clampActorToArena(player, playerData);
    clampActorToArena(enemy, enemyData);
  }



  function resetArena(options){
    const opts = (options && options.preventDefault) ? {} : (options || {});
    const silent = !!opts.silent;
    resetData(playerData); resetData(enemyData);
    playerData.guardGauge = playerData.guardMax || GUARD_MAX;
    enemyData.guardGauge = enemyData.guardMax || GUARD_MAX;
    playerData.studentProfile = null;
    enemyData.studentProfile = null;
    player.position.set(0, 1.0, 0); playerData.yaw = 0;
    enemy.position.set(6, 1.0, 6); enemyData.yaw = Math.PI * 0.75;
    enemyData.ai = { thinkCD: 0, state: 'idle', strafeDir: 1, strafeTimer: 0 };
    ensureEnemyProfile();
    syncCombatDataToControllers();
    syncArenaTransformsToNewEngine();
    resolvePositionalClash();
    applyPracticeState();
    if (!silent){ flashSpecial('Arena Reset'); }
  }

  // --- Main loop ---
  function animate(){
    const t = now();
    dt = clamp(t - lastTime, 0, 0.05);
    lastTime = t;

    syncArenaStateIntoLegacy(dt);

    // Decrease special log timer
    if (specialLogTimer > 0){
      specialLogTimer -= dt;
      if (specialLogTimer <= 0){ specialLog.style.opacity = '0'; }
    }

    // Update actors when 3D active
    const shouldSimulate = (typeof App !== 'undefined' ? App.renderEnabled : true);
    if (shouldSimulate){
      updatePlayer(dt);
      if (!practiceMode){
        updateEnemy(dt);
      } else {
        enemy.visible = false;
      }
      // Telemetry logging (reduced features)
      try {
        const dist = player.position.distanceTo(enemy.position);
        Telemetry.recordFrame({
          t,
          player_pos: [player.position.x, player.position.z],
          opponent_pos: [enemy.position.x, enemy.position.z],
          player_action: currentActionLabel(playerData),
          is_player_attacking: playerData.attackTimer>0,
          is_opponent_attacking: enemyData.attackTimer>0,
          is_player_in_hitstun: playerData.stun>0,
          is_opponent_in_hitstun: enemyData.stun>0,
          distance: dist
        });
      } catch(e){}
      // Situational tracking during training for learning
      if (trainingSession.active){
        const st = activeStudent();
        const newKey = getSituationKey(enemyData, playerData, enemy, player);
        if (newKey !== lastSituationKey && playerActionSequence.length>0){
          // finalize sequence on situation change
          recordPlayerAction(st, ''); // will flush if >= KB_SEQ_LEN; harmless otherwise
          playerActionSequence = [];
        }
        lastSituationKey = newKey;
      }
      if (typeof App !== 'undefined' && App.mode === 'tournamentVis' && typeof autoDrivePlayerAI==='function'){
        autoDrivePlayerAI(dt);
      }
      consumeBufferedAttack(player, playerData, enemy, enemyData);
      if (!practiceMode){
      consumeBufferedAttack(enemy, enemyData, player, playerData);
      }
      resolvePositionalClash();
      // Camera
      updateCamera(dt);
    }

    // Death handling
      if (typeof App !== 'undefined' && App.mode === 'training' && trainingSession.active){
        if (playerData.hp <= 0){ finishTraining(false); }
        else if (enemyData.hp <= 0){ finishTraining(true); }
      }

    if (tutorialGuide.active){
      updateTutorialGuide(dt);
    }

    // UI
    updateBars();
    updateEnemyBar();
    renderHintPanel();

    updateFX(dt);
    if (ENABLE_LEGACY_SCENE && shouldSimulate){
      if (ENABLE_BLOOM && composer){ composer.render(); } else { renderer.render(scene, camera); }
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  // Resize
  window.addEventListener('resize', ()=>{
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    if (ENABLE_LEGACY_SCENE){
      renderer.setSize(window.innerWidth, window.innerHeight);
      if (composer) composer.setSize(window.innerWidth, window.innerHeight);
    }
  });

  // Initial bars
  updateBars();

  // --- SPA: UI + Screens ---
  const el = (sel) => document.querySelector(sel);
  const screen = el('#screen');
  const studentsListEl = el('#studentsList');
  const styleListEl = el('#styleList');
  const moneyEl = el('#money');
  const fameEl = el('#fame');
  const schoolNameEl = el('#schoolName');
  const studentsCountEl = el('#studentsCount');
  const studentsCapEl = el('#studentsCap');

  function getStudentsCap(){
    var dorms = 0;
    if (App.school && App.school.buildings && typeof App.school.buildings.dorms === 'number') dorms = App.school.buildings.dorms;
    return 3 + dorms * 2;
  }

  function navigate(mode){
    App.mode = mode;
    updateHudContextLabel();
    if (USE_NEW_CHARACTER_CONTROLLER && mode === 'training' && !trainingSession.active){
      App.renderEnabled = false;
    }
    const modeWantsArena = mode === 'training' || mode === 'tournamentVis';
    if (!USE_NEW_CHARACTER_CONTROLLER){
      App.renderEnabled = modeWantsArena;
    }
    const show3D = USE_NEW_CHARACTER_CONTROLLER ? (modeWantsArena && App.renderEnabled) : modeWantsArena;
    const allowInteract = show3D;
    if (USE_NEW_CHARACTER_CONTROLLER && !allowInteract){
      setArenaFullscreen(false);
    }
    setRenderCanvasVisible(show3D, { interactive: allowInteract });
    hudRoot?.classList.toggle('hidden', !allowInteract);
    hintPanel?.classList.toggle('hidden', !allowInteract);
    const enemyHud = document.getElementById('enemy-hud'); if (enemyHud) enemyHud.classList.toggle('hidden', !allowInteract);
    if (mode==='hub') renderHub();
    else if (mode==='student') renderStudent();
    else if (mode==='training') renderTraining();
    else if (mode==='meditation') renderMeditation();
    else if (mode==='tournaments') renderTournaments();
  }

  function refreshAll(){
    if (!App.school) return;
    schoolNameEl.textContent = App.school.name;
    moneyEl.textContent = App.school.money;
    fameEl.textContent = App.school.fame;
    studentsCountEl.textContent = App.school.students.length;
    studentsCapEl.textContent = getStudentsCap();
    renderLeft();
    renderStyleList();
    navigate(App.mode);
  }

  function renderLeft(){
    studentsListEl.innerHTML = '';
    App.school.students.forEach(st =>{
      const d = document.createElement('div'); d.className='card';
      d.innerHTML = `<h4>${st.name}</h4>
        <div class="muted">Ур. ${st.level} • Опыт ${st.xp}/${st.nextXp}</div>
        <div class="row" style="margin-top:6px">
          <span class="tag">Сила ${st.attrs.str}</span>
          <span class="tag">Стойк. ${st.attrs.end}</span>
          <span class="tag">Конц. ${st.attrs.con}</span>
        </div>
        <div class="row" style="margin-top:6px">
          <button class="btn-sm">Открыть</button>
          <button class="btn-sm">Тренировать</button>
        </div>`;
      d.querySelectorAll('button')[0].onclick = ()=>{ App.activeStudentId = st.id; navigate('student'); };
      d.querySelectorAll('button')[1].onclick = ()=>{ App.activeStudentId = st.id; navigate('training'); };
      studentsListEl.appendChild(d);
    });
  }

  function renderStyleList(){
    styleListEl.innerHTML = '';
    (App.school.styleBook||[]).forEach(sp =>{
      const d = document.createElement('div'); d.className='card';
      d.innerHTML = `<h4>${sp.name}</h4>
        <div class="muted">${sp.pattern.join(' → ')} • Фокус ${sp.focusCost} • CD ${(sp.cooldown||4)}с</div>
        <div class="muted">Эффект: ${(sp.effect && sp.effect.type) || '—'}</div>`;
      styleListEl.appendChild(d);
    });
  }

  function renderHub(){
    clearScreen();
    const wrap = document.createElement('div');
    wrap.className='col';
    const b = document.createElement('div'); b.className='sec';
    const hall = App.school.buildings.hall, lib = App.school.buildings.library, dorm = App.school.buildings.dorms;
    b.innerHTML = `<h3>Здания</h3>
      <div class="list">
        <div class="row card"><div style="flex:1"><h4>Тренировочный зал (ур. ${hall})</h4><div class="muted">Бонус опыта в тренировках</div></div><button class="btn-sm" id="upHall">Улучшить (${50*hall} монет)</button></div>
        <div class="row card"><div style="flex:1"><h4>Библиотека (ур. ${lib})</h4><div class="muted">Шанс редких приёмов в медитации</div></div><button class="btn-sm" id="upLib">Улучшить (${70*lib} монет)</button></div>
        <div class="row card"><div style="flex:1"><h4>Жилые помещения (ур. ${dorm})</h4><div class="muted">Макс. учеников: ${getStudentsCap()}</div></div><button class="btn-sm" id="upDorm">Улучшить (${60*dorm} монет)</button></div>
      </div>`;
    wrap.appendChild(b);
    const shop = document.createElement('div'); shop.className='sec';
    shop.innerHTML = `<h3>Снаряжение</h3>`;
    const list = document.createElement('div'); list.className='list';
    (App.school.inventory||[]).forEach(it =>{
      const c = document.createElement('div'); c.className='row card';
      c.innerHTML = `<div style="flex:1"><h4>${it.name}</h4><div class="muted">Тип: ${it.type} • Бонус: ${Object.keys(it.bonus).map(k=>`${k}+${it.bonus[k]}`).join(', ')}</div></div><div class="row"><div class="tag">${it.cost} монет</div><button class="btn-sm">Купить</button></div>`;
      c.querySelector('button').onclick = ()=>{
        if (App.school.money < it.cost){ flashSpecial('Недостаточно денег'); return; }
        App.school.money -= it.cost;
        const copy = JSON.parse(JSON.stringify(it)); copy.id = it.id + '_' + Math.random().toString(36).slice(2,6);
        (App.school.bag ||= []).push(copy);
        refreshAll(); flashSpecial('Куплено: ' + it.name);
      };
      list.appendChild(c);
    });
    shop.appendChild(list);
    wrap.appendChild(shop);
    screen.appendChild(wrap);
    b.querySelector('#upHall').onclick = ()=> upgradeBuilding('hall');
    b.querySelector('#upLib').onclick = ()=> upgradeBuilding('library');
    b.querySelector('#upDorm').onclick = ()=> upgradeBuilding('dorms');
  }

  function upgradeBuilding(key){
    const costs = { hall: 50, library: 70, dorms: 60 };
    const level = App.school.buildings[key];
    const price = costs[key] * level;
    if (App.school.money < price){ flashSpecial('Недостаточно денег'); return; }
    App.school.money -= price;
    App.school.buildings[key] = level + 1;
    refreshAll();
  }

  function activeStudent(){
    if (!App.activeStudentId && App.school.students[0]) App.activeStudentId = App.school.students[0].id;
    return App.school.students.find(s=>s.id===App.activeStudentId) || null;
  }

  function renderStudent(){
    const st = activeStudent();
    if (!st){ clearScreen(); screen.innerHTML = '<div class="sec">Нет ученика</div>'; return; }
    clearScreen();
    const learned = st.learnedSpecials || [];
    const s = document.createElement('div'); s.className='col';
    const top = document.createElement('div'); top.className='sec';
    const psv = st.psv || {};
    const aggr = Math.max(0, Math.min(1, (psv.aggression_ratio||0) / ((psv.aggression_ratio||0) + 1)));
    const defr = Math.max(0, Math.min(1, (psv.block_vs_evade_ratio||0) / ((psv.block_vs_evade_ratio||0) + 1)));
    const evad = 1 - defr;
    const engage = 1 - Math.max(0, Math.min(1, (psv.mean_engagement_distance||0) / (CLOSE_DIST*3)));
    top.innerHTML = `<h3>${st.name} (ур. ${st.level})</h3>
      <div class="row"><span class="tag">Опыт: ${st.xp}/${st.nextXp}</span><span class="tag">Черта: ${st.trait}</span></div>
      <div class="row" style="margin-top:6px">
        <div class="card">Сила: ${st.attrs.str} <span class="muted">(${st.attr_xp.str}/${st.attr_next.str})</span></div>
        <div class="card">Стойкость: ${st.attrs.end} <span class="muted">(${st.attr_xp.end}/${st.attr_next.end})</span></div>
        <div class="card">Концентрация: ${st.attrs.con} <span class="muted">(${st.attr_xp.con}/${st.attr_next.con})</span></div>
      </div>
      <div class="row" style="margin-top:6px">
        <div class="tag">Стиль (PSV): агрессия ${aggr.toFixed(2)}, защита ${defr.toFixed(2)}, уклон ${evad.toFixed(2)}, сближение ${engage.toFixed(2)}</div>
      </div>`;
    s.appendChild(top);
    const eq = document.createElement('div'); eq.className='sec';
    const w = st.equipment.weapon ? st.equipment.weapon.name : '—';
    const a = st.equipment.armor ? st.equipment.armor.name : '—';
    eq.innerHTML = `<h3>Снаряжение</h3>
      <div class="row"><div class="card" style="flex:1">Оружие: ${w}</div><div class="card" style="flex:1">Броня: ${a}</div></div>
      <div class="list" id="bagList"></div>`;
    s.appendChild(eq);
    const sp = document.createElement('div'); sp.className='sec';
    sp.innerHTML = `<h3>Освоенные приёмы</h3>`;
    const spl = document.createElement('div'); spl.className='list';
    (App.school.styleBook||[]).forEach(spec =>{
      const prog = st.mastery[spec.id]||0;
      const learnedNow = learned.includes(spec.id);
      const row = document.createElement('div'); row.className='row card';
      row.innerHTML = `<div style="flex:1"><h4>${spec.name}</h4>
        <div class="muted">Прогресс: ${prog}% ${learnedNow?'• изучен':''}</div></div>
        <button class="btn-sm" ${learnedNow?'disabled':''}>Закрепить</button>`;
      row.querySelector('button').onclick = ()=>{ if (prog>=100 && !learnedNow){ st.learnedSpecials.push(spec.id); refreshAll(); flashSpecial('Приём выучен: '+spec.name); } };
      spl.appendChild(row);
    });
    sp.appendChild(spl);
    s.appendChild(sp);
    const act = document.createElement('div'); act.className='sec';
    act.innerHTML = `<div class="row"><button class="btn-sm" id="trainThis">Тренировать этого ученика</button></div>`;
    s.appendChild(act);
    screen.appendChild(s);

    // handlers (none for manual attribute points – growth is automatic)
    el('#trainThis').onclick = ()=>{ App.activeStudentId = st.id; navigate('training'); };
    // bag list
    const bag = (App.school.bag||[]);
    const bagList = el('#bagList');
    bagList.innerHTML = '';
    if (bag.length===0) bagList.innerHTML = '<div class="muted">Нет предметов</div>';
    bag.forEach((it,idx)=>{
      const row = document.createElement('div'); row.className='row card';
      row.innerHTML = `<div style="flex:1"><h4>${it.name}</h4><div class="muted">${it.type} • ${Object.keys(it.bonus).map(k=>`${k}+${it.bonus[k]}`).join(', ')}</div></div><button class="btn-sm">Экипировать</button>`;
      row.querySelector('button').onclick = ()=>{
        if (it.type==='weapon') st.equipment.weapon = it;
        if (it.type==='armor') st.equipment.armor = it;
        bag.splice(idx,1);
        refreshAll();
      };
      bagList.appendChild(row);
    });
  }

  // Training integration
  const trainingSession = { active: false, usage: { LIGHT:0, HEAVY:0, BLOCK:0, DODGE:0, SPECIAL:0, forwardTime:0, backwardTime:0, strafeTime:0 }, start: 0 };
  let combatStats = null; // tracks attr xp gained this fight for the student
  let combatLog = []; // situational combat events for learning

  // --- Module 1: Telemetry + Player Style Vector (PSV) ---
  const Telemetry = {
    logs: [],
    recordFrame(gs){ this.logs.push(gs); },
    clear(){ this.logs.length = 0; }
  };

  function currentActionLabel(data){
    if (!data) return 'idle';
    if (data.attackTimer > 0) return 'attack';
    if (data.block > 0) return 'block';
    if (data.dodge > 0) return 'dodge';
    const spd = data.vel ? Math.hypot(data.vel.x||0, data.vel.z||0) : 0;
    if (spd > PLAYER_SPEED*0.75) return 'forward_dash';
    if (spd > 0.1) return 'move';
    return 'idle';
  }

  function computePSV(logs){
    const v = { aggression_ratio:0, mean_engagement_distance:0, combo_complexity_score:0, punish_success_rate:0, block_vs_evade_ratio:0 };
    if (!logs || logs.length===0) return v;
    let off=0, def=0, blockTime=0, evadeTime=0; const dists=[];
    for (const l of logs){
      if (!l) continue;
      const act = l.player_action;
      if (act==='attack' || act==='forward_dash') off++;
      if (act==='block' || act==='back_dash' || act==='dodge') def++;
      if (act==='block') blockTime++;
      if (act==='dodge' || act==='back_dash') evadeTime++;
      if (!l.is_player_attacking && !l.is_opponent_attacking && !l.is_player_in_hitstun && !l.is_opponent_in_hitstun){
        dists.push(l.distance||0);
      }
    }
    v.aggression_ratio = def>0 ? off/def : off;
    v.mean_engagement_distance = dists.length ? dists.reduce((a,b)=>a+b,0)/dists.length : 0;
    v.block_vs_evade_ratio = evadeTime>0 ? blockTime/evadeTime : blockTime;
    return v;
  }

  function attachPSVToStudent(st){
    try { const psv = computePSV(Telemetry.logs); st.psv = psv; } catch(e) {}
    Telemetry.clear();
  }

  async function startTrainingSession(){
    const trainee = activeStudent();
    if (!trainee){
      flashSpecial('Нет ученика');
      return false;
    }
    try {
      await withLoadingOverlay('Подготовка к бою...', async () => {
        await ensureArenaReady();
        resetArena({ silent: true });
      });
    } catch (err) {
      console.error('[Training] Failed to prepare arena', err);
      flashSpecial('Не удалось подготовить арену');
      return false;
    }
    App.mode = 'training';
    updateHudContextLabel();
    App.renderEnabled = true;
    setRenderCanvasVisible(true, { interactive: true });
    if (USE_NEW_CHARACTER_CONTROLLER){
    setArenaFullscreen(true);
    }
    hudRoot?.classList.remove('hidden');
    hintPanel?.classList.remove('hidden');
    renderHintPanel({ force: true });
    document.getElementById('enemy-hud')?.classList.remove('hidden');
    el('#uiRoot').classList.add('hidden');
    const endBtn = el('#endTrain');
    if (endBtn) endBtn.disabled = false;
    trainingSession.active = true;
    trainingSession.usage = { LIGHT:0, HEAVY:0, BLOCK:0, DODGE:0, SPECIAL:0, forwardTime:0, backwardTime:0, strafeTime:0 };
    trainingSession.start = now();
    combatStats = { str:0, end:0, con:0 };
    combatLog = [];
    enemyData.regenMul = 0.75;
    if (!App.school.flags?.tutorialComplete){
      startTutorialGuide();
    } else {
      stopTutorialGuide();
    }
    flashSpecial('Спарринг начат');
    return true;
  }

  function renderTraining(){
    const st = activeStudent();
    if (!trainingSession.active){
      App.renderEnabled = false;
      setRenderCanvasVisible(false, { interactive: false });
      if (USE_NEW_CHARACTER_CONTROLLER){
        setArenaFullscreen(false);
      }
      hudRoot?.classList.add('hidden');
      hintPanel?.classList.add('hidden');
      renderHintPanel({ force: true });
      document.getElementById('enemy-hud')?.classList.add('hidden');
    }
    clearScreen();
    const sec = document.createElement('div'); sec.className='sec';
    sec.innerHTML = `<h3>Тренировка (спарринг)</h3>
      <div class="muted">Вы тренируете: ${st?st.name:'—'}. Применяйте приёмы — ученик будет их осваивать.</div>
      <div class="row" style="margin-top:6px"><button class="btn-sm" id="startTrain">Начать спарринг</button><button class="btn-sm" id="endTrain" disabled>Завершить</button></div>`;
    screen.appendChild(sec);

    el('#startTrain').onclick = () => { startTrainingSession(); };
    el('#endTrain').onclick = ()=>{
      if (!trainingSession.active) return;
      finishTraining(playerData.hp >= enemyData.hp);
    };
  }

  function finishTraining(playerWon){
    if (!trainingSession.active) return;
    trainingSession.active = false;
    stopTutorialGuide();
    // style & xp outcome (expanded)
    const stn = activeStudent();
    const usage = trainingSession.usage;
    const totalActions = Object.values(usage).reduce((a,b)=>a+b,0) || 1;

    const dur = Math.max(0, now() - trainingSession.start);
    const baseXp = Math.round(dur * 10 * (1 + 0.15*(App.school.buildings.hall-1)));
    const xpGain = playerWon ? Math.round(baseXp*1.3) : Math.round(baseXp*0.8);
    addStudentXp(stn, xpGain);
    // Apply combatStats to attributes
    if (combatStats){
      stn.attr_xp.str += combatStats.str;
      stn.attr_xp.end += combatStats.end;
      stn.attr_xp.con += combatStats.con;
      checkAttributeLevelUp(stn);
    }
    combatStats = null;
    // Learning from combat log
    processLearning(stn);
    // Compute PSV from telemetry
    attachPSVToStudent(stn);
    // Show training overlay result
    App.renderEnabled = false; // freeze background
    setRenderCanvasVisible(false);
    if (USE_NEW_CHARACTER_CONTROLLER){
      setArenaFullscreen(false);
    }
    hudRoot?.classList.add('hidden');
    hintPanel?.classList.add('hidden');
    const enemyHud = document.getElementById('enemy-hud'); if (enemyHud) enemyHud.classList.add('hidden');
    const titleEl = el('#trainResTitle');
    if (titleEl){
      titleEl.textContent = playerWon ? 'Тренировка успешна!' : 'Нужно больше практики';
      titleEl.className = 'title ' + (playerWon ? 'win' : 'loss');
      el('#trainResStudent').textContent = 'Ученик: ' + stn.name;
      el('#trainResXp').innerHTML = `<span class="tag">Опыт +${xpGain}</span>`;
      el('#trainOverlay').classList.add('show');
      el('#trainAgainBtn').onclick = ()=>{
        el('#trainOverlay').classList.remove('show');
        el('#uiRoot').classList.remove('hidden');
        startTrainingSession();
      };
      el('#trainBackBtn').onclick = ()=>{
        el('#trainOverlay').classList.remove('show');
        el('#uiRoot').classList.remove('hidden');
        App.renderEnabled = false;
        refreshAll();
        navigate('training');
      };
    } else {
      // Fallback to previous behavior if overlay missing
      setRenderCanvasVisible(false);
      if (USE_NEW_CHARACTER_CONTROLLER){
        setArenaFullscreen(false);
      }
      el('#uiRoot').classList.remove('hidden');
      App.renderEnabled = false;
      refreshAll();
      flashSpecial(playerWon ? 'Победа в спарринге (+'+xpGain+' XP)' : 'Поражение в спарринге (+'+xpGain+' XP)');
      navigate('training');
    }
  }

  function addStudentXp(st, xp){
    st.xp += xp;
    while (st.xp >= st.nextXp){
      st.xp -= st.nextXp; st.level++; st.nextXp = Math.round(st.nextXp * 1.25);
      flashSpecial(st.name + ' повысил уровень!');
    }
  }

  function checkAttributeLevelUp(st){
    const scale = 1.5;
    // Strength
    while (st.attr_xp.str >= st.attr_next.str){ st.attr_xp.str -= st.attr_next.str; st.attrs.str++; st.attr_next.str = Math.round(st.attr_next.str * scale); }
    // Endurance
    while (st.attr_xp.end >= st.attr_next.end){ st.attr_xp.end -= st.attr_next.end; st.attrs.end++; st.attr_next.end = Math.round(st.attr_next.end * scale); }
    // Concentration
    while (st.attr_xp.con >= st.attr_next.con){ st.attr_xp.con -= st.attr_next.con; st.attrs.con++; st.attr_next.con = Math.round(st.attr_next.con * scale); }
  }

  // Update knowledge base based on combat log events
  function processLearning(student){
    if (!student || !combatLog || combatLog.length===0) return;
    const kb = ensureStudentKnowledgeBase(student);
    if (!kb) return;
    for (let i = 0; i < combatLog.length; i++){
      const ev = combatLog[i];
      if (ev.actor !== playerData) continue; // only learn from the trainee/player side
      const list = kb[ev.situation];
      if (!list || list.length===0) continue;
      // Attribute outcome to the sequence last used/recorded for this situation
      const seqRef = lastSeqBySituation[ev.situation];
      let target = null;
      if (seqRef){
        const refStr = JSON.stringify(seqRef);
        target = list.find(it => JSON.stringify(it.sequence) === refStr) || null;
      }
      if (!target){ target = list[list.length-1]; }
      if (!target) continue;
      let delta = 0;
      const evTime = ev.time || 0;
      if (ev.reason === 'damage_dealt'){
        delta = 0.6;
        // downgrade if we traded and got punished immediately
        for (let j = i + 1; j < combatLog.length; j++){
          const nextEv = combatLog[j];
          if (nextEv.actor !== playerData) continue;
          if ((nextEv.time || 0) - evTime > 0.45) break;
          if (nextEv.reason === 'damage_taken'){
            delta = 0.15;
            break;
          }
        }
      } else if (ev.reason === 'kill'){
        delta = 10;
      } else if (ev.reason === 'damage_taken'){
        delta = -1.5;
      } else if (ev.reason === 'attack_blocked'){
        delta = -0.6;
      } else if (ev.reason === 'attack_parried'){
        delta = -2.2;
      } else {
        delta = (ev.result === 'success') ? 0.4 : -0.4;
      }
      target.effectiveness = Math.max(-5, Math.min(25, (target.effectiveness||0) + delta));
    }
  }

  function registerMasteryHit(studentId, specialId){
    const st = App.school.students.find(s=>s.id===studentId);
    if (!st) return;
    const inc = 20;
    st.mastery[specialId] = Math.min(100, (st.mastery[specialId]||0) + inc);
    if (st.mastery[specialId] >= 100 && !st.learnedSpecials.includes(specialId)){
      st.learnedSpecials.push(specialId);
      flashSpecial(st.name+': приём освоен!');
    }
  }

  // Hook combo usage to track training style
  const _addComboEntry = addComboEntry;
  addComboEntry = function(data, type){
    _addComboEntry.call(null, data, type);
    if (data===playerData && trainingSession.active){ trainingSession.usage[type] = (trainingSession.usage[type]||0) + 1; }
    // record tactical sequence during training
    if (data===playerData && trainingSession.active){
      const st = activeStudent();
      recordPlayerAction(st, type);
    }
  }

  // Meditation
  let meditSeq = [];
  function renderMeditation(){
    clearScreen();
    const sec = document.createElement('div'); sec.className='sec';
    sec.innerHTML = `<h3>Медитация</h3>
      <div class="muted">Комбинируйте базовые действия (2-4 шага). Клавиши: <span class="k">J</span>=Light, <span class="k">K</span>=Heavy, <span class="k">Shift</span>=Block, <span class="k">Space</span>=Jump</div>
      <div class="row" style="margin-top:8px"><button class="btn-sm" data-a="LIGHT">LIGHT</button><button class="btn-sm" data-a="HEAVY">HEAVY</button><button class="btn-sm" data-a="BLOCK">BLOCK</button><button class="btn-sm" data-a="DODGE">DODGE</button><button class="btn-sm" data-a="JUMP">JUMP</button></div>
      <div style="margin-top:8px">Последовательность: <span id="meditSeq">—</span></div>
      <div class="row" style="margin-top:8px"><button class="btn-sm" id="meditTest">Открыть приём</button><button class="btn-sm" id="meditClear">Очистить</button></div>
      <div id="meditResult" style="margin-top:8px" class="muted"></div>`;
    screen.appendChild(sec);
    sec.querySelectorAll('button[data-a]').forEach(b=> b.onclick = ()=>{ meditSeq.push(b.getAttribute('data-a')); updateMeditSeq(); });
    el('#meditClear').onclick = ()=>{ meditSeq=[]; updateMeditSeq(); };
    el('#meditTest').onclick = ()=>{ tryGenerateSpecial(meditSeq); };
    updateMeditSeq();
  }
  function pushMeditationActionByKey(code){
    const map = { KeyJ:'LIGHT', KeyK:'HEAVY', ShiftLeft:'BLOCK', ShiftRight:'BLOCK', Space:'JUMP' };
    const a = map[code]; if (!a) return; if (App.mode!=='meditation') return; meditSeq.push(a); updateMeditSeq();
  }
  function updateMeditSeq(){ const dst = el('#meditSeq'); if (!dst) return; dst.textContent = meditSeq.length ? meditSeq.join(' → ') : '—'; }
  function tryGenerateSpecial(seq){
    const res = el('#meditResult'); if (!res) return;
    if (seq.length < 2 || seq.length > 4){ res.textContent = 'Нужна длина 2-4.'; return; }
    if (App.school.styleBook.some(s=> JSON.stringify(s.pattern)===JSON.stringify(seq))){ res.textContent = 'Такая последовательность уже известна.'; return; }
    const libLv = App.school.buildings.library;
    const rare = Math.random() < 0.15 + 0.05*(libLv-1);
    // Bias by student PSV
    const st = activeStudent();
    const psv = st && st.psv || { aggression_ratio:0.8, block_vs_evade_ratio:0.6 };
    const aggrBias = Math.max(0, Math.min(1, psv.aggression_ratio / (psv.aggression_ratio + 1))); // 0..1
    const effectType = (Math.random() < (0.55 + 0.35*aggrBias)) ? 'damage_buff' : 'stun_push';
    let effect;
    if (effectType==='damage_buff'){ effect = { type:'damage_buff', bonus: rare?12:8, duration: rare?7:5 }; }
    else { effect = { type:'stun_push', stun: rare?2.0:1.5, push: rare?0.8:0.6 }; }
    // Style-influenced focus costs: aggressive styles tolerate costlier damage buffs; defensive prefer cheaper CC
    let focusCost = effectType==='damage_buff' ? (rare? 28:22) : (rare? 20:15);
    focusCost = Math.round(focusCost * (effectType==='damage_buff' ? (0.95 + 0.2*aggrBias) : (1.05 - 0.2*aggrBias)));
    const name = genSpecialName(effectType);
    const sp = { id: 'SP_'+Math.random().toString(36).slice(2,8), name, pattern: [...seq], focusCost, cooldown: 4.0, effect };
    App.school.styleBook.push(sp);
    meditSeq=[]; updateMeditSeq(); renderStyleList(); res.textContent = 'Открыт приём: '+name; flashSpecial('Новый приём: '+name);
  }
  function genSpecialName(type){
    const adj = ['Огненное','Теневое','Грозовое','Ледяное','Каменное','Алое','Золотое','Туманное'];
    const noun = type==='damage_buff' ? ['Лезвие','Клеймо','Пламя','Рев'] : ['Толчок','Удар','Искра','Взрыв'];
    return adj[Math.floor(Math.random()*adj.length)] + ' ' + noun[Math.floor(Math.random()*noun.length)];
  }

  // Tournaments
  let tourVis = null;
  function renderTournaments(){
    clearScreen();
    const sec = document.createElement('div'); sec.className='sec';
    const st = activeStudent();
    const tiers = [
      { id:'village', name:'Сельский турнир', reqFame:0, reward: { win: 50, fame: 2 } },
      { id:'regional', name:'Областной турнир', reqFame:10, reward: { win: 120, fame: 5 } },
      { id:'royal', name:'Королевский турнир', reqFame:30, reward: { win: 300, fame: 10 } },
    ];
    const tierBtns = tiers.map(t=> `<button class="btn-sm" data-tier="${t.id}" ${App.school.fame>=t.reqFame?'':'disabled'}>${t.name}</button>`).join(' ');
    sec.innerHTML = `<h3>Турниры</h3>
      <div class="muted">Выбран ученик: ${st?st.name:'—'}</div>
      <div class="row" style="margin-top:6px">${tierBtns}</div>
      <div class="row" style="margin-top:6px"><label><input type="checkbox" id="viz"/> Визуализировать бой</label></div>
      <div id="tourLog" class="muted" style="margin-top:8px"></div>`;
    screen.appendChild(sec);
    sec.querySelectorAll('button[data-tier]').forEach(b=> b.onclick = ()=> startTournament(st, b.getAttribute('data-tier'), el('#viz').checked));
  }

  let lastTour = null;
  function tierName(id){ return ({village:'Сельский турнир', regional:'Областной турнир', royal:'Королевский турнир'})[id] || id; }

  async function startTournament(st, tierId, visualize){
    if (!st){ flashSpecial('Выберите ученика'); return; }
    const tier = { village:{pow:12,reward:{win:50,fame:2}}, regional:{pow:24,reward:{win:120,fame:5}}, royal:{pow:40,reward:{win:300,fame:10}} }[tierId];
    if (!tier){ return; }
    lastTour = { student: st, tierId };
    if (visualize){
      try {
        await withLoadingOverlay('Подготовка к бою...', async () => {
          await ensureArenaReady();
          resetArena({ silent: true });
        });
      } catch (err) {
        console.error('[Tournament] Failed to prepare arena', err);
        flashSpecial('Не удалось подготовить арену');
        return;
      }
      App.mode = 'tournamentVis'; App.renderEnabled = true;
      updateHudContextLabel();
      setRenderCanvasVisible(true, { interactive: true });
      if (USE_NEW_CHARACTER_CONTROLLER){
        setArenaFullscreen(true);
      }
      playerData.aiControlled = true;
      ARENA?.setControlMode?.('player', 'proxy', { studentProfile: st, targetId: 'enemy' });
      el('#uiRoot').classList.add('hidden');
      hudRoot?.classList.remove('hidden');
      hintPanel?.classList.remove('hidden');
      { const eh = document.getElementById('enemy-hud'); if (eh) eh.classList.remove('hidden'); }
      combatLog = [];
      enemyData.maxHp = HP_MAX + tier.pow; enemyData.hp = enemyData.maxHp; enemyData.st = ST_MAX; enemyData.fo = 0;
      enemyData.guardMax = GUARD_MAX;
      enemyData.guardGauge = enemyData.guardMax;
      delete enemyData.regenMul;
      playerData.maxHp = HP_MAX; playerData.hp = playerData.maxHp; playerData.st = ST_MAX; playerData.fo = 0;
      playerData.guardMax = GUARD_MAX;
      playerData.guardGauge = playerData.guardMax;
      playerData.studentProfile = st;
      combatStats = { str:0, end:0, con:0 };
      tourVis = { done:false, student: st, tier: tierId, start: now() };
      syncCombatDataToControllers();
      flashSpecial('Бой начался: '+st.name);
    } else {
      playerData.aiControlled = false;
      const win = quickSimWin(st, tier.pow);
      endTournament(win, tierId, false);
    }
  }

  function quickSimWin(st, pow){
    const atk = st.attrs.str + ((st.equipment && st.equipment.weapon && st.equipment.weapon.bonus && st.equipment.weapon.bonus.str) || 0);
    const def = st.attrs.end + ((st.equipment && st.equipment.armor && st.equipment.armor.bonus && st.equipment.armor.bonus.end) || 0);
    const foc = st.attrs.con;
    const learned = (st.learnedSpecials||[]).length;
    const score = atk*1.5 + def*1.2 + foc*0.6 + learned*2 + st.level*1.8;
    const opp = pow + 10 + Math.random()*10;
    const chance = clamp(0.2 + (score - opp)/50, 0.1, 0.9);
    return Math.random() < chance;
  }

  function autoDrivePlayerAI(dt){
    if (!tourVis) return;
    if (tourVis.student){
      playerData.studentProfile = tourVis.student;
    }

    if (playerData.hp<=0 || enemyData.hp<=0){
      const win = enemyData.hp<=0 && playerData.hp>0;
      endTournament(win, tourVis.tier, true);
    }
  }

  function endTournament(win, tierId, visualize){
    const rewards = { village:{win:50,fame:2}, regional:{win:120,fame:5}, royal:{win:300,fame:10} }[tierId];
    const log = el('#tourLog'); if (log) log.textContent = win ? 'Победа!' : 'Поражение';
    if (win){ App.school.money += rewards.win; App.school.fame += rewards.fame; } else { App.school.fame = Math.max(0, App.school.fame - 1); }
    refreshAll();

    // Show overlay
    const overlay = el('#tourOverlay');
    const title = el('#tourResTitle');
    const tierEl = el('#tourResTier');
    const rew = el('#tourResRewards');
    title.textContent = win ? 'Победа!' : 'Поражение';
    title.className = 'title ' + (win ? 'win' : 'loss');
    const heroName = lastTour?.student?.name ?? 'Ваш боец';
    const winnerName = win ? heroName : 'Соперник';
    tierEl.textContent = 'Турнир: ' + tierName(tierId) + ' • Победитель: ' + winnerName;
    rew.innerHTML = win ? `<span class="tag">Монеты +${rewards.win}</span><span class="tag">Слава +${rewards.fame}</span>` : `<span class="tag">Слава -1</span>`;
    overlay.classList.add('show');

    if (visualize){
      App.renderEnabled = false; // freeze background
      setRenderCanvasVisible(false);
      if (USE_NEW_CHARACTER_CONTROLLER){
        setArenaFullscreen(false);
      }
      playerData.aiControlled = false;
      ARENA?.setControlMode?.('player', 'keyboard');
      el('#uiRoot').classList.remove('hidden');
      // hide HUD atop canvas but keep canvas visible as backdrop
      hudRoot?.classList.add('hidden');
      hintPanel?.classList.add('hidden');
      const enemyHud = document.getElementById('enemy-hud'); if (enemyHud) enemyHud.classList.add('hidden');
      tourVis = null;
      // Attribute XP from combat
      if (combatStats && lastTour && lastTour.student){
        const st = lastTour.student;
        processLearning(st);
        st.attr_xp.str += combatStats.str;
        st.attr_xp.end += combatStats.end;
        st.attr_xp.con += combatStats.con;
        checkAttributeLevelUp(st);
        attachPSVToStudent(st);
      }
      if (enemyData?.studentProfile){
        processLearning(enemyData.studentProfile);
      }
      combatStats = null;
    }
    el('#tourRetry').onclick = ()=>{
      overlay.classList.remove('show');
      const enemyHud = document.getElementById('enemy-hud'); if (enemyHud) enemyHud.classList.remove('hidden');
      App.renderEnabled = true;
      if (lastTour){ startTournament(lastTour.student, lastTour.tierId, !!visualize); }
    };
    el('#tourBack').onclick = ()=>{
      overlay.classList.remove('show');
      if (visualize){
        setRenderCanvasVisible(false);
        if (USE_NEW_CHARACTER_CONTROLLER){
          setArenaFullscreen(false);
        }
      }
      el('#uiRoot').classList.remove('hidden');
      App.renderEnabled = true;
      navigate('tournaments');
    };
  }

  // Top bar + left actions
  el('#saveBtn').onclick = saveGame;
  el('#loadBtn').onclick = ()=>{
    const ok = loadGame({ fallbackToDefault: false });
    if (ok){
      refreshAll();
      flashSpecial('Загружено');
    } else {
      flashSpecial('Сохранение не найдено');
    }
  };
  el('#resetSaveBtn').onclick = ()=>{
    saveBackend.remove();
    runtimeState.hasExistingSave = false;
    loadGame();
    refreshAll();
    saveGame({ silent: true });
    flashSpecial('Сброс сохранения');
  };
  el('#settingsBtnTop')?.addEventListener('click', showSettings);
  el('#hireBtn').onclick = ()=>{
    const cap = getStudentsCap();
    if (App.school.students.length >= cap){ flashSpecial('Нет мест (улучшите Жилые помещения)'); return; }
    const cost = 50 + 25 * Math.min(4, Math.floor(App.school.fame/5));
    if (App.school.money < cost){ flashSpecial('Недостаточно денег'); return; }
    App.school.money -= cost;
    const st = makeStudent('Ученик ' + (App.school.students.length+1));
    const bonus = Math.min(4, Math.floor(App.school.fame/5));
    st.attrs.str += Math.floor(Math.random()*bonus);
    st.attrs.end += Math.floor(Math.random()*bonus);
    st.attrs.con += Math.floor(Math.random()*bonus);
    App.school.students.push(st);
    refreshAll(); flashSpecial('Найм: ' + st.name);
  };
  document.querySelectorAll('#navBar .navbtn').forEach(btn=>{
    btn.onclick = ()=>{
      if (!App.started) return;
      navigate(btn.dataset.nav);
    };
  });

  bindMenuButtons();
  bindSettingsUI();
  syncSettingsUI();

  const initialLoaded = loadGame({ fallbackToDefault: false });
  if (!initialLoaded) {
    App.school = null;
  }
  showMainMenu();
  updateHudContextLabel();

  function syncCombatFromController(actorId){
    if (!USE_NEW_CHARACTER_CONTROLLER || !ARENA?.getController) return;
    const controller = ARENA.getController(actorId);
    const snapshot = controller?.getCombatState?.();
    if (!snapshot) return;
    const data = actorId === 'player' ? playerData : enemyData;
    if (!data) return;
    data.hp = snapshot.hp ?? data.hp;
    data.maxHp = snapshot.maxHp ?? data.maxHp ?? HP_MAX;
    data.st = snapshot.stamina ?? data.st;
    data.stMax = snapshot.maxStamina ?? data.stMax ?? ST_MAX;
    data.fo = snapshot.focus ?? data.fo;
    data.guardGauge = snapshot.guardGauge ?? data.guardGauge;
    data.guardMax = snapshot.guardMax ?? data.guardMax ?? GUARD_MAX;
    data.guardRegenDelay = snapshot.guardRegenDelay ?? data.guardRegenDelay ?? 0;
    data.block = snapshot.blockTimer ?? 0;
    data.dodge = snapshot.dodgeTimer ?? 0;
    data.invuln = snapshot.invulnTimer ?? 0;
    data.hitStop = snapshot.hitStopTimer ?? 0;
    data.stun = snapshot.stunTimer ?? 0;
    const attackSnap = controller.getAttackSnapshot?.();
    if (attackSnap?.active){
      data.attackTimer = attackSnap.totalRemaining ?? 0;
      data.attackKind = attackSnap.kind || null;
      if (attackSnap.phase === 'active'){
        data.attackActive = Math.max(0, attackSnap.phaseTimer ?? 0);
      } else if (attackSnap.phase === 'startup'){
        data.attackActive = -(attackSnap.phaseTimer ?? 0);
      } else {
        data.attackActive = 0;
      }
      data.attackAnimName = attackSnap.kind || data.attackAnimName || null;
    } else {
      data.attackTimer = 0;
      data.attackKind = null;
      data.attackActive = 0;
      data.attackAnimName = null;
    }
    ensureGuardValues(data);
    const status = controller.getStatusSnapshot?.() || {};
    data.activeBuffs = status.buffs || [];
    data.specialCooldowns = status.specials || [];
    data.specialsCD = data.specialsCD || {};
    for (const key of Object.keys(data.specialsCD)){
      if (!data.specialCooldowns.find((item)=> item.id === key)){
        data.specialsCD[key] = 0;
      }
    }
    data.specialCooldowns.forEach((item)=>{
      data.specialsCD[item.id] = item.remaining;
    });
  }

  function syncArenaStateIntoLegacy(delta){
    if (!USE_NEW_CHARACTER_CONTROLLER) return;
    let playerState = latestArenaState.player;
    let enemyState = latestArenaState.enemy;
    if (playerState){
      if (!prevArenaPosition.player) prevArenaPosition.player = playerState.position.clone();
      tmpVec2.copy(playerState.position);
      tmpVec2.y += ARENA_Y_OFFSET;
      player.position.lerp(tmpVec2, 0.6);
      if (playerData.vel){
        if (playerState.velocity){
          playerData.vel.copy(playerState.velocity);
        } else {
          const vel = playerState.position.clone().sub(prevArenaPosition.player).multiplyScalar(1 / Math.max(delta || 0.016, 0.0001));
          playerData.vel.copy(vel);
        }
        prevArenaPosition.player.copy(playerState.position);
      }
      if (typeof playerState.yaw === 'number'){
        playerData.yaw = playerState.yaw;
        player.rotation.y = playerState.yaw;
      }
      if (playerData){
        const py = playerState.position?.y ?? 0;
        playerData.isGrounded = py <= 0.1;
      }
    }
    if (enemyState){
      if (!prevArenaPosition.enemy) prevArenaPosition.enemy = enemyState.position.clone();
      tmpVec3.copy(enemyState.position);
      tmpVec3.y += ARENA_Y_OFFSET;
      enemy.position.lerp(tmpVec3, 0.6);
      if (enemyData.vel){
        if (enemyState.velocity){
          enemyData.vel.copy(enemyState.velocity);
        } else {
          const velE = enemyState.position.clone().sub(prevArenaPosition.enemy).multiplyScalar(1 / Math.max(delta || 0.016, 0.0001));
          enemyData.vel.copy(velE);
        }
        prevArenaPosition.enemy.copy(enemyState.position);
      }
      if (typeof enemyState.yaw === 'number'){
        enemyData.yaw = enemyState.yaw;
        enemy.rotation.y = enemyState.yaw;
      }
      if (enemyData){
        const ey = enemyState.position?.y ?? 0;
        enemyData.isGrounded = ey <= 0.1;
      }
    }
    syncCombatFromController('player');
    syncCombatFromController('enemy');
  }

  const arenaMoveBuffer = new THREE.Vector3();
  function pushArenaMoveIntent(actorId, direction){
    if (!USE_NEW_CHARACTER_CONTROLLER) return;
    if (!ARENA || typeof ARENA.setMoveIntent !== 'function') return;
    if (direction && direction.lengthSq() > 0.0001){
      arenaMoveBuffer.copy(direction);
      arenaMoveBuffer.y = 0;
      const lenSq = arenaMoveBuffer.lengthSq();
      if (lenSq > 0){
        arenaMoveBuffer.multiplyScalar(1 / Math.sqrt(lenSq));
      }
    } else {
      arenaMoveBuffer.set(0, 0, 0);
    }
    ARENA.setMoveIntent(actorId, arenaMoveBuffer);
  }

  function syncArenaTransformsToNewEngine(){
    if (!USE_NEW_CHARACTER_CONTROLLER || !ARENA || typeof ARENA.setActorTransform !== 'function') return;
    const playerPos = player.position.clone();
    const enemyPos = enemy.position.clone();
    playerPos.y = Math.max(0, playerPos.y - ARENA_Y_OFFSET);
    enemyPos.y = Math.max(0, enemyPos.y - ARENA_Y_OFFSET);
    ARENA.setActorTransform('player', playerPos, playerData.yaw);
    ARENA.setActorTransform('enemy', enemyPos, enemyData.yaw);
  }

  async function bootNewArena(){
    
    const host = ensureArenaHost();
    if (!host) return;
    host.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.background = '#05070d';
    host.appendChild(canvas);

    ensureEnemyProfile();

    const actorProfiles = {
      player: {
        targetId: 'enemy',
        studentProfile: playerData.studentProfile || null,
      },
      enemy: {
        targetId: 'player',
        studentProfile: enemyData.studentProfile || null,
      },
    };

    ARENA = new ArenaAdapter(host, {
      engineOptions: {
        lowFX: !!App.settings?.lowFX,
        characterOptions: {
          boundsRadius: ARENA_RADIUS - 1,
          controlOverrides: {
            player: playerData.aiControlled ? 'proxy' : 'keyboard',
            enemy: 'proxy',
          },
          actorProfiles,
        },
      },
    });
    window.arenaAdapter = ARENA;
    try {
      await ARENA.init();
      ARENA.setLowFX?.(App.settings?.lowFX);
      ARENA.onStateChange((state) => {
        latestArenaState = state;
      });
      if (!arenaEventsBound && typeof ARENA.onEvent === 'function') {
        arenaEventsBound = true;
        ARENA.onEvent('hit', (e = {}) => {
          const attackerId = e.attackerId;
          const targetId = e.target;
          if (!targetId) return;
          const targetController = ARENA.getController?.(targetId);
          if (!targetController?.receiveHit) return;
          const attackerData = attackerId === 'player' ? playerData : enemyData;
          const targetData = targetId === 'player' ? playerData : enemyData;
          const attackerMesh = attackerId === 'player' ? player : enemy;
          const targetMesh = targetId === 'player' ? player : enemy;
          const comboScale = attackerData
            ? 1 + Math.min(0.45, (attackerData.comboCounter || 0) * 0.035)
            : 1;
          const damageConfig = { ...(e.damageConfig || {}), comboScale };
          const moveDef = e.moveDef || damageConfig.moveDef;
          if (moveDef) damageConfig.moveDef = moveDef;
          const situationKey = attackerData && targetData
            ? getSituationKey(attackerData, targetData, attackerMesh, targetMesh)
            : null;
          const eventTime = now();
          const result = targetController.receiveHit(damageConfig);
          const attackerController = ARENA.getController?.(attackerId);
          if (attackerController?.applyOffensiveResult && moveDef){
            attackerController.applyOffensiveResult(result, moveDef);
          }
          if (result?.hit && attackerData){
            registerComboHit(attackerData);
            if (typeof onHitDamage === 'function'){
              onHitDamage(targetId === 'enemy' ? 'enemy' : 'player');
            }
            if (combatStats && attackerId === 'player'){
              combatStats.str += moveDef?.id === 'LIGHT' ? 6 : 14;
            }
          } else if (result?.blocked && targetId === 'player' && combatStats){
            if (result.parry){
              combatStats.end += 10;
            } else {
              const guardDmg = damageConfig.guardDamage ?? 0;
              combatStats.end += Math.max(4, guardDmg * 0.35);
            }
          } else if (result?.hit && targetId === 'player' && combatStats){
            combatStats.end += result.damage ?? 0;
          }
          if (tutorialGuide.active && result?.blocked && targetId === 'player'){
            tutorialGuide.metrics.blocks = (tutorialGuide.metrics.blocks || 0) + 1;
          }
          syncCombatFromController(targetId);
          if (attackerId) syncCombatFromController(attackerId);
          if (Array.isArray(combatLog) && situationKey){
            if (result?.blocked){
              combatLog.push({
                actor: attackerData,
                result: 'fail',
                reason: result.parry ? 'attack_parried' : 'attack_blocked',
                situation: situationKey,
                time: eventTime,
              });
            } else if (result?.hit){
              combatLog.push({
                actor: attackerData,
                result: 'success',
                reason: 'damage_dealt',
                situation: situationKey,
                time: eventTime,
              });
              if (targetData?.hp <= 0){
                combatLog.push({
                  actor: attackerData,
                  result: 'success',
                  reason: 'kill',
                  situation: situationKey,
                  time: eventTime,
                });
              }
              combatLog.push({
                actor: targetData,
                result: 'fail',
                reason: 'damage_taken',
                situation: situationKey,
                time: eventTime,
              });
            }
          }
          if (App.settings?.cameraShake && typeof ARENA?.shakeCamera === 'function'){
            if (result?.hit){
              const strength = targetId === 'player' ? 0.28 : 0.18;
              const duration = clamp(0.18 + (result.damage || 0) * 0.004, 0.18, 0.38);
              ARENA.shakeCamera(strength, duration);
            } else if (result?.blocked && targetId === 'player'){
              ARENA.shakeCamera(0.12, 0.18);
            }
          }
          updateBars();
          updateEnemyBar();
        });
        ARENA.onEvent('blockImpact', (payload = {}) => {
          if (!payload?.parry) return;
          pushCombatEvent('parry', `${describeActor(payload.actorId)}: Parry!`);
        });
        ARENA.onEvent('guardBreak', (payload = {}) => {
          pushCombatEvent('guard', `${describeActor(payload.actorId)}: Guard Break!`);
          if (App.settings?.cameraShake && typeof ARENA?.shakeCamera === 'function'){
            ARENA.shakeCamera(0.32, 0.32);
          }
        });
        ARENA.onEvent('stunStart', (payload = {}) => {
          if ((payload.duration ?? 0) < 0.4) return;
          pushCombatEvent('stun', `${describeActor(payload.actorId)}: Stun!`);
        });
      }
      const modeWantsArena = App.mode === 'training' || App.mode === 'tournamentVis';
      const show3D = modeWantsArena && App.renderEnabled;
      setRenderCanvasVisible(show3D, { interactive: show3D });
      ARENA.setCameraFollow?.('player', {
        offset: new THREE.Vector3(0, 2.8, -7.2),
        lookOffset: 1.65,
        positionTightness: 3.5,
        targetTightness: 6.5,
      });
      syncArenaTransformsToNewEngine();
    } catch (err){
      console.error('[Arena] Failed to boot ArenaAdapter', err);
    }
  }

  async function ensureArenaReady(){
    if (ARENA) return;
    if (!arenaBootPromise){
      arenaBootPromise = bootNewArena().catch((err)=>{
        console.error('[Arena] boot failed', err);
        throw err;
      }).finally(()=>{
        arenaBootPromise = null;
      });
    }
    await arenaBootPromise;
  }
  if (USE_NEW_CHARACTER_CONTROLLER) {
    App.renderEnabled = false;
  }


  

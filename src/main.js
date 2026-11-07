import { RoseScene } from './rose-scene.js';
import { HandTracker, CameraError } from './hand-tracker.js';

const $ = (selector) => document.querySelector(selector);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lerp = (a, b, t) => a + (b - a) * t;

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

const ui = {
  body: document.body,
  intro: $('#intro'),
  postCamera: $('#start-camera'),
  postCameraNote: $('#start-camera-note'),
  postTouch: $('#start-touch'),
  topbar: $('#topbar'),
  hud: $('#hud'),
  livePill: $('#live-pill'),
  trackState: $('#track-state'),
  gestureLabel: $('#gesture-label'),
  signalId: $('#signal-id'),
  opennessValue: $('#openness-value'),
  bloomMeter: $('.bloom-meter'),
  bloomFill: $('#bloom-fill'),
  hint: $('.hint'),
  btnEye: $('#btn-eye'),
  btnHelp: $('#btn-help'),
  guide: $('#guide'),
  guideContinue: $('#guide-continue'),
  guideTouch: $('#guide-touch'),
  closeGuide: $('#close-guide'),
  toast: $('#toast'),
  webglError: $('#webgl-error'),
  retryWebgl: $('#retry-webgl'),
  video: $('#camera'),
  overlay: $('#hand-overlay'),
  canvas: $('#webgl'),
};

const params = new URLSearchParams(window.location.search);
const debugDemo = params.has('demo');
const debugBloom = params.has('bloom') ? clamp(Number(params.get('bloom')) || 0, 0, 1) : null;
const autoTouch = params.has('touch') || debugDemo;
const prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let scene;
let tracker;
let mode = 'intro';
let bloom = 0.16;
let bloomTarget = 0.16;
let bloomVelocity = 0;
let energy = 0;
let elapsed = 0;
let lastFrame = performance.now();
const pointer = { x: 0, y: 0, active: false };
let touchHeld = false;
let touchStartedAt = 0;
let lastInteractionAt = 0;
let toastTimer = 0;
let cameraHidden = false;
let cameraStarting = false;
let hasStartedCamera = false;
let lastUiGesture = '';
let lastUiState = '';
let sceneReady = false;
let introDismissed = false;
let guidePreviouslyFocused = null;

/* --------------------------------------------------------------------------
   Scene setup
   -------------------------------------------------------------------------- */

try {
  scene = new RoseScene(ui.canvas);
  scene.setComposition('intro');
  const onResize = () => scene?.resize();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 220));
  ui.canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    showToast('图形上下文暂时丢失，正在尝试恢复…', 4000);
  });
  ui.canvas.addEventListener('webglcontextrestored', () => {
    scene.resize();
    showToast('视觉已恢复。');
  });
} catch (error) {
  console.error('[ROSA] WebGL initialization failed.', error);
  ui.webglError.hidden = false;
  ui.intro.style.display = 'none';
}

ui.retryWebgl?.addEventListener('click', () => window.location.reload());

/* --------------------------------------------------------------------------
   Hand tracker
   -------------------------------------------------------------------------- */

function ensureTracker() {
  if (tracker) return tracker;
  tracker = new HandTracker({
    video: ui.video,
    overlay: ui.overlay,
    onProgress: ({ stage, message }) => {
      if (stage === 'camera') {
        setStartButtonLoading('正在连接镜头', '请求摄像头权限…');
      } else if (stage === 'model') {
        setStartButtonLoading('正在唤醒玫瑰', '加载手势识别模型 · 本地运行');
      } else if (stage === 'ready') {
        ui.postCameraNote.textContent = '手势模型已就绪';
      }
      if (message) showToast(message, 2200);
    },
  });
  return tracker;
}

/* --------------------------------------------------------------------------
   Start / transitions
   -------------------------------------------------------------------------- */

async function startCamera() {
  if (cameraStarting) return;
  cameraStarting = true;
  hideGuide();
  setStartButtonLoading('正在连接镜头', '请求摄像头权限…');

  try {
    const handTracker = ensureTracker();
    await handTracker.start();
    hasStartedCamera = true;
    mode = 'camera';
    dismissIntro();
    ui.body.classList.add('camera-on', 'is-live');
    ui.body.classList.remove('camera-hidden');
    cameraHidden = false;
    ui.livePill.classList.remove('is-error');
    ui.btnEye.hidden = false;
    ui.btnEye.disabled = false;
    ui.btnEye.innerHTML = '<svg><use href="#i-eye"></use></svg>';
    ui.btnEye.setAttribute('aria-label', '隐藏摄像头背景');
    ui.trackState.textContent = '等待手势';
    scene?.setComposition('live');
    setStartButtonIdle();
    updateHint();
    showToast('手掌入镜 · 握拳收拢，张开放绽', 3800);
  } catch (error) {
    console.error('[ROSA] Camera start failed.', error);
    setStartButtonError(error);
    tracker?.stop();
    ui.body.classList.remove('camera-on', 'camera-hidden');
    ui.livePill.classList.add('is-error');
    ui.livePill.classList.remove('is-tracking');
    ui.trackState.textContent = '镜头未连接';
    const message = error instanceof CameraError
      ? error.message
      : '摄像头启动失败，请重试或进入触控模式。';
    showToast(message, 6000);
  } finally {
    cameraStarting = false;
  }
}

function setStartButtonLoading(title, note) {
  if (!ui.postCamera) return;
  ui.postCamera.disabled = true;
  ui.postCamera.classList.add('is-loading');
  const strong = ui.postCamera.querySelector('.button__text strong');
  if (strong) strong.textContent = title;
  ui.postCameraNote.textContent = note;
  ui.postCameraNote.classList.remove('is-error');
}

function setStartButtonError(error) {
  if (!ui.postCamera) return;
  ui.postCamera.disabled = false;
  ui.postCamera.classList.remove('is-loading');
  const strong = ui.postCamera.querySelector('.button__text strong');
  if (strong) strong.textContent = '重新开启摄像头';

  const code = error instanceof CameraError ? error.code : 'UNKNOWN';
  const notes = {
    INSECURE: '需要 HTTPS 或 localhost · 下方可先触控体验',
    PERMISSION: '摄像头权限被拒绝 · 可在浏览器设置中恢复',
    NO_CAMERA: '未检测到摄像头 · 可进入触控体验',
    BUSY: '摄像头被占用 · 请在关闭其他应用后重试',
    MODEL: '手势模型加载失败 · 可刷新或触控体验',
    NOT_SUPPORTED: '当前浏览器不支持摄像头',
    UNKNOWN: '连接失败 · 请重试或触控体验',
  };
  ui.postCameraNote.textContent = notes[code] || notes.UNKNOWN;
  ui.postCameraNote.classList.add('is-error');
}

function setStartButtonIdle() {
  if (!ui.postCamera) return;
  ui.postCamera.disabled = false;
  ui.postCamera.classList.remove('is-loading');
  const strong = ui.postCamera.querySelector('.button__text strong');
  if (strong) strong.textContent = '开启摄像头';
  ui.postCameraNote.textContent = '允许访问，让手成为画笔';
  ui.postCameraNote.classList.remove('is-error');
}

function dismissIntro() {
  if (introDismissed) return;
  introDismissed = true;
  ui.intro.classList.add('is-leaving');
  ui.intro.setAttribute('aria-hidden', 'true');
  ui.topbar.setAttribute('aria-hidden', 'false');
  ui.hud.setAttribute('aria-hidden', 'false');
  setTimeout(() => {
    ui.intro.style.visibility = 'hidden';
  }, 1200);
}

function enterTouchMode({ fromGuide = false } = {}) {
  if (mode === 'touch') {
    if (fromGuide) hideGuide();
    return;
  }
  if (tracker) {
    tracker.stop();
  }
  mode = 'touch';
  hasStartedCamera = false;
  cameraStarting = false;
  ui.body.classList.remove('camera-on', 'camera-hidden');
  ui.body.classList.add('is-live');
  cameraHidden = false;
  ui.overlay.style.opacity = '0';
  ui.btnEye.disabled = true;
  ui.btnEye.hidden = true;
  ui.trackState.textContent = '触控模式';
  ui.livePill.classList.remove('is-tracking', 'is-error');
  ui.btnEye.setAttribute('aria-label', '摄像头背景不可用');
  dismissIntro();
  scene?.setComposition('live');
  setStartButtonIdle();
  updateHint();
  hideGuide();
  showToast('按住画面收拢花苞，松手让它绽放', 3600);
}

/* --------------------------------------------------------------------------
   Input
   -------------------------------------------------------------------------- */

function pointerToNormalized(event) {
  return {
    x: (event.clientX / window.innerWidth) * 2 - 1,
    y: (event.clientY / window.innerHeight) * 2 - 1,
  };
}

function onPointerMove(event) {
  if (mode === 'intro') return;
  const next = pointerToNormalized(event);
  pointer.x = next.x;
  pointer.y = next.y;
  pointer.active = true;
  lastInteractionAt = elapsed;
}

function onPointerDown(event) {
  if (mode === 'intro' || event.target.closest('button, a, .modal, .topbar')) return;
  onPointerMove(event);
  pointer.active = true;
  lastInteractionAt = elapsed;
  if (mode === 'touch') {
    touchHeld = true;
    touchStartedAt = elapsed;
    ui.body.classList.add('is-holding');
  }
}

function onPointerUp() {
  if (mode !== 'touch') return;
  touchHeld = false;
  lastInteractionAt = elapsed;
  ui.body.classList.remove('is-holding');
}

function onKeyDown(event) {
  if (event.key === 'Escape') {
    hideGuide();
    return;
  }
  if (mode !== 'touch' || event.repeat) return;
  if (event.code === 'Space' || event.code === 'Enter') {
    if (event.target.closest('button, a, input, textarea')) return;
    event.preventDefault();
    touchHeld = true;
    lastInteractionAt = elapsed;
    ui.body.classList.add('is-holding');
  }
}

function onKeyUp(event) {
  if (mode !== 'touch') return;
  if (event.code === 'Space' || event.code === 'Enter') {
    touchHeld = false;
    lastInteractionAt = elapsed;
    ui.body.classList.remove('is-holding');
  }
}

window.addEventListener('pointermove', onPointerMove, { passive: true });
window.addEventListener('pointerdown', onPointerDown, { passive: true });
window.addEventListener('pointerup', onPointerUp, { passive: true });
window.addEventListener('pointercancel', onPointerUp, { passive: true });
window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);
window.addEventListener('blur', () => {
  touchHeld = false;
  ui.body.classList.remove('is-holding');
});

/* --------------------------------------------------------------------------
   Guide
   -------------------------------------------------------------------------- */

function openGuide() {
  guidePreviouslyFocused = document.activeElement;
  ui.guide.hidden = false;
  requestAnimationFrame(() => ui.closeGuide?.focus());
}

function hideGuide() {
  if (!ui.guide || ui.guide.hidden) return;
  ui.guide.hidden = true;
  if (guidePreviouslyFocused instanceof HTMLElement) guidePreviouslyFocused.focus();
}

ui.btnHelp?.addEventListener('click', openGuide);
ui.btnEye?.addEventListener('click', () => {
  if (mode !== 'camera') return;
  cameraHidden = !cameraHidden;
  ui.body.classList.toggle('camera-hidden', cameraHidden);
  ui.btnEye.innerHTML = cameraHidden
    ? '<svg><use href="#i-eye-off"></use></svg>'
    : '<svg><use href="#i-eye"></use></svg>';
  ui.btnEye.setAttribute('aria-label', cameraHidden ? '显示摄像头背景' : '隐藏摄像头背景');
  showToast(cameraHidden ? '镜头背景已隐藏' : '镜头背景已显示', 1800);
});
ui.closeGuide?.addEventListener('click', hideGuide);
ui.guide?.querySelector('[data-close-guide]')?.addEventListener('click', hideGuide);
ui.guideContinue?.addEventListener('click', hideGuide);
ui.guideTouch?.addEventListener('click', () => enterTouchMode({ fromGuide: true }));

/* --------------------------------------------------------------------------
   Hints / UI state
   -------------------------------------------------------------------------- */

function updateHint() {
  if (!ui.hint) return;
  if (mode === 'camera') {
    ui.hint.innerHTML = '<span class="hint__line"></span>握拳收拢<span class="hint__dot">·</span>张开放绽<span class="hint__line"></span>';
  } else {
    ui.hint.innerHTML = '<span class="hint__line"></span>按住收拢<span class="hint__dot">·</span>松手绽放<span class="hint__line"></span>';
  }
}

function setGesture(label, signal, hint) {
  const key = `${label}|${signal}|${hint}`;
  if (key === lastUiGesture) return;
  lastUiGesture = key;
  ui.gestureLabel.textContent = label;
  ui.signalId.textContent = signal;
  if (hint) ui.trackState.textContent = hint;
}

function setLiveState(key) {
  if (key === lastUiState) return;
  lastUiState = key;
  ui.livePill.classList.toggle('is-tracking', key === 'tracking');
  ui.livePill.classList.toggle('is-error', key === 'error');
}

function showToast(message, duration = 2600) {
  if (!ui.toast) return;
  clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.classList.add('is-visible');
  toastTimer = setTimeout(() => {
    ui.toast.classList.remove('is-visible');
  }, duration);
}

function updateReadout(target) {
  const percent = Math.round(clamp(target, 0, 1) * 100);
  const current = Number(ui.opennessValue.textContent);
  if (percent !== current) {
    ui.opennessValue.textContent = String(percent).padStart(2, '0');
    ui.bloomMeter.setAttribute('aria-valuenow', String(percent));
  }
  document.documentElement.style.setProperty('--bloom', target.toFixed(3));
}

/* --------------------------------------------------------------------------
   Main update loop
   -------------------------------------------------------------------------- */

function desiredBloom(dt) {
  if (debugBloom !== null && debugDemo) {
    return debugBloom;
  }

  if (mode === 'intro') {
    // A slow, breathing preview behind the opening scene.
    if (prefersReducedMotion) return 0.74;
    return 0.74 + Math.sin(elapsed * 0.48) * 0.09;
  }

  if (mode === 'camera') {
    const state = tracker?.state;
    if (state?.active) {
      return smoothstep(0.06, 0.9, state.openness);
    }
    // No hand in view: keep a quiet, half-open flower alive.
    if (prefersReducedMotion) return 0.46;
    return 0.66 + Math.sin(elapsed * 0.55) * 0.06;
  }

  if (mode === 'touch') {
    if (debugDemo) {
      if (debugBloom !== null) return debugBloom;
      return 0.5 - 0.5 * Math.cos(elapsed * 0.72);
    }
    if (touchHeld) return 0.035;
    const idleFor = elapsed - lastInteractionAt;
    if (idleFor > 2.8 && !prefersReducedMotion) {
      // A gentle autonomous breath when the visitor does nothing.
      return 0.68 + Math.sin(elapsed * 0.55) * 0.13;
    }
    return 0.82;
  }

  return 0.55;
}

function updateInteraction(dt) {
  const currentTarget = clamp(desiredBloom(dt), 0, 1);
  bloomTarget = currentTarget;
  const previousBloom = bloom;
  const follow = 1 - Math.exp(-dt * (mode === 'camera' ? 5.6 : 4.4));
  bloom = lerp(bloom, bloomTarget, follow);

  bloomVelocity = Math.abs(bloom - previousBloom) / Math.max(dt, 0.001);
  const targetEnergy = clamp(bloomVelocity * 0.22, 0, 1);
  energy = lerp(energy, targetEnergy, 1 - Math.exp(-dt * 6));
  scene?.setBloom(bloom);
  scene?.setEnergy(energy);

  const bloomNorm = clamp(bloom, 0, 1);
  const percent = Math.round(bloomNorm * 100);
  updateReadout(bloomNorm);

  if (mode === 'camera') {
    const state = tracker?.state;
    const active = Boolean(state?.active);
    if (active) {
      pointer.active = true;
      const nx = (state.screenPalm.x / window.innerWidth) * 2 - 1;
      const ny = (state.screenPalm.y / window.innerHeight) * 2 - 1;
      pointer.x = nx;
      pointer.y = ny;
      scene?.setHand({
        x: nx,
        y: ny,
        active: true,
        velocity: state.velocity || 0,
      });

      if (bloomNorm < 0.27) {
        setGesture('花苞 · 掌心收拢', 'FIST', '握拳');
        setLiveState('tracking');
      } else if (bloomNorm > 0.62) {
        setGesture('绽放 · 指尖生花', 'OPEN', '追踪中');
        setLiveState('tracking');
      } else {
        setGesture('呼吸 · 正在舒展', 'TRANSITION', '追踪中');
        setLiveState('tracking');
      }
      ui.trackState.textContent = '追踪中 · 21 点';
    } else {
      const lostFor = state?.lostFor ?? Infinity;
      if (lostFor < 1.8) {
        setGesture('将手掌放入画面', 'SEARCHING', '寻找手势');
      } else {
        setGesture('等待手掌入镜', 'READY', '等待手势');
      }
      scene?.setHand({ x: 0, y: 0, active: false });
      setLiveState('idle');
    }
  } else if (mode === 'touch') {
    const active = pointer.active || touchHeld;
    scene?.setHand({
      x: pointer.active ? pointer.x : 0,
      y: pointer.active ? pointer.y : 0,
      active,
      velocity: touchHeld ? 0.4 : 0,
    });

    if (debugDemo) {
      const demoX = Math.sin(elapsed * 0.31) * 0.65;
      const demoY = Math.cos(elapsed * 0.23) * 0.35;
      scene?.setHand({ x: demoX, y: demoY, active: true, velocity: 0.18 });
    }

    if (touchHeld || bloomNorm < 0.25) {
      setGesture('花苞 · 掌心收拢', 'FIST', '触控模式');
    } else if (bloomNorm > 0.64) {
      setGesture('绽放 · 指尖生花', 'OPEN', '触控模式');
    } else {
      setGesture('呼吸 · 正在舒展', 'TRANSITION', '触控模式');
    }
    setLiveState('touch');
  }

}

function frame(now) {
  const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
  lastFrame = now;
  elapsed += dt;

  if (scene) {
    updateInteraction(dt);
    scene.update(dt);
    scene.render();
  }

  if (!sceneReady) {
    sceneReady = true;
    requestAnimationFrame(() => ui.body.classList.add('scene-ready'));
  }

  requestAnimationFrame(frame);
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */

function boot() {
  if (!scene) return;

  // Expose a tiny read-only hook for debugging / visual regression work.
  window.__ROSA__ = {
    get bloom() { return bloom; },
    get mode() { return mode; },
    get target() { return bloomTarget; },
    get tracking() { return Boolean(tracker?.state?.active); },
    startCamera,
    enterTouchMode,
  };

  requestAnimationFrame(frame);

  if (autoTouch) {
    setTimeout(() => enterTouchMode(), 120);
  } else {
    setTimeout(() => {
      if (!hasStartedCamera && !introDismissed) {
        // Keep focus in a sensible place for keyboard visitors.
        ui.postCamera?.focus({ preventScroll: true });
      }
    }, 1600);
  }

  if (debugDemo) {
    showToast('演示模式 · 触控/自动绽放', 2600);
  }
}

ui.postCamera?.addEventListener('click', startCamera);
ui.postTouch?.addEventListener('click', () => enterTouchMode());
ui.guide?.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const focusable = ui.guide.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

boot();

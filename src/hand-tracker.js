import { FilesetResolver, HandLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const FINGERS = [
  { mcp: 5, pip: 6, tip: 8 },
  { mcp: 9, pip: 10, tip: 12 },
  { mcp: 13, pip: 14, tip: 16 },
  { mcp: 17, pip: 18, tip: 20 },
];

const PALM_LANDMARKS = [0, 5, 9, 13, 17];

export class CameraError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CameraError';
    this.code = code;
  }
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z || 0) - (b.z || 0);
  return Math.hypot(dx, dy, dz);
}

function averageLandmarks(landmarks, indices) {
  const point = { x: 0, y: 0, z: 0 };
  for (const index of indices) {
    point.x += landmarks[index].x;
    point.y += landmarks[index].y;
    point.z += landmarks[index].z || 0;
  }
  const count = indices.length;
  point.x /= count;
  point.y /= count;
  point.z /= count;
  return point;
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

/**
 * Wraps getUserMedia + MediaPipe Tasks Vision HandLandmarker.
 * Emits no events; the main loop reads `tracker.state`.
 */
export class HandTracker {
  constructor({ video, overlay, onProgress }) {
    this.video = video;
    this.overlay = overlay;
    this.overlayContext = overlay?.getContext('2d') || null;
    this.onProgress = onProgress || (() => {});
    this.stream = null;
    this.landmarker = null;
    this.running = false;
    this.rafId = 0;
    this.lastDetectAt = 0;
    this.lastVideoTime = -1;
    this.lastSeenAt = 0;
    this.lastFrameAt = 0;
    this.detectTimes = [];
    this.screenLandmarks = null;
    this.smoothedPalm = null;
    this.velocity = 0;
    this.delegate = 'GPU';
    this.state = {
      active: false,
      openness: 0.5,
      rawOpenness: 0.5,
      gesture: 'none',
      palm: { x: 0.5, y: 0.5 },
      screenPalm: { x: 0, y: 0 },
      tip: { x: 0, y: 0 },
      landmarks: null,
      fps: 0,
      lostFor: Infinity,
      cameraWidth: 0,
      cameraHeight: 0,
    };
    this._detect = this._detect.bind(this);
    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
  }

  async start() {
    if (!window.isSecureContext) {
      throw new CameraError(
        'INSECURE',
        '摄像头需要 HTTPS 或 localhost 才能启用，请使用本地安全地址打开。',
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('NOT_SUPPORTED', '当前浏览器不支持摄像头访问。');
    }

    this.onProgress({ stage: 'camera', message: '正在请求镜头权限' });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
    } catch (error) {
      const name = error?.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new CameraError('PERMISSION', '没有获得摄像头权限，可以在浏览器设置中重新允许。');
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        throw new CameraError('NO_CAMERA', '没有找到可用的摄像头。');
      }
      if (name === 'NotReadableError') {
        throw new CameraError('BUSY', '摄像头正被其他应用占用，请关闭其他应用后重试。');
      }
      throw new CameraError('UNKNOWN', '摄像头启动失败，请稍后重试。');
    }

    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    try {
      await this.video.play();
    } catch {
      // Some browsers resolve play() after metadata, others reject on autoplay.
      // The stream is still usable and the next user tap will allow playback.
    }

    await new Promise((resolve) => {
      if (this.video.readyState >= 1) {
        resolve();
        return;
      }
      const onLoaded = () => {
        this.video.removeEventListener('loadedmetadata', onLoaded);
        resolve();
      };
      this.video.addEventListener('loadedmetadata', onLoaded);
      setTimeout(resolve, 2500);
    });

    this.state.cameraWidth = this.video.videoWidth || 1280;
    this.state.cameraHeight = this.video.videoHeight || 720;

    await this._loadModel();
    this.running = true;
    this.lastFrameAt = performance.now();
    this.rafId = requestAnimationFrame(this._detect);
    return { width: this.state.cameraWidth, height: this.state.cameraHeight };
  }

  async _loadModel() {
    this.onProgress({ stage: 'model', message: '正在唤醒手势模型' });
    const wasmPath = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
    const modelPath = new URL('../vendor/mediapipe/hand_landmarker.task', import.meta.url).href;

    let vision;
    try {
      vision = await FilesetResolver.forVisionTasks(wasmPath);
    } catch {
      throw new CameraError('MODEL', '手势识别组件加载失败，请检查本地文件是否完整。');
    }

    const options = {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    };

    try {
      this.landmarker = await HandLandmarker.createFromOptions(vision, options);
      this.delegate = 'GPU';
    } catch (error) {
      console.warn('[ROSA] GPU delegate unavailable, falling back to CPU.', error);
      this.delegate = 'CPU';
      try {
        this.landmarker = await HandLandmarker.createFromOptions(vision, {
          ...options,
          baseOptions: { ...options.baseOptions, delegate: 'CPU' },
        });
      } catch {
        throw new CameraError('MODEL', '手势识别模型初始化失败，请尝试刷新页面。');
      }
    }
    this.onProgress({ stage: 'ready', message: `手势模型就绪 · ${this.delegate}` });
  }

  _resize() {
    if (!this.overlay) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.overlay.width = Math.round(window.innerWidth * dpr);
    this.overlay.height = Math.round(window.innerHeight * dpr);
    this.overlay.style.width = `${window.innerWidth}px`;
    this.overlay.style.height = `${window.innerHeight}px`;
    if (this.overlayContext) {
      this.overlayContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  /**
   * Map MediaPipe's normalized camera coordinates to the visible screen.
   * The <video> is mirrored with CSS, and uses object-fit: cover, so both
   * of those transforms are reproduced here for the skeleton overlay.
   */
  _toScreen(landmark) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const videoWidth = this.state.cameraWidth || 1280;
    const videoHeight = this.state.cameraHeight || 720;
    const cover = Math.max(width / videoWidth, height / videoHeight);
    const displayWidth = videoWidth * cover;
    const displayHeight = videoHeight * cover;
    const offsetX = (width - displayWidth) * 0.5;
    const offsetY = (height - displayHeight) * 0.5;

    return {
      x: offsetX + (1 - landmark.x) * displayWidth,
      y: offsetY + landmark.y * displayHeight,
    };
  }

  _detect(now) {
    if (!this.running || !this.landmarker) return;
    this.rafId = requestAnimationFrame(this._detect);

    if (document.hidden || this.video.readyState < 2) return;
    if (now - this.lastDetectAt < 33) return;
    if (this.video.currentTime === this.lastVideoTime) return;

    this.lastVideoTime = this.video.currentTime;
    this.lastDetectAt = now;

    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, now);
    } catch (error) {
      console.warn('[ROSA] Hand detection frame skipped.', error);
      return;
    }

    const frameDt = Math.min(0.2, Math.max(0.016, (now - this.lastFrameAt) / 1000));
    this.lastFrameAt = now;
    const hasHand = Boolean(result?.landmarks?.length);
    const landmarks = hasHand ? result.landmarks[0] : null;

    if (landmarks) {
      this.lastSeenAt = now;
      this.state.lostFor = 0;
      this._updateHand(landmarks, frameDt);
    } else {
      this.state.lostFor = (now - this.lastSeenAt) / 1000;
      if (this.state.lostFor > 0.16) {
        this.state.active = false;
        this.state.gesture = 'none';
        this.state.openness += (0.5 - this.state.openness) * (1 - Math.exp(-frameDt * 2.5));
        this.screenLandmarks = null;
        this.smoothedPalm = null;
        this._clearOverlay();
      }
    }

    this._trackFps(now);
  }

  _updateHand(landmarks, dt) {
    const wrist = landmarks[0];
    const middleMcp = landmarks[9];
    const indexMcp = landmarks[5];
    const pinkyMcp = landmarks[17];

    const palmSize = Math.max(
      0.001,
      (distance(wrist, middleMcp) + distance(indexMcp, pinkyMcp) + distance(landmarks[0], landmarks[5])) / 2.4,
    );

    let fingerTotal = 0;
    for (const finger of FINGERS) {
      const mcp = landmarks[finger.mcp];
      const pip = landmarks[finger.pip];
      const tip = landmarks[finger.tip];
      const reach = distance(tip, wrist) / palmSize;
      const reachScore = smoothstep(1.18, 2.02, reach);

      const fromPipToMcp = normalize({
        x: mcp.x - pip.x,
        y: mcp.y - pip.y,
        z: (mcp.z || 0) - (pip.z || 0),
      });
      const fromPipToTip = normalize({
        x: tip.x - pip.x,
        y: tip.y - pip.y,
        z: (tip.z || 0) - (pip.z || 0),
      });
      const straightness = dot(fromPipToMcp, fromPipToTip);
      const straightScore = 1 - smoothstep(-0.58, 0.52, straightness);

      fingerTotal += reachScore * 0.42 + straightScore * 0.58;
    }

    const thumbTip = landmarks[4];
    const thumbIp = landmarks[3];
    const thumbMcp = landmarks[2];
    const thumbReach = distance(thumbTip, wrist) / palmSize;
    const thumbStraightness = dot(
      normalize({
        x: thumbMcp.x - thumbIp.x,
        y: thumbMcp.y - thumbIp.y,
        z: (thumbMcp.z || 0) - (thumbIp.z || 0),
      }),
      normalize({
        x: thumbTip.x - thumbIp.x,
        y: thumbTip.y - thumbIp.y,
        z: (thumbTip.z || 0) - (thumbIp.z || 0),
      }),
    );
    const thumbScore = smoothstep(1.30, 2.0, thumbReach) * 0.38
      + (1 - smoothstep(-0.42, 0.62, thumbStraightness)) * 0.62;

    const rawOpenness = clamp01(
      (fingerTotal / FINGERS.length) * 0.84 + thumbScore * 0.16,
    );

    const smoothing = 1 - Math.exp(-dt * 13);
    this.state.rawOpenness = rawOpenness;
    this.state.openness += (rawOpenness - this.state.openness) * smoothing;
    this.state.active = true;

    if (this.state.openness > 0.62) this.state.gesture = 'open';
    else if (this.state.openness < 0.27) this.state.gesture = 'fist';
    else this.state.gesture = 'transition';

    const palmCenter = averageLandmarks(landmarks, PALM_LANDMARKS);
    const tipCenter = averageLandmarks(landmarks, [8, 12]);
    const focus = {
      x: palmCenter.x * 0.63 + tipCenter.x * 0.37,
      y: palmCenter.y * 0.63 + tipCenter.y * 0.37,
      z: palmCenter.z,
    };

    const palmScreen = this._toScreen(palmCenter);
    const focusScreen = this._toScreen(focus);

    if (!this.smoothedPalm) {
      this.smoothedPalm = { x: palmScreen.x, y: palmScreen.y };
      this.screenLandmarks = landmarks.map((landmark) => this._toScreen(landmark));
    } else {
      const follow = 1 - Math.exp(-dt * 17);
      const previous = { ...this.smoothedPalm };
      this.smoothedPalm.x += (palmScreen.x - this.smoothedPalm.x) * follow;
      this.smoothedPalm.y += (palmScreen.y - this.smoothedPalm.y) * follow;
      this.velocity = Math.min(
        1,
        Math.hypot(this.smoothedPalm.x - previous.x, this.smoothedPalm.y - previous.y)
          / Math.max(1, dt * 130),
      );
      this.screenLandmarks = landmarks.map((landmark, index) => {
        const target = this._toScreen(landmark);
        const previousPoint = this.screenLandmarks?.[index];
        if (!previousPoint) return target;
        return {
          x: previousPoint.x + (target.x - previousPoint.x) * follow,
          y: previousPoint.y + (target.y - previousPoint.y) * follow,
        };
      });
    }

    this.state.palm = { x: palmCenter.x, y: palmCenter.y };
    this.state.screenPalm = { ...this.smoothedPalm };
    this.state.tip = focusScreen;
    this.state.landmarks = landmarks;
    this.state.velocity = this.velocity;

    this._drawOverlay();
  }

  _trackFps(now) {
    this.detectTimes.push(now);
    while (this.detectTimes.length > 1 && now - this.detectTimes[0] > 1200) {
      this.detectTimes.shift();
    }
    if (this.detectTimes.length > 2) {
      const span = (this.detectTimes[this.detectTimes.length - 1] - this.detectTimes[0]) / 1000;
      this.state.fps = Math.round((this.detectTimes.length - 1) / Math.max(0.001, span));
    }
  }

  _clearOverlay() {
    if (!this.overlayContext) return;
    this.overlayContext.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  _drawOverlay() {
    const ctx = this.overlayContext;
    const points = this.screenLandmarks;
    if (!ctx || !points) return;

    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Faint palm fill anchors the wireframe against the camera image.
    const palmOrder = [0, 5, 9, 13, 17];
    ctx.beginPath();
    palmOrder.forEach((index, i) => {
      const point = points[index];
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 131, 146, 0.025)';
    ctx.fill();

    // Glow pass.
    ctx.save();
    ctx.shadowColor = 'rgba(255, 108, 133, 0.62)';
    ctx.shadowBlur = 15;
    ctx.strokeStyle = 'rgba(255, 177, 166, 0.22)';
    ctx.lineWidth = 2.2;
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(points[a].x, points[a].y);
      ctx.lineTo(points[b].x, points[b].y);
      ctx.stroke();
    }
    ctx.restore();

    // Crisp pass.
    ctx.strokeStyle = 'rgba(255, 220, 203, 0.50)';
    ctx.lineWidth = 0.9;
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(points[a].x, points[a].y);
      ctx.lineTo(points[b].x, points[b].y);
      ctx.stroke();
    }

    // Landmark dots.
    for (let i = 0; i < points.length; i += 1) {
      const point = points[i];
      const isTip = [4, 8, 12, 16, 20].includes(i);
      const radius = isTip ? 4.2 : 1.55;
      const gradient = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius * 2.4);
      gradient.addColorStop(0, isTip ? 'rgba(255, 240, 222, 0.95)' : 'rgba(255, 202, 185, 0.72)');
      gradient.addColorStop(0.35, 'rgba(255, 128, 144, 0.42)');
      gradient.addColorStop(1, 'rgba(255, 102, 128, 0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius * 2.4, 0, Math.PI * 2);
      ctx.fill();

      if (isTip) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius + 2.8, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 208, 190, 0.22)';
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    if (this.landmarker) {
      try {
        this.landmarker.close();
      } catch {
        // Ignore closing errors from the WASM bridge.
      }
      this.landmarker = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
    this._clearOverlay();
    this.state.active = false;
    this.state.landmarks = null;
    this.screenLandmarks = null;
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._resize);
  }
}

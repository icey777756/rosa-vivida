import * as THREE from '../vendor/three.module.js';

const TAU = Math.PI * 2;

/* --------------------------------------------------------------------------
   The rose is built as a stack of 49 procedurally generated petal cards.
   Each card is translucent, gold-rimmed and curved toward the viewer in Z,
   while a particle field dances across the same surfaces. The cards give the
   bloom a readable silhouette; the particles give it life.
   -------------------------------------------------------------------------- */

const PETAL_LAYERS = [
  { layer: 0.00, petals: 3, scale: 0.30, radius: 0.0, z: 0.96 },
  { layer: 0.02, petals: 4, scale: 0.40, radius: 0.012, z: 0.78 },
  { layer: 0.17, petals: 5, scale: 0.50, radius: 0.055, z: 0.62 },
  { layer: 0.33, petals: 6, scale: 0.63, radius: 0.125, z: 0.46 },
  { layer: 0.49, petals: 7, scale: 0.78, radius: 0.210, z: 0.28 },
  { layer: 0.65, petals: 7, scale: 0.96, radius: 0.330, z: 0.07 },
  { layer: 0.82, petals: 8, scale: 1.17, radius: 0.470, z: -0.16 },
  { layer: 1.00, petals: 9, scale: 1.38, radius: 0.620, z: -0.41 },
];

const GOLDEN_ANGLE = 2.3999632297;

/* --------------------------------------------------------------------------
   GLSL for the petal field
   -------------------------------------------------------------------------- */

const petalFieldShader = /* glsl */ `
  uniform float uTime;
  uniform float uBloom;
  uniform float uEnergy;
  uniform vec2 uWind;

  attribute float aAngle;
  attribute float aRadius;
  attribute float aScale;
  attribute float aLayer;
  attribute float aZ;
  attribute float aSeed;

  #define PI 3.141592653589793
  #define TAU 6.283185307179586

  float saturate(float x) { return clamp(x, 0.0, 1.0); }

  vec3 petalCardPoint(vec2 local, float angle, float radius, float scale,
                      float layer, float z, float seed) {
    float open = smoothstep(0.0, 1.0, uBloom);
    float closed = 1.0 - open;

    // The bud gathers every petal toward a tall, tight spindle.
    float grow = mix(0.37, 1.0, open);
    float sideGrow = grow * mix(0.56, 1.0, open);
    float lengthGrow = grow * mix(1.26, 1.0, open);

    float x = local.x * scale * sideGrow;
    float y = local.y * scale * lengthGrow * 1.12;
    float radial = radius * mix(0.02, 1.0, open);

    float angleNow = angle
      + closed * (0.56 * (layer - 0.5) + seed * 0.22)
      + sin(uTime * 0.52 + seed * TAU) * 0.012;

    vec2 dir = vec2(cos(angleNow), sin(angleNow));
    vec2 tangent = vec2(-sin(angleNow), cos(angleNow));

    vec2 p = dir * (radial + y) + tangent * x;
    p.x *= mix(0.78, 1.0, open);
    p.y += 0.12 + closed * 0.22;

    // Petal cupping and the soft roll of the outer petals.
    float cup = local.x * local.x * 0.20 * scale
      * mix(0.42, 1.0, open) * (0.55 + layer * 0.75);
    float zPos = z * mix(0.72, 1.0, open)
      + cup
      + local.x * (seed - 0.5) * 0.18 * scale * open
      + y * 0.026
      - y * 0.075 * layer * open
      + closed * 0.10;

    p += uWind * (0.015 + local.y * 0.045);
    p.x += sin(uTime * 0.7 + seed * TAU + local.y * 2.4) * 0.008 * local.y;
    p.y += cos(uTime * 0.58 + seed * 12.0 + local.x * 2.0) * 0.006 * local.y;

    return vec3(p, zPos);
  }

  vec3 petalTint(float layer, float seed, float open) {
    vec3 deep = vec3(0.34, 0.006, 0.035);
    vec3 heart = vec3(0.72, 0.018, 0.090);
    vec3 rose = vec3(1.0, 0.08, 0.19);
    vec3 coral = vec3(1.0, 0.28, 0.28);

    vec3 tint = mix(deep, heart, smoothstep(0.0, 0.42, layer));
    tint = mix(tint, rose, smoothstep(0.34, 0.78, layer));
    tint = mix(tint, coral, smoothstep(0.76, 1.0, layer));
    tint *= 0.86 + seed * 0.28;
    return tint * mix(0.58, 1.0, open);
  }
`;

const cardVertexShader = /* glsl */ `
  ${petalFieldShader}

  varying vec2 vUv;
  varying vec3 vTint;
  varying float vLayer;
  varying float vSeed;
  varying float vOpen;

  void main() {
    vec3 point = petalCardPoint(position.xy, aAngle, aRadius, aScale, aLayer, aZ, aSeed);
    vec4 viewPosition = modelViewMatrix * vec4(point, 1.0);
    gl_Position = projectionMatrix * viewPosition;

    float open = smoothstep(0.0, 1.0, uBloom);
    vUv = uv;
    vLayer = aLayer;
    vSeed = aSeed;
    vOpen = open;
    vTint = petalTint(aLayer, aSeed, open);
  }
`;

const cardFragmentShader = /* glsl */ `
  uniform float uBloom;
  uniform float uOpacity;

  varying vec2 vUv;
  varying vec3 vTint;
  varying float vLayer;
  varying float vSeed;
  varying float vOpen;

  #define PI 3.141592653589793

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  void main() {
    float x = vUv.x * 2.0 - 1.0;
    float y = vUv.y;

    // A softly ruffled, slightly asymmetric rose petal silhouette.
    float width = 0.58
      * pow(sin(PI * clamp(y, 0.0, 1.0)), 0.48)
      * smoothstep(0.0, 0.07, y);
    float skew = (vSeed - 0.5) * 0.22 * pow(y, 1.2);
    float ruffle = (0.016 * sin(y * 18.0 + vSeed * 23.0)
      + 0.009 * sin(y * 37.0 + vSeed * 51.0)) * smoothstep(0.16, 0.94, y);
    float inside = width + ruffle - abs(x - skew);
    if (inside <= 0.0) discard;

    float notch = smoothstep(0.94, 1.0, y)
      * exp(-pow((x - skew) / 0.15, 2.0)) * 0.085;
    inside -= notch;
    float rim = 1.0 - smoothstep(0.0, 0.040, inside);
    float feather = smoothstep(0.0, 0.010, inside);
    float tip = smoothstep(0.82, 1.0, y);

    // Fabric-like shading. The warm rim makes every overlapping petal legible.
    float shade = 0.56 + 0.44 * smoothstep(0.03, 0.72, y);
    shade *= 0.86 + 0.14 * cos(x * 2.1 - vLayer * 2.4);
    vec3 color = vTint * shade;
    color = mix(vec3(0.095, 0.002, 0.008), color, smoothstep(0.0, 0.33, y));
    color *= mix(0.58, 1.12, vOpen);

    vec3 rimColor = vec3(1.0, 0.48, 0.19);
    vec3 pale = vec3(1.0, 0.88, 0.66);
    color += rimColor * rim * 0.82;
    color += pale * tip * 0.15;
    color += pale * rim * tip * 0.18;

    float centerVein = 1.0 - smoothstep(0.0, 0.018, abs(x));
    float sideVeins = pow(0.5 + 0.5 * sin(y * 25.0 + abs(x) * 13.0), 14.0)
      * (1.0 - smoothstep(0.0, 0.22, inside)) * smoothstep(0.06, 0.40, y);
    color += vec3(1.0, 0.68, 0.39) * (centerVein * 0.055 + sideVeins * 0.06);

    float grain = hash21(gl_FragCoord.xy * 0.81 + vSeed * 9.0);
    float alpha = (mix(0.58, 0.84, vLayer) + rim * 0.26 + tip * 0.06)
      * (0.86 + grain * 0.14)
      * feather * uOpacity;
    alpha *= mix(1.0, 0.93, vOpen);

    gl_FragColor = vec4(color, alpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const spiralVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uBloom;
  uniform float uOpen;
  varying vec2 vUv;

  void main() {
    float open = smoothstep(0.0, 1.0, uBloom);
    vec3 p = position;
    p.xy *= mix(0.70, 1.0, open);
    p.z = 0.98 + 0.06 * sin(uTime * 0.7 + uv.x * 8.0) * open;
    p.x += 0.18 * (1.0 - open);
    p.y += 0.12 + (1.0 - open) * 0.12;
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const spiralFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uBloom;
  uniform float uOpacity;
  varying vec2 vUv;

  void main() {
    float across = vUv.y;
    float rim = smoothstep(0.35, 0.5, abs(across - 0.5));
    float shade = 0.55 + 0.45 * sin(vUv.x * 25.0 + uTime * 0.9);
    vec3 deep = vec3(0.18, 0.004, 0.018);
    vec3 rose = vec3(0.90, 0.045, 0.12);
    vec3 gold = vec3(1.0, 0.55, 0.24);
    vec3 color = mix(deep, rose, smoothstep(0.0, 0.8, vUv.x));
    color = mix(color, gold, rim * 0.72 + smoothstep(0.82, 1.0, vUv.x) * 0.25);
    color *= 0.72 + shade * 0.4;
    float alpha = (0.58 + rim * 0.3) * uOpacity * smoothstep(0.0, 0.08, vUv.x);
    gl_FragColor = vec4(color, alpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const petalParticleVertexShader = /* glsl */ `
  ${petalFieldShader}

  uniform float uPixelRatio;
  uniform float uPointScale;
  uniform float uParticleOpacity;

  attribute vec2 aLocal;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec3 point = petalCardPoint(aLocal, aAngle, aRadius, aScale, aLayer, aZ, aSeed);
    point.z += 0.022;
    vec4 mvPosition = modelViewMatrix * vec4(point, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float open = smoothstep(0.0, 1.0, uBloom);
    float twinkle = 0.65 + 0.35 * sin(uTime * 1.8 + aSeed * 43.0 + aLocal.y * 7.0);
    float size = 1.15 + pow(aSeed, 3.0) * 2.6 + aLocal.y * 0.5;
    gl_PointSize = size * uPixelRatio * uPointScale * (10.2 / max(4.0, -mvPosition.z));

    vec3 warm = vec3(1.0, 0.49, 0.22);
    vec3 blush = vec3(1.0, 0.16, 0.31);
    vec3 pale = vec3(1.0, 0.85, 0.60);
    vColor = mix(blush, warm, smoothstep(0.15, 0.9, aLocal.y));
    vColor = mix(vColor, pale, step(0.93, aSeed) * 0.5);
    vColor *= twinkle;
    vAlpha = (0.22 + aSeed * 0.25) * uParticleOpacity * mix(0.65, 1.0, open);
  }
`;

const petalParticleFragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 point = gl_PointCoord - 0.5;
    float dist = length(point) * 2.0;
    if (dist > 1.0) discard;
    float glow = pow(1.0 - dist, 2.1);
    float core = 1.0 - smoothstep(0.0, 0.34, dist);
    gl_FragColor = vec4(vColor * (0.7 + core * 1.5), glow * vAlpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/* --------------------------------------------------------------------------
   Ambient and flight particles
   -------------------------------------------------------------------------- */

const budVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uBloom;
  uniform float uEnergy;
  uniform float uPixelRatio;
  uniform float uPointScale;
  uniform float uOpacity;
  uniform vec2 uWind;

  attribute float aAngle;
  attribute float aSeed;
  attribute float aTilt;
  attribute float aRim;

  varying vec3 vColor;
  varying float vAlpha;

  #define PI 3.141592653589793
  #define TAU 6.283185307179586

  float saturate(float x) { return clamp(x, 0.0, 1.0); }

  void main() {
    float u = clamp(position.x, 0.0, 1.0);
    float v = clamp(position.y, -1.0, 1.0);
    float layer = clamp(position.z, 0.0, 1.0);
    float seed = aSeed;
    float petalRand = aTilt;
    float angle = aAngle + petalRand * 0.06;

    float budAngle = angle + u * 0.55 + layer * 0.20;
    vec3 budRadial = vec3(cos(budAngle), 0.0, sin(budAngle));
    vec3 budTangent = vec3(-sin(budAngle), 0.0, cos(budAngle));

    float budProfile = sin(pow(u, 0.80) * PI * 0.92);
    float budRadius = 0.10 + budProfile * (0.33 + layer * 0.07);
    budRadius *= 1.0 + petalRand * 0.055;
    budRadius *= 1.0 - 0.30 * smoothstep(0.60, 1.0, u);
    budRadius += layer * 0.038;
    float budWidth = (0.23 + layer * 0.08)
      * pow(sin(PI * clamp(u * 0.88 + 0.06, 0.0, 1.0)), 0.62);
    float budTang = v * budWidth * (1.0 - 0.20 * smoothstep(0.82, 1.0, u));

    vec3 p = budRadial * (budRadius + v * v * 0.08) + budTangent * budTang;
    p.y = 0.05 + u * (1.48 - layer * 0.20) + v * v * 0.10
      - 0.10 * u * u * layer;
    p.y += petalRand * 0.035 * (1.0 - u);

    float scatter = smoothstep(0.06, 0.52, uBloom);
    p *= 1.0 + scatter * (0.18 + seed * 0.7);
    p.y += scatter * (0.12 + seed * 0.55);
    p.xz += uWind * (0.06 + seed * 0.12) * (0.4 + scatter);
    p.x += sin(uTime * 0.9 + seed * 21.0) * 0.008 * (0.4 + scatter);

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float size = mix(1.65, 3.10, seed) + pow(u, 2.0) * 1.05;
    size *= 1.0 + aRim * 0.22;
    gl_PointSize = size * uPixelRatio * uPointScale * (10.2 / max(4.0, -mvPosition.z));

    vec3 burgundy = vec3(0.28, 0.004, 0.022);
    vec3 rose = vec3(0.92, 0.045, 0.15);
    vec3 coral = vec3(1.0, 0.26, 0.24);
    vec3 gold = vec3(1.0, 0.64, 0.34);

    vec3 color = mix(rose, coral, smoothstep(0.12, 0.94, layer));
    color = mix(burgundy, color, smoothstep(0.0, 0.22, u));
    color = mix(color, gold,
      smoothstep(0.86, 1.0, abs(v)) * 0.18 + smoothstep(0.88, 1.0, u) * 0.14);
    color += gold * (1.0 - smoothstep(0.0, 0.32, u)) * 0.16;
    color *= 0.82 + 0.32 * seed;
    color *= 0.86 + 0.24 * sin(uTime * 1.2 + seed * 33.0) * 0.35;
    color = mix(color, gold, aRim * 0.45);

    vColor = color;
    vAlpha = (0.31 + seed * 0.24) * (0.80 + 0.34 * abs(v))
      * uOpacity * (1.0 - 0.55 * scatter) * (1.0 + aRim * 0.65);
  }
`;

const budFragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 point = gl_PointCoord - 0.5;
    float dist = length(point) * 2.0;
    if (dist > 1.0) discard;
    float glow = pow(1.0 - dist, 2.2);
    float core = 1.0 - smoothstep(0.0, 0.52, dist);
    gl_FragColor = vec4(vColor * (0.62 + core * 1.25), glow * vAlpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const budShellVertexShader = /* glsl */ `
  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  varying vec2 vUv;

  void main() {
    vec3 p = position;
    float angle = atan(p.x, p.z);
    float lobes = 1.0 + 0.038 * sin(angle * 5.0 + p.y * 2.4)
      * smoothstep(-0.4, 1.2, p.y);
    p.xz *= lobes;
    vec4 world = modelMatrix * vec4(p, 1.0);
    vWorldPosition = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const budShellFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uBloom;
  uniform float uOpacity;

  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  varying vec2 vUv;

  void main() {
    vec3 normal = normalize(vNormal);
    if (!gl_FrontFacing) normal = -normal;
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    float fresnel = pow(1.0 - abs(dot(normal, viewDir)), 2.0);
    float angle = atan(vWorldPosition.x, vWorldPosition.z);
    float seam = pow(0.5 + 0.5 * sin(angle * 6.0 + vWorldPosition.y * 2.3), 22.0);
    float fold = pow(0.5 + 0.5 * sin(angle * 3.0 - vWorldPosition.y * 1.4 + 1.7), 10.0);
    vec3 key = normalize(vec3(-0.42, 0.82, 0.55));
    float diffuse = max(dot(normal, key), 0.0);

    vec3 deep = vec3(0.07, 0.001, 0.008);
    vec3 rose = vec3(0.30, 0.008, 0.030);
    vec3 blush = vec3(0.62, 0.035, 0.055);
    vec3 gold = vec3(1.0, 0.45, 0.18);
    vec3 color = mix(deep, rose, smoothstep(0.0, 0.9, vUv.y));
    color = mix(color, blush, fresnel * 0.35 + diffuse * 0.16);
    color += gold * (seam * 0.20 + fold * 0.05 + fresnel * 0.10);
    color *= 0.46 + 0.68 * diffuse + 0.20 * smoothstep(-0.3, 0.95, vWorldPosition.y);

    float alpha = (0.54 + seam * 0.10 + fresnel * 0.08) * uOpacity * 0.22;
    gl_FragColor = vec4(color, alpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const sparkVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uBloom;
  uniform float uEnergy;
  uniform float uPixelRatio;
  uniform float uPointScale;
  uniform vec2 uWind;

  attribute vec3 aOrbit;
  attribute float aSeed;
  attribute float aSize;

  varying vec3 vColor;
  varying float vAlpha;

  float hash(float n) { return fract(sin(n) * 43758.5453123); }

  void main() {
    float r1 = hash(aSeed * 91.7);
    float r2 = hash(aSeed * 37.1 + 3.4);
    float r3 = hash(aSeed * 73.9 + 8.7);

    float angle = aSeed * 6.2831853 + uTime * (0.035 + r1 * 0.1);
    float openRadius = 0.75 + r2 * 2.25;
    float radius = mix(0.12 + r3 * 0.55, openRadius, smoothstep(0.0, 1.0, uBloom));
    radius *= 1.0 + uEnergy * 0.16;

    vec3 dir = normalize(aOrbit);
    vec3 p = vec3(cos(angle) * radius, dir.y * (0.55 + 0.35 * radius) + 0.25, sin(angle) * radius);
    p += dir * (0.14 + r3 * 0.28);
    p.xz += uWind * (0.12 + r1 * 0.18);
    p.y += sin(uTime * (0.55 + r2 * 0.7) + aSeed * 20.0) * 0.09;

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float twinkle = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * (1.1 + r2 * 2.2) + aSeed * 31.0), 3.0);
    gl_PointSize = aSize * uPixelRatio * uPointScale * (10.2 / max(4.0, -mvPosition.z));

    vColor = mix(vec3(1.0, 0.72, 0.43), vec3(1.0, 0.34, 0.45), r1);
    vAlpha = twinkle * mix(0.24, 0.78, smoothstep(0.0, 0.7, uBloom)) * (0.5 + 0.5 * r3);
  }
`;

const sparkFragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 point = gl_PointCoord - 0.5;
    float dist = length(point) * 2.0;
    if (dist > 1.0) discard;
    float glow = pow(1.0 - dist, 2.6);
    float core = 1.0 - smoothstep(0.0, 0.45, dist);
    gl_FragColor = vec4(vColor * (0.5 + core * 1.5), glow * vAlpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const haloVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const haloFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uBloom;
  uniform float uOpacity;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying vec2 vUv;

  void main() {
    vec2 p = vUv - 0.5;
    float dist = length(p) * 2.0;
    float breathe = 0.92 + 0.08 * sin(uTime * 1.1);
    float core = pow(max(0.0, 1.0 - dist), 3.8);
    float wash = pow(max(0.0, 1.0 - dist), 1.5);
    float ring = smoothstep(0.56, 0.59, dist) * (1.0 - smoothstep(0.59, 0.64, dist));
    vec3 color = mix(uColorA, uColorB, smoothstep(0.0, 0.62, dist));
    float alpha = (core * 0.30 + wash * 0.075 + ring * 0.022) * uOpacity * breathe;
    gl_FragColor = vec4(color, alpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const dustVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;

  attribute float aSeed;
  attribute float aSize;

  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    vec3 p = position;
    p.x += sin(uTime * 0.09 + aSeed * 12.0) * 0.38;
    p.y += cos(uTime * 0.07 + aSeed * 19.0) * 0.22;
    p.z += sin(uTime * 0.05 + aSeed * 5.0) * 0.2;

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = aSize * uPixelRatio * (24.0 / max(4.0, -mvPosition.z));

    float twinkle = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * 0.4 + aSeed * 30.0), 3.0);
    vAlpha = twinkle * 0.3;
    vColor = mix(vec3(1.0, 0.82, 0.62), vec3(0.65, 0.85, 0.74), fract(aSeed * 5.7));
  }
`;

const dustFragmentShader = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    vec2 point = gl_PointCoord - 0.5;
    float dist = length(point) * 2.0;
    if (dist > 1.0) discard;
    float alpha = pow(1.0 - dist, 2.5) * vAlpha;
    gl_FragColor = vec4(vColor, alpha);

    #include <colorspace_fragment>
  }
`;

/* --------------------------------------------------------------------------
   Geometry helpers
   -------------------------------------------------------------------------- */

function hash(a, b = 0) {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function petalWidthAt(y) {
  return 0.61 * Math.pow(Math.sin(Math.PI * clamp01(y)), 0.34) * smoothstep(0, 0.07, y);
}

function buildPetalInstances() {
  const instances = [];
  let petalCounter = 0;
  for (let layerIndex = PETAL_LAYERS.length - 1; layerIndex >= 0; layerIndex -= 1) {
    const layerData = PETAL_LAYERS[layerIndex];
    for (let petal = 0; petal < layerData.petals; petal += 1) {
      const seed = hash(layerIndex + 3.1, petal + 8.7);
      const angle = petalCounter * GOLDEN_ANGLE + 0.42
        + (hash(layerIndex + 1.9, petal + 2.2) - 0.5) * 0.11;
      petalCounter += 1;
      instances.push({
        angle,
        radius: layerData.radius * (0.86 + seed * 0.28),
        scale: layerData.scale * (0.92 + seed * 0.18),
        layer: layerData.layer,
        z: layerData.z,
        seed,
      });
    }
  }
  return instances;
}

function createInstancedPetalGeometry(instances) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex([0, 1, 2, 1, 3, 2]);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -1, 0, 0,
    1, 0, 0,
    -1, 1, 0,
    1, 1, 0,
  ], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0,
    1, 0,
    0, 1,
    1, 1,
  ], 2));

  const count = instances.length;
  const angles = new Float32Array(count);
  const radii = new Float32Array(count);
  const scales = new Float32Array(count);
  const layers = new Float32Array(count);
  const zValues = new Float32Array(count);
  const seeds = new Float32Array(count);

  instances.forEach((instance, index) => {
    angles[index] = instance.angle;
    radii[index] = instance.radius;
    scales[index] = instance.scale;
    layers[index] = instance.layer;
    zValues[index] = instance.z;
    seeds[index] = instance.seed;
  });

  geometry.setAttribute('aAngle', new THREE.InstancedBufferAttribute(angles, 1));
  geometry.setAttribute('aRadius', new THREE.InstancedBufferAttribute(radii, 1));
  geometry.setAttribute('aScale', new THREE.InstancedBufferAttribute(scales, 1));
  geometry.setAttribute('aLayer', new THREE.InstancedBufferAttribute(layers, 1));
  geometry.setAttribute('aZ', new THREE.InstancedBufferAttribute(zValues, 1));
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  geometry.instanceCount = count;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 9);
  return geometry;
}

function createPetalParticleGeometry(instances, detail) {
  let totalPoints = 0;
  for (const instance of instances) {
    totalPoints += Math.round(detail * (0.42 + instance.scale * 0.62));
  }

  const positions = new Float32Array(totalPoints * 3);
  const locals = new Float32Array(totalPoints * 2);
  const angles = new Float32Array(totalPoints);
  const radii = new Float32Array(totalPoints);
  const scales = new Float32Array(totalPoints);
  const layers = new Float32Array(totalPoints);
  const zValues = new Float32Array(totalPoints);
  const seeds = new Float32Array(totalPoints);

  let index = 0;
  for (const instance of instances) {
    const count = Math.round(detail * (0.42 + instance.scale * 0.62));
    for (let i = 0; i < count; i += 1) {
      const y = Math.pow(Math.random(), 0.92);
      const width = petalWidthAt(y);
      const x = (Math.random() * 2 - 1) * width * (0.72 + Math.random() * 0.28);
      locals[index * 2] = x;
      locals[index * 2 + 1] = y;
      angles[index] = instance.angle;
      radii[index] = instance.radius;
      scales[index] = instance.scale;
      layers[index] = instance.layer;
      zValues[index] = instance.z;
      seeds[index] = Math.random();
      index += 1;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aLocal', new THREE.BufferAttribute(locals, 2));
  geometry.setAttribute('aAngle', new THREE.BufferAttribute(angles, 1));
  geometry.setAttribute('aRadius', new THREE.BufferAttribute(radii, 1));
  geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
  geometry.setAttribute('aLayer', new THREE.BufferAttribute(layers, 1));
  geometry.setAttribute('aZ', new THREE.BufferAttribute(zValues, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 9);
  return geometry;
}

function createSpiralGeometry(segments = 260, turns = 2.65) {
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const indices = new Uint16Array(segments * 6);

  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const theta = t * turns * TAU + 1.35;
    const radius = 0.022 + t * 0.33;
    const width = 0.026 + t * 0.055;
    const cx = Math.cos(theta) * radius;
    const cy = Math.sin(theta) * radius * 0.86 + 0.06;
    const nx = Math.cos(theta);
    const ny = Math.sin(theta) * 0.86;

    const base = i * 2;
    positions[base * 3] = cx - nx * width;
    positions[base * 3 + 1] = cy - ny * width;
    positions[base * 3 + 2] = 0.0;
    positions[(base + 1) * 3] = cx + nx * width;
    positions[(base + 1) * 3 + 1] = cy + ny * width;
    positions[(base + 1) * 3 + 2] = 0.0;

    uvs[base * 2] = t;
    uvs[base * 2 + 1] = 0.0;
    uvs[(base + 1) * 2] = t;
    uvs[(base + 1) * 2 + 1] = 1.0;

    if (i < segments) {
      const a = base;
      const b = base + 1;
      const c = base + 2;
      const d = base + 3;
      indices[i * 6] = a;
      indices[i * 6 + 1] = c;
      indices[i * 6 + 2] = b;
      indices[i * 6 + 3] = b;
      indices[i * 6 + 4] = c;
      indices[i * 6 + 5] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.1, 0.9), 1.0);
  return geometry;
}

function createBudShellGeometry() {
  const profile = [];
  const segments = 52;
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const y = -0.55 + t * 1.95;
    const radius = 0.52
      * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.68)), 0.82)
      * (1.0 - t * 0.14);
    profile.push(new THREE.Vector2(Math.max(0.0001, radius), y));
  }
  const geometry = new THREE.LatheGeometry(profile, 40);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.45, 0), 2);
  return geometry;
}

const BUD_LAYERS = [
  { layer: 0.04, petals: 4, weight: 0.55 },
  { layer: 0.15, petals: 5, weight: 0.65 },
  { layer: 0.27, petals: 6, weight: 0.80 },
  { layer: 0.40, petals: 6, weight: 0.95 },
  { layer: 0.54, petals: 7, weight: 1.10 },
  { layer: 0.68, petals: 8, weight: 1.25 },
  { layer: 0.83, petals: 8, weight: 1.40 },
  { layer: 1.00, petals: 9, weight: 1.55 },
];

function createBudGeometry(baseDetail = 480) {
  let totalPoints = 0;
  for (const entry of BUD_LAYERS) {
    totalPoints += Math.round(baseDetail * entry.weight) * entry.petals;
  }

  const params = new Float32Array(totalPoints * 3);
  const angles = new Float32Array(totalPoints);
  const seeds = new Float32Array(totalPoints);
  const tilts = new Float32Array(totalPoints);
  const rims = new Float32Array(totalPoints);

  let index = 0;
  for (let layerIndex = 0; layerIndex < BUD_LAYERS.length; layerIndex += 1) {
    const { layer, petals, weight } = BUD_LAYERS[layerIndex];
    for (let petal = 0; petal < petals; petal += 1) {
      const petalAngle = (petal / petals) * TAU + layerIndex * 0.72 + 0.31;
      const petalRandom = hash(layerIndex + 6.2, petal + 4.4) * 2 - 1;
      const count = Math.round(baseDetail * weight);
      for (let point = 0; point < count; point += 1) {
        let u = Math.pow(hash(index * 1.61, layerIndex + 3.9), 0.9);
        let v = hash(index * 2.07, petal + 9.5) * 2 - 1;
        let rim = 0;
        if (Math.random() < 0.15) {
          v = Math.sign(v || 1) * (0.90 + Math.random() * 0.10);
          rim = 1;
        } else if (Math.random() < 0.12) {
          u = 0.78 + Math.random() * 0.22;
        }
        params[index * 3] = u;
        params[index * 3 + 1] = v;
        params[index * 3 + 2] = layer;
        angles[index] = petalAngle;
        seeds[index] = hash(index * 0.73, 13.2);
        tilts[index] = petalRandom + (Math.random() - 0.5) * 0.03;
        rims[index] = rim;
        index += 1;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(params, 3));
  geometry.setAttribute('aAngle', new THREE.BufferAttribute(angles, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aTilt', new THREE.BufferAttribute(tilts, 1));
  geometry.setAttribute('aRim', new THREE.BufferAttribute(rims, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.7, 0), 4);
  return geometry;
}

function createSparkGeometry(count = 1400) {
  const orbits = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const theta = Math.random() * TAU;
    const y = Math.random() * 2 - 1;
    const radial = Math.sqrt(Math.max(0, 1 - y * y));
    orbits[i * 3] = Math.cos(theta) * radial;
    orbits[i * 3 + 1] = y * 0.55 + 0.28;
    orbits[i * 3 + 2] = Math.sin(theta) * radial;
    seeds[i] = Math.random();
    sizes[i] = 1.2 + Math.pow(Math.random(), 2.4) * 3.4;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('aOrbit', new THREE.BufferAttribute(orbits, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), 10);
  return geometry;
}

function createDustGeometry(count = 190) {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (Math.random() - 0.5) * 18;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 10;
    positions[i * 3 + 2] = -5 + Math.random() * 10;
    seeds[i] = Math.random();
    sizes[i] = 0.8 + Math.pow(Math.random(), 2) * 2.6;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  return geometry;
}

/* --------------------------------------------------------------------------
   Scene
   -------------------------------------------------------------------------- */

export class RoseScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.time = 0;
    this.bloom = 0.1;
    this.energy = 0;
    this.composition = 'intro';
    this.hand = { x: 0, y: 0, active: false, velocity: 0 };
    this.wind = new THREE.Vector2();
    this.windTarget = new THREE.Vector2();
    this.groupPosition = new THREE.Vector3();
    this.groupPositionTarget = new THREE.Vector3();
    this.rotationX = -0.02;
    this.rotationY = 0;
    this.rotationZ = 0;
    this.fitScale = 0.7;
    this.currentScale = 0.7;
    this.isMobile = matchMedia('(max-width: 760px), (pointer: coarse)').matches;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
      premultipliedAlpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    this.camera.position.set(0, 0.8, 10.5);
    this.camera.lookAt(0, 0.35, 0);

    this.flower = new THREE.Group();
    this.scene.add(this.flower);

    this.instances = buildPetalInstances();

    /* ---- petal cards ---------------------------------------------------- */
    this.cardMaterial = new THREE.ShaderMaterial({
      vertexShader: cardVertexShader,
      fragmentShader: cardFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uBloom: { value: this.bloom },
        uEnergy: { value: 0 },
        uWind: { value: new THREE.Vector2() },
        uOpacity: { value: 0.94 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    this.cardGeometry = createInstancedPetalGeometry(this.instances);
    this.cards = new THREE.Mesh(this.cardGeometry, this.cardMaterial);
    this.cards.frustumCulled = false;
    this.cards.renderOrder = 3;
    this.flower.add(this.cards);

    /* ---- the rose heart, a glowing spiral of folded petals -------------- */
    this.spiralMaterial = new THREE.ShaderMaterial({
      vertexShader: spiralVertexShader,
      fragmentShader: spiralFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uBloom: { value: this.bloom },
        uOpacity: { value: 0.96 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    this.spiralGeometry = createSpiralGeometry();
    this.spiral = new THREE.Mesh(this.spiralGeometry, this.spiralMaterial);
    this.spiral.frustumCulled = false;
    this.spiral.renderOrder = 7;
    this.flower.add(this.spiral);

    /* ---- the closed bud -------------------------------------------------- */
    this.budMaterial = new THREE.ShaderMaterial({
      vertexShader: budVertexShader,
      fragmentShader: budFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uBloom: { value: this.bloom },
        uEnergy: { value: 0 },
        uPixelRatio: { value: 1 },
        uPointScale: { value: 1 },
        uOpacity: { value: 1 },
        uWind: { value: new THREE.Vector2() },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
    });
    this.budGeometry = createBudGeometry(this.isMobile ? 400 : 570);
    this.buds = new THREE.Points(this.budGeometry, this.budMaterial);
    this.buds.frustumCulled = false;
    this.buds.renderOrder = 8;
    this.buds.scale.setScalar(1.55);
    this.buds.position.set(0, -0.30, 0.55);
    this.flower.add(this.buds);

    this.budGlowMaterial = new THREE.ShaderMaterial({
      vertexShader: haloVertexShader,
      fragmentShader: haloFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uBloom: { value: this.bloom },
        uOpacity: { value: 1 },
        uColorA: { value: new THREE.Color('#ffd7a1') },
        uColorB: { value: new THREE.Color('#ff5c73') },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.budGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.budGlowMaterial);
    this.budGlow.frustumCulled = false;
    this.budGlow.renderOrder = 9;
    this.scene.add(this.budGlow);

    this.budShellMaterial = new THREE.ShaderMaterial({
      vertexShader: budShellVertexShader,
      fragmentShader: budShellFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uBloom: { value: this.bloom },
        uOpacity: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    this.budShellGeometry = createBudShellGeometry();
    this.budShell = new THREE.Mesh(this.budShellGeometry, this.budShellMaterial);
    this.budShell.frustumCulled = false;
    this.budShell.renderOrder = 7;
    this.budShell.position.set(0, 0.08, 0.45);
    this.budShell.scale.set(0.82, 0.88, 0.82);
    this.flower.add(this.budShell);

    /* ---- particle embroidery on the petals ----------------------------- */
    this.particleMaterial = new THREE.ShaderMaterial({
      vertexShader: petalParticleVertexShader,
      fragmentShader: petalParticleFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uBloom: { value: this.bloom },
        uEnergy: { value: 0 },
        uWind: { value: new THREE.Vector2() },
        uPixelRatio: { value: 1 },
        uPointScale: { value: 1 },
        uParticleOpacity: { value: 0.95 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.particleGeometry = createPetalParticleGeometry(
      this.instances,
      this.isMobile ? 130 : 200,
    );
    this.particles = new THREE.Points(this.particleGeometry, this.particleMaterial);
    this.particles.frustumCulled = false;
    this.particles.renderOrder = 5;
    this.flower.add(this.particles);

    /* ---- flight particles ---------------------------------------------- */
    this.sparkMaterial = new THREE.ShaderMaterial({
      vertexShader: sparkVertexShader,
      fragmentShader: sparkFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uBloom: { value: this.bloom },
        uEnergy: { value: 0 },
        uPixelRatio: { value: 1 },
        uPointScale: { value: 1 },
        uWind: { value: new THREE.Vector2() },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.sparkGeometry = createSparkGeometry(this.isMobile ? 900 : 1400);
    this.sparks = new THREE.Points(this.sparkGeometry, this.sparkMaterial);
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 6;
    this.flower.add(this.sparks);

    /* ---- atmospheric glows ---------------------------------------------- */
    this.haloMaterial = new THREE.ShaderMaterial({
      vertexShader: haloVertexShader,
      fragmentShader: haloFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uBloom: { value: this.bloom },
        uOpacity: { value: 1 },
        uColorA: { value: new THREE.Color('#ffd9a8') },
        uColorB: { value: new THREE.Color('#a42045') },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.haloMaterial);
    this.halo.frustumCulled = false;
    this.halo.renderOrder = 0;
    this.scene.add(this.halo);

    this.coreMaterial = new THREE.ShaderMaterial({
      vertexShader: haloVertexShader,
      fragmentShader: haloFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uBloom: { value: this.bloom },
        uOpacity: { value: 1.2 },
        uColorA: { value: new THREE.Color('#fff1cf') },
        uColorB: { value: new THREE.Color('#ff7a7d') },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.core = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.coreMaterial);
    this.core.frustumCulled = false;
    this.core.renderOrder = 2;
    this.scene.add(this.core);

    this.dustMaterial = new THREE.ShaderMaterial({
      vertexShader: dustVertexShader,
      fragmentShader: dustFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.dust = new THREE.Points(createDustGeometry(this.isMobile ? 130 : 210), this.dustMaterial);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 1;
    this.scene.add(this.dust);

    this.visibleSize = { width: 1, height: 1 };
    this.resize();
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.isMobile ? 1.9 : 2.1);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();

    const distance = this.camera.position.length();
    const visibleHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
    const visibleWidth = visibleHeight * this.camera.aspect;
    this.visibleSize = { width: visibleWidth, height: visibleHeight };

    this.compactLandscape = window.innerHeight < 640 && this.camera.aspect > 1.2;
    this.fitScale = THREE.MathUtils.clamp(
      Math.min((visibleWidth * 0.85) / 4.7, (visibleHeight * 0.57) / 3.4),
      0.4,
      1.3,
    ) * (this.compactLandscape ? 0.84 : 1);
    if (this.currentScale < 0.45) this.currentScale = this.fitScale;

    this.dustMaterial.uniforms.uPixelRatio.value = pixelRatio;
    this.particleMaterial.uniforms.uPixelRatio.value = pixelRatio;
    this.sparkMaterial.uniforms.uPixelRatio.value = pixelRatio;
    this.budMaterial.uniforms.uPixelRatio.value = pixelRatio;

    this.updateCompositionTargets();
  }

  setComposition(composition) {
    this.composition = composition;
    this.updateCompositionTargets();
  }

  updateCompositionTargets() {
    const { width, height } = this.visibleSize;
    let x = 0;
    let y = 0.15;

    if (this.composition === 'intro') {
      if (this.camera.aspect > 0.95) {
        x = width * 0.205;
        y = 0.05;
      } else {
        x = 0;
        y = height * 0.145;
      }
    } else if (this.compactLandscape) {
      y = height * 0.085;
    } else {
      y = height * (this.camera.aspect > 0.95 ? 0.02 : 0.055);
    }

    this.groupPositionTarget.set(x, y, 0);
  }

  setHand({ x = 0, y = 0, active = false, velocity = 0 } = {}) {
    this.hand.x = x;
    this.hand.y = y;
    this.hand.active = active;
    this.hand.velocity = velocity;
  }

  setBloom(value) {
    this.bloom = THREE.MathUtils.clamp(value, 0, 1);
  }

  setEnergy(value) {
    this.energy = THREE.MathUtils.clamp(value, 0, 1);
  }

  update(dt) {
    this.time += dt;
    const { width, height } = this.visibleSize;

    const handX = this.hand.active ? this.hand.x : 0;
    const handY = this.hand.active ? this.hand.y : 0;
    const motionScale = this.hand.active ? 1 : 0.12;

    this.windTarget.set(
      -handX * 0.075 + Math.sin(this.time * 0.33) * 0.015,
      handY * 0.03 + Math.cos(this.time * 0.27) * 0.010,
    );
    this.wind.lerp(this.windTarget, 1 - Math.exp(-dt * 2.5));

    const targetPosition = this.groupPositionTarget.clone();
    targetPosition.x += handX * width * 0.045 * motionScale;
    targetPosition.y += -handY * height * 0.032 * motionScale;

    const follow = 1 - Math.exp(-dt * (this.composition === 'intro' ? 1.5 : 3.2));
    this.groupPosition.lerp(targetPosition, follow);

    const targetScale = this.fitScale * (
      this.composition === 'intro' && this.camera.aspect <= 0.95 ? 0.96 : 1
    );
    this.currentScale += (targetScale - this.currentScale) * (1 - Math.exp(-dt * 2.2));

    const idleSpin = this.composition === 'intro' ? 0.035 : 0.018;
    const targetRotY = Math.sin(this.time * idleSpin) * 0.11 + handX * 0.14;
    const targetRotX = -0.02 + handY * 0.07 + Math.sin(this.time * 0.22) * 0.016;
    const targetRotZ = handX * -0.045 + Math.sin(this.time * 0.3) * 0.010 + this.wind.x * 0.35;

    this.rotationY += (targetRotY - this.rotationY) * (1 - Math.exp(-dt * 2.4));
    this.rotationX += (targetRotX - this.rotationX) * (1 - Math.exp(-dt * 2.4));
    this.rotationZ += (targetRotZ - this.rotationZ) * (1 - Math.exp(-dt * 2.4));

    this.flower.position.copy(this.groupPosition);
    this.flower.rotation.set(this.rotationX, this.rotationY, this.rotationZ);
    this.flower.scale.setScalar(this.currentScale);

    this.halo.position.copy(this.groupPosition).add(
      new THREE.Vector3(0, 0.35 * this.currentScale, -0.7),
    );
    this.halo.quaternion.copy(this.camera.quaternion);
    this.halo.scale.setScalar(8.8 * this.currentScale * (0.85 + this.bloom * 0.15));

    this.core.position.copy(this.groupPosition).add(
      new THREE.Vector3(0, 0.33 * this.currentScale, -0.4),
    );
    this.core.quaternion.copy(this.camera.quaternion);
    this.core.scale.setScalar(1.55 * (0.7 + this.bloom * 0.4));

    this.budGlow.position.copy(this.groupPosition).add(
      new THREE.Vector3(0, 0.92 * this.currentScale, -0.05),
    );
    this.budGlow.quaternion.copy(this.camera.quaternion);
    this.budGlow.scale.setScalar(1.12 * this.currentScale);
    this.budGlowMaterial.uniforms.uOpacity.value = (1.0 - smoothstep(0.12, 0.42, this.bloom)) * 0.18;

    const time = this.time;

    const cardVisibility = smoothstep(0.07, 0.30, this.bloom);
    const budVisibility = 1.0 - smoothstep(0.14, 0.44, this.bloom);
    const heartVisibility = smoothstep(0.22, 0.55, this.bloom);

    this.cards.visible = cardVisibility > 0.005;
    this.particles.visible = cardVisibility > 0.005;
    this.spiral.visible = heartVisibility > 0.005;
    this.buds.visible = budVisibility > 0.005;
    this.budShell.visible = budVisibility > 0.005;
    this.budGlow.visible = budVisibility > 0.005;

    this.cardMaterial.uniforms.uTime.value = time;
    this.cardMaterial.uniforms.uBloom.value = this.bloom;
    this.cardMaterial.uniforms.uEnergy.value = this.energy;
    this.cardMaterial.uniforms.uWind.value.copy(this.wind);
    this.cardMaterial.uniforms.uOpacity.value = 0.94 * cardVisibility;

    this.particleMaterial.uniforms.uTime.value = time;
    this.particleMaterial.uniforms.uBloom.value = this.bloom;
    this.particleMaterial.uniforms.uEnergy.value = this.energy;
    this.particleMaterial.uniforms.uWind.value.copy(this.wind);
    this.particleMaterial.uniforms.uPointScale.value = this.currentScale;
    this.particleMaterial.uniforms.uParticleOpacity.value = 0.95 * cardVisibility;

    this.budMaterial.uniforms.uTime.value = time;
    this.budMaterial.uniforms.uBloom.value = this.bloom;
    this.budMaterial.uniforms.uEnergy.value = this.energy;
    this.budMaterial.uniforms.uWind.value.copy(this.wind);
    this.budMaterial.uniforms.uPointScale.value = this.currentScale * 1.5;
    this.budMaterial.uniforms.uOpacity.value = budVisibility;
    this.budGlowMaterial.uniforms.uTime.value = time;
    this.budGlowMaterial.uniforms.uBloom.value = this.bloom;

    this.budShellMaterial.uniforms.uTime.value = time;
    this.budShellMaterial.uniforms.uBloom.value = this.bloom;
    this.budShellMaterial.uniforms.uOpacity.value = budVisibility;

    this.sparkMaterial.uniforms.uTime.value = time;
    this.sparkMaterial.uniforms.uBloom.value = this.bloom;
    this.sparkMaterial.uniforms.uEnergy.value = this.energy;
    this.sparkMaterial.uniforms.uWind.value.copy(this.wind);
    this.sparkMaterial.uniforms.uPointScale.value = this.currentScale;

    this.spiralMaterial.uniforms.uTime.value = time;
    this.spiralMaterial.uniforms.uBloom.value = this.bloom;
    this.spiralMaterial.uniforms.uOpacity.value = 0.96 * heartVisibility;

    this.haloMaterial.uniforms.uTime.value = time;
    this.haloMaterial.uniforms.uBloom.value = this.bloom;
    this.haloMaterial.uniforms.uOpacity.value = this.composition === 'intro' ? 0.85 : 1;
    this.coreMaterial.uniforms.uTime.value = time;
    this.coreMaterial.uniforms.uBloom.value = this.bloom;
    this.coreMaterial.uniforms.uOpacity.value = 0.44 + this.bloom * 0.30;

    this.dustMaterial.uniforms.uTime.value = time;
    this.dust.rotation.z = Math.sin(time * 0.02) * 0.03;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.dispose();
    this.cardGeometry.dispose();
    this.budGeometry.dispose();
    this.particleGeometry.dispose();
    this.sparkGeometry.dispose();
    this.cardMaterial.dispose();
    this.budMaterial.dispose();
    this.budGlowMaterial.dispose();
    this.budGlow.geometry.dispose();
    this.budShellMaterial.dispose();
    this.budShellGeometry.dispose();
    this.spiralGeometry.dispose();
    this.spiralMaterial.dispose();
    this.particleMaterial.dispose();
    this.sparkMaterial.dispose();
    this.haloMaterial.dispose();
    this.coreMaterial.dispose();
    this.dustMaterial.dispose();
  }
}

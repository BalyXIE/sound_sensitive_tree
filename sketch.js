/** Debug pane hidden by default; press D to toggle. */
let debugPaneVisible = false;

/** Click to simulate sound input for testing */
const CLICK_SIMULATE_SOUND = true;

/** Match current git tag (`git describe --tags`). */
const SKETCH_VERSION = 'v0.2.1';

// ── Tree structure ────────────────────────────────────────
const MAX_DEPTH       = 8;
const TRUNK_HUE_START = 80;      // yellow-green base
const TRUNK_HUE_RANGE = 200;     // sweeps backward → orange → red → magenta → blue

let treeGrowth = 0;
let treeSeed   = 0;
let baseLength;
/** Only outermost twigs — stable DFS order for fruits once the canopy exists. */
let twigTips = [];

// ── Wind ──────────────────────────────────────────────────
const WIND_SPEED    = 0.018;
const WIND_STRENGTH = 0.045;

// ── State machine ─────────────────────────────────────────
// 0: waiting for first interaction   1: alive (tree persists, grows with sound)
let state = 0;

// ── Growth tuning ─────────────────────────────────────────
const GROWTH_PER_EVENT = 0.03;   // one “step” of growth
/** How many steps each debounced sound adds (2 ≈ half as many claps needed). */
const GROWTH_STEPS_PER_SOUND = 2;
/** Fruits use outer `twigTips` only — those exist once the tree reaches full depth (~1). */
const FRUIT_THRESHOLD   = 1.0;
/** After this many ms below the adaptive threshold, `treeGrowth` begins to decrease. */
const SILENCE_BEFORE_SHRINK_MS = 1800;
/** Per-frame reduction of `treeGrowth` while sustained quiet (~0.0004 → full→0 in ~40–50 s at 60 fps). */
const SHRINK_PER_FRAME = 0.00038;

// ── Reaction (visual feedback on sound) ───────────────────
let reactIntensity = 0;           // 0→1, spikes on sound event, decays per frame
const REACT_DECAY  = 0.035;

// ── Fruits ────────────────────────────────────────────────
let fruits = [];
/** Terminal twigs are grouped by this size; one fruit picks a random twig inside each group. */
const FRUIT_TWIG_PAIR = 2;
/** Target ≈ this fraction of all twig tips with a berry (can exceed 1 pair → both twigs get berries over slots). */
const FRUIT_CANOPY_DENSITY = 0.72;
const FRUIT_MAX = 420;
/** Avoid stutter when the canopy first fills. */
const FRUIT_SPAWN_PER_FRAME = 16;
/** Max queued “drops” from claps; consumed slowly so berries fall a few at a time. */
const FRUIT_PLUCK_BUDGET_CAP = 28;

let fruitPluckBudget = 0;

// ── Background (Beijing time → sun / moon / sky / terrain) ─

// ── Mic ───────────────────────────────────────────────────
let mic;
let soundLevel = 0;
/** Rolling ~30s ambient; `soundThreshold` is derived each frame from recent samples. */
const AMBIENT_WINDOW_MS = 30000;
/** Lower values = easier to trigger (quiet rooms / soft claps). Raise if you get false triggers. */
const THRESHOLD_FLOOR   = 0.006;
const THRESHOLD_ABOVE_MEAN = 0.014;
const THRESHOLD_STD_COEF = 0.95;
/** p5.sound: boosts `mic.getLevel()` when hardware input is quiet (try 1.0–3.5). */
const MIC_INPUT_GAIN = 2.4;
let soundSampleRing = [];
let soundThreshold = THRESHOLD_FLOOR;
let ambientMeanLevel = 0;
let ambientStdLevel  = 0;
let lastSoundTime  = 0;
let debounceDelay  = 340;
/** `millis()` when level first went at/below threshold; `null` while loud enough to grow. */
let quietSinceMs = null;

// ── Instrumentation ───────────────────────────────────────
let micSetupNote = '';
let frameForLog  = 0;
let instrumentListenersAttached = false;
let micStreamStarted = false;
let globalAudioUnlockAttached = false;
let autoMicAttempts = 0;

function instrumentInit() {
  const el = document.getElementById('debug-instrumentation');
  if (el) el.hidden = !debugPaneVisible;
  if (!instrumentListenersAttached) {
    instrumentListenersAttached = true;
    window.addEventListener('unhandledrejection', (e) => {
      console.warn('[instrument] unhandledrejection', e.reason);
    });
    window.addEventListener('error', (e) => {
      console.warn('[instrument] error', e.message, e.filename, e.lineno);
    });
  }
}

/**
 * Browsers require a user gesture for the mic — cannot start from silence alone.
 * First tap / click / touch / key anywhere on the page tries to open the mic (not only the canvas).
 * If the user already granted this site “microphone: allow”, auto‑retries in draw() may succeed without a click.
 */
function attachGlobalAudioUnlockOnce() {
  if (globalAudioUnlockAttached || typeof window === 'undefined') return;
  globalAudioUnlockAttached = true;
  const unlock = () => { userEnabledAudioInput(); };
  window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  window.addEventListener('keydown', unlock, { capture: true, passive: true });
  window.addEventListener('touchend', unlock, { capture: true, passive: true });
}

function instrumentLine(label, value) {
  return label + ': ' + String(value);
}

function instrumentFlush(lines) {
  if (!debugPaneVisible) return;
  const el = document.getElementById('debug-instrumentation');
  if (el) el.textContent = lines.join('\n');
  frameForLog++;
  if (frameForLog % 45 === 0) {
    console.log('[instrument]', Object.fromEntries(lines.map((L) => {
      const i = L.indexOf(':');
      return i === -1 ? [L, ''] : [L.slice(0, i), L.slice(i + 2)];
    })));
  }
}

// ── Lifecycle ─────────────────────────────────────────────

function preload() {
  instrumentInit();
  attachGlobalAudioUnlockOnce();
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  colorMode(HSB, 360, 100, 100, 1.0);
  baseLength = height * 0.25;

  try {
    mic = new p5.AudioIn();
    micSetupNote = 'Click or tap the canvas to enable mic (browser audio policy)';
  } catch (e) {
    micSetupNote = 'mic error: ' + e.message;
    console.warn('[instrument]', micSetupNote, e);
  }
}

function smoothstep(edge0, edge1, x) {
  const t = constrain((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Decimal hour [0,24) in Asia/Shanghai (China standard time). */
function beijingDecimalHour() {
  try {
    const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const parts = s.split(' ');
    const timePart = parts.length > 1 ? parts[1] : parts[0];
    const seg = timePart.split(':');
    const hh = parseInt(seg[0], 10) || 0;
    const mm = parseInt(seg[1], 10) || 0;
    const ss = parseInt(seg[2], 10) || 0;
    return hh + mm / 60 + ss / 3600;
  } catch (e) {
    return hour() + minute() / 60 + second() / 3600;
  }
}

function nightAmountFromHour(t) {
  const dayBlend = smoothstep(5.25, 8.25, t) * (1 - smoothstep(17.75, 20.75, t));
  return 1 - dayBlend;
}

/** 0 at 18:00 → 1 by ~06:30 (Beijing); −1 daytime. Capped so dawn hand‑off is smooth. */
function nightPhase18to6(t) {
  if (t >= 18) return constrain((t - 18) / 12, 0, 1);
  if (t < 6.5) return constrain((t + 6) / 12, 0, 1);
  return -1;
}

function sunsetWarmth(t) {
  const a = smoothstep(16.25, 18.5, t) * (1 - smoothstep(19, 21.5, t));
  const b = (1 - smoothstep(4.5, 6.25, t)) * smoothstep(3, 5.25, t);
  return max(a, b * 0.65);
}

function drawAtmosphericSky(horizon, t) {
  const night = nightAmountFromHour(t);
  const warm = sunsetWarmth(t);
  const steps = min(160, max(48, ceil(horizon / 4)));
  noStroke();
  for (let i = 0; i < steps; i++) {
    const y0 = map(i, 0, steps, 0, horizon);
    const y1 = map(i + 1, 0, steps, 0, horizon);
    const yn = ((y0 + y1) * 0.5) / horizon;
    const thick = pow(yn, 1.12);

    let h = lerp(lerp(238, 212, 1 - night), lerp(218, 198, 1 - night), thick);
    let s = lerp(lerp(42, 22, 1 - night), lerp(28, 6, 1 - night), thick);
    let b = lerp(lerp(11, 62, 1 - night), lerp(16, 96, 1 - night), pow(thick, 0.78));

    if (warm > 0.02 && yn > 0.42) {
      const w = warm * smoothstep(0.42, 1, yn);
      h = lerp(h, 14, w * 0.62);
      s = lerp(s, min(92, 78 + night * 12), w * 0.72);
      b = lerp(b, 88, w * 0.38);
    }

    fill(h, s, b);
    rect(0, y0, width, max(1, y1 - y0 + 0.5));
  }
}

function drawHighClouds(horizon, t, night) {
  const dayVis = 1 - night * 0.92;
  noStroke();
  const seed = width * 0.0017 + height * 0.0009;
  for (let k = 0; k < 48; k++) {
    const u = k / 47;
    const cx = width * fract(0.13 + u * 1.71 + sin(k * 2.17 + seed) * 0.08);
    const cy = horizon * (0.08 + noise(k * 0.31, seed) * 0.42);
    const w = width * (0.08 + noise(k * 0.5) * 0.1);
    const h = w * (0.35 + noise(k * 0.2, 2) * 0.2);
    const a = (0.018 + noise(k * 0.15) * 0.035) * dayVis;
    fill(210, 4 + night * 8, 100, a);
    ellipse(cx, cy, w, h);
  }
}

function drawStars(horizon, t, night) {
  if (night < 0.25) return;
  const vis = night * night;
  noStroke();
  for (let i = 0; i < 120; i++) {
    const rx = fract(sin(i * 127.1 + width * 0.01) * 43758.5453);
    const ry = fract(sin(i * 311.7 + height * 0.01) * 6789.1234);
    if (ry > 0.72) continue;
    const sx = rx * width;
    const sy = ry * horizon * 0.88;
    const tw = 0.55 + 0.45 * sin(frameCount * 0.04 + i * 1.7);
    fill(210, 25, 96, vis * tw * 0.55);
    const sd = 1.1 + (i % 3) * 0.35;
    ellipse(sx, sy, sd, sd);
  }
}

function drawSunDisk(sx, sy, dia, strength) {
  noStroke();
  for (let r = dia * 3.2; r > dia * 0.5; r -= dia * 0.22) {
    const k = r / (dia * 3.2);
    fill(43, 28, 100, sq(1 - k) * 0.11 * strength);
    ellipse(sx, sy, r, r);
  }
  fill(38, 18, 100, 0.92 * strength);
  ellipse(sx, sy, dia, dia);
  fill(48, 10, 100, 0.28 * strength);
  ellipse(sx - dia * 0.1, sy - dia * 0.1, dia * 0.38, dia * 0.38);
}

function drawMoonDisk(mx, my, dia, strength) {
  noStroke();
  for (let r = dia * 2.4; r > 1; r -= dia * 0.16) {
    const k = r / (dia * 2.4);
    fill(215, 12, 92, pow(1 - k, 1.8) * 0.14 * strength);
    ellipse(mx, my, r, r);
  }
  fill(210, 8, 96, 0.88 * strength);
  ellipse(mx, my, dia, dia);
  fill(220, 22, 78, 0.12 * strength);
  ellipse(mx + dia * 0.12, my - dia * 0.06, dia * 0.45, dia * 0.38);
}

function drawTerrain(horizon, t) {
  const W = width;
  const H = height;
  const night = nightAmountFromHour(t);
  noStroke();

  fill(lerp(168, 152, night * 0.5), lerp(18, 32, night), lerp(22, 14, night));
  beginShape();
  vertex(-120, H + 60);
  vertex(-120, horizon + 6);
  bezierVertex(W * 0.04, horizon - 14, W * 0.22, horizon + 4, W * 0.42, horizon - 6);
  bezierVertex(W * 0.6, horizon + 8, W * 0.78, horizon - 10, W + 120, horizon + 10);
  vertex(W + 120, H + 60);
  endShape(CLOSE);

  fill(lerp(98, 108, night * 0.35), lerp(26, 18, night), lerp(36, 18, night));
  beginShape();
  vertex(-140, H + 80);
  vertex(-140, horizon + 44);
  bezierVertex(W * 0.02, horizon + 28, W * 0.16, horizon + 56, W * 0.32, horizon + 38);
  bezierVertex(W * 0.46, horizon + 50, W * 0.6, horizon + 32, W * 0.74, horizon + 46);
  bezierVertex(W * 0.88, horizon + 36, W * 0.98, horizon + 52, W + 140, horizon + 48);
  vertex(W + 140, H + 80);
  endShape(CLOSE);

  fill(lerp(88, 96, night * 0.25), lerp(22, 16, night), lerp(48, 22, night));
  beginShape();
  vertex(-140, H + 80);
  vertex(-140, horizon + 62);
  bezierVertex(W * 0.08, horizon + 48, W * 0.28, horizon + 74, W * 0.5, horizon + 56);
  bezierVertex(W * 0.72, horizon + 68, W * 0.92, horizon + 52, W + 140, horizon + 72);
  vertex(W + 140, H + 80);
  endShape(CLOSE);

  const gl = (1 - night) * 0.22;
  fill(78, 18, 88, gl);
  beginShape();
  vertex(W * 0.02, H + 80);
  vertex(0, horizon + 88);
  bezierVertex(W * 0.24, horizon + 76, W * 0.5, horizon + 96, W * 0.78, horizon + 82);
  vertex(W, H + 80);
  endShape(CLOSE);
}

function drawBeijingDayNightBackground() {
  if (width < 4 || height < 4) {
    background(0, 0, 100);
    return;
  }
  const t = beijingDecimalHour();
  const horizon = height * 0.52;
  const night = nightAmountFromHour(t);

  drawAtmosphericSky(horizon, t);
  drawStars(horizon, t, night);

  if (t >= 5.2 && t <= 19.8) {
    const u = map(constrain(t, 5.2, 19.8), 5.2, 19.8, 0, PI);
    const elev = sin(u);
    let sunStr = smoothstep(0.02, 0.12, elev) * (1 - night * 1.05);
    sunStr = constrain(sunStr, 0, 1);
    if (elev > 0.03 && sunStr > 0.02) {
      const sunX = map(t, 5.2, 19.8, width * 0.06, width * 0.94);
      const sunY = horizon - elev * horizon * 0.9;
      drawSunDisk(sunX, sunY, min(width, height) * 0.052, sunStr);
    }
  }

  const np = nightPhase18to6(t);
  if (np >= 0 && night > 0.12) {
    let moonStr = constrain(night * (0.35 + 0.65 * sin(np * PI)), 0, 1);
    if (t < 10) moonStr *= 1 - smoothstep(5.0, 7.8, t);
    if (t >= 16) moonStr *= smoothstep(16.25, 18.75, t);
    const moonX = map(np, 0, 1, width * 0.91, width * 0.09);
    const moonY = horizon * 0.34 + sin(np * PI) * height * 0.2;
    if (moonStr > 0.06) {
      drawMoonDisk(moonX, moonY, min(width, height) * 0.04, moonStr);
    }
  }

  drawHighClouds(horizon, t, night);
  drawTerrain(horizon, t);
}

function pushSoundSampleForAmbient(v) {
  const t = millis();
  soundSampleRing.push({ t, v: constrain(v, 0, 1) });
  const cutoff = t - AMBIENT_WINDOW_MS;
  while (soundSampleRing.length > 0 && soundSampleRing[0].t < cutoff) {
    soundSampleRing.shift();
  }
  if (soundSampleRing.length > 4500) {
    soundSampleRing.splice(0, soundSampleRing.length - 4000);
  }
}

function updateAdaptiveSoundThreshold() {
  const n = soundSampleRing.length;
  if (n === 0) {
    ambientMeanLevel = 0;
    ambientStdLevel = 0;
    soundThreshold = THRESHOLD_FLOOR;
    return;
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += soundSampleRing[i].v;
  }
  ambientMeanLevel = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    varSum += sq(soundSampleRing[i].v - ambientMeanLevel);
  }
  ambientStdLevel = n > 1 ? sqrt(varSum / n) : 0;
  soundThreshold = max(
    THRESHOLD_FLOOR,
    ambientMeanLevel + THRESHOLD_ABOVE_MEAN + THRESHOLD_STD_COEF * ambientStdLevel
  );
}

function userEnabledAudioInput() {
  if (typeof userStartAudio === 'function') userStartAudio();
  try {
    const ac = typeof getAudioContext === 'function' ? getAudioContext() : null;
    if (ac && ac.state === 'suspended') {
      ac.resume().then(() => { micSetupNote = 'audio context: running — try speaking'; })
        .catch((e) => { micSetupNote = 'resume failed: ' + e.message; });
    }
    if (ac) micSetupNote = 'audio context: ' + ac.state + ' (allow mic if prompted)';
  } catch (e) { micSetupNote = 'audio unlock: ' + e.message; }
  if (!mic) return;
  if (micStreamStarted) {
    try {
      if (typeof mic.amp === 'function') mic.amp(MIC_INPUT_GAIN);
    } catch (e) { /* ignore */ }
    return;
  }
  try { mic.start(); }
  catch (e) {
    micSetupNote = 'mic.start: ' + e.message + ' — tap anywhere once';
    return;
  }
  micStreamStarted = true;
  micSetupNote = 'mic on — clap to grow';
  const hint = document.getElementById('mic-hint');
  if (hint) hint.style.display = 'none';
  try {
    if (typeof mic.amp === 'function') mic.amp(MIC_INPUT_GAIN);
  } catch (e) { console.warn('[instrument] mic.amp', e); }
}

// ── Procedural tree (bezier curves, asymmetric branching) ─

function drawBranch(x1, y1, angle, len, depth) {
  // Consume random() in a fixed pattern so the seed produces a stable tree shape.
  // Structure decisions (deterministic per treeSeed):
  let curvature = random(-0.18, 0.18);
  let nKids;
  if (depth === 0)      nKids = floor(random(3, 5));   // 3–4 main branches
  else if (depth < 3)   nKids = floor(random(2, 4));    // 2–3
  else                   nKids = 2;

  let childData = [];
  for (let i = 0; i < nKids; i++) {
    let baseSpread = map(i, 0, max(nKids - 1, 1), -0.5, 0.5);
    childData.push({
      spread: baseSpread + random(-0.12, 0.12),
      lenRatio: random(0.6, 0.78),
    });
  }

  // ── Visibility ──
  let maxVisible = treeGrowth * MAX_DEPTH;
  let visible = depth <= maxVisible;
  let fraction = visible ? min(maxVisible - depth, 1) : 0;

  // ── Wind + reaction jolt ──
  let wPhase  = frameCount * WIND_SPEED;
  let gWind   = sin(wPhase) * 0.55 + sin(wPhase * 2.1) * 0.25;
  let bWind   = gWind * WIND_STRENGTH * (depth / MAX_DEPTH);
  let localN  = (noise(depth * 0.5, frameCount * 0.007) - 0.5) * 0.025 * depth;
  // Jolt: fast oscillation that decays with reactIntensity, stronger at tips
  let jolt    = reactIntensity * sin(frameCount * 0.8 + depth * 1.5) * 0.12 * (depth / MAX_DEPTH);
  let a       = angle + bWind + localN + jolt;

  // ── Endpoints ──
  let drawLen = len * fraction;
  let fullEndX = x1 + cos(a) * len;
  let fullEndY = y1 + sin(a) * len;
  let endX = x1 + cos(a) * drawLen;
  let endY = y1 + sin(a) * drawLen;

  // True canopy ends (full length) — stable DFS order; only once tree reaches full depth
  if (depth === MAX_DEPTH && treeGrowth * MAX_DEPTH >= MAX_DEPTH) {
    twigTips.push({ x: fullEndX, y: fullEndY });
  }

  // ── Draw curved branch ──
  if (visible && fraction > 0) {
    let t = depth / MAX_DEPTH;
    let h = (TRUNK_HUE_START - t * TRUNK_HUE_RANGE + 720) % 360;
    let ri = reactIntensity;
    h = (h + ri * 50) % 360;
    let sat = lerp(80, 15, ri);
    let bri = lerp(95, 100, ri);
    let alp = map(depth, 0, MAX_DEPTH, 1.0, 0.75);

    let trunkPx = max(baseLength * 0.035, 4);
    let thickness = map(depth, 0, MAX_DEPTH, trunkPx, 0.6) * fraction;

    stroke(h, sat, bri, alp);
    strokeWeight(max(thickness, 0.5));
    strokeCap(ROUND);
    noFill();

    let dx = endX - x1;
    let dy = endY - y1;
    let bLen = sqrt(dx * dx + dy * dy);
    if (bLen > 0.5) {
      let nx = -dy / bLen;
      let ny =  dx / bLen;
      let off = bLen * curvature;
      bezier(
        x1, y1,
        x1 + dx * 0.35 + nx * off * 0.9, y1 + dy * 0.35 + ny * off * 0.9,
        x1 + dx * 0.65 + nx * off * 0.5, y1 + dy * 0.65 + ny * off * 0.5,
        endX, endY
      );
    }
  }

  // ── Recurse (always, for random-sequence stability) ──
  if (depth < MAX_DEPTH) {
    for (let cd of childData) {
      drawBranch(fullEndX, fullEndY, a + cd.spread, len * cd.lenRatio, depth + 1);
    }
  }
}

function drawTree() {
  twigTips = [];
  randomSeed(treeSeed);
  drawBranch(width / 2, height * 0.88, -HALF_PI, baseLength, 0);
  randomSeed(millis());
}

// ── Fruits ────────────────────────────────────────────────

function countLivingFruits() {
  let c = 0;
  for (const f of fruits) {
    if (f.mode !== 'gone') c++;
  }
  return c;
}

function desiredCanopyFruitCount(nTips) {
  if (nTips <= 0) return 0;
  const fromPairs = ceil(nTips / FRUIT_TWIG_PAIR);
  const fromDensity = floor(nTips * FRUIT_CANOPY_DENSITY);
  return min(FRUIT_MAX, max(fromPairs, fromDensity));
}

/** Deterministic spread: cycles through twig pairs, walks within a pair so both twigs can get berries over time. */
function tipIndexForFruitSlot(slot, nTips) {
  const pairs = max(1, ceil(nTips / FRUIT_TWIG_PAIR));
  const pi = slot % pairs;
  const t0 = min(pi * FRUIT_TWIG_PAIR, nTips - 1);
  const span = min(FRUIT_TWIG_PAIR, nTips - t0);
  const cycle = floor(slot / pairs);
  const o = span <= 1 ? 0 : cycle % span;
  return t0 + o;
}

function createFruitAtTip(tipIndex) {
  if (twigTips.length === 0) return;
  const ti = constrain(floor(tipIndex), 0, twigTips.length - 1);
  fruits.push({
    tipIndex: ti,
    size: 0.1,
    targetSize: random(5, 12),
    growthPhase: true,
    hue: random(0, 50),
    sat: random(80, 100),
    bri: random(75, 100),
    rotation: random(TWO_PI),
    mode: 'onTree',
    ripe: 0,
    onTreeAlpha: 1,
    px: 0,
    py: 0,
    vx: 0,
    vy: 0,
    fallAlpha: 1,
    lastTipX: null,
    lastTipY: null,
  });
}

function refillCanopyFruits() {
  if (twigTips.length === 0 || treeGrowth < FRUIT_THRESHOLD) return;
  const n = twigTips.length;
  const want = desiredCanopyFruitCount(n);
  let added = 0;
  while (countLivingFruits() < want && added < FRUIT_SPAWN_PER_FRAME) {
    createFruitAtTip(tipIndexForFruitSlot(countLivingFruits(), n));
    added++;
  }
}

function isTreeShrinking() {
  return state === 1 &&
    quietSinceMs !== null &&
    millis() - quietSinceMs >= SILENCE_BEFORE_SHRINK_MS;
}

/** At most one new fall per frame while react is up — uses `fruitPluckBudget` from each clap. */
function tryPluckOneFruitFromBudget() {
  if (fruitPluckBudget <= 0 || reactIntensity <= 0.28) return;
  const candidates = [];
  for (const f of fruits) {
    if (f.mode === 'onTree' && !f.growthPhase && f.ripe >= 0.55 && (f.onTreeAlpha ?? 1) > 0.08) {
      candidates.push(f);
    }
  }
  if (candidates.length === 0) return;
  const pick = candidates[floor(random(candidates.length))];
  const tip = twigTips.length > 0 ? twigTips[pick.tipIndex % twigTips.length] : null;
  if (!tip) return;
  pick.mode = 'falling';
  pick.px = tip.x;
  pick.py = tip.y;
  pick.vx = random(-1.2, 1.2);
  pick.vy = random(-0.5, 0.8);
  pick.fallAlpha = 1;
  fruitPluckBudget--;
}

function updateAndDisplayElements() {
  noStroke();

  const groundY = height * 0.92;
  const react = reactIntensity;
  const shrinking = isTreeShrinking();

  for (let f of fruits) {
    if (f.mode === 'gone') continue;
    if (f.mode === undefined) {
      f.mode = 'onTree';
      f.ripe = 0;
      f.fallAlpha = 1;
      f.onTreeAlpha = 1;
      f.px = 0;
      f.py = 0;
      f.vx = 0;
      f.vy = 0;
      f.lastTipX = null;
      f.lastTipY = null;
    }
    if (f.onTreeAlpha === undefined) f.onTreeAlpha = 1;

    if (f.growthPhase) {
      f.size += f.targetSize * 0.05;
      if (f.size >= f.targetSize) {
        f.size = f.targetSize;
        f.growthPhase = false;
      }
    }

    if (f.mode === 'onTree') {
      f.ripe = min(f.ripe + 0.0025, 1);
      if (shrinking) {
        f.onTreeAlpha = max(0, f.onTreeAlpha - SHRINK_PER_FRAME);
        if (f.onTreeAlpha <= 0) {
          f.mode = 'gone';
          continue;
        }
      } else if (f.onTreeAlpha < 1) {
        f.onTreeAlpha = min(1, f.onTreeAlpha + SHRINK_PER_FRAME * 2.5);
      }
      // Rare tiny chance so it still feels alive (does not cause mass drops)
      let tip =
        twigTips.length > 0 ? twigTips[f.tipIndex % twigTips.length] : null;
      if (
        tip &&
        !f.growthPhase &&
        f.ripe >= 0.55 &&
        react > 0.5 &&
        random() < 0.0012
      ) {
        f.mode = 'falling';
        f.px = tip.x;
        f.py = tip.y;
        f.vx = random(-1.2, 1.2);
        f.vy = random(-0.5, 0.8);
        f.fallAlpha = 1;
      }
    }

    if (f.mode === 'onTree') {
      let tip2 =
        twigTips.length > 0 ? twigTips[f.tipIndex % twigTips.length] : null;
      if (tip2) {
        f.lastTipX = tip2.x;
        f.lastTipY = tip2.y;
        push();
        translate(tip2.x, tip2.y);
        rotate(f.rotation);
        let fh = (f.hue + react * 50) % 360;
        let fs = lerp(f.sat, 15, react);
        let fb = lerp(f.bri, 100, react);
        let ripeTint = lerp(0, 18, f.ripe);
        const a = 0.9 * f.onTreeAlpha;
        fill((fh + ripeTint) % 360, fs, fb, a);
        ellipse(0, 0, f.size);
        pop();
      } else if (f.lastTipX != null) {
        f.mode = 'falling';
        f.px = f.lastTipX;
        f.py = f.lastTipY;
        f.vx = random(-0.9, 0.9);
        f.vy = random(-0.3, 0.5);
        f.fallAlpha = 1;
      }
    } else if (f.mode === 'falling') {
      f.vy += 0.42;
      f.px += f.vx;
      f.py += f.vy;
      if (shrinking) {
        f.fallAlpha = max(0, f.fallAlpha - SHRINK_PER_FRAME * 0.85);
        if (f.fallAlpha <= 0) {
          f.mode = 'gone';
          continue;
        }
      }
      if (f.py >= groundY - f.size * 0.35) {
        f.py = groundY - f.size * 0.35;
        f.vy = 0;
        f.vx *= 0.88;
        f.mode = 'ground';
      }
      push();
      fill(f.hue, f.sat, f.bri, 0.9 * f.fallAlpha);
      ellipse(f.px, f.py, f.size);
      pop();
    } else if (f.mode === 'ground') {
      if (shrinking) {
        f.fallAlpha -= SHRINK_PER_FRAME;
      } else {
        f.fallAlpha -= 0.007;
      }
      if (f.fallAlpha <= 0) {
        f.mode = 'gone';
      } else {
        push();
        fill(f.hue, f.sat, f.bri, 0.88 * f.fallAlpha);
        ellipse(f.px, f.py, f.size);
        pop();
      }
    }
  }

  tryPluckOneFruitFromBudget();
}

// ── State transitions ─────────────────────────────────────

function tryAdvanceFromSound() {
  if (millis() - lastSoundTime <= debounceDelay) return;

  if (state === 0) {
    state = 1;
    treeSeed = floor(millis());
  }

  if (state === 1) {
    const step = GROWTH_PER_EVENT * GROWTH_STEPS_PER_SOUND;
    treeGrowth = min(treeGrowth + step, 1);
    reactIntensity = 1.0;
    const add = floor(random(2, 6));
    fruitPluckBudget = min(FRUIT_PLUCK_BUDGET_CAP, fruitPluckBudget + add);
  }

  lastSoundTime = millis();
}

// ── Main draw loop ────────────────────────────────────────

function draw() {
  drawBeijingDayNightBackground();

  // If mic permission was already granted for this origin, this sometimes succeeds without a click.
  if (mic && !micStreamStarted && autoMicAttempts < 90) {
    autoMicAttempts++;
    if (autoMicAttempts === 1 || autoMicAttempts === 15 || autoMicAttempts === 45) {
      userEnabledAudioInput();
    }
  }

  if (mic) {
    try { soundLevel = mic.getLevel(); }
    catch (e) { soundLevel = 0; }
  } else {
    soundLevel = 0;
  }

  pushSoundSampleForAmbient(soundLevel);
  updateAdaptiveSoundThreshold();

  reactIntensity = max(reactIntensity - REACT_DECAY, 0);

  if (soundLevel > soundThreshold) {
    quietSinceMs = null;
    tryAdvanceFromSound();
  } else if (quietSinceMs === null) {
    quietSinceMs = millis();
  }

  if (
    state === 1 &&
    quietSinceMs !== null &&
    millis() - quietSinceMs >= SILENCE_BEFORE_SHRINK_MS
  ) {
    treeGrowth = max(0, treeGrowth - SHRINK_PER_FRAME);
  }

  if (state === 1) {
    drawTree();

    if (treeGrowth >= FRUIT_THRESHOLD && twigTips.length > 0) {
      refillCanopyFruits();
    }
    if (fruits.length > 0) {
      updateAndDisplayElements();
    }
  }

  if (debugPaneVisible) {
    let acState = 'n/a';
    try {
      if (typeof getAudioContext === 'function') {
        const ac = getAudioContext();
        if (ac) acState = ac.state;
      }
    } catch (e) { acState = 'err'; }

    const gUM = typeof navigator !== 'undefined'
      && navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ? 'available' : 'missing';

    let bjClock = '';
    try {
      bjClock = new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      });
    } catch (e) { bjClock = '?'; }

    instrumentFlush([
      instrumentLine('Beijing (Asia/Shanghai)', bjClock),
      instrumentLine('secure context', window.isSecureContext),
      instrumentLine('audio context', acState),
      instrumentLine('mic note', micSetupNote),
      instrumentLine('state', state),
      instrumentLine('treeGrowth', nf(treeGrowth, 1, 3)),
      instrumentLine('soundLevel', nf(soundLevel, 1, 5)),
      instrumentLine(
        'ambient ~30s',
        nf(ambientMeanLevel, 1, 4) + '  σ ' + nf(ambientStdLevel, 1, 4) + '  n ' + soundSampleRing.length
      ),
      instrumentLine('sound thresh', nf(soundThreshold, 1, 5)),
      instrumentLine(
        'quiet / shrink',
        quietSinceMs === null
          ? '—'
          : nf((millis() - quietSinceMs) / 1000, 1, 1) +
              's / ' +
              (quietSinceMs !== null &&
              millis() - quietSinceMs >= SILENCE_BEFORE_SHRINK_MS
                ? 'on'
                : 'wait')
      ),
      instrumentLine('react', nf(reactIntensity, 1, 2)),
      instrumentLine('twigs (fruit)', twigTips.length),
      instrumentLine(
        'fruits',
        countLivingFruits() +
          '/' +
          desiredCanopyFruitCount(max(1, twigTips.length)) +
          '  onTree ' +
          fruits.filter((f) => f.mode === 'onTree').length +
          '  fall ' +
          fruits.filter((f) => f.mode === 'falling' || f.mode === 'ground').length
      ),
      instrumentLine('click sim', CLICK_SIMULATE_SOUND ? 'on' : 'off'),
      instrumentLine('version', SKETCH_VERSION),
    ]);
  }
}

// ── Event handlers ────────────────────────────────────────

function keyPressed() {
  if (key === 'f' || key === 'F') fullscreen(true);
  else if (key === 'd' || key === 'D') {
    debugPaneVisible = !debugPaneVisible;
    const el = document.getElementById('debug-instrumentation');
    if (el) el.hidden = !debugPaneVisible;
  }
}

function onCanvasPointerDown() {
  userEnabledAudioInput();
  if (CLICK_SIMULATE_SOUND) tryAdvanceFromSound();
}

function mousePressed()  { onCanvasPointerDown(); }
function touchStarted()  { onCanvasPointerDown(); return false; }

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  baseLength = height * 0.25;
}

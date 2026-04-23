/** Troubleshooting panel — hide with ?instrument=0 */
const INSTRUMENT =
  typeof location !== 'undefined' && !/[?&]instrument=0(?:&|$)/.test(location.search);

/** Click to simulate sound input for testing */
const CLICK_SIMULATE_SOUND = true;

/** Match current git tag (`git describe --tags`). */
const SKETCH_VERSION = 'v0.2.0';

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
const GROWTH_PER_EVENT  = 0.03;   // small bump per clap/click — ~33 events to full
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
let fruits     = [];
let fruitCount = 25;

// ── Mic ───────────────────────────────────────────────────
let mic;
let soundLevel = 0;
/** Rolling ~30s ambient; `soundThreshold` is derived each frame from recent samples. */
const AMBIENT_WINDOW_MS = 30000;
const THRESHOLD_FLOOR   = 0.016;
const THRESHOLD_ABOVE_MEAN = 0.024;
const THRESHOLD_STD_COEF = 1.35;
let soundSampleRing = [];
let soundThreshold = THRESHOLD_FLOOR;
let ambientMeanLevel = 0;
let ambientStdLevel  = 0;
let lastSoundTime  = 0;
let debounceDelay  = 300;
/** `millis()` when level first went at/below threshold; `null` while loud enough to grow. */
let quietSinceMs = null;

// ── Instrumentation ───────────────────────────────────────
let micSetupNote = '';
let frameForLog  = 0;

function instrumentInit() {
  if (!INSTRUMENT) return;
  const el = document.getElementById('debug-instrumentation');
  if (el) el.hidden = false;
  window.addEventListener('unhandledrejection', (e) => {
    console.warn('[instrument] unhandledrejection', e.reason);
  });
  window.addEventListener('error', (e) => {
    console.warn('[instrument] error', e.message, e.filename, e.lineno);
  });
}

function instrumentLine(label, value) {
  return label + ': ' + String(value);
}

function instrumentFlush(lines) {
  if (!INSTRUMENT) return;
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
  try { mic.start(); } catch (e) { micSetupNote = 'mic.start: ' + e.message; }
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
    // Reaction flash: shift hue toward warm white/gold, desaturate, brighten
    let ri = reactIntensity;
    h   = (h + ri * 50) % 360;
    let sat = lerp(80, 15, ri);
    let bri = lerp(95, 100, ri);
    let alp = map(depth, 0, MAX_DEPTH, 1.0, 0.75);

    let trunkPx = max(baseLength * 0.035, 4);
    let thickness = map(depth, 0, MAX_DEPTH, trunkPx, 0.6) * fraction;

    stroke(h, sat, bri, alp);
    strokeWeight(max(thickness, 0.5));
    strokeCap(ROUND);
    noFill();

    // Bezier control points: perpendicular offset for a gentle arc
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

function createFruit() {
  if (twigTips.length === 0) return;
  fruits.push({
    tipIndex: floor(random(twigTips.length)),
    size: 0.1,
    targetSize: random(6, 14),
    growthPhase: true,
    hue: random(0, 50),
    sat: random(80, 100),
    bri: random(75, 100),
    rotation: random(TWO_PI),
    mode: 'onTree',
    ripe: 0,
    px: 0,
    py: 0,
    vx: 0,
    vy: 0,
    fallAlpha: 1,
    lastTipX: null,
    lastTipY: null,
  });
}

function updateAndDisplayElements() {
  noStroke();

  const groundY = height * 0.92;
  const react = reactIntensity;

  for (let f of fruits) {
    if (f.mode === 'gone') continue;
    if (f.mode === undefined) {
      f.mode = 'onTree';
      f.ripe = 0;
      f.fallAlpha = 1;
      f.px = 0;
      f.py = 0;
      f.vx = 0;
      f.vy = 0;
      f.lastTipX = null;
      f.lastTipY = null;
    }

    if (f.growthPhase) {
      f.size += f.targetSize * 0.05;
      if (f.size >= f.targetSize) {
        f.size = f.targetSize;
        f.growthPhase = false;
      }
    }

    if (f.mode === 'onTree') {
      f.ripe = min(f.ripe + 0.0025, 1);
      let tip =
        twigTips.length > 0 ? twigTips[f.tipIndex % twigTips.length] : null;
      if (
        tip &&
        !f.growthPhase &&
        f.ripe >= 0.55 &&
        react > 0.45 &&
        random() < 0.035 * react * (0.35 + f.ripe)
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
        fill((fh + ripeTint) % 360, fs, fb, 0.9);
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
      f.fallAlpha -= 0.007;
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

}

// ── State transitions ─────────────────────────────────────

function tryAdvanceFromSound() {
  if (millis() - lastSoundTime <= debounceDelay) return;

  if (state === 0) {
    state = 1;
    treeSeed = floor(millis());
  }

  if (state === 1) {
    treeGrowth = min(treeGrowth + GROWTH_PER_EVENT, 1);
    reactIntensity = 1.0;
  }

  lastSoundTime = millis();
}

// ── Main draw loop ────────────────────────────────────────

function draw() {
  background(0, 0, 100);

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

    // Fruits only on real twigs (need full canopy so twigTips is populated)
    if (
      treeGrowth >= FRUIT_THRESHOLD &&
      twigTips.length > 0 &&
      fruits.length < fruitCount
    ) {
      createFruit();
    }
    if (fruits.length > 0) {
      updateAndDisplayElements();
    }
  }

  if (INSTRUMENT) {
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

    instrumentFlush([
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
        fruits.filter((f) => f.mode !== 'gone').length +
          '/' +
          fruitCount +
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

/** Troubleshooting panel — hide with ?instrument=0 */
const INSTRUMENT =
  typeof location !== 'undefined' && !/[?&]instrument=0(?:&|$)/.test(location.search);

/** Click to simulate sound input for testing */
const CLICK_SIMULATE_SOUND = true;

// ── Tree structure ────────────────────────────────────────
const MAX_DEPTH       = 8;
const TRUNK_HUE_START = 80;      // yellow-green base
const TRUNK_HUE_RANGE = 200;     // sweeps backward → orange → red → magenta → blue

let treeGrowth = 0;
let treeSeed   = 0;
let baseLength;
let branchTips = [];

// ── Wind ──────────────────────────────────────────────────
const WIND_SPEED    = 0.018;
const WIND_STRENGTH = 0.045;

// ── State machine ─────────────────────────────────────────
// 0: waiting for first interaction   1: alive (tree persists, grows with sound)
let state = 0;

// ── Growth tuning ─────────────────────────────────────────
const GROWTH_PER_EVENT  = 0.03;   // small bump per clap/click — ~33 events to full
const LEAF_THRESHOLD    = 0.5;
const FRUIT_THRESHOLD   = 0.8;

// ── Reaction (visual feedback on sound) ───────────────────
let reactIntensity = 0;           // 0→1, spikes on sound event, decays per frame
const REACT_DECAY  = 0.035;

// ── Leaves & fruits ───────────────────────────────────────
let leaves     = [];
let fruits     = [];
let leafCount  = 120;
let fruitCount = 25;

// ── Mic ───────────────────────────────────────────────────
let mic;
let soundLevel     = 0;
let soundThreshold = 0.1;
let lastSoundTime  = 0;
let debounceDelay  = 300;

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

    // Collect tips
    if (fraction < 1 || depth >= MAX_DEPTH - 1 || nKids === 0) {
      branchTips.push({ x: endX, y: endY });
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
  branchTips = [];
  randomSeed(treeSeed);
  drawBranch(width / 2, height * 0.88, -HALF_PI, baseLength, 0);
  randomSeed(millis());
}

// ── Leaves & fruits ───────────────────────────────────────

function createLeaf() {
  if (branchTips.length === 0) return;
  leaves.push({
    tipIndex: floor(random(branchTips.length)),
    size: 0.1,
    targetSize: random(4, 11),
    growthPhase: true,
    rotation: random(TWO_PI),
    hue: random(80, 155),
    sat: random(55, 85),
    bri: random(50, 80),
  });
}

function createFruit() {
  if (branchTips.length === 0) return;
  fruits.push({
    tipIndex: floor(random(branchTips.length)),
    size: 0.1,
    targetSize: random(6, 14),
    growthPhase: true,
    hue: random(0, 50),
    sat: random(80, 100),
    bri: random(75, 100),
    rotation: random(TWO_PI),
  });
}

function updateAndDisplayElements() {
  noStroke();

  for (let leaf of leaves) {
    if (leaf.growthPhase) {
      leaf.size += leaf.targetSize * 0.05;
      if (leaf.size >= leaf.targetSize) {
        leaf.size = leaf.targetSize;
        leaf.growthPhase = false;
      }
    }
    let tip = branchTips[leaf.tipIndex % branchTips.length];
    if (!tip) continue;
    push();
    translate(tip.x, tip.y);
    rotate(leaf.rotation);
    let lh = (leaf.hue + reactIntensity * 50) % 360;
    let ls = lerp(leaf.sat, 15, reactIntensity);
    let lb = lerp(leaf.bri, 100, reactIntensity);
    fill(lh, ls, lb, 0.8);
    ellipse(0, 0, leaf.size, leaf.size * 1.5);
    pop();
  }

  for (let f of fruits) {
    if (f.growthPhase) {
      f.size += f.targetSize * 0.05;
      if (f.size >= f.targetSize) {
        f.size = f.targetSize;
        f.growthPhase = false;
      }
    }
    let tip = branchTips[f.tipIndex % branchTips.length];
    if (!tip) continue;
    push();
    translate(tip.x, tip.y);
    rotate(f.rotation);
    let fh = (f.hue + reactIntensity * 50) % 360;
    let fs = lerp(f.sat, 15, reactIntensity);
    let fb = lerp(f.bri, 100, reactIntensity);
    fill(fh, fs, fb, 0.9);
    ellipse(0, 0, f.size);
    pop();
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

  reactIntensity = max(reactIntensity - REACT_DECAY, 0);

  if (soundLevel > soundThreshold) {
    tryAdvanceFromSound();
  }

  if (state === 1) {
    drawTree();

    // Leaves appear once the tree is half-grown
    if (treeGrowth >= LEAF_THRESHOLD && leaves.length < leafCount) {
      createLeaf();
    }
    // Fruits appear once the tree is nearly full
    if (treeGrowth >= FRUIT_THRESHOLD && fruits.length < fruitCount) {
      createFruit();
    }
    if (leaves.length > 0 || fruits.length > 0) {
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
      instrumentLine('react', nf(reactIntensity, 1, 2)),
      instrumentLine('tips', branchTips.length),
      instrumentLine('leaves', leaves.length + '/' + leafCount),
      instrumentLine('fruits', fruits.length + '/' + fruitCount),
      instrumentLine('click sim', CLICK_SIMULATE_SOUND ? 'on' : 'off'),
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

/** Keep in sync with the current git tag for this demo (see `git describe --tags`). */
const SKETCH_VERSION = 'v0.2.1';

let maxLevels = 12;

let startingHue = 200;

let mic, fft;

let angle = 0;

/** Endpoints of terminal twigs (tree space: origin bottom centre, y negative = up) */
let branchTips = [];

const FRUIT_COUNT = 28;
const SPAWN_STAGGER_FRAMES = 20;
const RIPEN_RATE = 0.0022;
const RIPEN_MAX = 1;
/** Per-fruit: how much angle delta counts as “enough” shake for a fall roll; decays → easier drops */
const SHAKE_GATE_START = 0.52;
const SHAKE_GATE_FLOOR = 0.028;
const SHAKE_GATE_DECAY = 0.00042;
const SHAKE_MIN_FOR_ROLL = 0.055;
const FALL_CHANCE_SCALE = 0.055;

let fruits = [];
let debugEl;

function setup() {
  createCanvas(windowWidth, windowHeight);
  angleMode(DEGREES);
  colorMode(HSB, 360, 100, 100, 1);

  mic = new p5.AudioIn();
  mic.start();
  fft = new p5.FFT();
  fft.setInput(mic);

  collectTips();
  initFruitSlots();

  debugEl = document.getElementById('debug-instrumentation');
}

/** Unique terminal tip indices — each fruit stays on its branch for good */
function assignUniqueTipIndices(n, count) {
  const used = new Set();
  const out = [];
  const phi = 0.618033988749895;
  for (let k = 0; k < count * 6 && out.length < count; k++) {
    const u = ((k + 1) * phi) % 1;
    const idx = min(floor(u * n), n - 1);
    if (!used.has(idx)) {
      used.add(idx);
      out.push(idx);
    }
  }
  while (out.length < count) {
    const j = floor(random(n));
    if (!used.has(j)) {
      used.add(j);
      out.push(j);
    }
  }
  return out;
}

function initFruitSlots() {
  fruits = [];
  const n = branchTips.length;
  if (n === 0) return;
  const tips = assignUniqueTipIndices(n, FRUIT_COUNT);
  for (let i = 0; i < tips.length; i++) {
    fruits.push({
      tipIndex: tips[i],
      spawnDelay: i * SPAWN_STAGGER_FRAMES,
      age: 0,
      size: 0.01,
      targetSize: random(5, 11),
      ripen: 0,
      shakeGate: SHAKE_GATE_START,
      state: 'dormant',
      vx: 0,
      vy: 0,
      x: 0,
      y: 0,
      rot: random(TWO_PI),
      groundAlpha: 1,
    });
  }
}

function collectTips() {
  branchTips = [];
  collectTipsLine(1, 0, 0, -90);
}

/** Only the outermost segment ends (no further split) count as tips */
function collectTipsLine(level, x, y, heading) {
  const size = (height / 4) * (1 / level);
  const rad = radians(heading);
  const x2 = x + cos(rad) * size;
  const y2 = y + sin(rad) * size;
  level++;
  if (level < maxLevels) {
    collectTipsLine(level, x2, y2, heading + angle);
    collectTipsLine(level, x2, y2, heading - angle);
  } else {
    branchTips.push({ x: x2, y: y2 });
  }
}

function drawLine(level, x, y, heading) {
  const size = (height / 4) * (1 / level);
  const hue = startingHue + level * 7.5;
  stroke(hue, 100, 100, 0.5);
  strokeWeight(5);
  const rad = radians(heading);
  const x2 = x + cos(rad) * size;
  const y2 = y + sin(rad) * size;
  line(x, y, x2, y2);
  level++;
  if (level < maxLevels) {
    drawLine(level, x2, y2, heading + angle);
    drawLine(level, x2, y2, heading - angle);
  }
}

function draw() {
  const spectrum = fft.analyze();
  let amp = 0;
  for (let a = 0; a < spectrum.length; a++) {
    amp += spectrum[a];
  }
  const ampAverage = amp / spectrum.length;

  const nextAngle = map(ampAverage, 0, 100, 0, 45, true);
  const rawShake = abs(nextAngle - angle);
  const shake = rawShake < 0.1 ? 0 : rawShake;
  angle = nextAngle;

  background(angle * 3, 100, 100);

  collectTips();

  if (fruits.length === 0 && branchTips.length > 0) {
    initFruitSlots();
  }

  updateFruits(shake);

  push();
  translate(width / 2, height);
  drawLine(1, 0, 0, -90);
  drawFruitsOnTree();
  pop();

  drawFruitsFallenLayer();

  flushExcitedDebug(ampAverage, shake);
}

function flushExcitedDebug(ampAverage, shake) {
  if (!debugEl) return;
  const onTree = fruits.filter((f) => f.state === 'onTree').length;
  const ripe = fruits.filter((f) => f.state === 'onTree' && f.ripen >= RIPEN_MAX).length;
  debugEl.textContent = [
    'amp (avg): ' + nf(ampAverage, 1, 2),
    'angle: ' + nf(angle, 1, 2),
    'shake: ' + nf(shake, 1, 3),
    'tips: ' + branchTips.length,
    'fruits on tree: ' + onTree,
    'fully ripe: ' + ripe,
    'click sim: n/a',
    'version: ' + SKETCH_VERSION,
  ].join('\n');
}

function updateFruits(shake) {
  for (const f of fruits) {
    if (f.state === 'gone') continue;

    if (f.state === 'dormant') {
      f.age++;
      if (f.age >= f.spawnDelay) {
        f.state = 'growing';
      }
      continue;
    }

    if (f.state === 'growing') {
      f.size += f.targetSize * 0.045;
      if (f.size >= f.targetSize) {
        f.size = f.targetSize;
        f.state = 'onTree';
        f.shakeGate = SHAKE_GATE_START;
      }
      continue;
    }

    if (f.state === 'onTree') {
      f.ripen = min(f.ripen + RIPEN_RATE, RIPEN_MAX);
      f.shakeGate = max(SHAKE_GATE_FLOOR, f.shakeGate - SHAKE_GATE_DECAY);
      if (f.ripen >= RIPEN_MAX && shake > SHAKE_MIN_FOR_ROLL) {
        const gate = max(f.shakeGate, SHAKE_GATE_FLOOR);
        const p = min(
          0.42,
          FALL_CHANCE_SCALE * sq(shake / gate) + shake * 0.014
        );
        if (random() < p) {
          startFall(f);
        }
      }
    }
  }

  updateFallingFruits();
}

function startFall(f) {
  const tip = branchTips[f.tipIndex % branchTips.length];
  if (!tip) return;
  f.state = 'falling';
  f.x = tip.x;
  f.y = tip.y;
  f.vx = random(-1.1, 1.1);
  f.vy = random(-0.2, 0.6);
}

function updateFallingFruits() {
  const g = 0.45;
  const groundY = 0;
  for (const f of fruits) {
    if (f.state === 'falling') {
      f.vy += g;
      f.x += f.vx;
      f.y += f.vy;
      if (f.y >= groundY - f.size * 0.35) {
        f.y = groundY - f.size * 0.35;
        f.vy = 0;
        f.vx *= 0.85;
        f.state = 'ground';
        f.groundAlpha = 1;
      }
    } else if (f.state === 'ground') {
      f.groundAlpha -= 0.008;
      if (f.groundAlpha <= 0) {
        f.state = 'gone';
      }
    }
  }
}

/** Ripeness 0…1 → green → yellow → orange (HSB) */
function fruitColorFromRipen(ripen) {
  const u = constrain(ripen, 0, 1);
  let h;
  let s;
  let b;
  if (u < 0.5) {
    const t = u / 0.5;
    h = lerp(122, 58, t);
    s = lerp(70, 86, t);
    b = lerp(52, 94, t);
  } else {
    const t = (u - 0.5) / 0.5;
    h = lerp(58, 32, t);
    s = lerp(86, 98, t);
    b = lerp(94, 90, t);
  }
  return { h, s, b };
}

function fruitFillOnTree(f) {
  const { h, s, b } = fruitColorFromRipen(f.ripen);
  fill(h, s, b, 0.92);
}

function fruitFillFallen(f) {
  const { h, s, b } = fruitColorFromRipen(f.ripen);
  const a = f.state === 'ground' ? 0.88 * f.groundAlpha : 0.92;
  fill(h, s, b, a);
}

function drawFruitsOnTree() {
  noStroke();
  for (const f of fruits) {
    if (f.state !== 'growing' && f.state !== 'onTree') continue;
    const tip = branchTips[f.tipIndex % branchTips.length];
    if (!tip) continue;
    push();
    translate(tip.x, tip.y);
    rotate(f.rot);
    if (f.state === 'growing') {
      const gProg = constrain(f.size / max(f.targetSize, 0.01), 0, 1);
      const { h, s, b } = fruitColorFromRipen(f.ripen * 0.15 * gProg);
      fill(h, s, b, 0.78);
    } else {
      fruitFillOnTree(f);
    }
    ellipse(0, 0, f.size, f.size * 1.05);
    pop();
  }
}

function drawFruitsFallenLayer() {
  push();
  translate(width / 2, height);
  noStroke();
  for (const f of fruits) {
    if (f.state === 'falling' || f.state === 'ground') {
      push();
      translate(f.x, f.y);
      rotate(f.rot);
      fruitFillFallen(f);
      ellipse(0, 0, f.size, f.size * 1.05);
      pop();
    }
  }
  pop();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

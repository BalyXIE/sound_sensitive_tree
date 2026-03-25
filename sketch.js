/** Set false, or open with ?instrument=0, to hide the troubleshooting panel. */
const INSTRUMENT =
  typeof location !== 'undefined' && !/[?&]instrument=0(?:&|$)/.test(location.search);

/** If true, each click (debounced) runs the same advance as a loud sound — isolates mic vs rendering. */
const CLICK_SIMULATE_SOUND = true;

let bg;
let bgLoadState = 'loading';
  let circleSize = 100;
  let offsetX = 0;
  let offsetY = 0;
  let state = 0;
  
  let leaves = [];
  let fruits = [];
  let leafCount = 200;
  let fruitCount = 40;
  
  let minFallSpeed = 1;
  let maxFallSpeed = 3;
  
  let minLeafSize = 5;
  let maxLeafSize = 15;
  
  let minFruitSize = 20;
  let maxFruitSize = 30;
  
  let mic;
  let soundLevel;
  let soundThreshold = 0.1;
  let lastSoundTime = 0;
  let debounceDelay = 300;
  
  let subState = 1;
  
  let bgAlpha = 0;
  let fadeIn = false;

  let micSetupNote = '';
  let frameForLog = 0;

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
  
  function preload() {
    instrumentInit();
    bg = loadImage(
      'assets/bg.png',
      () => { bgLoadState = 'loaded'; },
      (evt) => {
        bgLoadState = 'load failed (check path & server)';
        console.warn('[instrument] bg image error', evt);
      }
    );
  }
  
  function setup() {
    createCanvas(windowWidth, windowHeight);
    circleSize = min(width, height) / 2;
    offsetY = -height * 0.1;
    noStroke();
  
    try {
      mic = new p5.AudioIn();
      // Do not mic.start() here: AudioContext stays "suspended" until a user gesture,
      // so getLevel() stays 0 until the user clicks/taps (see userEnabledAudioInput).
      micSetupNote = 'Click or tap the canvas to enable mic (browser audio policy)';
    } catch (e) {
      micSetupNote = 'mic error: ' + e.message;
      console.warn('[instrument]', micSetupNote, e);
    }
  }

  function userEnabledAudioInput() {
    if (typeof userStartAudio === 'function') {
      userStartAudio();
    }
    try {
      const ac = typeof getAudioContext === 'function' ? getAudioContext() : null;
      if (ac && ac.state === 'suspended') {
        ac.resume().then(() => {
          micSetupNote = 'audio context: running — try speaking';
        }).catch((e) => {
          micSetupNote = 'resume failed: ' + e.message;
        });
      }
      if (ac) {
        micSetupNote = 'audio context: ' + ac.state + ' (allow mic if prompted)';
      }
    } catch (e) {
      micSetupNote = 'audio unlock: ' + e.message;
    }
    if (!mic) return;
    try {
      mic.start();
    } catch (e) {
      micSetupNote = 'mic.start: ' + e.message;
    }
  }
  
  function createLeaf() {
    let angle = random(TWO_PI);
    let distance = random(circleSize / 2);
  
    let leaf = {
      x: width / 2 + cos(angle) * distance,
      y: height / 2 + offsetY + sin(angle) * distance,
      size: 0.1,
      targetSize: random(minLeafSize, maxLeafSize),
      growthPhase: true,
      rotation: random(TWO_PI),
      color: color(random(50,150), random(100,200), random(50))
    };
  
    leaves.push(leaf);
  }
  
  function createFruit() {
    let angle = random(TWO_PI);
    let distance = random(circleSize / 2);
  
    let r = random(150,255);
    let g = random(50,200);
    let b = random(50,200);
  
    let fruit = {
      x: width / 2 + cos(angle) * distance,
      y: height / 2 + offsetY + sin(angle) * distance,
      size: 0.1,
      targetSize: random(minFruitSize, maxFruitSize),
      growthPhase: true,
      rotation: random(TWO_PI),
      rotSpeed: random(-0.05, 0.05),
      color: color(r,g,b),
  
      isFalling: false,
      speedY: random(1,2),
      gravity: 0.15
    };
  
    fruits.push(fruit);
  }
  
  function updateAndDisplayElements() {
  
    for (let leaf of leaves) {
  
      if (leaf.growthPhase) {
        leaf.size += leaf.targetSize * 0.05;
        if (leaf.size >= leaf.targetSize) {
          leaf.size = leaf.targetSize;
          leaf.growthPhase = false;
        }
      }
  
      push();
      translate(leaf.x, leaf.y);
      rotate(leaf.rotation);
      fill(leaf.color);
      ellipse(0, 0, leaf.size, leaf.size * 1.5);
      pop();
    }
  
    for (let i = fruits.length - 1; i >= 0; i--) {
      let f = fruits[i];
  
      if (f.growthPhase) {
        f.size += f.targetSize * 0.05;
        if (f.size >= f.targetSize) {
          f.size = f.targetSize;
          f.growthPhase = false;
        }
      }
  
      if (f.isFalling) {
        f.speedY += f.gravity;    
        f.y += f.speedY;
        f.rotation += f.rotSpeed;  
  
        if (f.y > height + f.size) {
          fruits.splice(i, 1);
          continue;
        }
      }
  
      push();
      translate(f.x, f.y);
      rotate(f.rotation);
      fill(f.color);
      ellipse(0, 0, f.size);
      pop();
    }
  
    if (state === 3 && fruits.length === 0) {
      state = 0;
    }
  }
  
  
  function triggerFruitDrop() {
    let available = fruits.filter(f => !f.isFalling);
  
    let count = min(floor(random(3,5)), available.length);
  
    for (let i = 0; i < count; i++) {
      let index = floor(random(available.length));
      available[index].isFalling = true;
      available.splice(index, 1);
    }
  }

  function tryAdvanceFromSound() {
    if (millis() - lastSoundTime <= debounceDelay) return;

    if (state === 0) {
      state = 1;
      fadeIn = false;
    } else if (state === 1) {
      state = 2;
      leaves = [];
      fruits = [];
      subState = 1;
    } else if (state === 2 && leaves.length >= leafCount && fruits.length >= fruitCount) {
      state = 3;
    } else if (state === 3) {
      triggerFruitDrop();
    }

    lastSoundTime = millis();
  }
  
  function draw() {
  
    if (state === 0) {
      background(255);
      bgAlpha = 0;
    } else {
  
      if (state === 1 && !fadeIn) fadeIn = true;
  
      if (fadeIn && bgAlpha < 255) {
        bgAlpha += 0.5;
      }
  
      tint(255, bgAlpha);
      image(bg, 0, 0, width, height);
      noTint();
    }
  
    if (mic) {
      try {
        soundLevel = mic.getLevel();
      } catch (e) {
        soundLevel = 0;
        micSetupNote = 'getLevel error: ' + e.message;
      }
    } else {
      soundLevel = 0;
    }
  
    if (soundLevel > soundThreshold) {
      tryAdvanceFromSound();
    }
  
    if (state === 2) {
  
      if (subState === 1) {
        if (leaves.length < leafCount) {
          createLeaf();
        } else {
          subState = 2;
        }
      }
  
      if (subState === 2) {
        if (fruits.length < fruitCount) {
          createFruit();
        }
      }
    }
  
    if (state !== 0) {
      updateAndDisplayElements();
    }

    if (INSTRUMENT) {
      let acState = 'n/a';
      try {
        if (typeof getAudioContext === 'function') {
          const ac = getAudioContext();
          if (ac) acState = ac.state;
        }
      } catch (e) {
        acState = 'err';
      }

      const gUM = typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia
        ? 'available'
        : 'missing (no mic API)';

      instrumentFlush([
        instrumentLine('page', location.href.split('?')[0]),
        instrumentLine('secure context', window.isSecureContext),
        instrumentLine('protocol', location.protocol),
        instrumentLine('getUserMedia', gUM),
        instrumentLine('audio context', acState),
        instrumentLine('mic note', micSetupNote),
        instrumentLine('bg image', bgLoadState),
        instrumentLine('state', state),
        instrumentLine('soundLevel', soundLevel !== undefined ? nf(soundLevel, 1, 5) : 'n/a'),
        instrumentLine('threshold', soundThreshold),
        instrumentLine('click sim', CLICK_SIMULATE_SOUND ? 'on (click to advance)' : 'off'),
        instrumentLine(
          'hint',
          CLICK_SIMULATE_SOUND
            ? 'Click advances like sound; compare to mic soundLevel'
            : 'White screen = state 0; loud noise should set state 1 if mic works'
        ),
      ]);
    }
  }
  
  function keyPressed() {
    if (key === 'f' || key === 'F') fullscreen(true);
  }
  
  function onCanvasPointerDown() {
    userEnabledAudioInput();
    if (CLICK_SIMULATE_SOUND) {
      tryAdvanceFromSound();
    }
  }

  function mousePressed() {
    onCanvasPointerDown();
  }

  function touchStarted() {
    onCanvasPointerDown();
    return false;
  }
  
  function windowResized() {
    resizeCanvas(windowWidth, windowHeight);
    circleSize = min(width, height) / 2;
    offsetY = -height * 0.1;
  }
function setup() {
    createCanvas(400, 400);
  }
  
  function draw() {
    background(220);
  }
  let bg;
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
  
  function preload() {
    bg = loadImage('assets/bg.png');
  }
  
  function setup() {
    createCanvas(windowWidth, windowHeight);
    circleSize = min(width, height) / 2;
    offsetY = -height * 0.1;
    noStroke();
  
    mic = new p5.AudioIn();
    mic.start();
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
  
    soundLevel = mic.getLevel();
  
    if (soundLevel > soundThreshold && millis() - lastSoundTime > debounceDelay) {
  
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
  }
  
  function keyPressed() {
    if (key === 'f' || key === 'F') fullscreen(true);
  }
  
  function mousePressed() {
    mic.start();
  }
  
  function windowResized() {
    resizeCanvas(windowWidth, windowHeight);
    circleSize = min(width, height) / 2;
    offsetY = -height * 0.1;
  }
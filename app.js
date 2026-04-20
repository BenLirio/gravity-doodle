// Gravity Doodle — an AI-driven falling-sand physics sandbox.
// Explosions are a CORE mechanic. Two built-in explosive materials:
//   EXPLOSIVE (powder) — bright red, stable until it touches ANYTHING
//                        that isn't explosive; then it chain-blasts outward
//                        in every direction with flying debris.
//   NITRO (liquid)     — orange, flows like water, violently detonates on
//                        contact with any non-liquid material.
//
// The seed palette: wall, sand, water, explosive, nitro.
// Everything else is invented by the user via the AI.
//
// Physics kinds:
//   static   — never moves (wall, plant, ice).
//   powder   — falls straight or diagonally and piles. denser powders
//              sink through lighter liquids. a `flow` 0..1 controls how
//              steep the pile is (0 = stacks vertically like cubes,
//              1 = collapses flat like flour).
//   liquid   — falls and spreads sideways. denser liquids sink below
//              lighter ones. `viscosity` 0..1 controls how reluctant the
//              liquid is to move sideways or fall (0 = water, 1 = honey).
//   gas      — rises and escapes the top. `lifeMin/lifeMax` decay it.
//   cellular — Conway-style cellular automaton. `born` and `survive` are
//              arrays of neighbor counts. `birthFrom` is an optional list
//              of element keys that count as "alive" neighbors for triggering
//              birth (defaults to self). Makes elements feel like living
//              organisms or spreading mold.
//
// Reactions: per element, list `{ other, becomes, chance }`. When this
// element is adjacent to `other`, with `chance` per frame `other`'s cell
// becomes `becomes` (or `null`/`"empty"` to destroy it). Built-in rules
// use this same system.
//
// Special reaction flag `explodes: true` — if present on a reaction, when
// it fires it triggers a radial explosion instead of the normal cell swap.
// The `explosionRadius` and `explosionPower` fields control blast size and
// how much fire/debris spawns. Explosions spawn flying debris particles that
// scatter outward in every direction, making blasts feel physically dramatic.

(function () {
  // ── Constants ──────────────────────────────────────────────────────────────
  const CELL = 3;
  const AI_ENDPOINT = 'https://uy3l6suz07.execute-api.us-east-1.amazonaws.com/ai';
  const SLUG = 'gravity-doodle';

  const EMPTY = 0;

  // ── Element registry ───────────────────────────────────────────────────────
  // 0 = EMPTY is reserved. Each element has a stable numeric id so the grid
  // can store one Uint8 per cell.
  //
  //   {
  //     id, key, displayName,
  //     kind:        'static'|'powder'|'liquid'|'gas',
  //     density:     1..9,
  //     viscosity:   0..1   (liquid only)
  //     flow:        0..1   (powder only — 1 = flows like flour, 0 = stacks)
  //     buoyancy:    0..1   (gas only — chance per frame to rise)
  //     stickiness:  0..1   (liquid/powder — chance per frame to stay put)
  //     lifeMin/lifeMax     (gas only)
  //     colors:      hex strings
  //     reactions:   [{other, becomes, chance}]
  //     isBuiltIn
  //   }

  const registry = {};            // id -> spec
  const keyToId  = {};            // key -> id

  function registerElement(spec) {
    registry[spec.id] = spec;
    keyToId[spec.key] = spec.id;
  }

  function nextCustomId() {
    let max = 0;
    for (const id in registry) if (+id > max) max = +id;
    return max + 1;
  }

  // ── Built-in seed elements ─────────────────────────────────────────────────
  // Three only — the rest are AI-invented. Stable ids so reactions can refer
  // to them.
  const WALL_ID      = 1;
  const SAND_ID      = 2;
  const WATER_ID     = 3;
  const EXPLOSIVE_ID = 4;
  const NITRO_ID     = 5;

  // Canonical sand: warm amber/golden tones. Earlier palettes leaned into deep
  // reds which made sand read as lava — a user flagged it explicitly. Keep
  // this to honey-to-tan variation only.
  const SAND_PALETTE = ['#e8a030', '#d89028', '#f0b848', '#e8a838', '#d8982c', '#f0c858', '#c88820', '#e0a030'];

  function initBuiltIns() {
    registerElement({
      id: WALL_ID, key: 'wall', displayName: 'wall',
      kind: 'static', density: 10,
      colors: ['#d8c8a0', '#c8b890', '#b8a880'],
      isBuiltIn: true,
      reactions: [],
    });
    registerElement({
      id: SAND_ID, key: 'sand', displayName: 'sand',
      kind: 'powder', density: 5, flow: 0.55, stickiness: 0,
      colors: SAND_PALETTE,
      isBuiltIn: true,
      reactions: [],
    });
    registerElement({
      id: WATER_ID, key: 'water', displayName: 'water',
      kind: 'liquid', density: 5, viscosity: 0, stickiness: 0,
      colors: ['#4aa8d8', '#3e9ac8', '#62b8e0', '#2e84b8', '#6cc0e8'],
      isBuiltIn: true,
      reactions: [],
    });
    // EXPLOSIVE: red powder. Stable on its own. Explodes violently when it
    // touches ANYTHING that isn't also explosive. Triggers chain reactions
    // with adjacent explosive cells. The blast scatters debris in all directions.
    registerElement({
      id: EXPLOSIVE_ID, key: 'explosive', displayName: 'explosive',
      kind: 'powder', density: 4, flow: 0.45, stickiness: 0,
      colors: ['#e02020', '#ff3030', '#c01010', '#ff5040', '#ff1010'],
      isBuiltIn: true,
      isExplosive: true,
      explosionRadius: 12,
      explosionPower: 1.8,
      reactions: [],
    });
    // NITRO: liquid explosive. Flows like water, detonates on contact with
    // any non-liquid (wall, powder, static). Pooling nitro can cause cascades.
    registerElement({
      id: NITRO_ID, key: 'nitro', displayName: 'nitro',
      kind: 'liquid', density: 4, viscosity: 0.05, stickiness: 0,
      colors: ['#ff8010', '#e86000', '#ffa030', '#ff6000', '#ffb840'],
      isBuiltIn: true,
      isExplosive: true,
      explosionRadius: 9,
      explosionPower: 1.4,
      reactions: [],
    });
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let canvas, ctx;
  let COLS, ROWS;
  let grid;        // Uint8Array of element ids
  let colors;      // per-cell color strings
  let life;        // Uint8Array auxiliary lifetime (gas decay)
  let flags;       // Uint8Array per-cell flags (bit0=moved, bit1=reacted)

  let selectedKey = 'explosive';
  let isPointerDown = false;
  let lastCell = null;
  let lastPointer = null;        // {c, r} of most recent pointer position
  let holdPaintTimer = null;     // continuous-paint interval while held still
  let animId = null;

  // Active pours: top-of-screen curtains. { id, frames, total, kind }
  let pours = [];

  // Debris particles: flying shrapnel after explosions.
  // Each: { x, y, vx, vy, life, maxLife, color }
  // These are rendered as sub-cell dots flying in arc trajectories.
  let debris = [];

  // Screen flash effect after explosion: { intensity 0-1 }
  let flashIntensity = 0;

  // ── Init ───────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    canvas = document.getElementById('main-canvas');
    ctx = canvas.getContext('2d');

    initBuiltIns();
    rebuildPalette();

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup',   onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerUp);

    // Mobile: suppress the "tap-and-hold selects the whole screen" behaviour
    // and double-tap/pinch-zoom on the canvas. iOS Safari ignores the
    // viewport `maximum-scale` in some contexts, so we also block gesture
    // events and touchmove at the element level.
    const swallowTouch = (e) => { if (e.cancelable) e.preventDefault(); };
    canvas.addEventListener('touchstart',  swallowTouch, { passive: false });
    canvas.addEventListener('touchmove',   swallowTouch, { passive: false });
    canvas.addEventListener('touchend',    swallowTouch, { passive: false });
    canvas.addEventListener('gesturestart',  (e) => e.preventDefault());
    canvas.addEventListener('gesturechange', (e) => e.preventDefault());
    canvas.addEventListener('gestureend',    (e) => e.preventDefault());
    canvas.addEventListener('contextmenu',   (e) => e.preventDefault());
    // Block the page-level double-tap-to-zoom that sometimes fires even when
    // the canvas swallows the touch.
    let lastTap = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTap < 350) {
        if (e.cancelable) e.preventDefault();
      }
      lastTap = now;
    }, { passive: false });

    animId = requestAnimationFrame(loop);

    showOverlay('paint explosive (red) onto the canvas\nthen pour sand on top to detonate!\n\nnested walls shape the blast.\nchain reactions cascade!');
    syncActionLabel();
    bindModal();
    bindElementFeedbackModal();
  });

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    canvas.width  = w;
    canvas.height = h;
    COLS = Math.floor(w / CELL);
    ROWS = Math.floor(h / CELL);
    initGrid();
  }

  function initGrid() {
    grid   = new Uint8Array(COLS * ROWS);
    colors = new Array(COLS * ROWS).fill(null);
    life   = new Uint8Array(COLS * ROWS);
    flags  = new Uint8Array(COLS * ROWS);
  }

  function idx(c, r) { return r * COLS + c; }

  // ── Overlay ────────────────────────────────────────────────────────────────
  function showOverlay(msg) {
    const el = document.getElementById('overlay-msg');
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function hideOverlay() {
    document.getElementById('overlay-msg').classList.add('hidden');
  }

  // ── Palette UI ─────────────────────────────────────────────────────────────
  function rebuildPalette() {
    const host = document.getElementById('palette-buttons');
    if (!host) return;
    host.innerHTML = '';

    // Seeds first in their canonical order, then invented elements in insertion
    // order, then the erase tool.
    const orderedIds = [WALL_ID, SAND_ID, WATER_ID, EXPLOSIVE_ID, NITRO_ID];
    const customIds = Object.keys(registry)
      .map(n => +n)
      .filter(id => !registry[id].isBuiltIn)
      .sort((a, b) => a - b);
    orderedIds.push(...customIds);

    for (const id of orderedIds) {
      const spec = registry[id];
      if (!spec) continue;
      host.appendChild(buildMaterialButton(spec));
    }
    host.appendChild(buildEraseButton());

    refreshActiveClass();
  }

  function buildMaterialButton(spec) {
    const btn = document.createElement('button');
    btn.type = 'button';
    // isExplosive built-ins get a special pulsing class for visibility
    const extraClass = spec.isBuiltIn && spec.isExplosive ? ' mat-explosive-builtin' : '';
    btn.className = 'tool-btn ' + (spec.isBuiltIn ? ('mat-' + spec.key) : 'mat-custom') + extraClass;
    btn.setAttribute('data-key', spec.key);
    if (!spec.isBuiltIn) {
      btn.style.setProperty('--swatch', spec.colors[0] || '#e8a030');
    }

    // Name label
    const label = document.createElement('span');
    label.textContent = spec.displayName.slice(0, 14);
    btn.appendChild(label);

    // Per-element flag — only on invented elements. The built-in seeds
    // (wall/sand/water) aren't user-generated, so flagging them doesn't
    // improve the AI-generated element quality the user is complaining
    // about.
    if (!spec.isBuiltIn) {
      const flag = document.createElement('span');
      flag.className = 'flag-el';
      flag.setAttribute('role', 'button');
      flag.setAttribute('aria-label', 'flag ' + spec.displayName);
      flag.setAttribute('title', 'flag ' + spec.displayName + ' — tell the builder what is wrong');
      flag.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        openElementFeedback(spec.key);
      });
      btn.appendChild(flag);

      // Touch long-press on the whole tile opens the flag modal too —
      // small tap targets on mobile make the flag glyph fiddly.
      attachLongPress(btn, () => openElementFeedback(spec.key));
    }

    btn.addEventListener('click', (e) => {
      // Ignore clicks that originated on the flag glyph (already handled).
      if (e.target && e.target.classList && e.target.classList.contains('flag-el')) return;
      setMaterial(spec.key);
    });
    return btn;
  }

  // Long-press: fires after 650ms of a stationary touch. Used to open the
  // element-flag modal without needing to hit the tiny flag glyph.
  function attachLongPress(el, handler) {
    let timer = null;
    let startX = 0, startY = 0;
    let fired = false;
    const start = (e) => {
      fired = false;
      const t = (e.touches && e.touches[0]) || e;
      startX = t.clientX; startY = t.clientY;
      timer = setTimeout(() => {
        fired = true;
        handler();
      }, 650);
    };
    const cancel = () => {
      if (timer) { clearTimeout(timer); timer = null; }
    };
    const move = (e) => {
      if (!timer) return;
      const t = (e.touches && e.touches[0]) || e;
      const dx = Math.abs(t.clientX - startX), dy = Math.abs(t.clientY - startY);
      if (dx > 8 || dy > 8) cancel();
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', (e) => {
      cancel();
      if (fired && e.cancelable) e.preventDefault();
    });
    el.addEventListener('touchcancel', cancel);
  }

  function buildEraseButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tool-btn mat-erase';
    btn.setAttribute('data-key', 'erase');
    btn.textContent = 'erase';
    btn.onclick = () => setMaterial('erase');
    return btn;
  }

  function refreshActiveClass() {
    document.querySelectorAll('.tool-btn').forEach(b => {
      const k = b.getAttribute('data-key');
      b.classList.toggle('active', k === selectedKey);
    });
  }

  window.setMaterial = function (key) {
    selectedKey = key;
    refreshActiveClass();
    syncActionLabel();
  };

  // Static materials and erase can't be poured — fall back to sand.
  function pourableKeyFor(key) {
    if (key === 'erase') return 'sand';
    const id = keyToId[key];
    if (!id) return 'sand';
    const spec = registry[id];
    if (!spec) return 'sand';
    if (spec.kind === 'static') return 'sand';
    return key;
  }

  function syncActionLabel() {
    const drop = document.getElementById('btn-drop');
    if (drop) drop.textContent = 'pour ' + pourableKeyFor(selectedKey);
  }

  // ── Reset ──────────────────────────────────────────────────────────────────
  window.clearAll = function () {
    pours = [];
    debris = [];
    flashIntensity = 0;
    pendingExplosions = [];
    initGrid();
    selectedKey = 'explosive';
    refreshActiveClass();
    syncActionLabel();
    showOverlay('paint explosive (red) onto the canvas\nthen pour sand on top to detonate!\n\nnested walls shape the blast.\nchain reactions cascade!');
  };

  // ── Drawing ────────────────────────────────────────────────────────────────
  function canvasCell(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return { c: Math.floor(x / CELL), r: Math.floor(y / CELL) };
  }

  function colorForSpec(spec) {
    if (!spec || !spec.colors || !spec.colors.length) return '#888';
    return spec.colors[Math.floor(Math.random() * spec.colors.length)];
  }

  function paintAt(c, r, brushR) {
    const key = selectedKey;
    if (key === 'erase') {
      for (let dc = -brushR; dc <= brushR; dc++) {
        for (let dr = -brushR; dr <= brushR; dr++) {
          if (dc * dc + dr * dr > brushR * brushR) continue;
          const nc = c + dc, nr = r + dr;
          if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
          const i = idx(nc, nr);
          grid[i] = EMPTY; colors[i] = null; life[i] = 0;
        }
      }
      return;
    }
    const id = keyToId[key];
    if (!id) return;
    const spec = registry[id];
    for (let dc = -brushR; dc <= brushR; dc++) {
      for (let dr = -brushR; dr <= brushR; dr++) {
        if (dc * dc + dr * dr > brushR * brushR) continue;
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
        const i = idx(nc, nr);
        if (spec.kind === 'static') {
          grid[i] = id;
          colors[i] = colorForSpec(spec);
          life[i] = 0;
        } else {
          // Dynamic: only paint into empty cells so we don't wipe other
          // materials.
          if (grid[i] === EMPTY || grid[i] === id) {
            grid[i] = id;
            colors[i] = colorForSpec(spec);
            life[i] = (spec.kind === 'gas' && spec.lifeMin)
              ? spec.lifeMin + Math.floor(Math.random() * Math.max(1, spec.lifeMax - spec.lifeMin))
              : 0;
          }
        }
      }
    }
  }

  function paintLine(c0, r0, c1, r1, brushR) {
    let dx = Math.abs(c1 - c0), sx = c0 < c1 ? 1 : -1;
    let dy = -Math.abs(r1 - r0), sy = r0 < r1 ? 1 : -1;
    let err = dx + dy;
    let c = c0, r = r0;
    while (true) {
      paintAt(c, r, brushR);
      if (c === c1 && r === r1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; c += sx; }
      if (e2 <= dx) { err += dx; r += sy; }
    }
  }

  function startHoldPaint() {
    stopHoldPaint();
    // Fires ~30/s while the pointer is held. Even if the cursor is perfectly
    // still, dynamic materials keep being deposited at the cursor — so
    // holding over one spot pours material continuously instead of stopping
    // after the first drop. (User-reported bug: paint stalls when finger
    // doesn't move.)
    holdPaintTimer = setInterval(() => {
      if (!isPointerDown || !lastPointer) return;
      paintAt(lastPointer.c, lastPointer.r, brushRadiusFor(selectedKey));
    }, 33);
  }

  function stopHoldPaint() {
    if (holdPaintTimer) { clearInterval(holdPaintTimer); holdPaintTimer = null; }
  }

  function onPointerDown(e) {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    isPointerDown = true;
    const cell = canvasCell(e);
    lastCell = cell;
    lastPointer = cell;
    paintAt(cell.c, cell.r, brushRadiusFor(selectedKey));
    hideOverlay();
    startHoldPaint();
  }

  function onPointerMove(e) {
    if (!isPointerDown) return;
    e.preventDefault();
    const cell = canvasCell(e);
    if (lastCell) paintLine(lastCell.c, lastCell.r, cell.c, cell.r, brushRadiusFor(selectedKey));
    lastCell = cell;
    lastPointer = cell;
  }

  function onPointerUp() {
    isPointerDown = false;
    lastCell = null;
    lastPointer = null;
    stopHoldPaint();
  }

  // ── Pour ───────────────────────────────────────────────────────────────────
  window.startDrop = function () {
    const key = pourableKeyFor(selectedKey);
    const id = keyToId[key];
    if (!id) return;
    const spec = registry[id];
    pours.push({ id, kind: spec.kind, frames: 0, total: 300 });
    hideOverlay();
  };

  const SPAWN_RATE = 18;

  function spawnFromPours() {
    if (!pours.length) return;
    const next = [];
    for (const p of pours) {
      if (p.frames > p.total) continue;
      const spec = registry[p.id];
      if (!spec) continue;
      for (let s = 0; s < SPAWN_RATE; s++) {
        const c = Math.floor(Math.random() * COLS);
        // Gases rise → spawn near bottom; everything else → top.
        const r = (spec.kind === 'gas')
          ? (Math.random() < 0.5 ? ROWS - 1 : ROWS - 2)
          : (Math.random() < 0.5 ? 0 : 1);
        const i = idx(c, r);
        if (grid[i] !== EMPTY) continue;
        grid[i] = p.id;
        colors[i] = colorForSpec(spec);
        if (spec.kind === 'gas' && spec.lifeMin) {
          life[i] = spec.lifeMin + Math.floor(Math.random() * Math.max(1, spec.lifeMax - spec.lifeMin));
        } else {
          life[i] = 0;
        }
      }
      p.frames++;
      next.push(p);
    }
    pours = next;
  }

  // ── Simulation ─────────────────────────────────────────────────────────────
  function clearFlags() { flags.fill(0); }

  const NBR_DIRS = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];

  // ── Explosion system ───────────────────────────────────────────────────────
  // Queue of pending explosions: { c, r, radius, power }. Applied after
  // reactions each step so a chain can enqueue new explosions (chains).
  let pendingExplosions = [];
  // Track cells that already exploded this step to prevent double-triggering
  let explodedCells = new Set();

  function enqueueExplosion(c, r, radius, power) {
    pendingExplosions.push({ c, r, radius: radius || 8, power: power || 1 });
  }

  // Debris colors for shrapnel particles
  const DEBRIS_COLORS = ['#ff8020', '#ffb040', '#ff4010', '#ffd060', '#ff6030', '#ffe080', '#ff2000', '#ffffff'];

  function spawnDebris(cx, cy, radius, power) {
    // Spawn debris particles flying outward in all directions.
    // Number of debris pieces scales with explosion power and radius.
    const count = Math.floor(radius * power * 6 + 20);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (1.5 + Math.random() * 4.5) * power;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      const maxLife = 18 + Math.floor(Math.random() * 30);
      debris.push({
        x: cx * CELL + CELL / 2 + (Math.random() - 0.5) * radius * CELL * 0.4,
        y: cy * CELL + CELL / 2 + (Math.random() - 0.5) * radius * CELL * 0.4,
        vx, vy,
        life: maxLife,
        maxLife,
        color: DEBRIS_COLORS[Math.floor(Math.random() * DEBRIS_COLORS.length)],
        size: 1 + Math.random() * 3,
      });
    }
  }

  function applyExplosions() {
    if (!pendingExplosions.length) return;
    const fireId  = keyToId['fire'];
    const smokeId = keyToId['smoke'];
    // Cap chain reaction depth: if this step's explosions trigger new ones,
    // they go into the NEXT step's queue via a secondary buffer.
    const thisRound = pendingExplosions;
    pendingExplosions = [];

    for (const ex of thisRound) {
      const { c, r, radius, power } = ex;

      // Screen flash — intensity proportional to power
      flashIntensity = Math.min(1, flashIntensity + power * 0.5);

      // Spawn flying debris
      spawnDebris(c, r, radius, power);

      const r2 = radius * radius;
      for (let dc = -radius; dc <= radius; dc++) {
        for (let dr = -radius; dr <= radius; dr++) {
          const dist2 = dc * dc + dr * dr;
          if (dist2 > r2) continue;
          const nc = c + dc, nr = r + dr;
          if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
          const ni = idx(nc, nr);
          const existId = grid[ni];

          // Chain reaction: if a neighboring cell is also explosive, detonate it too
          // (but only if it hasn't already exploded this frame to prevent infinite loops)
          if (existId) {
            const existSpec = registry[existId];
            if (existSpec && existSpec.isExplosive && !explodedCells.has(ni)) {
              explodedCells.add(ni);
              const chainRadius = existSpec.explosionRadius || 8;
              const chainPower = (existSpec.explosionPower || 1) * 0.9; // slight damping
              pendingExplosions.push({ c: nc, r: nr, radius: chainRadius, power: chainPower });
              grid[ni] = EMPTY; colors[ni] = null; life[ni] = 0;
              continue;
            }
            // Walls resist explosions; higher power punches through better
            if (existSpec && existSpec.kind === 'static') {
              if (Math.random() > power * 0.45) continue;
            }
          }

          // Eject material outward as debris color before clearing
          const normDist = Math.sqrt(dist2) / radius;
          grid[ni] = EMPTY; colors[ni] = null; life[ni] = 0;

          // Inner core: fire spawns
          if (normDist < 0.45 && fireId && Math.random() < power * 0.75) {
            grid[ni] = fireId;
            const fSpec = registry[fireId];
            colors[ni] = colorForSpec(fSpec);
            if (fSpec.lifeMin) {
              life[ni] = fSpec.lifeMin + Math.floor(Math.random() * Math.max(1, fSpec.lifeMax - fSpec.lifeMin));
            }
          // Outer ring: smoke + a chance of fire licks
          } else if (normDist >= 0.45 && smokeId && Math.random() < 0.55) {
            grid[ni] = smokeId;
            const sSpec = registry[smokeId];
            colors[ni] = colorForSpec(sSpec);
            if (sSpec.lifeMin) {
              life[ni] = sSpec.lifeMin + Math.floor(Math.random() * Math.max(1, sSpec.lifeMax - sSpec.lifeMin));
            }
          }
        }
      }
    }
    explodedCells.clear();
  }

  // ── Explosive contact detection ─────────────────────────────────────────────
  // Called during the reaction pass. Built-in explosives (explosive powder,
  // nitro liquid) detonate the moment they touch ANY non-explosive material.
  // This is different from reaction-based explosions which only fire on
  // specific `other` element contacts.
  function applyExplosiveContacts() {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = idx(c, r);
        const id = grid[i];
        if (!id) continue;
        const spec = registry[id];
        if (!spec || !spec.isExplosive) continue;
        if (flags[i] & 2) continue;

        // Check all 8 neighbors for non-explosive contact
        let triggered = false;
        for (const [dc, dr] of NBR_DIRS) {
          const nc = c + dc, nr = r + dr;
          if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
          const ni = idx(nc, nr);
          const nid = grid[ni];
          if (!nid) continue; // empty
          const nSpec = registry[nid];
          if (!nSpec) continue;
          // Don't trigger on contact with other explosives — they'll chain
          if (nSpec.isExplosive) continue;
          // Trigger! Mark this cell as reacted and enqueue explosion
          triggered = true;
          break;
        }

        if (triggered) {
          const cKey = i;
          if (!explodedCells.has(cKey)) {
            explodedCells.add(cKey);
            enqueueExplosion(c, r, spec.explosionRadius || 10, spec.explosionPower || 1.5);
            grid[i] = EMPTY; colors[i] = null; life[i] = 0;
            flags[i] |= 2;
          }
        }
      }
    }
    explodedCells.clear();
  }

  function applyReactions() {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = idx(c, r);
        const id = grid[i];
        if (!id) continue;
        if (flags[i] & 2) continue;
        const spec = registry[id];
        if (!spec || !spec.reactions || !spec.reactions.length) continue;

        for (const rx of spec.reactions) {
          const otherId = keyToId[rx.other];
          if (!otherId) continue;

          for (const [dc, dr] of NBR_DIRS) {
            const nc = c + dc, nr = r + dr;
            if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
            const ni = idx(nc, nr);
            if (flags[ni] & 2) continue;
            if (grid[ni] !== otherId) continue;

            if (Math.random() < (rx.chance || 0)) {
              // Explosion reaction: queue a blast centered on this cell
              if (rx.explodes) {
                enqueueExplosion(c, r, rx.explosionRadius || 8, rx.explosionPower || 1);
                // The exploding cell itself is consumed
                grid[i] = EMPTY; colors[i] = null; life[i] = 0;
                flags[i] |= 2;
                break;
              }
              if (rx.becomes === null || rx.becomes === '' || rx.becomes === 'empty') {
                grid[ni] = EMPTY;
                colors[ni] = null;
                life[ni] = 0;
              } else {
                const becId = keyToId[rx.becomes];
                if (!becId) continue;
                const becSpec = registry[becId];
                grid[ni] = becId;
                colors[ni] = colorForSpec(becSpec);
                life[ni] = (becSpec.kind === 'gas' && becSpec.lifeMin)
                  ? becSpec.lifeMin + Math.floor(Math.random() * Math.max(1, becSpec.lifeMax - becSpec.lifeMin))
                  : 0;
              }
              flags[ni] |= 2;
            }
          }
        }
      }
    }
  }

  // ── Cellular automaton step ────────────────────────────────────────────────
  // Applies Conway-style rules for elements with kind === 'cellular'.
  // `born`    — array of neighbor-count values that birth a new cell from empty
  // `survive` — array of neighbor-count values that keep an existing cell alive
  // `birthFrom` — optional array of element keys that count as neighbors
  //               (defaults to the element's own key + keys listed)
  function applyCellular() {
    // Collect all cellular element ids
    const cellularIds = Object.keys(registry)
      .map(n => +n)
      .filter(id => registry[id] && registry[id].kind === 'cellular');
    if (!cellularIds.length) return;

    // We process all cellular elements in one snapshot pass to avoid order bias
    const snapGrid = grid.slice();
    for (const id of cellularIds) {
      const spec = registry[id];
      const born    = spec.born    || [3];
      const survive = spec.survive || [2, 3];
      // Keys whose cells count as "alive" neighbors for birth/survival counting
      const neighborKeys = [spec.key, ...(spec.birthFrom || [])];
      const neighborIds  = new Set(neighborKeys.map(k => keyToId[k]).filter(Boolean));

      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const i = idx(c, r);
          const isAlive = snapGrid[i] === id;
          let n = 0;
          for (const [dc, dr] of NBR_DIRS) {
            const nc = c + dc, nr = r + dr;
            if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
            if (neighborIds.has(snapGrid[idx(nc, nr)])) n++;
          }
          if (isAlive) {
            if (!survive.includes(n)) {
              grid[i] = EMPTY; colors[i] = null; life[i] = 0;
            }
          } else if (snapGrid[i] === EMPTY) {
            if (born.includes(n)) {
              grid[i] = id;
              colors[i] = colorForSpec(spec);
              life[i] = 0;
            }
          }
        }
      }
    }
  }

  function step() {
    clearFlags();

    // Bottom row is open sky for falling things.
    for (let c = 0; c < COLS; c++) {
      const i = idx(c, ROWS - 1);
      const id = grid[i];
      if (!id) continue;
      const spec = registry[id];
      if (!spec) continue;
      if (spec.kind === 'powder' || spec.kind === 'liquid') {
        grid[i] = EMPTY; colors[i] = null;
      }
    }
    // Top row is open sky for gases.
    for (let c = 0; c < COLS; c++) {
      const i = idx(c, 0);
      const id = grid[i];
      if (!id) continue;
      const spec = registry[id];
      if (!spec) continue;
      if (spec.kind === 'gas') {
        grid[i] = EMPTY; colors[i] = null; life[i] = 0;
      }
    }

    applyExplosiveContacts();
    applyReactions();
    applyExplosions();
    applyCellular();

    // Gas rise (top to bottom so a rising gas isn't moved twice).
    for (let r = 0; r < ROWS; r++) {
      const cols = shuffledCols();
      for (let ci = 0; ci < COLS; ci++) {
        const c = cols[ci];
        const i = idx(c, r);
        if (flags[i] & 1) continue;
        const id = grid[i];
        if (!id) continue;
        const spec = registry[id];
        if (!spec || spec.kind !== 'gas') continue;

        // Decay.
        if (spec.lifeMin) {
          if (life[i] > 0) life[i]--;
          if (life[i] === 0) {
            grid[i] = EMPTY; colors[i] = null;
            continue;
          }
        }

        // Buoyancy: chance to skip rising this frame.
        const buoy = (typeof spec.buoyancy === 'number') ? spec.buoyancy : 0.9;
        if (Math.random() > buoy) continue;

        if (r - 1 >= 0) {
          const up = idx(c, r - 1);
          if (grid[up] === EMPTY) { swap(i, up); flags[up] |= 1; continue; }
        }
        const goLeft = Math.random() < 0.5;
        const d1 = goLeft ? -1 : 1, d2 = -d1;
        if (tryGasDiag(c, r, d1) || tryGasDiag(c, r, d2)) continue;
      }
    }

    // Falling passes (bottom to top).
    for (let r = ROWS - 2; r >= 0; r--) {
      const cols = shuffledCols();
      for (let ci = 0; ci < COLS; ci++) {
        const c = cols[ci];
        const i = idx(c, r);
        if (flags[i] & 1) continue;
        const id = grid[i];
        if (!id) continue;
        const spec = registry[id];
        if (!spec) continue;
        if (spec.kind === 'powder')      stepPowder(c, r, i, spec);
        else if (spec.kind === 'liquid') stepLiquid(c, r, i, spec);
      }
    }
  }

  function stepPowder(c, r, i, spec) {
    // Stickiness: a sticky powder clings to walls and neighboring solids.
    // High stickiness (wet sand, clay) makes the particle freeze when touching walls.
    const stick = (typeof spec.stickiness === 'number') ? spec.stickiness : 0;
    if (stick > 0) {
      let wallNearby = false;
      for (const [dc, dr] of NBR_DIRS) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) { wallNearby = true; break; }
        const nid = grid[idx(nc, nr)];
        if (!nid) continue;
        const nSpec = registry[nid];
        if (nSpec && nSpec.kind === 'static') { wallNearby = true; break; }
      }
      const freezeChance = wallNearby ? stick * 0.8 : stick * 0.5;
      if (Math.random() < freezeChance) return;
    }

    if (r + 1 < ROWS) {
      const below = idx(c, r + 1);
      const bt = grid[below];
      if (bt === EMPTY) { swap(i, below); flags[below] |= 1; return; }
      const bSpec = registry[bt];
      // Powders sink through liquids of lower density.
      if (bSpec && bSpec.kind === 'liquid' && bSpec.density < spec.density + 0.5) {
        swap(i, below); flags[below] |= 1; return;
      }
    }

    // Diagonal flow controlled by `flow` 0..1. Low flow = high angle of repose.
    const flow = (typeof spec.flow === 'number') ? spec.flow : 0.55;
    if (Math.random() > flow) return;

    const goLeft = Math.random() < 0.5;
    const d1 = goLeft ? -1 : 1, d2 = -d1;
    if (tryPowderDiag(c, r, d1, spec)) return;
    if (tryPowderDiag(c, r, d2, spec)) return;
  }

  function tryPowderDiag(c, r, dc, spec) {
    const nc = c + dc;
    if (nc < 0 || nc >= COLS) return false;
    if (r + 1 >= ROWS) return false;
    const ni = idx(nc, r + 1);
    const nt = grid[ni];
    if (nt === EMPTY) {
      swap(idx(c, r), ni); flags[ni] |= 1; return true;
    }
    const nSpec = registry[nt];
    if (nSpec && nSpec.kind === 'liquid' && nSpec.density < spec.density + 0.5) {
      swap(idx(c, r), ni); flags[ni] |= 1; return true;
    }
    return false;
  }

  function stepLiquid(c, r, i, spec) {
    const visc = (typeof spec.viscosity === 'number') ? spec.viscosity : 0;
    const stick = (typeof spec.stickiness === 'number') ? spec.stickiness : 0;

    // Stickiness: chance to anchor (honey/syrup clinging to walls/each other).
    // Elements with high stickiness should "freeze" when touching a wall —
    // gravity effectively stops while they're connected to a solid surface.
    // Walls (static kind) give a stronger anchoring signal than powders.
    if (stick > 0) {
      let wallTouching = false;   // adjacent to a static (wall/structure)
      let solidTouching = false;  // adjacent to a powder
      for (const [dc, dr] of NBR_DIRS) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) {
          // Edge of the canvas counts as a wall for stickiness purposes.
          wallTouching = true;
          break;
        }
        const nid = grid[idx(nc, nr)];
        if (!nid || nid === grid[i]) continue;
        const nSpec = registry[nid];
        if (!nSpec) continue;
        if (nSpec.kind === 'static') { wallTouching = true; break; }
        if (nSpec.kind === 'powder') solidTouching = true;
      }
      // Wall contact → high freeze chance (gravity stop effect the user expects).
      if (wallTouching && Math.random() < stick) return;
      // Powder contact → moderate freeze (clumping/cohesion).
      if (solidTouching && Math.random() < stick * 0.6) return;
    }

    // Viscosity: a viscous liquid sometimes refuses to move at all this frame.
    // viscosity=1 → moves ~1/5 of frames; viscosity=0 → moves every frame.
    if (visc > 0 && Math.random() < visc * 0.8) return;

    // Falling + density separation.
    if (r + 1 < ROWS) {
      const below = idx(c, r + 1);
      const bt = grid[below];
      if (bt === EMPTY) { swap(i, below); flags[below] |= 1; return; }
      const bSpec = registry[bt];
      if (bSpec && bSpec.kind === 'liquid' && bSpec.density < spec.density) {
        swap(i, below); flags[below] |= 1; return;
      }
      // Diagonal fall.
      const goLeft = Math.random() < 0.5;
      const d1 = goLeft ? -1 : 1, d2 = -d1;
      if (tryLiquidDiag(c, r, d1, spec)) return;
      if (tryLiquidDiag(c, r, d2, spec)) return;
    }

    // Sideways spread: viscous liquids spread less (extra dampening).
    if (visc > 0 && Math.random() < visc * 0.5) return;

    const goLeft = Math.random() < 0.5;
    const d1 = goLeft ? -1 : 1, d2 = -d1;
    if (trySideways(c, r, d1)) return;
    if (trySideways(c, r, d2)) return;
  }

  function tryLiquidDiag(c, r, dc, spec) {
    const nc = c + dc;
    if (nc < 0 || nc >= COLS) return false;
    if (r + 1 >= ROWS) return false;
    const ni = idx(nc, r + 1);
    const nt = grid[ni];
    if (nt === EMPTY) { swap(idx(c, r), ni); flags[ni] |= 1; return true; }
    const nSpec = registry[nt];
    if (nSpec && nSpec.kind === 'liquid' && nSpec.density < spec.density) {
      swap(idx(c, r), ni); flags[ni] |= 1; return true;
    }
    return false;
  }

  function trySideways(c, r, dc) {
    const nc = c + dc;
    if (nc < 0 || nc >= COLS) return false;
    const ni = idx(nc, r);
    if (grid[ni] === EMPTY) {
      swap(idx(c, r), ni); flags[ni] |= 1; return true;
    }
    return false;
  }

  function tryGasDiag(c, r, dc) {
    const nc = c + dc;
    if (nc < 0 || nc >= COLS) return false;
    if (r - 1 < 0) return false;
    const ni = idx(nc, r - 1);
    if (grid[ni] === EMPTY) { swap(idx(c, r), ni); flags[ni] |= 1; return true; }
    return false;
  }

  function swap(a, b) {
    const g = grid[a], co = colors[a], l = life[a];
    grid[a] = grid[b];  colors[a] = colors[b];  life[a] = life[b];
    grid[b] = g;        colors[b] = co;         life[b] = l;
  }

  let _colArr = null;
  function shuffledCols() {
    if (!_colArr || _colArr.length !== COLS) {
      _colArr = Array.from({ length: COLS }, (_, i) => i);
    }
    for (let i = COLS - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [_colArr[i], _colArr[j]] = [_colArr[j], _colArr[i]];
    }
    return _colArr;
  }

  // ── Debris particle update ──────────────────────────────────────────────────
  function updateDebris() {
    const alive = [];
    for (const p of debris) {
      p.x  += p.vx;
      p.y  += p.vy;
      p.vy += 0.18;  // gravity pulls debris down
      p.vx *= 0.97;  // air drag
      p.life--;
      if (p.life > 0 && p.x >= 0 && p.x < canvas.width && p.y >= 0 && p.y < canvas.height) {
        alive.push(p);
      }
    }
    debris = alive;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render() {
    ctx.fillStyle = '#0f0e0c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw grid cells
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = idx(c, r);
        const id = grid[i];
        if (!id) continue;
        ctx.fillStyle = colors[i] || (registry[id] && registry[id].colors[0]) || '#888';
        ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      }
    }

    // Draw debris particles (flying shrapnel)
    for (const p of debris) {
      const alpha = p.life / p.maxLife;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // Explosion flash overlay
    if (flashIntensity > 0.01) {
      ctx.fillStyle = `rgba(255, 200, 100, ${Math.min(0.7, flashIntensity * 0.7)})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      flashIntensity *= 0.72; // decay flash quickly
    }
  }

  // ── Loop ───────────────────────────────────────────────────────────────────
  function loop() {
    spawnFromPours();
    step();
    updateDebris();
    render();
    animId = requestAnimationFrame(loop);
  }

  // ── Invent modal ───────────────────────────────────────────────────────────
  function bindModal() {
    const overlay = document.getElementById('invent-overlay');
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeInvent();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeInvent();
    });
    // Example chips: click to fill the form, then user can submit (or tweak).
    document.querySelectorAll('.invent-example').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('invent-name').value = btn.getAttribute('data-name') || '';
        document.getElementById('invent-desc').value = btn.getAttribute('data-desc') || '';
        document.getElementById('invent-name').focus();
      });
    });
  }

  // ── Per-element feedback ───────────────────────────────────────────────────
  // Users repeatedly said "elements don't behave how I'd expect". A generic
  // feedback box can't tell the builder WHICH element broke, so we capture
  // the element's full generated spec + the user's original description +
  // a tagged reason. That goes to the same feedback endpoint as the global
  // "Feedback" button, tagged as element_feedback so the builder can read
  // structured per-element reports next cycle.
  const FEEDBACK_ENDPOINT = 'https://5c99bazuj0.execute-api.us-east-1.amazonaws.com/feedback';
  let elfbTargetKey = null;

  function bindElementFeedbackModal() {
    const overlay = document.getElementById('elfb-overlay');
    if (!overlay) return;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeElementFeedback();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeElementFeedback();
    });
    document.getElementById('elfb-cancel').addEventListener('click', closeElementFeedback);
    document.getElementById('elfb-submit').addEventListener('click', submitElementFeedback);
    // Chips are multi-select — clicking toggles the .selected class; all
    // selected reasons get concatenated into the payload.
    document.querySelectorAll('#elfb-chips .elfb-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('selected');
      });
    });
  }

  function openElementFeedback(key) {
    const id = keyToId[key];
    if (!id) return;
    const spec = registry[id];
    if (!spec) return;
    elfbTargetKey = key;
    document.getElementById('elfb-name').textContent = spec.displayName;
    document.querySelectorAll('#elfb-chips .elfb-chip').forEach(c => c.classList.remove('selected'));
    document.getElementById('elfb-note').value = '';
    setElfbStatus('', false);
    document.getElementById('elfb-submit').disabled = false;
    document.getElementById('elfb-submit').textContent = 'send';
    document.getElementById('elfb-overlay').classList.remove('hidden');
  }

  function closeElementFeedback() {
    document.getElementById('elfb-overlay').classList.add('hidden');
    elfbTargetKey = null;
  }

  function setElfbStatus(msg, isErr) {
    const el = document.getElementById('elfb-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('err', !!isErr);
  }

  function submitElementFeedback() {
    if (!elfbTargetKey) { closeElementFeedback(); return; }
    const id = keyToId[elfbTargetKey];
    const spec = registry[id];
    if (!spec) { closeElementFeedback(); return; }

    const reasons = Array.from(document.querySelectorAll('#elfb-chips .elfb-chip.selected'))
      .map(c => c.getAttribute('data-reason'))
      .filter(Boolean);
    const note = (document.getElementById('elfb-note').value || '').trim();
    if (!reasons.length && !note) {
      setElfbStatus('pick a reason or add a note.', true);
      return;
    }

    // Build a structured text payload so the global feedback system
    // (which only has a `text` field) still carries everything the
    // builder needs to iterate. The `[element_feedback]` tag and JSON
    // block make it trivial to parse in the next triage cycle.
    const report = {
      type: 'element_feedback',
      element: {
        displayName: spec.displayName,
        key: spec.key,
        userDesc: spec.userDesc || '',
        kind: spec.kind,
        density: spec.density,
        viscosity: spec.viscosity,
        flow: spec.flow,
        stickiness: spec.stickiness,
        buoyancy: spec.buoyancy,
        lifeMin: spec.lifeMin,
        lifeMax: spec.lifeMax,
        colors: spec.colors,
        reactions: spec.reactions,
      },
      reasons,
      note,
    };
    const text = '[element_feedback] ' + spec.displayName
      + (reasons.length ? ' — ' + reasons.join('; ') : '')
      + (note ? ' — ' + note : '')
      + '\n' + JSON.stringify(report);

    const submitBtn = document.getElementById('elfb-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'sending…';
    setElfbStatus('', false);

    fetch(FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: SLUG, text }),
    }).then(r => {
      if (!r.ok) throw new Error('http_' + r.status);
      return r.json();
    }).then(() => {
      setElfbStatus('thanks — the builder will see this next iteration.', false);
      setTimeout(closeElementFeedback, 1200);
    }).catch(() => {
      submitBtn.disabled = false;
      submitBtn.textContent = 'retry';
      setElfbStatus('send failed. try again?', true);
    });
  }

  window.openInvent = function () {
    const overlay = document.getElementById('invent-overlay');
    overlay.classList.remove('hidden');
    setInventStatus('', false);
    const nameEl = document.getElementById('invent-name');
    const descEl = document.getElementById('invent-desc');
    nameEl.value = '';
    descEl.value = '';
    setInventBusy(false);
    setTimeout(() => nameEl.focus(), 30);
  };

  window.closeInvent = function () {
    document.getElementById('invent-overlay').classList.add('hidden');
  };

  function setInventStatus(msg, isErr) {
    const el = document.getElementById('invent-status');
    el.textContent = msg || '';
    el.classList.toggle('err', !!isErr);
  }

  function setInventBusy(busy) {
    document.getElementById('invent-submit').disabled = busy;
    document.getElementById('invent-cancel').disabled = busy;
    document.getElementById('invent-submit').textContent = busy ? 'inventing…' : 'invent';
  }

  window.submitInvent = async function () {
    const nameRaw = (document.getElementById('invent-name').value || '').trim();
    const descRaw = (document.getElementById('invent-desc').value || '').trim();
    if (!nameRaw) { setInventStatus('give it a name first.', true); return; }

    const key = slugify(nameRaw);
    if (!key) { setInventStatus('pick a name with letters in it.', true); return; }
    if (keyToId[key]) { setInventStatus('that name is already taken.', true); return; }

    setInventBusy(true);
    setInventStatus('asking the AI for physics…', false);

    try {
      const spec = await generateElement(nameRaw, descRaw);
      const finalized = finalizeSpec(nameRaw, key, spec, descRaw);
      registerElement(finalized);
      rebuildPalette();
      setMaterial(finalized.key);
      closeInvent();
    } catch (e) {
      try {
        const fb = fallbackSpec(nameRaw, key, descRaw);
        registerElement(fb);
        rebuildPalette();
        setMaterial(fb.key);
        closeInvent();
      } catch (e2) {
        setInventBusy(false);
        setInventStatus('could not invent right now. try a different name.', true);
      }
    }
  };

  function slugify(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
  }

  // ── Brush radius per element ──────────────────────────────────────────────
  // Different elements benefit from different brush sizes. Static elements
  // (walls, structures) get a large brush so you can build quickly. Gases
  // get a medium-large brush since they're diffuse. Liquids and powders use
  // a size that scales with their expected "pour" or "dump" feel.
  // For invented elements, stickiness hints at precision (sticky = smaller
  // brush so placement is deliberate), and gas buoyancy hints at spread.
  function brushRadiusFor(key) {
    if (key === 'erase') return 3;
    const id = keyToId[key];
    if (!id) return 2;
    const spec = registry[id];
    if (!spec) return 2;
    // Explosive materials get a bigger brush so users can paint satisfying amounts
    if (spec.isExplosive) return 3;
    if (spec.kind === 'static') return 4;
    if (spec.kind === 'gas') {
      // High-buoyancy gases (fire, plasma) spread fast — small brush reads better.
      const buoy = (typeof spec.buoyancy === 'number') ? spec.buoyancy : 0.9;
      return buoy >= 0.9 ? 2 : 3;
    }
    if (spec.kind === 'liquid') {
      // Highly sticky liquids: smaller brush for precise placement.
      const stick = (typeof spec.stickiness === 'number') ? spec.stickiness : 0;
      if (stick >= 0.7) return 1;
      // Very viscous liquids also get a small brush — you're placing globs, not pouring.
      const visc = (typeof spec.viscosity === 'number') ? spec.viscosity : 0;
      if (visc >= 0.8) return 2;
      return 2;
    }
    if (spec.kind === 'powder') {
      const flow = (typeof spec.flow === 'number') ? spec.flow : 0.55;
      // Fine powders (flour, dust, glitter) — bigger brush feels right.
      if (flow >= 0.9) return 3;
      // Coarse/chunky powders (gravel) — smaller, deliberate.
      if (flow <= 0.2) return 2;
      return 2;
    }
    return 2;
  }

  // ── AI call ────────────────────────────────────────────────────────────────
  // We use the flagship gpt-5.4 model (not mini) because designing a
  // coherent physics spec — picking density, viscosity, stickiness, flow,
  // colors, AND reactive behaviour against existing elements all at once —
  // is exactly the multi-step reasoning case the flagship is for. The user
  // explicitly asked for the best model.
  async function generateElement(name, desc) {
    const existing = Object.keys(keyToId);
    const otherList = existing.join(', ');

    const SYSTEM_PROMPT = [
      'You design elements for a falling-sand physics sandbox. The user INVENTS an element by naming it; your job is to make that element BEHAVE THE WAY THE NAME IMPLIES when the user paints it into the grid.',
      '',
      'CORE RULE: the element must feel obvious to a human who hears the name. If a user types "fire" and it doesn\'t rise, glow, or consume plants, the app is broken. Always match common intuition before trying to be clever.',
      '',
      'Output ONE strict JSON object. No prose, no code fence.',
      '',
      'Schema (all fields required unless marked optional):',
      '{',
      '  "kind": "static" | "powder" | "liquid" | "gas" | "cellular",',
      '  "density": number 1-9,',
      '  "viscosity": number 0-1 (LIQUID ONLY),',
      '  "flow": number 0-1 (POWDER ONLY),',
      '  "stickiness": number 0-1 (LIQUID/POWDER only),',
      '  "buoyancy": number 0-1 (GAS ONLY),',
      '  "lifeMin": integer 0-150 (GAS ONLY),',
      '  "lifeMax": integer 0-200 (GAS ONLY, >= lifeMin),',
      '  "born": array of integers 0-8 (CELLULAR ONLY — neighbor counts that birth a new cell, e.g. [3] for Conway life),',
      '  "survive": array of integers 0-8 (CELLULAR ONLY — neighbor counts that keep an existing cell alive, e.g. [2,3]),',
      '  "colors": array of 3-6 hex strings like "#aabbcc", vivid, coherent, readable on near-black,',
      '  "reactions": array of 0-3 objects, each { "other": "<existing-key>", "becomes": "<existing-key-or-empty>", "chance": number 0.005-0.25, "explodes": bool (optional), "explosionRadius": int 4-16 (optional), "explosionPower": float 0.5-2 (optional) }',
      '}',
      '',
      'KIND — pick by what the name evokes, not just letters:',
      '- static: solid, never moves. wall, brick, stone, metal, wood, ice, plant, glass, bone, web, crystal, bedrock, concrete, iron, steel.',
      '- powder: granular, falls and piles. sand, salt, sugar, flour, dust, ash, glitter, snow, seed, gunpowder, TNT, gravel, pebbles, rice, confetti.',
      '- liquid: falls and spreads sideways. water, oil, honey, acid, slime, blood, milk, juice, lava, mercury, syrup, tar, wine, soda, gasoline, ink, paint.',
      '- gas: RISES. fire, flame, smoke, steam, vapor, fog, mist, cloud, spore, plasma, lightning-bug swarm. If in doubt about something hot, bright, or airborne, it\'s a gas.',
      '- cellular: Conway-style automaton that evolves by neighbor counts. Use for mold, fungus, crystal growth, coral, life, infection, mycelium, slime mold, lichen.',
      '',
      'NUMERIC GUIDES (follow unless the description overrides):',
      '- density: feather=1, smoke=2, oil=3, alcohol=4, water=5, blood=6, mercury=8, lead=9.',
      '- viscosity (liquid): water=0, gasoline=0.05, oil=0.3, blood=0.5, syrup=0.75, honey=0.9, tar=0.97. If the desc says "thick", "viscous", "slow", "oozing", "sluggish", use >= 0.6. NEVER 0 for honey/syrup/tar/oil.',
      '- flow (powder): flour/talc/dust=1.0, fine sand=0.7, sand=0.55, salt=0.5, gravel=0.25, chunky/jagged/rocks=0.1.',
      '- stickiness: glue/tar/slime/web/resin = 0.7-0.95. "sticky/clingy/gummy" >= 0.5. default 0.',
      '- buoyancy (gas): hot/fire/plasma = 1.0, steam = 0.8, smoke = 0.6, heavy fog = 0.25.',
      '- lifeMin/lifeMax (gas): short puff 20-40, medium 60-100, long-lived 120-180. Fire usually 40-80; smoke 60-120; steam 30-60.',
      '- born/survive (cellular): standard Conway life = born:[3], survive:[2,3]. Dense coral = born:[3,4,5], survive:[4,5,6,7]. Fast spreading mold = born:[3,6], survive:[2,3].',
      '',
      'EXPLOSION REACTIONS — use the explodes flag for elements that should BLOW UP:',
      '  If the element name or description implies explosion (TNT, bomb, dynamite, C4, grenade, landmine, etc.), add a reaction with `"explodes": true`.',
      '  The exploding cell AND a radius of cells around it are cleared; fire and smoke are spawned in the blast zone.',
      '  Example: tnt reacting to fire → { "other": "fire", "explodes": true, "explosionRadius": 10, "explosionPower": 1.5, "chance": 0.9 }',
      '  Explosion reactions REPLACE the normal "becomes" — you do not need "becomes" when "explodes" is true.',
      '',
      'REACTIONS — this is what makes the sandbox feel ALIVE. Always think: "what does this element DO to things it touches?"',
      '  "other" must be one of the EXISTING keys: ' + otherList + '. (You may also reference yourself in "becomes".)',
      '  "becomes" is an existing key OR the literal string "empty" to destroy the other cell.',
      '  Meaning: "when this element is next to <other>, with <chance> per frame, <other> turns into <becomes>".',
      '  Worked examples — COPY THESE PATTERNS when names match:',
      '    fire → kind:gas, buoyancy:1, density:1, lifeMin:30, lifeMax:70, colors:["#ff4020","#ff8010","#ffc040","#ffe070"], reactions:[{other:"water",becomes:"empty",chance:0.25},{other:"plant",becomes:"fire",chance:0.12},{other:"oil",becomes:"fire",chance:0.15}]',
      '    lava → kind:liquid, density:8, viscosity:0.8, colors:["#ff5020","#ff8030","#d03010","#ffc040"], reactions:[{other:"water",becomes:"empty",chance:0.2},{other:"plant",becomes:"fire",chance:0.15},{other:"wall",becomes:"empty",chance:0.01}]',
      '    acid → kind:liquid, density:4, viscosity:0.1, colors:["#60ff30","#80ff40","#30d020","#b0ff60"], reactions:[{other:"wall",becomes:"empty",chance:0.04},{other:"sand",becomes:"empty",chance:0.06},{other:"plant",becomes:"empty",chance:0.15}]',
      '    snow → kind:powder, flow:0.4, density:2, colors:["#ffffff","#e8f0ff","#d0e0f0","#fafcff"], reactions:[{other:"fire",becomes:"empty",chance:0.25}]',
      '    honey → kind:liquid, density:6, viscosity:0.9, stickiness:0.7, colors:["#e8a030","#d48020","#ffc050","#b86020"]',
      '    smoke → kind:gas, buoyancy:0.6, density:2, lifeMin:60, lifeMax:120, colors:["#606060","#808080","#4a4a4a","#a0a0a0"]',
      '    plant → kind:static, density:3, colors:["#409040","#60a050","#308030","#80b060"]',
      '    ice → kind:static, density:5, colors:["#c0e0ff","#a0d0f0","#e0f0ff","#80b0e0"]',
      '    oil → kind:liquid, density:3, viscosity:0.3, colors:["#2a1010","#4a2810","#1a0808","#603020"], reactions:[{other:"fire",becomes:"fire",chance:0.2}]',
      '    gunpowder → kind:powder, flow:0.6, density:4, colors:["#2a2a2a","#404040","#1a1a1a"], reactions:[{other:"fire",becomes:"fire",chance:0.5}]',
      '    tnt → kind:powder, flow:0.45, density:4, colors:["#c02020","#e03030","#ff4040","#802020"], reactions:[{other:"fire",explodes:true,explosionRadius:10,explosionPower:1.5,chance:0.9}]',
      '    mold → kind:cellular, density:3, born:[3,6], survive:[2,3,6], colors:["#304820","#405830","#50682a","#2a3818"]',
      '    life → kind:cellular, density:3, born:[3], survive:[2,3], colors:["#40e080","#30c060","#60f090","#20a050"]',
      '',
      'REACTION ANTI-PATTERNS (avoid these):',
      '- Do NOT make a sticky or gooey element convert other elements into itself (e.g. boogers turning water into boogers). That makes the element feel like a virus, not a physical material. Stickiness is handled by the `stickiness` property — reactions should model chemistry, not growth.',
      '- Reactions with `becomes: <self>` (the element converts things into more of itself) should only be used for truly contagious elements (fire spreading to plant, infection, etc.). Keep chance very low (< 0.06) and only against 1 other element max.',
      '- If the element description says "sticky" or "clingy", set `stickiness >= 0.7` instead of adding self-propagating reactions.',
      '- NEVER use "becomes" when "explodes" is true — the explosion mechanic handles what the cell becomes.',
      '',
      'RULES OF THUMB:',
      '- If the name contains "fire/flame/inferno/ember/plasma/spark/lightning" → kind MUST be gas, buoyancy >= 0.9, and add a reaction that burns plant/oil/wood.',
      '- If the name contains "smoke/steam/vapor/mist/fog/cloud" → kind MUST be gas.',
      '- If the name contains "wall/brick/stone/wood/metal/crystal/glass/ice/plant" → kind MUST be static unless the user says otherwise.',
      '- If the name contains "water/oil/lava/acid/slime/blood/juice/honey/syrup/tar/milk/soda/ink/wine" → kind MUST be liquid.',
      '- If the name contains "sand/salt/sugar/dust/ash/flour/glitter/snow/seed/gravel" → kind MUST be powder.',
      '- If the name contains "tnt/bomb/dynamite/explosive/c4/grenade/landmine/blastite" → kind MUST be powder, AND MUST have an explodes:true reaction triggered by fire.',
      '- If the name contains "mold/fungus/moss/coral/mycelium/lichen/slime-mold/life/conway/automaton" → kind MUST be cellular.',
      '- If the element sounds REACTIVE (burns, melts, freezes, dissolves, rusts, poisons, cures, grows, explodes, etches, corrodes), ADD AT LEAST ONE reaction. Elements with no reactions feel inert.',
      '',
      'COLORS: 3-6 hex values from a coherent palette that READS on near-black (#0f0e0c). Honey=warm gold, tar=near-black with brown flecks, acid=vivid neon green, snow=warm whites + pale blues, fire=orange/yellow/red, smoke=grays, lava=deep red/orange/yellow, plant=greens, ice=pale blues/cyans. Avoid pure #000000 or very dark colors for powders/liquids — they disappear.',
      '',
      'Before you respond, sanity-check: does this behaviour match what a human would expect when they see the name? If not, fix it. Respond with ONLY the JSON object.',
    ].join('\n');

    const userPrompt = desc
      ? `Name: ${name}\nDescription: ${desc}`
      : `Name: ${name}`;

    const body = {
      slug: SLUG,
      // Best model — the user explicitly asked for it. Element design is a
      // multi-knob reasoning task (kind + 4-5 numeric params + colors +
      // reactions) where mini was producing generic specs.
      model: 'gpt-5.4',
      temperature: 0.7,
      max_tokens: 600,
      response_format: 'json_object',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
    };

    const res = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('http_' + res.status);
    const data = await res.json();
    if (!data || typeof data.content !== 'string') throw new Error('bad_shape');
    let parsed;
    try { parsed = JSON.parse(data.content); } catch (e) { throw new Error('bad_json'); }
    if (!parsed || typeof parsed !== 'object') throw new Error('bad_obj');
    return parsed;
  }

  // Name-based overrides: if the user typed something with an obvious real-
  // world kind, the LLM occasionally miscategorises it. These rules are a
  // final safety net so "fire" always rises and "wall" never falls, no
  // matter what the model said. Only fires for unambiguous names.
  //
  // CRITICAL: we must check the KEY (element name) first, not the full
  // key+description blob. Example descriptions describe *interactions*
  // ("snow … melts on contact with fire", "acid … eats through walls",
  // "lava … hardens water into steam") — if we pattern-match those reaction
  // words as kind hints we get wildly wrong results (snow flagged as gas
  // because its desc mentions fire, acid flagged as static because its desc
  // mentions walls, lava flagged as gas because its desc mentions steam).
  // Previous bug: blob-match produced a gas for lava and snow, and a static
  // for acid. Three separate user reports. Fix: name-first, desc only as a
  // weak fallback for elements whose *name itself* contains one of the
  // category words.
  function kindOverrideFromName(key, desc) {
    // Whole-word matcher against a single string. Uses word boundaries so
    // "water" doesn't match "underwater cave" descriptions unexpectedly, and
    // more importantly so reaction verbs like "melts" don't match "melt".
    function hitsWord(str, words) {
      for (const w of words) {
        const re = new RegExp('(^|[^a-z0-9])' + w + '([^a-z0-9]|$)', 'i');
        if (re.test(str)) return true;
      }
      return false;
    }

    const name = (key || '').toLowerCase();

    // Pass 1 — match against the element NAME only. This is the strongest
    // signal: if the user types "acid", the thing is a liquid, period, no
    // matter what their free-text description says about it.
    // Order matters: gas first (airborne stuff must rise), then static,
    // then liquid, then powder.
    if (hitsWord(name, ['fire', 'flame', 'inferno', 'ember', 'plasma', 'lightning', 'spark'])) return 'gas';
    if (hitsWord(name, ['smoke', 'steam', 'vapor', 'mist', 'fog', 'cloud', 'haze'])) return 'gas';

    if (hitsWord(name, ['wall', 'brick', 'concrete', 'bedrock', 'stone', 'rock'])) return 'static';
    if (hitsWord(name, ['wood', 'timber', 'log', 'bark'])) return 'static';
    if (hitsWord(name, ['metal', 'iron', 'steel', 'copper', 'brass', 'gold', 'silver'])) return 'static';
    if (hitsWord(name, ['ice', 'icicle', 'glacier'])) return 'static';
    if (hitsWord(name, ['plant', 'leaf', 'vine', 'tree', 'grass', 'moss'])) return 'static';
    if (hitsWord(name, ['glass', 'crystal', 'gem', 'diamond'])) return 'static';

    if (hitsWord(name, ['lava', 'magma'])) return 'liquid';
    if (hitsWord(name, ['water', 'ocean', 'river'])) return 'liquid';
    if (hitsWord(name, ['oil', 'gasoline', 'petrol', 'fuel'])) return 'liquid';
    if (hitsWord(name, ['acid', 'poison'])) return 'liquid';
    if (hitsWord(name, ['honey', 'syrup', 'molasses', 'caramel', 'tar'])) return 'liquid';
    if (hitsWord(name, ['blood', 'slime', 'goo', 'ooze'])) return 'liquid';
    if (hitsWord(name, ['juice', 'milk', 'wine', 'soda', 'ink', 'paint'])) return 'liquid';

    if (hitsWord(name, ['sand', 'salt', 'sugar', 'flour', 'dust', 'talc'])) return 'powder';
    if (hitsWord(name, ['ash', 'soot', 'cinder', 'glitter', 'gravel'])) return 'powder';
    if (hitsWord(name, ['snow', 'seed', 'gunpowder', 'gun-powder', 'confetti'])) return 'powder';
    if (hitsWord(name, ['tnt', 'bomb', 'dynamite', 'explosive', 'c4', 'grenade', 'blastite', 'landmine'])) return 'powder';
    if (hitsWord(name, ['mold', 'fungus', 'mycelium', 'lichen', 'coral', 'conway', 'automaton', 'slime-mold'])) return 'cellular';

    // Pass 2 — fall back to description ONLY if the name itself didn't
    // give us anything. This catches e.g. user types "whoosh" with desc
    // "a rising burst of fire" → gas. We don't trust desc matches that
    // could be reaction language ("eats through walls", "melts fire")
    // enough to override the name, but if there's no name signal at all
    // it's better than nothing.
    const d = (desc || '').toLowerCase();
    if (!d) return null;
    if (hitsWord(d, ['fire', 'flame', 'inferno', 'ember', 'plasma'])) return 'gas';
    if (hitsWord(d, ['smoke', 'steam', 'vapor', 'fog'])) return 'gas';
    return null;
  }

  // Canonical numeric hints per name — used by `finalizeSpec` when the LLM
  // returned numbers keyed to the wrong kind (e.g. it thought lava was a
  // gas and gave us gas-only buoyancy/lifeMin values instead of viscosity).
  // Returns null when the name is too generic to hint. Mirrors the
  // per-name branches in `fallbackSpec` so behaviour stays consistent.
  function namePropertyHints(key) {
    const n = (key || '').toLowerCase();
    const has = (...words) => words.some(w => n.indexOf(w) >= 0);
    if (has('fire', 'flame', 'inferno', 'ember', 'plasma', 'spark', 'lightning')) {
      return { density: 1, buoyancy: 1, lifeMin: 30, lifeMax: 70 };
    }
    if (has('lava', 'magma'))          return { density: 8, viscosity: 0.8, stickiness: 0 };
    if (has('steam'))                  return { density: 2, buoyancy: 0.8, lifeMin: 30, lifeMax: 60 };
    if (has('smoke'))                  return { density: 2, buoyancy: 0.6, lifeMin: 60, lifeMax: 120 };
    if (has('fog', 'mist', 'vapor', 'cloud', 'haze')) return { density: 2, buoyancy: 0.5, lifeMin: 60, lifeMax: 120 };
    if (has('honey', 'syrup', 'molasses', 'caramel')) return { density: 6, viscosity: 0.9, stickiness: 0.7 };
    if (has('tar', 'pitch', 'glue', 'resin')) return { density: 6, viscosity: 0.95, stickiness: 0.85 };
    if (has('acid'))                   return { density: 4, viscosity: 0.1, stickiness: 0 };
    if (has('oil', 'gasoline', 'petrol', 'fuel')) return { density: 3, viscosity: 0.3, stickiness: 0 };
    if (has('water', 'juice', 'milk', 'wine', 'soda')) return { density: 5, viscosity: 0, stickiness: 0 };
    if (has('slime', 'goo', 'ooze'))   return { density: 5, viscosity: 0.6, stickiness: 0.5 };
    if (has('blood'))                  return { density: 6, viscosity: 0.4, stickiness: 0 };
    if (has('ink', 'paint'))           return { density: 5, viscosity: 0.2, stickiness: 0 };
    if (has('snow'))                   return { density: 2, flow: 0.4, stickiness: 0 };
    if (has('flour', 'dust', 'talc', 'powder')) return { density: 2, flow: 1.0, stickiness: 0 };
    if (has('ash', 'soot', 'cinder'))  return { density: 2, flow: 0.9, stickiness: 0 };
    if (has('gravel', 'pebbles', 'rocks')) return { density: 7, flow: 0.15, stickiness: 0 };
    if (has('gunpowder') || has('gun-powder')) return { density: 4, flow: 0.6, stickiness: 0 };
    if (has('salt', 'sugar', 'seed', 'rice', 'glitter', 'confetti', 'sand')) return { density: 4, flow: 0.55, stickiness: 0 };
    if (has('wood', 'timber', 'log', 'bark')) return { density: 4 };
    if (has('metal', 'iron', 'steel', 'copper', 'brass', 'gold', 'silver')) return { density: 8 };
    if (has('ice', 'icicle'))          return { density: 5 };
    if (has('plant', 'leaf', 'vine', 'tree', 'grass', 'moss')) return { density: 3 };
    return null;
  }

  // Sanitize and shape whatever the LLM returned into a valid spec.
  function finalizeSpec(displayName, key, raw, userDesc) {
    const kinds = ['static', 'powder', 'liquid', 'gas', 'cellular'];
    let kind = (raw && typeof raw.kind === 'string') ? raw.kind.toLowerCase() : 'powder';
    if (kinds.indexOf(kind) < 0) kind = 'powder';
    // Hard override for names with unambiguous real-world kinds.
    const override = kindOverrideFromName(key, userDesc);
    const kindWasOverridden = !!(override && override !== kind);
    if (override) kind = override;
    // Name-based property hints — used when the LLM either got the kind
    // wrong (so its density/viscosity/flow numbers were picked for the
    // wrong category) or omitted the per-kind knob entirely. We map the
    // canonical names to plausible defaults that `finalizeSpec` can
    // merge in below. Same table as `fallbackSpec`, kept in sync.
    const hint = namePropertyHints(key);

    let density = Number(raw && raw.density);
    if (!isFinite(density)) density = (hint && isFinite(hint.density)) ? hint.density : 5;
    // If we overrode the kind, the LLM's density was picked for the wrong
    // kind — prefer our canonical default if we have one.
    if (kindWasOverridden && hint && isFinite(hint.density)) density = hint.density;
    density = Math.max(1, Math.min(9, density));

    let colorsArr = Array.isArray(raw && raw.colors) ? raw.colors.filter(isHex).slice(0, 6) : [];
    if (colorsArr.length < 3) colorsArr = fillFallbackColors(key);

    // Reactions — `becomes` may reference this new element by its own key.
    const validKeys = new Set(Object.keys(keyToId));
    validKeys.add(key);
    const reactions = [];
    if (Array.isArray(raw && raw.reactions)) {
      let selfPropagateCount = 0;
      for (const rx of raw.reactions.slice(0, 3)) {
        if (!rx || typeof rx !== 'object') continue;
        const other = (typeof rx.other === 'string') ? rx.other.toLowerCase() : '';
        if (!validKeys.has(other)) continue;

        // Explosion reaction: { other, explodes: true, explosionRadius, explosionPower, chance }
        if (rx.explodes) {
          let chance = Number(rx.chance);
          if (!isFinite(chance)) chance = 0.9;
          chance = Math.max(0.1, Math.min(1, chance));
          const explosionRadius = Math.max(4, Math.min(20, Math.round(Number(rx.explosionRadius)) || 8));
          const explosionPower  = Math.max(0.3, Math.min(3, Number(rx.explosionPower) || 1));
          reactions.push({ other, explodes: true, explosionRadius, explosionPower, chance });
          continue;
        }

        let becomes = rx.becomes;
        if (becomes == null || becomes === '' || /^empty$/i.test(String(becomes))) {
          becomes = null;
        } else {
          becomes = String(becomes).toLowerCase();
          if (!validKeys.has(becomes)) continue;
        }
        let chance = Number(rx.chance);
        if (!isFinite(chance)) chance = 0.05;
        chance = Math.max(0.005, Math.min(0.25, chance));
        // Guard against "viral spread" anti-pattern: an element that converts
        // other materials into more of itself reads as a bug, not physics.
        // Cap self-propagating reactions to one max, with a low chance.
        // (Exception: fire spreading to plant/oil is expected and intentional.)
        if (becomes === key) {
          selfPropagateCount++;
          if (selfPropagateCount > 1) continue; // only allow one self-reaction
          chance = Math.min(chance, 0.05);       // cap viral spread chance
        }
        reactions.push({ other, becomes, chance });
      }
    }

    const out = {
      id: nextCustomId(),
      key,
      displayName: displayName.slice(0, 14).toLowerCase(),
      kind,
      density,
      colors: colorsArr,
      reactions,
      isBuiltIn: false,
      // Keep the user's original description so per-element feedback can
      // include "they asked for X but got Y" — makes iteration tractable.
      userDesc: userDesc || '',
    };

    // When we overrode the kind, the raw per-kind knobs belong to the
    // original (wrong) kind and shouldn't be trusted. Prefer name-based
    // hints in that case.
    const preferHint = kindWasOverridden && hint;
    if (kind === 'liquid') {
      let visc = Number(raw && raw.viscosity);
      if (preferHint && isFinite(hint.viscosity)) visc = hint.viscosity;
      else if (!isFinite(visc)) visc = (hint && isFinite(hint.viscosity)) ? hint.viscosity : 0;
      out.viscosity = Math.max(0, Math.min(1, visc));
      let stick = Number(raw && raw.stickiness);
      if (preferHint && isFinite(hint.stickiness)) stick = hint.stickiness;
      else if (!isFinite(stick)) stick = (hint && isFinite(hint.stickiness)) ? hint.stickiness : 0;
      out.stickiness = Math.max(0, Math.min(1, stick));
    } else if (kind === 'powder') {
      let flow = Number(raw && raw.flow);
      if (preferHint && isFinite(hint.flow)) flow = hint.flow;
      else if (!isFinite(flow)) flow = (hint && isFinite(hint.flow)) ? hint.flow : 0.55;
      out.flow = Math.max(0.05, Math.min(1, flow));
      let stick = Number(raw && raw.stickiness);
      if (preferHint && isFinite(hint.stickiness)) stick = hint.stickiness;
      else if (!isFinite(stick)) stick = (hint && isFinite(hint.stickiness)) ? hint.stickiness : 0;
      out.stickiness = Math.max(0, Math.min(1, stick));
    } else if (kind === 'gas') {
      let buoy = Number(raw && raw.buoyancy);
      if (preferHint && isFinite(hint.buoyancy)) buoy = hint.buoyancy;
      else if (!isFinite(buoy)) buoy = (hint && isFinite(hint.buoyancy)) ? hint.buoyancy : 0.9;
      out.buoyancy = Math.max(0.05, Math.min(1, buoy));
      let lifeMin = Math.round(Number(raw && raw.lifeMin));
      let lifeMax = Math.round(Number(raw && raw.lifeMax));
      if (preferHint && isFinite(hint.lifeMin)) lifeMin = hint.lifeMin;
      else if (!isFinite(lifeMin)) lifeMin = (hint && isFinite(hint.lifeMin)) ? hint.lifeMin : 60;
      if (preferHint && isFinite(hint.lifeMax)) lifeMax = hint.lifeMax;
      else if (!isFinite(lifeMax) || lifeMax < lifeMin) lifeMax = lifeMin + 40;
      lifeMin = Math.max(0, Math.min(150, lifeMin));
      lifeMax = Math.max(0, Math.min(200, lifeMax));
      if (lifeMin === 0 && lifeMax === 0) { lifeMin = 60; lifeMax = 100; }
      out.lifeMin = lifeMin; out.lifeMax = lifeMax;
    } else if (kind === 'cellular') {
      // born: neighbor counts that create a new cell from empty
      // survive: neighbor counts that keep an existing cell alive
      const parseIntArray = (v) => Array.isArray(v)
        ? v.map(Number).filter(n => isFinite(n) && n >= 0 && n <= 8).map(Math.round)
        : null;
      out.born    = parseIntArray(raw && raw.born)    || [3];
      out.survive = parseIntArray(raw && raw.survive) || [2, 3];
    }

    // Name-based reaction backstops: if the model produced no reactions for
    // an obviously-reactive element, add the canonical ones so the user
    // sees the expected behaviour (fire burns plants, acid eats walls, etc).
    const blob = (key + ' ' + (userDesc || '')).toLowerCase();
    const any = (...words) => words.some(w => blob.indexOf(w) >= 0);
    const hasReact = (other) => out.reactions.some(r => r.other === other);
    const tryAdd = (other, becomes, chance) => {
      if (!keyToId[other]) return;
      if (becomes != null && !keyToId[becomes] && becomes !== key) return;
      if (hasReact(other)) return;
      out.reactions.push({ other, becomes, chance });
    };
    const tryAddExplode = (other, radius, power, chance) => {
      if (!keyToId[other]) return;
      if (hasReact(other)) return;
      out.reactions.push({ other, explodes: true, explosionRadius: radius, explosionPower: power, chance });
    };
    if (kind === 'gas' && any('fire', 'flame', 'inferno', 'ember', 'plasma')) {
      tryAdd('plant', 'fire', 0.12);
      tryAdd('oil', 'fire', 0.2);
      tryAdd('wood', 'fire', 0.1);
      tryAdd('water', null, 0.25);
    }
    if (kind === 'liquid' && any('lava', 'magma')) {
      tryAdd('water', null, 0.2);
      tryAdd('plant', 'fire', 0.15);
    }
    if (kind === 'liquid' && any('acid')) {
      tryAdd('plant', null, 0.15);
      tryAdd('wall', null, 0.04);
      tryAdd('sand', null, 0.06);
    }
    if (kind === 'powder' && any('snow', 'ice')) {
      tryAdd('fire', null, 0.2);
    }
    // Explosive backstop: if an element with a clearly explosive name has no
    // fire reaction, add a guaranteed explosion reaction so users get the
    // expected "touch fire → BOOM" behaviour.
    if (kind === 'powder' && any('tnt', 'bomb', 'dynamite', 'explosive', 'blastite', 'c4', 'grenade')) {
      tryAddExplode('fire', 10, 1.5, 0.9);
    }
    if (kind === 'powder' && any('gunpowder', 'gun-powder')) {
      // Gunpowder chain-reacts but doesn't full-explode — leave as normal reaction.
      tryAdd('fire', 'fire', 0.5);
    }

    return out;
  }

  function isHex(s) { return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s); }

  function fillFallbackColors(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = ((h * 31) + key.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    const out = [];
    for (let i = 0; i < 5; i++) {
      const hh = (hue + i * 12) % 360;
      const ll = 38 + i * 6;
      out.push(hslToHex(hh, 55, ll));
    }
    return out;
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
      const col = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return Math.round(255 * col).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  // Offline / rate-limit fallback: keyword-sniff a plausible spec. The
  // registry is checked so reactions only reference elements that actually
  // exist in this session.
  function fallbackSpec(displayName, key, desc) {
    const blob = (key + ' ' + (desc || '')).toLowerCase();
    const has = (...words) => words.some(w => blob.indexOf(w) >= 0);
    const keyExists = (k) => keyToId[k] != null;
    const react = (other, becomes, chance) =>
      keyExists(other) && (becomes == null || keyExists(becomes))
        ? { other, becomes, chance }
        : null;
    const reactList = (...rs) => rs.filter(Boolean);

    let kind = 'powder';
    let density = 5;
    let viscosity = 0;
    let flow = 0.55;
    let stickiness = 0;
    let buoyancy = 0.9;
    let lifeMin = 60, lifeMax = 110;
    let colorsOverride = null;
    let reactions = [];
    let born = [3];
    let survive = [2, 3];

    if (has('fire', 'flame', 'inferno', 'ember', 'plasma', 'spark', 'lightning')) {
      kind = 'gas'; density = 1; buoyancy = 1; lifeMin = 30; lifeMax = 70;
      colorsOverride = ['#ff4020', '#ff8010', '#ffc040', '#ffe070', '#d02010'];
      reactions = reactList(
        react('water', null, 0.25),
        react('plant', 'fire', 0.12),
        react('oil', 'fire', 0.2),
        react('wood', 'fire', 0.1),
      );
    } else if (has('lava', 'magma')) {
      kind = 'liquid'; density = 8; viscosity = 0.8;
      colorsOverride = ['#ff5020', '#ff8030', '#d03010', '#ffc040'];
      reactions = reactList(
        react('water', null, 0.2),
        react('plant', 'fire', 0.15),
        react('wood', 'fire', 0.12),
      );
    } else if (has('smoke', 'steam', 'fog', 'mist', 'vapor', 'cloud', 'spore', 'haze')) {
      kind = 'gas'; density = 2; buoyancy = 0.6; lifeMin = 60; lifeMax = 120;
      if (has('steam')) colorsOverride = ['#d8e8f0', '#b0c8d8', '#f0f6fa'];
      else if (has('smoke')) colorsOverride = ['#606060', '#808080', '#4a4a4a', '#a0a0a0'];
      else colorsOverride = ['#a0b8c8', '#c0d0dc', '#7890a0'];
    } else if (has('ice', 'icicle')) {
      kind = 'static'; density = 5;
      colorsOverride = ['#c0e0ff', '#a0d0f0', '#e0f0ff', '#80b0e0'];
    } else if (has('plant', 'leaf', 'vine', 'tree', 'grass', 'moss')) {
      kind = 'static'; density = 3;
      colorsOverride = ['#409040', '#60a050', '#308030', '#80b060'];
    } else if (has('wood', 'timber', 'log', 'bark', 'twig')) {
      kind = 'static'; density = 4;
      colorsOverride = ['#7a4820', '#8a5828', '#5a3010', '#a06838'];
    } else if (has('metal', 'iron', 'steel', 'copper', 'brass', 'gold', 'silver')) {
      kind = 'static'; density = 8;
      colorsOverride = ['#9a9a9a', '#b0b0b0', '#707070', '#c8c8c8'];
    } else if (has('rock', 'stone', 'brick', 'concrete', 'crystal', 'glass', 'bone', 'web')) {
      kind = 'static';
    } else if (has('honey', 'syrup', 'molasses', 'caramel')) {
      kind = 'liquid'; density = 6; viscosity = 0.9; stickiness = 0.7;
      colorsOverride = ['#e8a030', '#d48020', '#ffc050', '#b86020'];
    } else if (has('tar', 'glue', 'resin', 'pitch')) {
      kind = 'liquid'; density = 6; viscosity = 0.95; stickiness = 0.85;
      colorsOverride = ['#1a1008', '#2a1810', '#3a2418'];
    } else if (has('acid')) {
      kind = 'liquid'; density = 4; viscosity = 0.1;
      colorsOverride = ['#60ff30', '#80ff40', '#30d020', '#b0ff60'];
      reactions = reactList(
        react('wall', null, 0.04),
        react('sand', null, 0.06),
        react('plant', null, 0.15),
      );
    } else if (has('oil', 'gasoline', 'petrol', 'fuel')) {
      kind = 'liquid'; density = 3; viscosity = 0.3;
      colorsOverride = ['#2a1010', '#4a2810', '#1a0808', '#603020'];
      reactions = reactList(react('fire', 'fire', 0.2));
    } else if (has('water', 'juice', 'milk', 'wine', 'soda', 'liquid')) {
      kind = 'liquid'; density = 5; viscosity = 0;
    } else if (has('slime', 'goo', 'ooze')) {
      kind = 'liquid'; density = 5; viscosity = 0.6; stickiness = 0.5;
      colorsOverride = ['#60c060', '#40a040', '#80d080'];
    } else if (has('blood')) {
      kind = 'liquid'; density = 6; viscosity = 0.4;
      colorsOverride = ['#a02020', '#801010', '#c03030', '#600808'];
    } else if (has('ink', 'paint')) {
      kind = 'liquid'; density = 5; viscosity = 0.2;
    } else if (has('snow')) {
      kind = 'powder'; density = 2; flow = 0.4;
      colorsOverride = ['#ffffff', '#e8f0ff', '#d0e0f0', '#fafcff'];
      reactions = reactList(react('fire', null, 0.25));
    } else if (has('flour', 'powder', 'dust', 'talc')) {
      kind = 'powder'; flow = 1.0; density = 2;
    } else if (has('ash', 'soot', 'cinder')) {
      kind = 'powder'; flow = 0.9; density = 2;
      colorsOverride = ['#505050', '#707070', '#3a3a3a'];
    } else if (has('gravel', 'rocks', 'pebbles')) {
      kind = 'powder'; flow = 0.15; density = 7;
    } else if (has('gunpowder', 'gun-powder')) {
      kind = 'powder'; flow = 0.6; density = 4;
      colorsOverride = ['#2a2a2a', '#404040', '#1a1a1a'];
      reactions = reactList(react('fire', 'fire', 0.5));
    } else if (has('tnt', 'bomb', 'dynamite', 'explosive', 'c4', 'grenade', 'blastite', 'landmine')) {
      kind = 'powder'; flow = 0.45; density = 4;
      colorsOverride = ['#c02020', '#e03030', '#ff4040', '#802020'];
      // Explosion reaction — blows up on contact with fire
      if (keyExists('fire')) {
        reactions = [{ other: 'fire', explodes: true, explosionRadius: 10, explosionPower: 1.5, chance: 0.9 }];
      }
    } else if (has('mold', 'fungus', 'mycelium', 'lichen', 'coral', 'slime-mold')) {
      kind = 'cellular'; density = 3; born = [3, 6]; survive = [2, 3, 6];
      colorsOverride = ['#304820', '#405830', '#50682a', '#2a3818'];
    } else if (has('conway', 'automaton', 'life')) {
      kind = 'cellular'; density = 3; born = [3]; survive = [2, 3];
      colorsOverride = ['#40e080', '#30c060', '#60f090', '#20a050'];
    } else if (has('sand', 'salt', 'glitter', 'seed', 'sugar', 'rice', 'confetti', 'gun-powder')) {
      kind = 'powder'; flow = 0.55;
    }

    const out = {
      id: nextCustomId(),
      key,
      displayName: displayName.slice(0, 14).toLowerCase(),
      kind,
      density,
      colors: colorsOverride || fillFallbackColors(key),
      reactions,
      isBuiltIn: false,
      userDesc: desc || '',
    };
    if (kind === 'liquid')   { out.viscosity = viscosity; out.stickiness = stickiness; }
    if (kind === 'powder')   { out.flow = flow; out.stickiness = stickiness; }
    if (kind === 'gas')      { out.buoyancy = buoyancy; out.lifeMin = lifeMin; out.lifeMax = lifeMax; }
    if (kind === 'cellular') { out.born = born; out.survive = survive; }
    return out;
  }
})();

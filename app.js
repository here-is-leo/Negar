(() => {
'use strict';

/* ═══════════════════════════════════════════
   DOM & STATE
   ═══════════════════════════════════════════ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const gridCv = $('#grid-canvas');
const drawCv = $('#draw-canvas');
const gctx = gridCv.getContext('2d');
const ctx = drawCv.getContext('2d');
const cursorEl = $('#cursor');
const panelEl = $('#panel');
const emptyEl = $('#empty');
const textInput = $('#text-input');
const toastsEl = $('#toasts');
const zoomLabel = $('#zoom-label');

const S = {
  tool: 'pen',
  stroke: '#18181B',
  width: 4,
  style: 'solid',
  opacity: 1,
  theme: localStorage.getItem('theme') || 'light',
  elements: [],
  selected: new Set(),
  viewport: { x: 0, y: 0, z: 1 },
  history: [],
  histIdx: -1,
  drawing: false,
  current: null,
  dragging: null,
  pan: null,
  erasing: null,
  clipboard: null,
  space: false,
  shift: false,
  showGrid: true,
};

let dpr = 1;
const uid = () => Math.random().toString(36).slice(2, 10);

/* ═══════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════ */
function init() {
  applyTheme();
  resize();
  setTool('pen');
  setStroke(S.stroke);
  pushHistory();
  bindUI();
  bindCanvas();
  bindKeyboard();
  updateZoomLabel();
}

window.addEventListener('resize', resize);

function resize() {
  dpr = window.devicePixelRatio || 1;
  const w = innerWidth, h = innerHeight;
  [gridCv, drawCv].forEach(c => {
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.width = w + 'px';
    c.style.height = h + 'px';
  });
  drawGrid();
  render();
}

/* ═══════════════════════════════════════════
   GRID
   ═══════════════════════════════════════════ */
function drawGrid() {
  gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gctx.clearRect(0, 0, gridCv.width, gridCv.height);
  if (!S.showGrid) return;
  const { x, y, z } = S.viewport;
  const size = 24 * z;
  const offX = ((x % size) + size) % size;
  const offY = ((y % size) + size) % size;
  gctx.fillStyle = getComputedStyle(document.documentElement)
    .getPropertyValue('--grid-dot').trim() || 'rgba(0,0,0,.08)';
  const radius = Math.min(1.1 * z, 1.6);
  const W = gridCv.width / dpr, H = gridCv.height / dpr;
  for (let px = offX; px < W; px += size) {
    for (let py = offY; py < H; py += size) {
      gctx.beginPath();
      gctx.arc(px, py, radius, 0, Math.PI * 2);
      gctx.fill();
    }
  }
}

/* ═══════════════════════════════════════════
   RENDER
   ═══════════════════════════════════════════ */
function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, drawCv.width, drawCv.height);

  const { x, y, z } = S.viewport;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(z, z);

  for (const el of S.elements) drawElement(el);
  if (S.current) drawElement(S.current);
  ctx.restore();

  if (S.selected.size > 0) drawSelection();
}

function drawElement(el) {
  if (el.hidden) return;
  ctx.globalAlpha = el.opacity ?? 1;

  // ✓ تشخیص بر اساس وجود points، نه اسم ابزار
  if (el.points) {
    drawFreehand(el);
  } else if (el.type === 'text') {
    drawText(el);
  } else {
    drawShape(el);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}
/* ═══════════════════════════════════════════
   FREEHAND ENGINE
   ═══════════════════════════════════════════ */
function drawFreehand(el) {
  const raw = el.points;
  if (!raw?.length) return;

  const isHi = el.type === 'highlighter';
  const isEr = el.type === 'eraser';

  if (isHi) ctx.globalCompositeOperation = 'multiply';
  else if (isEr) ctx.globalCompositeOperation = 'destination-out';
  const fill = isEr ? '#000' : el.color;

  if (raw.length === 1) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(raw[0].x, raw[0].y, el.width / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    return;
  }

  const STREAMLINE = 0.45;
  const pts = [{ x: raw[0].x, y: raw[0].y }];
  for (let i = 1; i < raw.length; i++) {
    const p = pts[pts.length - 1];
    pts.push({
      x: p.x + (raw[i].x - p.x) * (1 - STREAMLINE),
      y: p.y + (raw[i].y - p.y) * (1 - STREAMLINE),
    });
  }

  const path = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = path[path.length - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dx * dx + dy * dy > 0.5) path.push(b);
  }
  if (path.length < 2) path.push(pts[pts.length - 1]);
  const n = path.length;
  if (n < 2) return;

  const vel = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    vel[i] = Math.hypot(b.x - a.x, b.y - a.y) / 2;
  }
  for (let k = 0; k < 3; k++) {
    for (let i = 1; i < n - 1; i++) {
      vel[i] = (vel[i - 1] + vel[i] * 2 + vel[i + 1]) / 4;
    }
  }

  const baseW = el.width * (isHi ? 2.6 : 1);
  const MIN_RATIO = 0.35;
  const MAX_SPEED = 26;
  const widths = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = Math.min(vel[i] / MAX_SPEED, 1);
    const e = t * t * (3 - 2 * t);
    widths[i] = baseW * (1 - e * (1 - MIN_RATIO));
  }
  for (let k = 0; k < 2; k++) {
    for (let i = 1; i < n - 1; i++) {
      widths[i] = (widths[i - 1] + widths[i] * 2 + widths[i + 1]) / 4;
    }
  }

  const taper = Math.min(Math.floor(n * 0.18), 6);
  for (let i = 0; i < taper; i++) {
    const f = (i / taper) ** 2;
    widths[i] *= f;
    widths[n - 1 - i] *= f;
  }

  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len, ny = tx / len;
    const hw = Math.max(widths[i] / 2, 0.4);
    left.push({ x: path[i].x + nx * hw, y: path[i].y + ny * hw });
    right.push({ x: path[i].x - nx * hw, y: path[i].y - ny * hw });
  }

  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(left[0].x, left[0].y);
  for (let i = 1; i < n - 1; i++) {
    const mx = (left[i].x + left[i + 1].x) / 2;
    const my = (left[i].y + left[i + 1].y) / 2;
    ctx.quadraticCurveTo(left[i].x, left[i].y, mx, my);
  }
  ctx.lineTo(left[n - 1].x, left[n - 1].y);
  for (let i = n - 1; i > 0; i--) {
    const mx = (right[i].x + right[i - 1].x) / 2;
    const my = (right[i].y + right[i - 1].y) / 2;
    ctx.quadraticCurveTo(right[i].x, right[i].y, mx, my);
  }
  ctx.lineTo(right[0].x, right[0].y);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.arc(path[0].x, path[0].y, Math.max(widths[0] / 2, 0.4), 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(path[n - 1].x, path[n - 1].y, Math.max(widths[n - 1] / 2, 0.4), 0, Math.PI * 2);
  ctx.fill();

  ctx.globalCompositeOperation = 'source-over';
}

/* ═══════════════════════════════════════════
   SHAPES
   ═══════════════════════════════════════════ */
function drawShape(el) {
  const x = Math.min(el.x, el.x + el.w);
  const y = Math.min(el.y, el.y + el.h);
  const w = Math.abs(el.w);
  const h = Math.abs(el.h);

  ctx.save();
  if (el.angle) {
    const cx = x + w / 2, cy = y + h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(el.angle);
    ctx.translate(-cx, -cy);
  }

  ctx.strokeStyle = el.color;
  ctx.fillStyle = el.fill && el.fill !== 'transparent' ? el.fill : 'transparent';
  ctx.lineWidth = el.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  setDash(ctx, el.style, el.width);

  ctx.beginPath();

  if (el.type === 'rect') {
    roundRect(ctx, x, y, w, h, Math.min(10, Math.min(w, h) * 0.15));
  } else if (el.type === 'ellipse') {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (el.type === 'diamond') {
    const cx = x + w / 2, cy = y + h / 2;
    ctx.moveTo(cx, y);
    ctx.lineTo(x + w, cy);
    ctx.lineTo(cx, y + h);
    ctx.lineTo(x, cy);
    ctx.closePath();
  } else if (el.type === 'triangle') {
    ctx.moveTo(x + w / 2, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
  } else if (el.type === 'star') {
    const cx = x + w / 2, cy = y + h / 2;
    const rx = w / 2, ry = h / 2;
    const spikes = 5, inner = 0.42;
    for (let i = 0; i < spikes * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / spikes;
      const f = i % 2 === 0 ? 1 : inner;
      const px = cx + Math.cos(a) * rx * f;
      const py = cy + Math.sin(a) * ry * f;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
  } else if (el.type === 'line') {
    ctx.moveTo(el.x, el.y);
    ctx.lineTo(el.x + el.w, el.y + el.h);
  } else if (el.type === 'arrow') {
    const x1 = el.x, y1 = el.y, x2 = el.x + el.w, y2 = el.y + el.h;
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const hl = Math.max(12, el.width * 4);
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - hl * Math.cos(ang - Math.PI / 7), y2 - hl * Math.sin(ang - Math.PI / 7));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - hl * Math.cos(ang + Math.PI / 7), y2 - hl * Math.sin(ang + Math.PI / 7));
  }

  if (el.fill && el.fill !== 'transparent' && !['line', 'arrow'].includes(el.type)) {
    ctx.fill();
  }
  ctx.stroke();
  ctx.restore();
}

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

function setDash(c, style, w) {
  c.setLineDash([]);
  if (style === 'dashed') c.setLineDash([w * 3, w * 2]);
  else if (style === 'dotted') c.setLineDash([0.1, w * 2]);
}

function drawText(el) {
  ctx.save();
  ctx.fillStyle = el.color;
  ctx.font = `500 ${el.fontSize || 20}px Vazirmatn, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.direction = 'rtl';
  const lines = (el.text || '').split('\n');
  const lh = (el.fontSize || 20) * 1.35;
  lines.forEach((line, i) => ctx.fillText(line, el.x, el.y + i * lh));
  ctx.restore();
}

/* ═══════════════════════════════════════════
   SELECTION
   ═══════════════════════════════════════════ */
function drawSelection() {
  const b = getSelectionBounds();
  if (!b) return;
  const { x, y, z } = S.viewport;
  const sx = b.x * z + x, sy = b.y * z + y;
  const sw = b.w * z, sh = b.h * z;
  const pad = 6;

  ctx.save();
  ctx.strokeStyle = '#6366F1';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(sx - pad, sy - pad, sw + pad * 2, sh + pad * 2);
  ctx.setLineDash([]);

  const corners = [
    [sx - pad, sy - pad], [sx + sw + pad, sy - pad],
    [sx + sw + pad, sy + sh + pad], [sx - pad, sy + sh + pad],
  ];
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#6366F1';
  for (const [cx, cy] of corners) {
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function getSelectionBounds() {
  if (!S.selected.size) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of S.elements) {
    if (!S.selected.has(el.id)) continue;
    const b = bounds(el);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function bounds(el) {
  if (el.points) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const p of el.points) {
      x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y);
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  if (el.type === 'text') {
    const lines = (el.text || '').split('\n');
    const lh = (el.fontSize || 20) * 1.35;
    const w = Math.max(...lines.map(l => ctx.measureText(l).width), 60);
    return { x: el.x, y: el.y, w, h: lines.length * lh };
  }
  return {
    x: Math.min(el.x, el.x + el.w),
    y: Math.min(el.y, el.y + el.h),
    w: Math.abs(el.w),
    h: Math.abs(el.h),
  };
}

/* ═══════════════════════════════════════════
   COORDS
   ═══════════════════════════════════════════ */
function toWorld(cx, cy) {
  const { x, y, z } = S.viewport;
  return { x: (cx - x) / z, y: (cy - y) / z };
}

function hitTest(wx, wy, r = 8) {
  for (let i = S.elements.length - 1; i >= 0; i--) {
    const el = S.elements[i];
    if (el.hidden) continue;
    if (hitElement(el, wx, wy, r)) return el;
  }
  return null;
}

/* Precise hit test — used by select and eraser */
function hitElement(el, wx, wy, r) {
  if (el.points && el.points.length) {
    const pts = el.points;
    const step = Math.max(1, Math.floor(pts.length / 60));
    const r2 = r * r;
    for (let i = 0; i < pts.length; i += step) {
      const dx = pts[i].x - wx, dy = pts[i].y - wy;
      if (dx * dx + dy * dy <= r2) return true;
    }
    const last = pts[pts.length - 1];
    const dx = last.x - wx, dy = last.y - wy;
    if (dx * dx + dy * dy <= r2) return true;
    // segment test between coarse points
    for (let i = 0; i < pts.length - 1; i += step) {
      const a = pts[i], b = pts[Math.min(i + step, pts.length - 1)];
      if (distToSegment(wx, wy, a.x, a.y, b.x, b.y) <= r) return true;
    }
    return false;
  }
  if (el.type === 'line' || el.type === 'arrow') {
    return distToSegment(wx, wy, el.x, el.y, el.x + el.w, el.y + el.h) <= r;
  }
  const b = bounds(el);
  return wx >= b.x - r && wx <= b.x + b.w + r &&
         wy >= b.y - r && wy <= b.y + b.h + r;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/* ═══════════════════════════════════════════
   CANVAS EVENTS
   ═══════════════════════════════════════════ */
function bindCanvas() {
  drawCv.addEventListener('pointerdown', onDown);
  drawCv.addEventListener('pointermove', onMove);
  drawCv.addEventListener('pointerup', onUp);
  drawCv.addEventListener('pointercancel', onUp);
  window.addEventListener('pointerup', onUp);
  drawCv.addEventListener('wheel', onWheel, { passive: false });
}

function onDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  try { drawCv.setPointerCapture(e.pointerId); } catch (_) {}

  hideEmpty();
  const p = toWorld(e.clientX, e.clientY);

  /* --- PAN --- */
  if (S.tool === 'hand' || S.space) {
    S.pan = { sx: e.clientX, sy: e.clientY, vx: S.viewport.x, vy: S.viewport.y };
    document.body.classList.add('panning');
    return;
  }

  /* --- ERASER: whole-element --- */
  if (S.tool === 'eraser') {
    S.erasing = { ids: new Set() };
    cursorEl.classList.add('drawing');
    eraseAt(p.x, p.y);
    render();
    return;
  }

  /* --- SELECT --- */
  if (S.tool === 'select') {
    const hit = hitTest(p.x, p.y, 6);
    if (hit) {
      if (!S.selected.has(hit.id)) {
        if (!e.shiftKey) S.selected.clear();
        S.selected.add(hit.id);
      } else if (e.shiftKey) {
        S.selected.delete(hit.id);
      }
      S.dragging = { sx: p.x, sy: p.y, orig: {} };
      for (const el of S.elements) {
        if (S.selected.has(el.id)) S.dragging.orig[el.id] = JSON.parse(JSON.stringify(el));
      }
    } else {
      if (!e.shiftKey) S.selected.clear();
      S.dragging = { type: 'marquee', sx: p.x, sy: p.y, ex: p.x, ey: p.y };
    }
    render();
    return;
  }

  /* --- TEXT --- */
  if (S.tool === 'text') {
    openText(p.x, p.y);
    return;
  }

  /* --- DRAW --- */
  S.drawing = true;
  cursorEl.classList.add('drawing');
  const base = {
    id: uid(),
    type: S.tool,
    color: S.stroke,
    width: S.width,
    style: S.style,
    opacity: S.tool === 'highlighter' ? 0.4 : S.opacity,
    fill: 'transparent',
    angle: 0,
  };

  if (['pen', 'highlighter'].includes(S.tool)) {
    S.current = { ...base, points: [{ x: p.x, y: p.y }] };
  } else {
    S.current = { ...base, x: p.x, y: p.y, w: 0, h: 0 };
  }
  render();
}

function eraseAt(wx, wy) {
  if (!S.erasing) return;
  const r = Math.max(S.width * 2, 12);
  for (let i = S.elements.length - 1; i >= 0; i--) {
    const el = S.elements[i];
    if (el.hidden) continue;
    if (S.erasing.ids.has(el.id)) continue;
    if (hitElement(el, wx, wy, r)) {
      S.erasing.ids.add(el.id);
      S.elements.splice(i, 1);
    }
  }
}

function onMove(e) {
  if (S.tool !== 'hand' && !S.space) {
    cursorEl.style.transform = `translate3d(${e.clientX}px,${e.clientY}px,0)`;
    cursorEl.classList.add('on');
  } else {
    cursorEl.classList.remove('on');
  }

  const p = toWorld(e.clientX, e.clientY);

  if (S.pan) {
    S.viewport.x = S.pan.vx + (e.clientX - S.pan.sx);
    S.viewport.y = S.pan.vy + (e.clientY - S.pan.sy);
    drawGrid();
    render();
    return;
  }

  /* --- ERASING --- */
  if (S.erasing) {
    e.preventDefault();
    const events = e.getCoalescedEvents?.() ?? [e];
    for (const ev of events) {
      const q = toWorld(ev.clientX, ev.clientY);
      eraseAt(q.x, q.y);
    }
    render();
    return;
  }

  if (S.dragging) {
    if (S.dragging.type === 'marquee') {
      S.dragging.ex = p.x;
      S.dragging.ey = p.y;
    } else {
      const dx = p.x - S.dragging.sx;
      const dy = p.y - S.dragging.sy;
      for (const el of S.elements) {
        if (!S.selected.has(el.id)) continue;
        const o = S.dragging.orig[el.id];
        if (o.points) {
          el.points = o.points.map(pt => ({ x: pt.x + dx, y: pt.y + dy }));
        } else {
          el.x = o.x + dx;
          el.y = o.y + dy;
        }
      }
    }
    render();
    return;
  }

  if (!S.drawing || !S.current) return;
  e.preventDefault();

  if (S.current.points) {
    const events = e.getCoalescedEvents?.() ?? [e];
    for (const ev of events) {
      const q = toWorld(ev.clientX, ev.clientY);
      S.current.points.push({ x: q.x, y: q.y });
    }
  } else {
    let ex = p.x, ey = p.y;
    if (e.shiftKey) {
      const dx = ex - S.current.x;
      const dy = ey - S.current.y;
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      ex = S.current.x + Math.sign(dx) * m;
      ey = S.current.y + Math.sign(dy) * m;
    }
    S.current.w = ex - S.current.x;
    S.current.h = ey - S.current.y;
  }
  render();
}

function onUp(e) {
  document.body.classList.remove('panning');

  if (S.pan) { S.pan = null; return; }

  /* --- ERASER END --- */
  if (S.erasing) {
    const count = S.erasing.ids.size;
    S.erasing = null;
    cursorEl.classList.remove('drawing');
    if (count > 0) {
      pushHistory();
      toast(count === 1 ? 'حذف شد' : `${count} عنصر حذف شد`);
    }
    render();
    return;
  }

  if (S.dragging) {
    if (S.dragging.type === 'marquee') {
      const bx = Math.min(S.dragging.sx, S.dragging.ex);
      const by = Math.min(S.dragging.sy, S.dragging.ey);
      const bw = Math.abs(S.dragging.ex - S.dragging.sx);
      const bh = Math.abs(S.dragging.ey - S.dragging.sy);
      if (!e.shiftKey) S.selected.clear();
      if (bw > 3 || bh > 3) {
        for (const el of S.elements) {
          const b = bounds(el);
          if (b.x < bx + bw && b.x + b.w > bx && b.y < by + bh && b.y + b.h > by) {
            S.selected.add(el.id);
          }
        }
      }
    } else {
      pushHistory();
    }
    S.dragging = null;
    render();
    return;
  }

  if (!S.drawing || !S.current) return;
  S.drawing = false;
  cursorEl.classList.remove('drawing');

  const el = S.current;
  if (el.points) {
    if (el.points.length >= 1) {
      S.elements.push(el);
      pushHistory();
    }
  } else {
    if (Math.abs(el.w) > 1 || Math.abs(el.h) > 1) {
      S.elements.push(el);
      pushHistory();
    }
  }
  S.current = null;
  render();
}

function onWheel(e) {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const f = Math.exp(-e.deltaY * 0.002);
    const nz = Math.max(0.1, Math.min(5, S.viewport.z * f));
    S.viewport.x = e.clientX - (e.clientX - S.viewport.x) * (nz / S.viewport.z);
    S.viewport.y = e.clientY - (e.clientY - S.viewport.y) * (nz / S.viewport.z);
    S.viewport.z = nz;
    updateZoomLabel();
  } else {
    S.viewport.x -= e.deltaX;
    S.viewport.y -= e.deltaY;
  }
  drawGrid();
  render();
}

/* ═══════════════════════════════════════════
   TEXT
   ═══════════════════════════════════════════ */
let textTarget = null;

function openText(wx, wy) {
  const px = wx * S.viewport.z + S.viewport.x;
  const py = wy * S.viewport.z + S.viewport.y;
  textInput.style.display = 'block';
  textInput.style.left = px + 'px';
  textInput.style.top = py + 'px';
  textInput.style.color = S.stroke;
  textInput.style.fontSize = (20 * S.viewport.z) + 'px';
  textInput.value = '';
  textInput.focus();
  textTarget = { x: wx, y: wy };
}

textInput.addEventListener('input', () => {
  textInput.style.height = 'auto';
  textInput.style.height = textInput.scrollHeight + 'px';
});

textInput.addEventListener('blur', commitText);
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { textInput.value = ''; textInput.blur(); }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textInput.blur(); }
});

function commitText() {
  const text = textInput.value.trim();
  textInput.style.display = 'none';
  if (!text || !textTarget) { textTarget = null; return; }
  S.elements.push({
    id: uid(), type: 'text',
    x: textTarget.x, y: textTarget.y,
    text, color: S.stroke,
    fontSize: 20, opacity: 1,
  });
  textTarget = null;
  pushHistory();
  render();
}

/* ═══════════════════════════════════════════
   HISTORY
   ═══════════════════════════════════════════ */
function pushHistory() {
  S.history = S.history.slice(0, S.histIdx + 1);
  S.history.push(JSON.stringify(S.elements));
  if (S.history.length > 100) S.history.shift();
  S.histIdx = S.history.length - 1;
  updateHist();
}

function undo() {
  if (S.histIdx <= 0) return;
  S.histIdx--;
  S.elements = JSON.parse(S.history[S.histIdx]);
  S.selected.clear();
  render();
  updateHist();
}

function redo() {
  if (S.histIdx >= S.history.length - 1) return;
  S.histIdx++;
  S.elements = JSON.parse(S.history[S.histIdx]);
  S.selected.clear();
  render();
  updateHist();
}

function updateHist() {
  $('[data-action="undo"]').disabled = S.histIdx <= 0;
  $('[data-action="redo"]').disabled = S.histIdx >= S.history.length - 1;
}

/* ═══════════════════════════════════════════
   ZOOM
   ═══════════════════════════════════════════ */
function zoomBy(f) {
  const cx = innerWidth / 2, cy = innerHeight / 2;
  const nz = Math.max(0.1, Math.min(5, S.viewport.z * f));
  S.viewport.x = cx - (cx - S.viewport.x) * (nz / S.viewport.z);
  S.viewport.y = cy - (cy - S.viewport.y) * (nz / S.viewport.z);
  S.viewport.z = nz;
  drawGrid(); render(); updateZoomLabel();
}

function resetView() {
  S.viewport = { x: 0, y: 0, z: 1 };
  drawGrid(); render(); updateZoomLabel();
}

function updateZoomLabel() {
  if (zoomLabel) zoomLabel.textContent = Math.round(S.viewport.z * 100) + '%';
}

/* ═══════════════════════════════════════════
   SELECTION HELPERS
   ═══════════════════════════════════════════ */
function getSelected() {
  return S.elements.filter(el => S.selected.has(el.id));
}

function duplicateSelected() {
  const sel = getSelected();
  if (!sel.length) return;
  const copies = sel.map(el => {
    const c = JSON.parse(JSON.stringify(el));
    c.id = uid();
    if (c.points) c.points = c.points.map(p => ({ x: p.x + 20, y: p.y + 20 }));
    else { c.x += 20; c.y += 20; }
    return c;
  });
  S.elements.push(...copies);
  S.selected = new Set(copies.map(c => c.id));
  pushHistory();
  render();
  toast(`${copies.length} عنصر تکثیر شد`);
}

function copySelected() {
  const sel = getSelected();
  if (!sel.length) return;
  S.clipboard = JSON.parse(JSON.stringify(sel));
  toast(`${sel.length} عنصر کپی شد`);
}

function pasteClipboard() {
  if (!S.clipboard?.length) return;
  const copies = S.clipboard.map(el => {
    const c = JSON.parse(JSON.stringify(el));
    c.id = uid();
    if (c.points) c.points = c.points.map(p => ({ x: p.x + 30, y: p.y + 30 }));
    else { c.x += 30; c.y += 30; }
    return c;
  });
  S.elements.push(...copies);
  S.selected = new Set(copies.map(c => c.id));
  S.clipboard = copies.map(c => JSON.parse(JSON.stringify(c)));
  pushHistory();
  render();
  toast('چسبانده شد');
}

function bringToFront() {
  if (!S.selected.size) return;
  const sel = S.elements.filter(el => S.selected.has(el.id));
  const rest = S.elements.filter(el => !S.selected.has(el.id));
  S.elements = [...rest, ...sel];
  pushHistory(); render();
  toast('به جلو منتقل شد');
}

function sendToBack() {
  if (!S.selected.size) return;
  const sel = S.elements.filter(el => S.selected.has(el.id));
  const rest = S.elements.filter(el => !S.selected.has(el.id));
  S.elements = [...sel, ...rest];
  pushHistory(); render();
  toast('به عقب منتقل شد');
}

function deleteSelected() {
  if (!S.selected.size) return;
  S.elements = S.elements.filter(el => !S.selected.has(el.id));
  S.selected.clear();
  pushHistory(); render();
}

/* ═══════════════════════════════════════════
   UI BINDING
   ═══════════════════════════════════════════ */
function bindUI() {
  $$('.tool[data-tool]').forEach(b => {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });

  $('[data-action="undo"]').addEventListener('click', undo);
  $('[data-action="redo"]').addEventListener('click', redo);
  $('[data-action="theme"]').addEventListener('click', toggleTheme);
  $('[data-action="help"]').addEventListener('click', () => $('#help').classList.add('is-open'));
  $('[data-action="export"]').addEventListener('click', exportPNG);

  $('[data-action="zoom-in"]').addEventListener('click', () => zoomBy(1.2));
  $('[data-action="zoom-out"]').addEventListener('click', () => zoomBy(1 / 1.2));
  $('[data-action="zoom-reset"]').addEventListener('click', resetView);
  $('[data-action="grid"]').addEventListener('click', toggleGrid);

  $('[data-action="panel"]').addEventListener('click', (e) => {
    e.stopPropagation();
    panelEl.classList.toggle('is-open');
  });
  const panelClose = $('[data-action="panel-close"]');
  if (panelClose) panelClose.addEventListener('click', () => panelEl.classList.remove('is-open'));

  $('[data-action="clear"]').addEventListener('click', () => {
    if (!S.elements.length) return;
    S.elements = [];
    S.selected.clear();
    pushHistory();
    render();
    toast('بوم پاک شد');
  });

  $$('[data-action="close-help"]').forEach(el => {
    el.addEventListener('click', () => $('#help').classList.remove('is-open'));
  });

  $$('[data-action="to-front"]').forEach(b => b.addEventListener('click', bringToFront));
  $$('[data-action="to-back"]').forEach(b => b.addEventListener('click', sendToBack));
  $$('[data-action="duplicate"]').forEach(b => b.addEventListener('click', duplicateSelected));

  panelEl.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => {
    if (['select', 'hand'].includes(S.tool)) panelEl.classList.remove('is-open');
  });

  $$('#colors-stroke .swatch-item').forEach(b => {
    b.addEventListener('click', () => setStroke(b.dataset.c));
  });

  $$('#widths button').forEach(b => {
    b.addEventListener('click', () => {
      $$('#widths button').forEach(x => x.classList.remove('is-active'));
      b.classList.add('is-active');
      S.width = +b.dataset.w;
      updateCursorSize();
    });
  });

  $$('#styles button').forEach(b => {
    b.addEventListener('click', () => {
      $$('#styles button').forEach(x => x.classList.remove('is-active'));
      b.classList.add('is-active');
      S.style = b.dataset.s;
    });
  });

  const opacityEl = $('#opacity');
  if (opacityEl) {
    opacityEl.addEventListener('input', e => {
      S.opacity = +e.target.value / 100;
    });
  }
}

function setTool(tool) {
  S.tool = tool;
  $$('.tool[data-tool]').forEach(b => b.classList.toggle('is-active', b.dataset.tool === tool));
  document.body.dataset.tool = tool;
  updateCursorSize();

  if (['select', 'hand'].includes(tool)) {
    panelEl.classList.remove('is-open');
  } else {
    panelEl.classList.add('is-open');
  }
  if (tool !== 'select') S.selected.clear();
  render();
}

function setStroke(color) {
  S.stroke = color;
  const sw = $('#swatch');
  if (sw) sw.style.setProperty('--c', color);
  $$('#colors-stroke .swatch-item').forEach(b => {
    b.classList.toggle('is-active', b.dataset.c === color);
  });
}

function updateCursorSize() {
  const s = S.width * 1.4 + 4;
  cursorEl.style.setProperty('--s', s + 'px');
}

function toggleTheme() {
  S.theme = S.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('theme', S.theme);
  applyTheme();
  drawGrid();
  toast(S.theme === 'dark' ? 'حالت تاریک' : 'حالت روشن');
}

function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  document.body.dataset.theme = S.theme;
}

function toggleGrid() {
  S.showGrid = !S.showGrid;
  drawGrid();
  toast(S.showGrid ? 'شبکه روشن' : 'شبکه خاموش');
}

/* ═══════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════ */
function exportPNG() {
  const temp = document.createElement('canvas');
  temp.width = drawCv.width;
  temp.height = drawCv.height;
  const tc = temp.getContext('2d');
  tc.fillStyle = S.theme === 'dark' ? '#0F0F12' : '#FFFFFF';
  tc.fillRect(0, 0, temp.width, temp.height);
  tc.drawImage(drawCv, 0, 0);
  const a = document.createElement('a');
  a.download = `canvas-${Date.now()}.png`;
  a.href = temp.toDataURL('image/png');
  a.click();
  toast('ذخیره شد');
}

/* ═══════════════════════════════════════════
   TOAST
   ═══════════════════════════════════════════ */
function toast(msg) {
  if (!toastsEl) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  toastsEl.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, 1800);
}

/* ═══════════════════════════════════════════
   EMPTY
   ═══════════════════════════════════════════ */
function hideEmpty() {
  if (!emptyEl) return;
  emptyEl.style.transition = 'opacity .3s, transform .3s';
  emptyEl.style.opacity = '0';
  emptyEl.style.transform = 'translate(-50%, -50%) translateY(-8px)';
  setTimeout(() => emptyEl.remove(), 300);
  emptyEl = null;
}

/* ═══════════════════════════════════════════
   KEYBOARD
   ═══════════════════════════════════════════ */
const KEYMAP = {
  v: 'select', h: 'hand', p: 'pen', m: 'highlighter', e: 'eraser',
  l: 'line', a: 'arrow', r: 'rect', o: 'ellipse',
  d: 'diamond', g: 'triangle', s: 'star', t: 'text',
};

function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    const key = e.key.toLowerCase();
    const mod = e.metaKey || e.ctrlKey;

    if (e.code === 'Space' && !mod) { S.space = true; cursorEl.classList.remove('on'); }

    if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && ((e.shiftKey && key === 'z') || key === 'y')) { e.preventDefault(); redo(); return; }
    if (mod && key === 's') { e.preventDefault(); exportPNG(); return; }
    if (mod && key === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if (mod && key === 'c') { e.preventDefault(); copySelected(); return; }
    if (mod && key === 'v') { e.preventDefault(); pasteClipboard(); return; }

    if (mod && key === ']') { e.preventDefault(); bringToFront(); return; }
    if (mod && key === '[') { e.preventDefault(); sendToBack(); return; }

    if (mod && (key === '=' || key === '+')) { e.preventDefault(); zoomBy(1.2); return; }
    if (mod && key === '-') { e.preventDefault(); zoomBy(1 / 1.2); return; }
    if (mod && key === '0') { e.preventDefault(); resetView(); return; }

    if (mod && key === 'a') {
      e.preventDefault();
      S.selected = new Set(S.elements.map(el => el.id));
      render();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (S.selected.size) { e.preventDefault(); deleteSelected(); }
      return;
    }

    if (e.key === 'Escape') {
      S.selected.clear();
      panelEl.classList.remove('is-open');
      const h = $('#help'); if (h) h.classList.remove('is-open');
      render();
      return;
    }

    if (e.key === '?' || (e.shiftKey && key === '/')) {
      if (!mod) {
        e.preventDefault();
        const h = $('#help'); if (h) h.classList.toggle('is-open');
        return;
      }
    }

    if (!mod && !e.altKey && KEYMAP[key]) {
      e.preventDefault();
      setTool(KEYMAP[key]);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') S.space = false;
  });
}

/* ═══════════════════════════════════════════
   GO
   ═══════════════════════════════════════════ */
init();

console.log('%c◆ Canvas ready', 'color:#6366F1;font-weight:700');
})();
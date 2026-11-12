// The shared drawing: a sheet of dotted paper where every player draws in their own colour.
// Strokes are lists of x,y points on an 800 x 600 sheet, scaled to the screen.
import { BOARD, STROKE } from './engine.js';

const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 5;          // pen width in sheet units
const MIN_STEP = 1.6;     // skip points closer than this to the last one
const FLUSH_MS = 150;   // ink goes to the server in batches: smooth to watch, few messages

function el(tag, attrs, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}

// A smooth path through the points (quadratic curves through midpoints).
export function pathData(pts) {
  const n = pts.length / 2;
  if (n === 0) return '';
  const x = (i) => pts[i * 2], y = (i) => pts[i * 2 + 1];
  if (n === 1) return `M${x(0)} ${y(0)}l0.01 0`;
  if (n === 2) return `M${x(0)} ${y(0)}L${x(1)} ${y(1)}`;
  let d = `M${x(0)} ${y(0)}`;
  for (let i = 1; i < n - 1; i++) d += `Q${x(i)} ${y(i)} ${(x(i) + x(i + 1)) / 2} ${(y(i) + y(i + 1)) / 2}`;
  return `${d}L${x(n - 1)} ${y(n - 1)}`;
}

export function createSheet(container) {
  const svg = el('svg', { viewBox: `0 0 ${BOARD.w} ${BOARD.h}`, class: 'sheet-svg', role: 'img', 'aria-label': 'Shared drawing' });
  const defs = el('defs', {}, svg);
  const dots = el('pattern', { id: 'paper-dots', width: 20, height: 20, patternUnits: 'userSpaceOnUse' }, defs);
  el('circle', { cx: 10, cy: 10, r: 0.9, class: 'paper-dot' }, dots);
  el('rect', { x: 0, y: 0, width: BOARD.w, height: BOARD.h, class: 'paper' }, svg);
  el('rect', { x: 0, y: 0, width: BOARD.w, height: BOARD.h, fill: 'url(#paper-dots)' }, svg);
  const ink = el('g', { class: 'ink' }, svg);
  container.append(svg);

  const paths = new Map();   // sid -> { path, pts, pid, color }
  let pen = null;            // the local pen when it's my turn
  let focus = null;

  const draw = (s) => s.path.setAttribute('d', pathData(s.pts));

  const sheet = {
    svg,
    get count() { return paths.size; },
    clear() {
      paths.clear();
      ink.replaceChildren();
    },
    // Replace everything with a full drawing (joining or reconnecting mid-game)
    load(strokes) {
      sheet.clear();
      for (const s of strokes) sheet.add(s.sid, s.pid, s.color, s.pts);
    },
    add(sid, pid, color, pts = []) {
      let s = paths.get(sid);
      if (!s) {
        s = { path: el('path', { class: `stroke pc${color}`, 'data-pid': pid }, ink), pts: [], pid, color };
        paths.set(sid, s);
        if (focus !== null) s.path.classList.toggle('dim', s.pid !== focus);
      }
      if (pts.length) {
        s.pts.push(...pts);
        draw(s);
      }
      return s;
    },
    // Show only one player's lines (null shows everyone)
    highlight(pid) {
      focus = pid;
      for (const s of paths.values()) s.path.classList.toggle('dim', pid !== null && s.pid !== pid);
    },
    // Redraw the whole picture line by line, in the order it was drawn
    async replay() {
      const all = [...paths.values()];
      if (!all.length) return;
      const lengths = all.map((s) => Math.max(1, s.path.getTotalLength()));
      const total = lengths.reduce((a, b) => a + b, 0);
      const scale = Math.min(1, 9000 / (total * 1.4));   // keep the whole replay under ~9 s
      all.forEach((s, i) => {
        s.path.style.transition = 'none';
        s.path.style.strokeDasharray = `${lengths[i]} ${lengths[i]}`;
        s.path.style.strokeDashoffset = String(lengths[i]);
      });
      svg.getBoundingClientRect();
      for (const [i, s] of all.entries()) {
        const ms = Math.max(90, Math.min(1100, lengths[i] * 1.4 * scale));
        s.path.style.transition = `stroke-dashoffset ${ms}ms linear`;
        s.path.style.strokeDashoffset = '0';
        await new Promise((r) => setTimeout(r, ms + 40));
      }
      all.forEach((s) => { s.path.style.strokeDasharray = ''; s.path.style.strokeDashoffset = ''; s.path.style.transition = ''; });
    },

    // Let this player draw. Calls onInk(sid, pts, end) with new points every FLUSH_MS.
    // single: the turn is one stroke (it ends on lift, or after STROKE.maxMs).
    enable({ pid, color, single, onInk, onStroke }) {
      sheet.disable();
      let n = 0;
      // P is this turn's pen; closures use it (not the shared variable) so a stroke cut off
      // by the end of the turn still sends its last points.
      const P = { pid, color, single, onInk, onStroke, current: null, used: false, stopping: false };
      pen = P;
      svg.classList.add('pen-on');
      const point = (e) => {
        const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
        return [Math.max(0, Math.min(BOARD.w, Math.round(p.x))), Math.max(0, Math.min(BOARD.h, Math.round(p.y)))];
      };
      const flush = (end = false) => {
        const c = P.current;
        if (!c) return;
        const fresh = c.pts.slice(c.sent);
        c.sent = c.pts.length;
        if (fresh.length || end) P.onInk(c.sid, fresh, end);
      };
      const finish = () => {
        if (!P.current) return;
        clearInterval(P.current.timer);
        clearTimeout(P.current.cap);
        flush(true);
        P.current = null;
        if (P.single && !P.stopping) sheet.disable();
        if (P.onStroke) P.onStroke();
      };
      const down = (e) => {
        if (pen !== P || P.current || (P.single && P.used) || e.button > 0) return;
        e.preventDefault();
        try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
        P.used = true;
        const sid = `${pid}.${Date.now().toString(36)}.${n++}`;
        const [x, y] = point(e);
        const s = sheet.add(sid, pid, color, [x, y]);
        P.current = { sid, pts: s.pts, sent: 0, pointer: e.pointerId, timer: setInterval(() => flush(), FLUSH_MS), cap: 0 };
        if (P.single) P.current.cap = setTimeout(finish, STROKE.maxMs);
        flush();
      };
      const move = (e) => {
        if (!P.current || e.pointerId !== P.current.pointer) return;
        const s = paths.get(P.current.sid);
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
        let changed = false;
        for (const ev of events.length ? events : [e]) {
          const [x, y] = point(ev);
          const lx = s.pts[s.pts.length - 2], ly = s.pts[s.pts.length - 1];
          if (Math.hypot(x - lx, y - ly) < MIN_STEP) continue;
          s.pts.push(x, y);
          changed = true;
        }
        if (changed) draw(s);
      };
      const up = (e) => { if (P.current && e.pointerId === P.current.pointer) finish(); };
      svg.addEventListener('pointerdown', down);
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerup', up);
      svg.addEventListener('pointercancel', up);
      P.off = () => {
        P.stopping = true;
        finish();
        svg.removeEventListener('pointerdown', down);
        svg.removeEventListener('pointermove', move);
        svg.removeEventListener('pointerup', up);
        svg.removeEventListener('pointercancel', up);
      };
    },
    disable() {
      if (!pen) return;
      const p = pen;
      pen = null;
      svg.classList.remove('pen-on');
      p.off();
    },
    get drawing() { return Boolean(pen && pen.current); },

    // The picture as a PNG, with the page's colours baked in
    async toPNG() {
      const clone = svg.cloneNode(true);
      const live = svg.querySelectorAll('path, rect, circle');
      clone.querySelectorAll('path, rect, circle').forEach((node, i) => {
        const cs = getComputedStyle(live[i]);
        for (const prop of ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity']) {
          node.setAttribute(prop, cs.getPropertyValue(prop));
        }
      });
      clone.setAttribute('width', BOARD.w * 2);
      clone.setAttribute('height', BOARD.h * 2);
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
      try {
        const img = new Image();
        await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; });
        const canvas = document.createElement('canvas');
        canvas.width = BOARD.w * 2;
        canvas.height = BOARD.h * 2;
        canvas.getContext('2d').drawImage(img, 0, 0);
        return await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
      } finally {
        URL.revokeObjectURL(url);
      }
    },
  };
  return sheet;
}

export const PEN_WIDTH = WIDTH;

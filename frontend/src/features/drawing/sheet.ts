/**
 * 도면 시트 구성 (엔진 투상 결과 → 용지 위 그림 요소). 순수 함수: SVG·DXF·화면이 같은 요소를 그린다.
 *
 * - 용지: A4·A3 가로, 테두리 10mm, 오른쪽 아래 표제란.
 * - 배치: 3각법 (KS B 0001·ISO 128 투상법 E) — 정면도 왼쪽 아래, 평면도는 정면도 위, 우측면도는 정면도 오른쪽, 등각도는 오른쪽 위.
 *   평면도·정면도는 가로 위치가, 정면도·우측면도는 높이가 맞춰진다.
 * - 척도: 표준 척도(10:1 … 1:1000) 중 용지에 들어가는 가장 큰 것 (직접 고를 수도 있음).
 * - 등각도는 숨은선을 그리지 않는다.
 * - 자동 치수: 정면도 전체 너비·높이, 우측면도 전체 깊이(우측면도가 없으면 평면도), 정면으로 보이는 원의 지름(같은 지름은 n×Ø).
 * 좌표: 용지 mm, 원점 = 왼쪽 아래, y 위쪽 (DXF 와 같음. SVG 는 뒤집어 그린다).
 */
import type { DrawingView, DrawingViewName } from '../engine/types';
import { DRAWING_VIEWS } from './views';

export type Paper = 'A4' | 'A3';
export const PAPERS: Record<Paper, [number, number]> = { A4: [297, 210], A3: [420, 297] };
/** 표준 척도 (용지 mm / 실제 mm), 큰 것부터 */
export const STANDARD_SCALES = [10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100, 1 / 200, 1 / 500, 1 / 1000] as const;

export type Layer = 'visible' | 'hidden' | 'dim' | 'frame' | 'text';
export type SheetItem =
  | { kind: 'line'; layer: Layer; points: number[] }
  | { kind: 'fill'; layer: Layer; points: number[] }
  | { kind: 'text'; layer: Layer; x: number; y: number; size: number; text: string; anchor: 'start' | 'middle' | 'end'; angle?: number };

export interface SheetOptions {
  paper: Paper;
  /** 'auto' = 들어가는 가장 큰 표준 척도 */
  scale: number | 'auto';
  title: string;
  date: string;
  /** 자동 치수 넣기 */
  dimensions: boolean;
}

export interface Sheet {
  width: number;
  height: number;
  scale: number;
  /** 고른 척도로는 용지에 다 들어가지 않음 */
  overflow: boolean;
  items: SheetItem[];
}

const MARGIN = 10;
const TITLE_W = 130;
const TITLE_H = 32;
const GAP = 24; // 보기 사이 (치수 자리 포함)
const PAD = 14; // 바깥쪽 치수 자리
const TEXT = 3.5;
const ARROW = 3;

export function scaleLabel(s: number): string {
  if (s >= 1) return `${round2(s)}:1`;
  return `1:${round2(1 / s)}`;
}
const round2 = (v: number) => String(Math.round(v * 100) / 100);
export const dimText = (v: number) => String(Math.round(v * 100) / 100);

type Box = { w: number; h: number };
const size = (v: DrawingView | undefined): Box => (v ? { w: v.bounds[2] - v.bounds[0], h: v.bounds[3] - v.bounds[1] } : { w: 0, h: 0 });

/** 척도 s 에서 배치 전체 크기 (치수 자리 포함) */
function layoutSize(views: Partial<Record<DrawingViewName, DrawingView>>, s: number) {
  const f = size(views.front);
  const t = size(views.top);
  const r = size(views.right);
  const i = size(views.iso);
  const col1 = Math.max(f.w, t.w) * s;
  const col2 = Math.max(r.w, i.w) * s;
  const row1 = Math.max(f.h, r.h) * s;
  const row2 = Math.max(t.h, i.h) * s;
  const w = col1 + (col1 && col2 ? GAP : 0) + col2 + 2 * PAD;
  const h = row1 + (row1 && row2 ? GAP : 0) + row2 + 2 * PAD;
  return { col1, col2, row1, row2, w, h };
}

export function buildSheet(list: DrawingView[], opt: SheetOptions): Sheet {
  const [W, H] = PAPERS[opt.paper];
  const views = Object.fromEntries(list.map((v) => [v.name, v])) as Partial<Record<DrawingViewName, DrawingView>>;
  // 보기를 놓을 수 있는 곳: 테두리 안, 표제란 위
  const area = { x: MARGIN, y: MARGIN + TITLE_H + 4, w: W - 2 * MARGIN, h: H - 2 * MARGIN - TITLE_H - 4 };
  const fits = (s: number) => {
    const l = layoutSize(views, s);
    return l.w <= area.w && l.h <= area.h;
  };
  const scale = opt.scale === 'auto' ? (STANDARD_SCALES.find(fits) ?? STANDARD_SCALES[STANDARD_SCALES.length - 1]!) : opt.scale;
  const L = layoutSize(views, scale);
  const items: SheetItem[] = [];

  // 테두리·표제란
  items.push({ kind: 'line', layer: 'frame', points: rect(MARGIN, MARGIN, W - MARGIN, H - MARGIN) });
  titleBlock(items, W - MARGIN - TITLE_W, MARGIN, opt, scale);

  // 배치 원점 (가운데 정렬)
  const ox = area.x + Math.max(0, (area.w - L.w) / 2) + PAD;
  const oy = area.y + Math.max(0, (area.h - L.h) / 2) + PAD;
  const row2y = oy + L.row1 + (L.row1 ? GAP : 0);
  const col2x = ox + L.col1 + (L.col1 ? GAP : 0);
  // 각 보기의 왼쪽 아래 (보기 범위 최소점이 놓일 자리). 정면·평면은 가로, 정면·우측면은 높이를 맞춘다
  const place: Partial<Record<DrawingViewName, [number, number]>> = {};
  const f = views.front;
  if (f) place.front = [ox, oy];
  if (views.top) place.top = [ox + (f ? (views.top.bounds[0] - f.bounds[0]) * scale : 0), row2y];
  if (views.right) place.right = [col2x, oy + (f ? (views.right.bounds[1] - f.bounds[1]) * scale : 0)];
  if (views.iso) {
    const i = size(views.iso);
    place.iso = [col2x + (L.col2 - i.w * scale) / 2, row2y + (L.row2 - i.h * scale) / 2];
  }

  for (const v of list) {
    const at = place[v.name];
    if (!at) continue;
    const map = (x: number, y: number): [number, number] => [at[0] + (x - v.bounds[0]) * scale, at[1] + (y - v.bounds[1]) * scale];
    const mapLine = (l: number[]) => l.flatMap((_, k) => (k % 2 ? [] : map(l[k]!, l[k + 1]!)));
    // 등각도는 숨은선 없이 (일반 도면 관례: 입체 모양만 보여 준다)
    if (v.name !== 'iso') for (const l of v.hidden) items.push({ kind: 'line', layer: 'hidden', points: mapLine(l) });
    for (const l of v.visible) items.push({ kind: 'line', layer: 'visible', points: mapLine(l) });
    const [x0, y0] = map(v.bounds[0], v.bounds[1]);
    const [x1, y1] = map(v.bounds[2], v.bounds[3]);
    items.push({ kind: 'text', layer: 'text', x: (x0 + x1) / 2, y: y0 - (v.name === 'front' || v.name === 'right' ? (opt.dimensions ? 17 : 6) : 6), size: 2.5, text: DRAWING_VIEWS[v.name].label, anchor: 'middle' });
    if (!opt.dimensions || v.name === 'iso') continue;
    const w = v.bounds[2] - v.bounds[0];
    const h = v.bounds[3] - v.bounds[1];
    if (v.name === 'front') {
      linearDim(items, [x0, y0], [x1, y0], [0, -1], 8, dimText(w));
      linearDim(items, [x0, y0], [x0, y1], [-1, 0], 8, dimText(h));
    }
    if (v.name === 'right' || (v.name === 'top' && !views.right)) {
      if (v.name === 'right') linearDim(items, [x0, y0], [x1, y0], [0, -1], 8, dimText(w));
      else linearDim(items, [x0, y0], [x0, y1], [-1, 0], 8, dimText(h));
    }
    diameterDims(items, v, map);
  }
  return { width: W, height: H, scale, overflow: L.w > area.w + 1e-9 || L.h > area.h + 1e-9, items };
}

const rect = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];

function titleBlock(items: SheetItem[], x: number, y: number, opt: SheetOptions, scale: number) {
  const w = TITLE_W;
  const h = TITLE_H;
  items.push({ kind: 'line', layer: 'frame', points: rect(x, y, x + w, y + h) });
  // 위 칸: 이름 / 아래 두 줄: 척도·투상법·단위, 날짜·프로그램
  const r1 = y + h - 14;
  const r2 = y + 9;
  items.push({ kind: 'line', layer: 'frame', points: [x, r1, x + w, r1] });
  items.push({ kind: 'line', layer: 'frame', points: [x, r2, x + w, r2] });
  for (const cx of [x + 45, x + 90]) items.push({ kind: 'line', layer: 'frame', points: [cx, y, cx, r1] });
  const label = (lx: number, ly: number, t: string) => items.push({ kind: 'text', layer: 'text', x: lx, y: ly, size: 2, text: t, anchor: 'start' });
  const value = (lx: number, ly: number, t: string, s = TEXT) => items.push({ kind: 'text', layer: 'text', x: lx, y: ly, size: s, text: t, anchor: 'start' });
  label(x + 2, y + h - 4, '이름');
  value(x + 12, y + h - 10, opt.title || '제목 없음', 5);
  label(x + 2, r1 - 4, '척도');
  value(x + 14, r1 - 8, scaleLabel(scale));
  label(x + 47, r1 - 4, '투상법');
  value(x + 59, r1 - 8, '3각법');
  label(x + 92, r1 - 4, '단위');
  value(x + 102, r1 - 8, 'mm');
  label(x + 2, y + 3, '날짜');
  value(x + 12, y + 2.5, opt.date, 3);
  value(x + 92, y + 2.5, 'AI 3D Studio', 3);
}

/** 화살표 (끝점 tip, 방향 d = 화살표가 가리키는 쪽) */
function arrow(items: SheetItem[], tip: [number, number], d: [number, number]) {
  const [ux, uy] = d;
  const bx = tip[0] - ux * ARROW;
  const by = tip[1] - uy * ARROW;
  const nx = -uy * ARROW * 0.18;
  const ny = ux * ARROW * 0.18;
  items.push({ kind: 'fill', layer: 'dim', points: [tip[0], tip[1], bx + nx, by + ny, bx - nx, by - ny, tip[0], tip[1]] });
}

/** 선형 치수: a → b 를 n 방향(단위)으로 off 만큼 띄워 */
export function linearDim(items: SheetItem[], a: [number, number], b: [number, number], n: [number, number], off: number, text: string) {
  const a2: [number, number] = [a[0] + n[0] * off, a[1] + n[1] * off];
  const b2: [number, number] = [b[0] + n[0] * off, b[1] + n[1] * off];
  // 치수 보조선: 형상에서 1mm 띄우고 치수선 너머 2mm
  for (const [p, q] of [[a, a2], [b, b2]] as const)
    items.push({ kind: 'line', layer: 'dim', points: [p[0] + n[0], p[1] + n[1], q[0] + n[0] * 2, q[1] + n[1] * 2] });
  items.push({ kind: 'line', layer: 'dim', points: [...a2, ...b2] });
  const len = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]) || 1;
  const d: [number, number] = [(b2[0] - a2[0]) / len, (b2[1] - a2[1]) / len];
  arrow(items, b2, d);
  arrow(items, a2, [-d[0], -d[1]]);
  // 글자: 치수선 가운데, 선 위 1mm (ISO 129). 세로 치수는 90° 돌려 왼쪽에 쓴다 (아래에서 위로 읽음)
  const vertical = Math.abs(d[1]) > Math.abs(d[0]);
  const mx = (a2[0] + b2[0]) / 2;
  const my = (a2[1] + b2[1]) / 2;
  if (vertical) items.push({ kind: 'text', layer: 'dim', x: mx - 1, y: my, size: TEXT, text, anchor: 'middle', angle: 90 });
  else items.push({ kind: 'text', layer: 'dim', x: mx, y: my + 1, size: TEXT, text, anchor: 'middle' });
}

/** 정면으로 보이는 온전한 원의 지름: 같은 지름끼리 묶어 첫 원에 지시선 (n×Øx) */
function diameterDims(items: SheetItem[], v: DrawingView, map: (x: number, y: number) => [number, number]) {
  const groups = new Map<number, DrawingView['circles']>();
  for (const c of v.circles) {
    if (!c.full || !c.visible) continue;
    const key = Math.round(c.radius * 2000) / 1000;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  for (const [d, cs] of groups) {
    const c = cs[0]!;
    const [cx, cy] = map(c.center[0], c.center[1]);
    const [ex] = map(c.center[0] + c.radius, c.center[1]);
    const r = ex - cx;
    const u: [number, number] = [Math.SQRT1_2, Math.SQRT1_2];
    const edge: [number, number] = [cx + u[0] * r, cy + u[1] * r];
    const knee: [number, number] = [edge[0] + u[0] * 8, edge[1] + u[1] * 8];
    const label = `${cs.length > 1 ? `${cs.length}×` : ''}Ø${dimText(d)}`;
    const tail = label.length * TEXT * 0.62;
    items.push({ kind: 'line', layer: 'dim', points: [...edge, ...knee, knee[0] + tail, knee[1]] });
    arrow(items, edge, [-u[0], -u[1]]);
    items.push({ kind: 'text', layer: 'dim', x: knee[0] + 0.5, y: knee[1] + 1, size: TEXT, text: label, anchor: 'start' });
  }
}

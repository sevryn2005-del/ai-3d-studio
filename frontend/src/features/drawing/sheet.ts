/**
 * 도면 시트 구성 (엔진 투상 결과 → 용지 위 그림 요소). 순수 함수: SVG·DXF·화면이 같은 요소를 그린다.
 *
 * - 용지: A4·A3 가로, 테두리 10mm, 오른쪽 아래 표제란.
 * - 배치: 3각법 (KS B 0001·ISO 128 투상법 E) — 정면도 왼쪽 아래, 평면도는 정면도 위, 우측면도는 정면도 오른쪽, 등각도는 오른쪽 위.
 *   평면도·정면도는 가로 위치가, 정면도·우측면도는 높이가 맞춰진다.
 * - 척도: 표준 척도(10:1 … 1:1000) 중 용지에 들어가는 가장 큰 것 (직접 고를 수도 있음).
 * - 등각도는 숨은선을 그리지 않는다.
 * - 부분 단면(형식 v26): section.rect 영역 안만 걷어낸 결과 — 절단선·A-A 라벨 없이 해칭만, 라벨은 "정면도 (부분 단면)".
 * - 단면도(형식 v14): 정면도·우측면도를 전단면 A-A 로 — 잘린 면 45° 해칭(2.5mm), 다른 보기에 절단선(가는 1점 쇄선 + 굵은 끝 + 보는 방향 화살표 + A).
 * - 중심선: 정면으로 보이는 원의 중심 표시(+ 자형), 원통 축선 (가는 1점 쇄선, 2mm 넘게). 등각도에는 그리지 않는다.
 * - 주기: 표제란 왼쪽 칸에 여러 줄 (최대 6줄).
 * - 사용자 치수(형식 v17): 끝점을 투상 결과에 다시 붙여(dims.ts) 그린다. 붙을 곳이 없으면 값 뒤에 "?" (연결 끊김).
 * - 공차(형식 v23): 사용자 치수 값 뒤에 ±0.1 또는 +0.1/−0.05.
 * - 보조 투상도(형식 v25): 엔진이 aux1·aux2 로 투상한 보기를 빈 자리에, 부모 보기에는 보는 방향 화살표 + 기호 P, Q.
 * - 상세도(형식 v23): 보기의 원 영역을 확대해 빈 자리(보기·표제란·주기·다른 상세도와 겹치지 않는 곳)에 — 원래 보기에는 가는 원과 기호 B, C, …
 * - 표면 거칠기(형식 v24): 보이는 선 위 점에 √ 기호 + "Ra 값" — 형상 바깥쪽에 서고, 글자는 읽기 쉬운 방향으로.
 * - 자동 치수: 정면도 전체 너비·높이, 우측면도 전체 깊이(우측면도가 없으면 평면도), 정면으로 보이는 원의 지름(같은 지름은 n×Ø).
 * 좌표: 용지 mm, 원점 = 왼쪽 아래, y 위쪽 (DXF 와 같음. SVG 는 뒤집어 그린다).
 */
import type { DrawingAux, DrawingDetail, DrawingDim, DrawingMark } from '../../cad/commandTypes';
import type { DrawingView, DrawingViewName, StandardViewName } from '../engine/types';
import { resolveDim, resolveMark, type ResolvedDim } from './dims';
import { DRAWING_VIEWS } from './views';

export type Paper = 'A4' | 'A3';
export const PAPERS: Record<Paper, [number, number]> = { A4: [297, 210], A3: [420, 297] };
/** 표준 척도 (용지 mm / 실제 mm), 큰 것부터 */
export const STANDARD_SCALES = [10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100, 1 / 200, 1 / 500, 1 / 1000] as const;

export type Layer = 'visible' | 'hidden' | 'dim' | 'frame' | 'text' | 'center' | 'hatch';
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
  /** 중심선 (원 중심 표시·원통 축선) */
  centerlines?: boolean;
  /** 단면도 (엔진에 같은 값을 넘겨 투상한 결과여야 한다). rect = 부분 단면 영역 (보기 좌표) */
  section?: { view: 'front' | 'right'; offset: number; rect?: [number, number, number, number] };
  /** 주기 (여러 줄) */
  notes?: string;
  /** 사용자 치수 */
  dims?: DrawingDim[];
  /** 상세도 */
  details?: DrawingDetail[];
  /** 표면 거칠기 기호 */
  marks?: DrawingMark[];
  /** 보조 투상도 (순서대로 엔진 결과 aux1, aux2) */
  aux?: DrawingAux[];
  /** 여러 장일 때 [이 시트 번호, 전체 장 수] → 표제란 "시트 n/m" (형식 v27) */
  sheetNo?: [number, number];
}

/** 보기 배치: 보기 좌표 (x, y) → 종이 = at + (p − bounds 최소) × scale */
export interface ViewPlacement {
  at: [number, number];
  bounds: [number, number, number, number];
  scale: number;
}

export interface Sheet {
  width: number;
  height: number;
  scale: number;
  /** 고른 척도로는 용지에 다 들어가지 않음 */
  overflow: boolean;
  items: SheetItem[];
  /** 화면에서 종이 좌표 ↔ 보기 좌표 바꾸기 (치수 고르기) */
  placements: Partial<Record<DrawingViewName, ViewPlacement>>;
  /** 사용자 치수가 붙은 결과 (목록 표시용) */
  dims: ResolvedDim[];
  /** 사용자 치수 끌기 손잡이 (종이 mm): 끝점 A·B(지름은 원 가장자리 A) + 글자 자리 handle */
  dimHandles: { id: string; kind: DrawingDim['kind']; A: [number, number]; B?: [number, number]; handle: [number, number] }[];
  /** 보조 투상도 자리 (종이 mm: 보기 범위 최소점이 놓인 곳) — 목록·시험용 */
  aux: { id: string; label: string; at: [number, number]; bounds: [number, number, number, number] }[];
  /** 표면 거칠기 기호 (종이 mm: 붙은 점, 붙었는지) — 목록·시험용 */
  marks: { id: string; ok: boolean; at: [number, number] }[];
  /** 상세도 자리 (종이 mm: 가운데·반지름, 기호) — 목록·시험용 */
  details: { id: string; label: string; center: [number, number]; radius: number; scale: number }[];
}

const MARGIN = 10;
const TITLE_W = 130;
const TITLE_H = 32;
const GAP = 24; // 보기 사이 (치수 자리 포함)
const PAD = 14; // 바깥쪽 치수 자리
const TEXT = 3.5;
const ARROW = 3;
const HATCH = 2.5;
const MAX_NOTE_LINES = 6;
const SECTION_LABEL = 'A';

export function scaleLabel(s: number): string {
  if (s >= 1) return `${round2(s)}:1`;
  return `1:${round2(1 / s)}`;
}
const round2 = (v: number) => String(Math.round(v * 100) / 100);
export const dimText = (v: number) => String(Math.round(v * 100) / 100);
/** 공차 글자: 같은 크기 반대 부호 = ±, 아니면 +위/−아래 (0 은 그대로 0). 없으면 '' */
export function tolText(t: DrawingDim['tol']): string {
  if (!t || (t.upper === 0 && t.lower === 0)) return '';
  const r = (v: number) => String(Math.round(Math.abs(v) * 1e4) / 1e4);
  if (Math.abs(t.upper + t.lower) < 1e-12) return ` ±${r(t.upper)}`;
  const sg = (v: number) => (v === 0 ? '0' : `${v > 0 ? '+' : '−'}${r(v)}`);
  return ` ${sg(t.upper)}/${sg(t.lower)}`;
}
/** 보조 투상도 기호 */
export const AUX_LABELS = ['P', 'Q'];
/** 상세도 기호: A 는 단면도가 쓰므로 B 부터 */
export const DETAIL_LABELS = ['B', 'C', 'D', 'E'];

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
  notes(items, opt.notes);

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
    const sectioned = !!v.section && opt.section?.view === v.name;
    if (sectioned) for (const l of hatch(v.section!.map(mapLine))) items.push({ kind: 'line', layer: 'hatch', points: l });
    // 등각도는 숨은선 없이 (일반 도면 관례: 입체 모양만 보여 준다)
    if (v.name !== 'iso') for (const l of v.hidden) items.push({ kind: 'line', layer: 'hidden', points: mapLine(l) });
    for (const l of v.visible) items.push({ kind: 'line', layer: 'visible', points: mapLine(l) });
    const [x0, y0] = map(v.bounds[0], v.bounds[1]);
    const [x1, y1] = map(v.bounds[2], v.bounds[3]);
    if (opt.centerlines && v.name !== 'iso') centerLines(items, v, map, scale);
    // 부분 단면은 절단선·단면 라벨 없이 (걷어낸 영역 안만 해칭)
    const partial = !!opt.section?.rect;
    if (opt.section && !sectioned && !partial) cuttingLine(items, v, opt.section, map, [x0, y0, x1, y1]);
    const label = sectioned && !partial ? `단면 ${SECTION_LABEL}-${SECTION_LABEL}` : `${DRAWING_VIEWS[v.name as StandardViewName].label}${sectioned ? ' (부분 단면)' : ''}`;
    items.push({ kind: 'text', layer: 'text', x: (x0 + x1) / 2, y: y0 - (v.name === 'front' || v.name === 'right' ? (opt.dimensions ? 17 : 6) : 6), size: sectioned && !partial ? 3.5 : 2.5, text: label, anchor: 'middle' });
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
  // 사용자 치수 (보기가 그려진 것만)
  const placements: Sheet['placements'] = {};
  for (const v of list) {
    const at = place[v.name];
    if (at) placements[v.name] = { at, bounds: v.bounds, scale };
  }
  // 상세도: 원래 보기에 가는 원 + 기호, 확대 그림은 빈 자리에
  const auxPlaced: Sheet['aux'] = [];
  const occupied: [number, number, number, number][] = [[W - MARGIN - TITLE_W, MARGIN, W - MARGIN, MARGIN + TITLE_H]];
  if (opt.notes?.trim()) occupied.push([MARGIN, MARGIN, W - MARGIN - TITLE_W, MARGIN + TITLE_H]);
  for (const v of list) {
    const at = place[v.name];
    if (!at) continue;
    occupied.push([at[0] - PAD, at[1] - PAD - 4, at[0] + (v.bounds[2] - v.bounds[0]) * scale + PAD, at[1] + (v.bounds[3] - v.bounds[1]) * scale + PAD]);
  }
  /** 겹치지 않는 첫 빈 자리 (위→아래, 왼쪽→오른쪽 2mm 씩). 없으면 null */
  const freeSpot = (bw: number, bh: number): [number, number] | null => {
    for (let y = H - MARGIN - 2 - bh; y >= MARGIN + 2; y -= 2)
      for (let x = MARGIN + 2; x + bw <= W - MARGIN - 2; x += 2)
        if (!occupied.some(([a, b, c, d]) => x < c && x + bw > a && y < d && y + bh > b)) return [x, y];
    return null;
  };
  let detailOverflow = false;
  // 보조 투상도: 부모 보기에 보는 방향 화살표 + 기호, 투상 결과는 빈 자리에
  (opt.aux ?? []).forEach((ax, k) => {
    const v = views[(k === 0 ? 'aux1' : 'aux2') as DrawingViewName];
    const pv = views[ax.view];
    const pat = place[ax.view];
    if (!v || !pv || !pat) return;
    const label = AUX_LABELS[k] ?? String(k + 1);
    // 화살표: 부모 보기 가운데에서 방향 n 쪽 바깥 → 보기 쪽을 가리킴
    const a = (ax.angle * Math.PI) / 180;
    const n: [number, number] = [Math.cos(a), Math.sin(a)];
    const pw = (pv.bounds[2] - pv.bounds[0]) * scale;
    const ph = (pv.bounds[3] - pv.bounds[1]) * scale;
    const c: [number, number] = [pat[0] + pw / 2, pat[1] + ph / 2];
    // 가운데에서 n 방향 광선이 보기 상자 경계와 만나는 거리
    const half = Math.min(Math.abs(n[0]) > 1e-9 ? pw / 2 / Math.abs(n[0]) : Infinity, Math.abs(n[1]) > 1e-9 ? ph / 2 / Math.abs(n[1]) : Infinity);
    const tip: [number, number] = [c[0] + n[0] * (half + 3), c[1] + n[1] * (half + 3)];
    const tail: [number, number] = [c[0] + n[0] * (half + 13), c[1] + n[1] * (half + 13)];
    items.push({ kind: 'line', layer: 'dim', points: [...tail, ...tip] });
    arrow(items, tip, [-n[0], -n[1]]);
    items.push({ kind: 'text', layer: 'text', x: tail[0] + n[0] * 2.5, y: tail[1] + n[1] * 2.5 - 1.2, size: 3.5, text: label, anchor: 'middle' });
    // 투상 결과
    const w = (v.bounds[2] - v.bounds[0]) * scale;
    const h = (v.bounds[3] - v.bounds[1]) * scale;
    const spot = freeSpot(w + 8, h + 12);
    if (!spot) detailOverflow = true;
    const [sx, sy] = spot ?? [MARGIN + 2, H - MARGIN - 2 - h - 12];
    occupied.push([sx, sy, sx + w + 8, sy + h + 12]);
    const at: [number, number] = [sx + 4, sy + 9];
    const map = (x: number, y: number): [number, number] => [at[0] + (x - v.bounds[0]) * scale, at[1] + (y - v.bounds[1]) * scale];
    const mapLine = (l: number[]) => l.flatMap((_, j) => (j % 2 ? [] : map(l[j]!, l[j + 1]!)));
    for (const l of v.hidden) items.push({ kind: 'line', layer: 'hidden', points: mapLine(l) });
    for (const l of v.visible) items.push({ kind: 'line', layer: 'visible', points: mapLine(l) });
    if (opt.centerlines) centerLines(items, v, map, scale);
    items.push({ kind: 'text', layer: 'text', x: at[0] + w / 2, y: sy + 3, size: 3.5, text: `보조 투상도 ${label}`, anchor: 'middle' });
    auxPlaced.push({ id: ax.id, label, at, bounds: v.bounds });
  });
  const details: Sheet['details'] = [];
  (opt.details ?? []).forEach((dt, k) => {
    const v = views[dt.view];
    const at = place[dt.view];
    if (!v || !at || dt.view === ('iso' as string)) return;
    const label = DETAIL_LABELS[k] ?? String(k + 1);
    const map = (x: number, y: number): [number, number] => [at[0] + (x - v.bounds[0]) * scale, at[1] + (y - v.bounds[1]) * scale];
    const [pcx, pcy] = map(dt.center[0], dt.center[1]);
    const pr = dt.radius * scale;
    items.push({ kind: 'line', layer: 'dim', points: circlePts(pcx, pcy, pr) });
    // 기호는 왼쪽 위 (지름 지시선은 오른쪽 위 45° 로 나가므로 겹치지 않게)
    items.push({ kind: 'text', layer: 'text', x: pcx - pr * Math.SQRT1_2 - 1, y: pcy + pr * Math.SQRT1_2 + 1, size: 3.5, text: label, anchor: 'end' });
    // 확대 그림 자리: 위에서 아래, 왼쪽에서 오른쪽으로 2mm 씩 훑어 겹치지 않는 첫 곳
    const ds = scale * dt.scale;
    const R = dt.radius * ds;
    const bw = 2 * R + 4;
    const bh = 2 * R + 10;
    let spot = freeSpot(bw, bh);
    if (!spot) {
      detailOverflow = true;
      spot = [MARGIN + 2, H - MARGIN - 2 - bh];
    }
    occupied.push([spot[0], spot[1], spot[0] + bw, spot[1] + bh]);
    const cx = spot[0] + bw / 2;
    const cy = spot[1] + 8 + R + 2;
    const dmap = (x: number, y: number): [number, number] => [cx + (x - dt.center[0]) * ds, cy + (y - dt.center[1]) * ds];
    const clipMap = (l: number[]) => clipToCircle(l, dt.center, dt.radius).map((piece) => piece.flatMap((_, j) => (j % 2 ? [] : dmap(piece[j]!, piece[j + 1]!))));
    if (v.section && opt.section?.view === v.name) for (const l of hatch(v.section.map((l) => l.flatMap((_, j) => (j % 2 ? [] : dmap(l[j]!, l[j + 1]!)))))) for (const piece of clipToCircle(l, [cx, cy], R)) items.push({ kind: 'line', layer: 'hatch', points: piece });
    for (const l of v.hidden) for (const piece of clipMap(l)) items.push({ kind: 'line', layer: 'hidden', points: piece });
    for (const l of v.visible) for (const piece of clipMap(l)) items.push({ kind: 'line', layer: 'visible', points: piece });
    items.push({ kind: 'line', layer: 'dim', points: circlePts(cx, cy, R) });
    items.push({ kind: 'text', layer: 'text', x: cx, y: spot[1] + 2, size: 3.5, text: `상세 ${label} (${scaleLabel(ds)})`, anchor: 'middle' });
    details.push({ id: dt.id, label, center: [cx, cy], radius: R, scale: ds });
  });

  const resolved: ResolvedDim[] = [];
  const dimHandles: Sheet['dimHandles'] = [];
  for (const d of opt.dims ?? []) {
    const v = views[d.view];
    const pl = placements[d.view];
    if (!v || !pl) continue;
    const r = resolveDim(v, d);
    resolved.push(r);
    const h = userDim(items, r, (p) => [pl.at[0] + (p[0] - pl.bounds[0]) * scale, pl.at[1] + (p[1] - pl.bounds[1]) * scale], scale);
    if (h) dimHandles.push({ id: d.id, kind: d.kind, ...h });
  }
  const marks: Sheet['marks'] = [];
  for (const m of opt.marks ?? []) {
    const v = views[m.view];
    const pl = placements[m.view];
    if (!v || !pl) continue;
    const r = resolveMark(v, m);
    const P: [number, number] = [pl.at[0] + (r.p[0] - pl.bounds[0]) * scale, pl.at[1] + (r.p[1] - pl.bounds[1]) * scale];
    roughnessSymbol(items, P, r.out, `Ra ${dimText(m.ra)}${r.ok ? '' : '?'}`);
    marks.push({ id: m.id, ok: r.ok, at: P });
  }
  return { width: W, height: H, scale, overflow: detailOverflow || L.w > area.w + 1e-9 || L.h > area.h + 1e-9, items, placements, dims: resolved, details, dimHandles, marks, aux: auxPlaced };
}

const rect = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
/**
 * 표면 거칠기 기호 (ISO 1302 √, 제거 가공 = 삼각형 없이 열린 꼴): 끝 P 가 표면에 닿고, out 방향으로 선다.
 * 짧은 다리·긴 다리(60°), 긴 다리 위 가로선 아래에 "Ra 값". 글자가 거꾸로 읽히지 않게 가로 방향을 고른다 (기호는 좌우가 뒤집힐 수 있음)
 */
function roughnessSymbol(items: SheetItem[], P: [number, number], out: [number, number], text: string) {
  const u = out;
  let r: [number, number] = [u[1], -u[0]];
  if (r[0] < -1e-9 || (Math.abs(r[0]) <= 1e-9 && r[1] < 0)) r = [-r[0], -r[1]];
  const h = 3.5;
  const t = Math.tan(Math.PI / 6);
  const at = (a: number, b: number): [number, number] => [P[0] + r[0] * a + u[0] * b, P[1] + r[1] * a + u[1] * b];
  const S = at(-h * t, h);
  const L = at(2 * h * t, 2 * h);
  const w = Math.max(9, text.length * TEXT * 0.62 + 1.5);
  items.push({ kind: 'line', layer: 'dim', points: [...S, ...P, ...L, ...at(2 * h * t + w, 2 * h)] });
  const ang = (Math.atan2(r[1], r[0]) * 180) / Math.PI;
  const [tx, ty] = at(2 * h * t + 0.8, 2 * h - TEXT - 0.6);
  items.push({ kind: 'text', layer: 'dim', x: tx, y: ty, size: TEXT, text, anchor: 'start', ...(Math.abs(ang) > 1e-9 ? { angle: Math.round(ang * 1000) / 1000 } : {}) });
}

/** 원 꺾은선 (72 조각, 닫힘) */
const circlePts = (cx: number, cy: number, r: number) => Array.from({ length: 73 }, (_, k) => [cx + r * Math.cos((k * Math.PI) / 36), cy + r * Math.sin((k * Math.PI) / 36)]).flat();

/** 꺾은선을 원 안 조각들로 자른다 (상세도) */
export function clipToCircle(l: number[], c: readonly [number, number] | readonly number[], r: number): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length >= 4) out.push(cur);
    cur = [];
  };
  for (let k = 2; k + 1 < l.length; k += 2) {
    const [ax, ay, bx, by] = [l[k - 2]!, l[k - 1]!, l[k]!, l[k + 1]!];
    const dx = bx - ax;
    const dy = by - ay;
    const fx = ax - c[0]!;
    const fy = ay - c[1]!;
    const A = dx * dx + dy * dy;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - r * r;
    const disc = B * B - 4 * A * C;
    if (A < 1e-18 || disc <= 0) {
      flush();
      continue;
    }
    const sq = Math.sqrt(disc);
    const t0 = Math.max(0, (-B - sq) / (2 * A));
    const t1 = Math.min(1, (-B + sq) / (2 * A));
    if (t0 >= t1) {
      flush();
      continue;
    }
    const p0 = [ax + dx * t0, ay + dy * t0];
    const p1 = [ax + dx * t1, ay + dy * t1];
    if (t0 > 0) flush();
    if (!cur.length) cur.push(p0[0]!, p0[1]!);
    cur.push(p1[0]!, p1[1]!);
    if (t1 < 1) flush();
  }
  flush();
  return out;
}

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
  if (opt.sheetNo) {
    label(x + 47, y + 3, '시트');
    value(x + 57, y + 2.5, `${opt.sheetNo[0]}/${opt.sheetNo[1]}`, 3);
  }
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

/** 주기: 표제란 왼쪽 칸 (테두리 안 아래쪽) */
function notes(items: SheetItem[], text: string | undefined) {
  const lines = (text ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(0, MAX_NOTE_LINES);
  if (!lines.length) return;
  const x = MARGIN + 3;
  let y = MARGIN + TITLE_H - 4;
  items.push({ kind: 'text', layer: 'text', x, y, size: 3, text: '주기', anchor: 'start' });
  for (const l of lines) {
    y -= 4.4;
    items.push({ kind: 'text', layer: 'text', x: x + 2, y, size: 3, text: l, anchor: 'start' });
  }
}

/**
 * 45° 해칭 (짝수-홀수 규칙): 경계 꺾은선 조각을 순서 없이 받아, 간격 HATCH 의 평행선마다 교차점을 정렬해 둘씩 잇는다.
 * 꼭짓점을 지나는 선은 반열림 규칙(한쪽 끝만 셈)으로 두 번 세지 않는다.
 */
export function hatch(boundary: number[][], spacing = HATCH): number[][] {
  const segs: [number, number, number, number][] = [];
  for (const l of boundary) for (let k = 2; k + 1 < l.length; k += 2) segs.push([l[k - 2]!, l[k - 1]!, l[k]!, l[k + 1]!]);
  if (!segs.length) return [];
  const d = [Math.SQRT1_2, Math.SQRT1_2];
  const n = [-Math.SQRT1_2, Math.SQRT1_2];
  const dn = (x: number, y: number) => x * n[0]! + y * n[1]!;
  const dd = (x: number, y: number) => x * d[0]! + y * d[1]!;
  let lo = Infinity;
  let hi = -Infinity;
  for (const [ax, ay, bx, by] of segs) {
    lo = Math.min(lo, dn(ax, ay), dn(bx, by));
    hi = Math.max(hi, dn(ax, ay), dn(bx, by));
  }
  const out: number[][] = [];
  for (let c = Math.floor(lo / spacing) * spacing + spacing / 2; c < hi; c += spacing) {
    const ts: number[] = [];
    for (const [ax, ay, bx, by] of segs) {
      const sa = dn(ax, ay) - c;
      const sb = dn(bx, by) - c;
      if (sa >= 0 === sb >= 0) continue;
      const u = sa / (sa - sb);
      ts.push(dd(ax, ay) + (dd(bx, by) - dd(ax, ay)) * u);
    }
    ts.sort((a, b) => a - b);
    for (let k = 0; k + 1 < ts.length; k += 2) {
      const p = (t: number) => [c * n[0]! + t * d[0]!, c * n[1]! + t * d[1]!];
      out.push([...p(ts[k]!), ...p(ts[k + 1]!)]);
    }
  }
  return out;
}

/** 중심선: 온전히 보이는 원의 중심 표시(+), 원통 축선 — 끝을 2mm 넘긴다 */
function centerLines(items: SheetItem[], v: DrawingView, map: (x: number, y: number) => [number, number], scale: number) {
  const seen: number[][] = [];
  for (const c of v.circles) {
    if (!c.full || !c.visible || c.radius * scale < 1) continue;
    if (seen.some((q) => Math.hypot(q[0]! - c.center[0], q[1]! - c.center[1]) < 1e-6)) continue;
    seen.push([...c.center]);
    const [cx, cy] = map(c.center[0], c.center[1]);
    const r = c.radius * scale + 2;
    items.push({ kind: 'line', layer: 'center', points: [cx - r, cy, cx + r, cy] });
    items.push({ kind: 'line', layer: 'center', points: [cx, cy - r, cx, cy + r] });
  }
  for (const a of v.axes) {
    const [ax, ay] = map(a[0]!, a[1]!);
    const [bx, by] = map(a[2]!, a[3]!);
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-6) continue;
    const ux = ((bx - ax) / L) * 2;
    const uy = ((by - ay) / L) * 2;
    items.push({ kind: 'line', layer: 'center', points: [ax - ux, ay - uy, bx + ux, by + uy] });
  }
}

/**
 * 절단선: 단면 평면이 이 보기에 선으로 보이면 (정면 단면 → 평면도의 y = offset, 우측면 단면 → 정면도의 x = offset)
 * 가는 1점 쇄선 + 양 끝 굵은 선 + 보는 방향 화살표 + 기호 A
 */
function cuttingLine(
  items: SheetItem[],
  v: DrawingView,
  sec: { view: 'front' | 'right'; offset: number },
  map: (x: number, y: number) => [number, number],
  [x0, y0, x1, y1]: number[],
) {
  // 정면 단면: 평면 y = c 는 평면도에서 가로선 (보는 쪽 +Y = 종이 위쪽). 우측면 단면: 평면 x = c 는 정면도에서 세로선 (보는 쪽 −X = 왼쪽)
  let a: [number, number];
  let b: [number, number];
  let look: [number, number];
  if (sec.view === 'front' && v.name === 'top') {
    const y = map(0, sec.offset)[1];
    [a, b, look] = [[x0! - 6, y], [x1! + 6, y], [0, 1]];
  } else if (sec.view === 'right' && v.name === 'front') {
    const x = map(sec.offset, 0)[0];
    [a, b, look] = [[x, y0! - 6], [x, y1! + 6], [-1, 0]];
  } else return;
  items.push({ kind: 'line', layer: 'center', points: [...a, ...b] });
  const along: [number, number] = [(b[0] - a[0]) / Math.hypot(b[0] - a[0], b[1] - a[1]), (b[1] - a[1]) / Math.hypot(b[0] - a[0], b[1] - a[1])];
  for (const [p, sign] of [[a, 1], [b, -1]] as const) {
    const q: [number, number] = [p[0] + along[0] * 5 * sign, p[1] + along[1] * 5 * sign];
    items.push({ kind: 'line', layer: 'visible', points: [...p, ...q] });
    // 화살표: 끝에서 보는 방향으로 6mm
    const tip: [number, number] = [p[0] + look[0] * 6, p[1] + look[1] * 6];
    items.push({ kind: 'line', layer: 'dim', points: [...p, ...tip] });
    arrow(items, tip, look);
    items.push({ kind: 'text', layer: 'text', x: tip[0] + look[0] * 1.5, y: tip[1] + (look[1] > 0 ? 1.5 : -1.2), size: 3.5, text: SECTION_LABEL, anchor: look[0] < 0 ? 'end' : 'middle' });
  }
}

/** 치수선 하나: 보조선 A→A2, B→B2 (형상에서 1mm 띄우고 2mm 넘김), 치수선 A2–B2 + 화살표, 글자는 선 가운데 위 1mm (선 방향으로 돌려 읽기 쉽게) */
function dimLine(items: SheetItem[], A: [number, number], B: [number, number], A2: [number, number], B2: [number, number], text: string) {
  for (const [p, q] of [[A, A2], [B, B2]] as const) {
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 1e-6) continue;
    const u = [(q[0] - p[0]) / L, (q[1] - p[1]) / L];
    if (L > 1) items.push({ kind: 'line', layer: 'dim', points: [p[0] + u[0]!, p[1] + u[1]!, q[0] + u[0]! * 2, q[1] + u[1]! * 2] });
  }
  items.push({ kind: 'line', layer: 'dim', points: [...A2, ...B2] });
  const len = Math.hypot(B2[0] - A2[0], B2[1] - A2[1]) || 1;
  const d: [number, number] = [(B2[0] - A2[0]) / len, (B2[1] - A2[1]) / len];
  arrow(items, B2, d);
  arrow(items, A2, [-d[0], -d[1]]);
  // 읽는 방향: 각도를 (−90°, 90°] 로
  let ang = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
  if (ang > 90) ang -= 180;
  if (ang <= -90) ang += 180;
  const rad = (ang * Math.PI) / 180;
  const up: [number, number] = [-Math.sin(rad), Math.cos(rad)];
  const mx = (A2[0] + B2[0]) / 2 + up[0];
  const my = (A2[1] + B2[1]) / 2 + up[1];
  items.push({ kind: 'text', layer: 'dim', x: mx, y: my, size: TEXT, text, anchor: 'middle', ...(Math.abs(ang) > 1e-9 ? { angle: Math.round(ang * 1000) / 1000 } : {}) });
}

/** 사용자 치수 그리기. 연결이 끊기면 값 뒤에 "?" */
function userDim(items: SheetItem[], r: ResolvedDim, map: (p: [number, number]) => [number, number], scale: number): { A: [number, number]; B?: [number, number]; handle: [number, number] } | null {
  const mark = r.ok ? '' : '?';
  const off = r.dim.offset;
  if (r.dim.kind === 'diameter') {
    const [cx, cy] = map(r.a);
    const rad = (r.radius ?? 0) * scale;
    const u: [number, number] = [Math.SQRT1_2, Math.SQRT1_2];
    const edge: [number, number] = [cx + u[0] * rad, cy + u[1] * rad];
    const knee: [number, number] = [edge[0] + u[0] * Math.max(3, Math.abs(off)), edge[1] + u[1] * Math.max(3, Math.abs(off))];
    const label = r.ok ? `Ø${dimText(r.value)}${tolText(r.dim.tol)}` : 'Ø?';
    items.push({ kind: 'line', layer: 'dim', points: [...edge, ...knee, knee[0] + label.length * TEXT * 0.62, knee[1]] });
    arrow(items, edge, [-u[0], -u[1]]);
    items.push({ kind: 'text', layer: 'dim', x: knee[0] + 0.5, y: knee[1] + 1, size: TEXT, text: label, anchor: 'start' });
    return { A: edge, handle: knee };
  }
  const A = map(r.a);
  const B = map(r.b!);
  let A2: [number, number];
  let B2: [number, number];
  if (r.dim.kind === 'horizontal') {
    const y = (off >= 0 ? Math.max(A[1], B[1]) : Math.min(A[1], B[1])) + off;
    [A2, B2] = [[A[0], y], [B[0], y]];
  } else if (r.dim.kind === 'vertical') {
    const x = (off >= 0 ? Math.max(A[0], B[0]) : Math.min(A[0], B[0])) + off;
    [A2, B2] = [[x, A[1]], [x, B[1]]];
  } else {
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    const n: [number, number] = [-(B[1] - A[1]) / L, (B[0] - A[0]) / L];
    [A2, B2] = [[A[0] + n[0] * off, A[1] + n[1] * off], [B[0] + n[0] * off, B[1] + n[1] * off]];
  }
  if (Math.hypot(B2[0] - A2[0], B2[1] - A2[1]) < 1e-6) return null; // 같은 점 (수평 치수인데 세로로 놓인 두 점 등)
  dimLine(items, A, B, A2, B2, `${dimText(r.value)}${mark}${r.ok ? tolText(r.dim.tol) : ''}`);
  return { A, B, handle: [(A2[0] + B2[0]) / 2, (A2[1] + B2[1]) / 2] };
}

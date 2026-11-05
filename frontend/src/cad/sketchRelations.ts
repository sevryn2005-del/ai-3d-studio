/**
 * 스케치 구속·치수 표시 (솔리드웍스처럼 선·점 옆 작은 기호) — 순수 함수: 무엇을 어디에 그릴지.
 * 같은 자리 기호는 한 묶음으로 (화면에서 가로로 나란히).
 */
import type { Point2, Sketch } from './commandTypes';
import { CONSTRAINT_LABEL, sketchPoints } from './solver';
import { dimensionValue } from './sketch';
import { formatMm } from './units';

export interface Badge {
  /** 같은 자리 묶음 키 */
  at: Point2;
  text: string;
  title: string;
  kind: 'relation' | 'dimension';
}

const SYMBOL: Record<string, string> = {
  fix: '⊕',
  coincident: '●',
  concentric: '◎',
  horizontal: '―',
  vertical: '｜',
  parallel: '∥',
  perpendicular: '⊥',
  equal: '＝',
  tangent: 'T',
  symmetric: '⇋',
  midpoint: 'M',
};

const RECT: Point2[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

/** 점 이름 → 좌표 (사각형 모서리 포함) */
function pointAt(sketch: Sketch, pts: Map<string, Point2>, ref: string): Point2 | null {
  const direct = pts.get(ref) ?? pts.get(`${ref}.center`);
  if (direct) return direct;
  const [id, part] = ref.split('.');
  const e = sketch.entities.find((x) => x.id === id);
  if (e?.type === 'rectangle' && part && /^p[0-3]$/.test(part)) {
    const [sx, sy] = RECT[Number(part[1])]!;
    return [e.center[0] + (sx! * (dimensionValue(sketch, e.id, 'width') ?? 0)) / 2, e.center[1] + (sy! * (dimensionValue(sketch, e.id, 'height') ?? 0)) / 2];
  }
  return null;
}

/** 변 이름 → 가운데 */
function edgeMid(sketch: Sketch, pts: Map<string, Point2>, ref: string): Point2 | null {
  const [id, part] = ref.split('.');
  if (!part?.startsWith('e')) return null;
  const k = Number(part.slice(1));
  const e = sketch.entities.find((x) => x.id === id);
  const n = e?.type === 'rectangle' ? 4 : e && 'points' in e ? (e as { points: Point2[] }).points.length : 0;
  if (!n) return null;
  const a = pointAt(sketch, pts, `${id}.p${k}`);
  const b = pointAt(sketch, pts, `${id}.p${(k + 1) % n}`);
  return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
}

export function sketchBadges(sketch: Sketch): Badge[] {
  const pts = sketchPoints(sketch);
  const out: Badge[] = [];
  const where = (ref: string) => edgeMid(sketch, pts, ref) ?? pointAt(sketch, pts, ref);
  for (const c of sketch.constraints) {
    const title = `${CONSTRAINT_LABEL[c.type]} (${c.refs.join(', ')})`;
    let at: Point2 | null;
    let text = SYMBOL[c.type] ?? '';
    if (c.type === 'length' || c.type === 'distance' || c.type === 'angle') {
      text = c.type === 'angle' ? `∠${formatMm(c.value ?? 0)}°` : formatMm(c.value ?? 0);
      if (c.type === 'distance') {
        const [a, b] = [where(c.refs[0]!), where(c.refs[1]!)];
        at = a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
      } else at = where(c.refs[0]!);
      if (at) out.push({ at, text, title, kind: 'dimension' });
      continue;
    }
    if ((c.type === 'horizontal' || c.type === 'vertical' || c.type === 'coincident') && c.refs.length === 2) {
      // 두 점 수평·수직·일치: 둘째 점에
      at = where(c.refs[1]!);
    } else if (c.type === 'midpoint' || c.type === 'tangent') at = where(c.refs[0]!);
    else at = where(c.refs[0]!);
    if (at) out.push({ at, text, title, kind: 'relation' });
    // 두 대상 관계(평행·직교·같은 길이)는 둘째 대상에도
    if ((c.type === 'parallel' || c.type === 'perpendicular' || c.type === 'equal') && c.refs[1]) {
      const b = where(c.refs[1]);
      if (b) out.push({ at: b, text, title, kind: 'relation' });
    }
  }
  // 요소 치수 (사각형 폭·높이, 원·슬롯·타원 지름)
  for (const e of sketch.entities) {
    if (e.type === 'rectangle') {
      const w = dimensionValue(sketch, e.id, 'width') ?? 0;
      const h = dimensionValue(sketch, e.id, 'height') ?? 0;
      out.push({ at: [e.center[0], e.center[1] - h / 2], text: formatMm(w), title: `${e.id} 폭`, kind: 'dimension' });
      out.push({ at: [e.center[0] + w / 2, e.center[1]], text: formatMm(h), title: `${e.id} 높이`, kind: 'dimension' });
    } else if (e.type === 'circle') {
      const d = dimensionValue(sketch, e.id, 'diameter') ?? 0;
      out.push({ at: [e.center[0] + d / 2 / Math.SQRT2, e.center[1] + d / 2 / Math.SQRT2], text: `Ø${formatMm(d)}`, title: `${e.id} 지름`, kind: 'dimension' });
    }
  }
  return out;
}

/** 같은 자리(0.001mm) 기호 묶기 */
export function groupBadges(badges: Badge[]): { at: Point2; items: Badge[] }[] {
  const m = new Map<string, { at: Point2; items: Badge[] }>();
  for (const b of badges) {
    const k = b.at.map((v) => Math.round(v * 1000)).join(',');
    const g = m.get(k) ?? { at: b.at, items: [] };
    g.items.push(b);
    m.set(k, g);
  }
  return [...m.values()];
}

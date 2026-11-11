/**
 * 판금 (형식 v45, 솔리드웍스 Base Flange + Edge Flange + Flatten 1단계).
 *
 * 한 장의 판(두께 t)을 네 변에서 90° 위로 접은 쟁반·상자 모양. 원점 = 바닥 중심, Z-up.
 * - width·depth: 바깥 치수 (X·Y), flangePX/NX/PY/NY: 그 변 플랜지의 바깥 높이 (0 = 없음)
 * - bendRadius: 안쪽 굽힘 반지름 r, 바깥 반지름 a = r + t
 * - 바닥 평판 = 플랜지가 있는 변에서 a 만큼 안쪽까지. 플랜지는 바닥 평판 길이만큼만 (모서리는 열린 릴리프)
 * - 굽힘 = 중심 (바닥 끝, z = a) 둘레 1/4 고리, 벽 = 바깥면이 바깥 치수에 닿는 두께 t 판, z = a → 높이
 * 전개(flat pattern): 굽힘 허용량 BA = (π/2)(r + K·t) (K = kFactor), 플랜지 평판 길이 = 높이 − a.
 * 세 엔진(브라우저 manifold·OCCT, 서버 CadQuery)이 같은 단면(sheetProfile)을 쓴다.
 */
import type { SheetParams } from './commandTypes';

export type SheetSide = 'PX' | 'NX' | 'PY' | 'NY';
export const SHEET_SIDES: readonly SheetSide[] = ['PX', 'NX', 'PY', 'NY'];
export const flangeOf = (p: SheetParams, s: SheetSide): number => p[`flange${s}`];

/** 바닥 평판 범위 [x0, x1, y0, y1] */
export function sheetBase(p: SheetParams): [number, number, number, number] {
  const a = p.bendRadius + p.thickness;
  return [
    -p.width / 2 + (p.flangeNX > 0 ? a : 0),
    p.width / 2 - (p.flangePX > 0 ? a : 0),
    -p.depth / 2 + (p.flangeNY > 0 ? a : 0),
    p.depth / 2 - (p.flangePY > 0 ? a : 0),
  ];
}

/** 값 검사 (스키마 refine 과 엔진이 같은 말을 쓴다). 문제 없으면 null */
export function sheetError(p: SheetParams): string | null {
  const a = p.bendRadius + p.thickness;
  for (const s of SHEET_SIDES) {
    const h = flangeOf(p, s);
    if (h > 0 && h <= a + 0.01) return `플랜지 높이는 0(없음)이거나 굽힘 바깥 반지름(${round(a)}mm)보다 커야 합니다`;
  }
  const [x0, x1, y0, y1] = sheetBase(p);
  if (x1 - x0 < 0.1 || y1 - y0 < 0.1) return '바닥 평판이 남지 않습니다 (폭·깊이를 늘리거나 굽힘 반지름을 줄이세요)';
  return null;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** 플랜지 이음 단면 (u = 바깥쪽, v = 위): 바깥 굽힘 호 → 벽 → 안쪽 굽힘 호. segments = 1/4 호 분할 수 */
export function sheetProfile(r: number, t: number, h: number, segments: number): [number, number][] {
  const a = r + t;
  const pts: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const th = -Math.PI / 2 + (Math.PI / 2) * (i / segments);
    pts.push([a * Math.cos(th), a + a * Math.sin(th)]);
  }
  pts.push([a, h], [r, h]);
  for (let i = segments; i >= 0; i--) {
    const th = -Math.PI / 2 + (Math.PI / 2) * (i / segments);
    pts.push([r * Math.cos(th), a + r * Math.sin(th)]);
  }
  return pts;
}

/**
 * 변마다 플랜지가 놓이는 자리: 단면 (u, v) 와 길이 방향 s → 로컬 (x, y, z) 의 원점·u 방향·s 방향.
 * 길이 s ∈ [0, length]
 */
export function flangeFrames(p: SheetParams): { side: SheetSide; origin: [number, number, number]; u: [number, number, number]; s: [number, number, number]; length: number }[] {
  const [x0, x1, y0, y1] = sheetBase(p);
  const out: ReturnType<typeof flangeFrames> = [];
  // (u, 위, s) 가 오른손 좌표계가 되게 s = u × Z
  if (p.flangePX > 0) out.push({ side: 'PX', origin: [x1, y1, 0], u: [1, 0, 0], s: [0, -1, 0], length: y1 - y0 });
  if (p.flangeNX > 0) out.push({ side: 'NX', origin: [x0, y0, 0], u: [-1, 0, 0], s: [0, 1, 0], length: y1 - y0 });
  if (p.flangePY > 0) out.push({ side: 'PY', origin: [x0, y1, 0], u: [0, 1, 0], s: [1, 0, 0], length: x1 - x0 });
  if (p.flangeNY > 0) out.push({ side: 'NY', origin: [x1, y0, 0], u: [0, -1, 0], s: [-1, 0, 0], length: x1 - x0 });
  return out;
}

/** 정확한 부피 (참 원호) — 공유 픽스처 기대값 */
export function sheetVolume(p: SheetParams): number {
  const [x0, x1, y0, y1] = sheetBase(p);
  const r = p.bendRadius;
  const t = p.thickness;
  const a = r + t;
  let v = (x1 - x0) * (y1 - y0) * t;
  for (const f of flangeFrames(p)) v += f.length * ((Math.PI / 4) * (a * a - r * r) + t * (flangeOf(p, f.side) - a));
  return v;
}

/** 굽힘 허용량 (중립면 호 길이) */
export const bendAllowance = (p: SheetParams) => (Math.PI / 2) * (p.bendRadius + p.kFactor * p.thickness);

export interface FlatPattern {
  /** 바깥 윤곽 (닫힌 다각형, 반시계) */
  outline: [number, number][];
  /** 굽힘선 (굽힘 영역 양 끝) */
  bendLines: [[number, number], [number, number]][];
  /** 전개 크기 [가로, 세로] */
  size: [number, number];
}

/** 전개도: 바닥 평판 + 변마다 (굽힘 허용량 + 플랜지 평판) 띠. 열린 모서리는 노치로 남는다 */
export function flatPattern(p: SheetParams): FlatPattern {
  const [x0, x1, y0, y1] = sheetBase(p);
  const ba = bendAllowance(p);
  const a = p.bendRadius + p.thickness;
  const ext = (h: number) => (h > 0 ? ba + (h - a) : 0);
  const ePX = ext(p.flangePX);
  const eNX = ext(p.flangeNX);
  const ePY = ext(p.flangePY);
  const eNY = ext(p.flangeNY);
  // 십자 모양 윤곽 (반시계, 아래 변부터)
  const outline: [number, number][] = [];
  const push = (x: number, y: number) => {
    const last = outline[outline.length - 1];
    if (!last || Math.abs(last[0] - x) > 1e-9 || Math.abs(last[1] - y) > 1e-9) outline.push([x, y]);
  };
  push(x0, y0 - eNY);
  push(x1, y0 - eNY);
  push(x1, y0);
  push(x1 + ePX, y0);
  push(x1 + ePX, y1);
  push(x1, y1);
  push(x1, y1 + ePY);
  push(x0, y1 + ePY);
  push(x0, y1);
  push(x0 - eNX, y1);
  push(x0 - eNX, y0);
  push(x0, y0);
  // 같은 직선 위 중간점 빼기 (플랜지 없는 변)
  const clean = outline.filter((pt, i) => {
    const a0 = outline[(i - 1 + outline.length) % outline.length]!;
    const b0 = outline[(i + 1) % outline.length]!;
    return Math.abs((pt[0] - a0[0]) * (b0[1] - a0[1]) - (pt[1] - a0[1]) * (b0[0] - a0[0])) > 1e-9;
  });
  const bendLines: FlatPattern['bendLines'] = [];
  if (ePX) bendLines.push([[x1, y0], [x1, y1]], [[x1 + ba, y0], [x1 + ba, y1]]);
  if (eNX) bendLines.push([[x0, y0], [x0, y1]], [[x0 - ba, y0], [x0 - ba, y1]]);
  if (ePY) bendLines.push([[x0, y1], [x1, y1]], [[x0, y1 + ba], [x1, y1 + ba]]);
  if (eNY) bendLines.push([[x0, y0], [x1, y0]], [[x0, y0 - ba], [x1, y0 - ba]]);
  return { outline: clean, bendLines, size: [x1 - x0 + ePX + eNX, y1 - y0 + ePY + eNY] };
}

/** 전개도 DXF (R12, 단위 mm): 윤곽 = 레이어 OUTLINE, 굽힘선 = 레이어 BEND (점선 아님 — 레이저 장비가 레이어로 구분) */
export function flatPatternDxf(f: FlatPattern): string {
  const out: string[] = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  const n = (v: number) => (Math.round(v * 1e4) / 1e4).toString();
  const line = (layer: string, a: [number, number], b: [number, number]) => out.push('0', 'LINE', '8', layer, '10', n(a[0]), '20', n(a[1]), '30', '0', '11', n(b[0]), '21', n(b[1]), '31', '0');
  f.outline.forEach((pt, i) => line('OUTLINE', pt, f.outline[(i + 1) % f.outline.length]!));
  for (const [a, b] of f.bendLines) line('BEND', a, b);
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n') + '\n';
}

/** 다각형 넓이 (전개 넓이 × 두께 ≈ 부피 확인용) */
export function polygonArea(pts: [number, number][]): number {
  let s = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length]!;
    s += p[0] * q[1] - q[0] * p[1];
  });
  return s / 2;
}

/**
 * 도면 사용자 치수 (형식 v17): 끝점을 투상 결과에 다시 붙이고 값을 잰다. 순수 함수 (시트·화면·테스트 공용).
 *
 * 끝점 = { at: 보기 좌표 mm, rel: 보기 범위 안 상대 위치 }. 다시 그릴 때 rel 로 옮긴 자리 → at 순서로
 * 가장 가까운 꼭짓점(지름 치수는 원 중심)을 허용 거리 안에서 찾는다. 모델 크기가 바뀌어 꼭짓점이 비례해 움직여도 따라가고,
 * 붙을 곳이 없으면 "연결 끊김"(ok = false, 저장된 자리로 그림).
 * 진짜 위상 이름(면·모서리 ID)이 아니라 위치로 다시 붙이는 방식이라, 모양이 크게 바뀌면 다른 꼭짓점에 붙을 수 있다.
 */
import type { DrawingAnchor, DrawingDim, DrawingMark } from '../../cad/commandTypes';
import type { DrawingView } from '../engine/types';

type P2 = [number, number];

/** 보기의 꼭짓점: 선(보이는 선·숨은선)의 양 끝 + 꺾인 점 (원 중심은 따로) */
export function viewVertices(v: DrawingView): P2[] {
  const out: P2[] = [];
  const seen = new Set<string>();
  const add = (p: P2) => {
    const k = `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  };
  for (const l of [...v.visible, ...v.hidden]) {
    // 양 끝 + 진짜 꺾인 점 (방향이 20° 넘게 바뀜). 곡선 표본(π/48 간격)의 중간 점은 빼고
    const n = l.length / 2;
    for (let k = 0; k < n; k++) {
      if (k > 0 && k < n - 1) {
        const d1 = Math.atan2(l[2 * k + 1]! - l[2 * k - 1]!, l[2 * k]! - l[2 * k - 2]!);
        const d2 = Math.atan2(l[2 * k + 3]! - l[2 * k + 1]!, l[2 * k + 2]! - l[2 * k]!);
        const turn = Math.abs(((d2 - d1 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
        if (turn < 0.35) continue;
      }
      add([l[2 * k]!, l[2 * k + 1]!]);
    }
  }
  return out;
}

const size = (v: DrawingView) => [v.bounds[2] - v.bounds[0], v.bounds[3] - v.bounds[1]] as const;

/** 다시 붙이는 허용 거리 (보기 mm): 보기 크기의 2%, 최소 0.5 */
export const snapTolerance = (v: DrawingView) => Math.max(0.5, 0.02 * Math.max(...size(v)));

export function makeAnchor(v: DrawingView, p: P2): DrawingAnchor {
  const [w, h] = size(v);
  const r = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
  return { at: [r(p[0]), r(p[1])], rel: [w > 1e-9 ? r((p[0] - v.bounds[0]) / w) : 0.5, h > 1e-9 ? r((p[1] - v.bounds[1]) / h) : 0.5] };
}

const relPoint = (v: DrawingView, a: DrawingAnchor): P2 => {
  const [w, h] = size(v);
  return [v.bounds[0] + a.rel[0] * w, v.bounds[1] + a.rel[1] * h];
};

function nearest(points: P2[], p: P2, tol: number): P2 | null {
  let best: P2 | null = null;
  let bd = tol;
  for (const q of points) {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d <= bd) {
      bd = d;
      best = q;
    }
  }
  return best;
}

/** 화면에서 고르기: p 에 가장 가까운 꼭짓점 (tol 안) */
export function snapVertex(v: DrawingView, p: P2, tol: number): P2 | null {
  return nearest(viewVertices(v), p, tol);
}

/** 화면에서 고르기: p 가 가장자리·중심 가까이에 있는 온전한 원 */
export function snapCircle(v: DrawingView, p: P2, tol: number): DrawingView['circles'][number] | null {
  let best: DrawingView['circles'][number] | null = null;
  let bd = tol;
  for (const c of v.circles) {
    if (!c.full) continue;
    const dc = Math.hypot(p[0] - c.center[0], p[1] - c.center[1]);
    const d = Math.min(dc, Math.abs(dc - c.radius));
    if (d <= bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

export interface ResolvedDim {
  dim: DrawingDim;
  ok: boolean;
  a: P2;
  b?: P2;
  /** 지름 치수의 반지름 */
  radius?: number;
  /** 치수 값 (mm). 지름이 끊기면 0 */
  value: number;
}

export function resolveDim(v: DrawingView, dim: DrawingDim): ResolvedDim {
  const tol = snapTolerance(v);
  if (dim.kind === 'diameter') {
    const centers = v.circles.filter((c) => c.full);
    const find = (p: P2) => centers.find((c) => Math.hypot(c.center[0] - p[0], c.center[1] - p[1]) <= tol) ?? null;
    const c = find(relPoint(v, dim.a)) ?? find(dim.a.at);
    return c ? { dim, ok: true, a: c.center, radius: c.radius, value: 2 * c.radius } : { dim, ok: false, a: dim.a.at, value: 0 };
  }
  const verts = viewVertices(v);
  const attach = (an: DrawingAnchor) => nearest(verts, relPoint(v, an), tol) ?? nearest(verts, an.at, tol);
  const a = attach(dim.a);
  const b = dim.b ? attach(dim.b) : null;
  const A = a ?? dim.a.at;
  const B = b ?? dim.b?.at ?? dim.a.at;
  return { dim, ok: !!a && !!b, a: A, b: B, value: dimValue(dim.kind, A, B) };
}

export function dimValue(kind: DrawingDim['kind'], a: P2, b: P2): number {
  if (kind === 'horizontal') return Math.abs(b[0] - a[0]);
  if (kind === 'vertical') return Math.abs(b[1] - a[1]);
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export const DIM_KIND_LABEL: Record<DrawingDim['kind'], string> = { horizontal: '수평', vertical: '수직', aligned: '평행(두 점 사이)', diameter: '지름' };

/**
 * 공차 입력 읽기 (형식 v23): "" = 없음, "±0.1"·"+-0.1"·"0.1" = ±0.1, "+0.1/-0.05"·"+0.1 -0.05" = 위 +0.1 · 아래 −0.05.
 * 읽을 수 없으면 null (입력 오류)
 */
export function parseTol(text: string): DrawingDim['tol'] | undefined | null {
  const t = text.trim().replace(/−/g, '-').replace(/\s+/g, ' ');
  if (!t) return undefined;
  const sym = t.match(/^(?:±|\+-|\+\/-)?\s*(\d*\.?\d+)$/);
  if (sym) {
    const v = Number(sym[1]);
    return v === 0 ? undefined : { upper: v, lower: -v };
  }
  const two = t.match(/^([+-]?\d*\.?\d+)\s*[/ ]\s*([+-]?\d*\.?\d+)$/);
  if (!two) return null;
  const a = Number(two[1]);
  const b = Number(two[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 100 || Math.abs(b) > 100) return null;
  const [upper, lower] = a >= b ? [a, b] : [b, a];
  return upper === 0 && lower === 0 ? undefined : { upper, lower };
}

/** 공차 → 입력 칸 글자 (parseTol 의 반대) */
export function tolInput(t: DrawingDim['tol']): string {
  if (!t) return '';
  if (Math.abs(t.upper + t.lower) < 1e-12) return `±${t.upper}`;
  const sg = (v: number) => (v >= 0 ? `+${v}` : `${v}`);
  return `${sg(t.upper)}/${sg(t.lower)}`;
}

/**
 * 치수선 간격 (종이 mm, 부호 = 방향): 끝점 A·B 와 치수선을 놓을 자리 P (모두 종이 좌표).
 * 수평 = 위·아래로 형상에서 얼마나, 수직 = 좌·우로, 평행 = 두 점을 잇는 선의 왼쪽 법선 방향, 지름 = 원 가장자리 A 에서 지시선 꺾임까지 길이.
 * 치수 추가(세 번째 클릭)와 끌어 옮기기가 같은 규칙을 쓴다. ±200 으로 자르고 0.1mm 로 반올림
 */
export function dimOffsetAt(kind: DrawingDim['kind'], A: P2, B: P2 | undefined, P: P2): number {
  let off: number;
  if (kind === 'diameter') off = Math.max(3, Math.hypot(P[0] - A[0], P[1] - A[1]));
  else if (kind === 'horizontal') {
    const hi = Math.max(A[1], B![1]);
    const lo = Math.min(A[1], B![1]);
    off = P[1] >= hi ? P[1] - hi : P[1] <= lo ? P[1] - lo : P[1] - hi;
  } else if (kind === 'vertical') {
    const hi = Math.max(A[0], B![0]);
    const lo = Math.min(A[0], B![0]);
    off = P[0] >= hi ? P[0] - hi : P[0] <= lo ? P[0] - lo : P[0] - hi;
  } else {
    const L = Math.hypot(B![0] - A[0], B![1] - A[1]) || 1;
    off = ((P[0] - A[0]) * -(B![1] - A[1]) + (P[1] - A[1]) * (B![0] - A[0])) / L;
  }
  return Math.max(-200, Math.min(200, Math.round(off * 10) / 10));
}

/** 보이는 선 위에서 p 에 가장 가까운 점과 그 선의 방향 (tol 안) — 표면 거칠기 기호 붙이기 */
export function snapEdge(v: DrawingView, p: P2, tol: number): { p: P2; dir: P2 } | null {
  let best: { p: P2; dir: P2 } | null = null;
  let bd = tol;
  for (const l of v.visible)
    for (let k = 2; k + 1 < l.length; k += 2) {
      const [ax, ay, bx, by] = [l[k - 2]!, l[k - 1]!, l[k]!, l[k + 1]!];
      const dx = bx - ax;
      const dy = by - ay;
      const L2 = dx * dx + dy * dy;
      if (L2 < 1e-18) continue;
      const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2));
      const q: P2 = [ax + dx * t, ay + dy * t];
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d <= bd) {
        bd = d;
        const L = Math.sqrt(L2);
        best = { p: q, dir: [dx / L, dy / L] };
      }
    }
  return best;
}

/** 표면 거칠기 기호 다시 붙이기 (형식 v24): rel 자리 → at 자리 순서로 가장 가까운 보이는 선 위 점. 기호가 설 바깥 방향 out 도 */
export function resolveMark(v: DrawingView, m: DrawingMark): { ok: boolean; p: P2; out: P2 } {
  const tol = snapTolerance(v);
  const hit = snapEdge(v, relPoint(v, m.at), tol) ?? snapEdge(v, m.at.at, tol);
  const p = hit?.p ?? m.at.at;
  // 바깥 방향: 선의 법선 중 보기 가운데에서 멀어지는 쪽 (선이 없으면 위)
  let out: P2 = hit ? [-hit.dir[1], hit.dir[0]] : [0, 1];
  const c: P2 = [(v.bounds[0] + v.bounds[2]) / 2, (v.bounds[1] + v.bounds[3]) / 2];
  if ((p[0] - c[0]) * out[0] + (p[1] - c[1]) * out[1] < 0) out = [-out[0], -out[1]];
  return { ok: !!hit, p, out };
}

/** 표준 Ra 값 (ISO 1302 권장 수열의 흔히 쓰는 값) */
export const RA_VALUES = [0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.3, 12.5, 25, 50];

/**
 * 도면 사용자 치수 (형식 v17): 끝점을 투상 결과에 다시 붙이고 값을 잰다. 순수 함수 (시트·화면·테스트 공용).
 *
 * 끝점 = { at: 보기 좌표 mm, rel: 보기 범위 안 상대 위치 }. 다시 그릴 때 rel 로 옮긴 자리 → at 순서로
 * 가장 가까운 꼭짓점(지름 치수는 원 중심)을 허용 거리 안에서 찾는다. 모델 크기가 바뀌어 꼭짓점이 비례해 움직여도 따라가고,
 * 붙을 곳이 없으면 "연결 끊김"(ok = false, 저장된 자리로 그림).
 * 진짜 위상 이름(면·모서리 ID)이 아니라 위치로 다시 붙이는 방식이라, 모양이 크게 바뀌면 다른 꼭짓점에 붙을 수 있다.
 */
import type { DrawingAnchor, DrawingDim } from '../../cad/commandTypes';
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

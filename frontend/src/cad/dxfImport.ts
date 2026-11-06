/**
 * DXF 가져오기 (2D 도면 → 스케치): 다른 CAD·레이저 커터·일러스트 도구에서 내보낸 ASCII DXF 를 읽어
 * 보통의 스케치 명령(add_polygon·add_path·set_arc·add_circle·add_ellipse)으로 바꾼다. 저장 형식은 그대로.
 *
 * - 읽는 요소: LINE · ARC · CIRCLE · LWPOLYLINE · POLYLINE(VERTEX) · ELLIPSE · SPLINE (ENTITIES 섹션, 블록 삽입은 건너뜀)
 * - 끝점이 맞닿는 선·호는 이어 붙여, 닫히면 다각형(돌출 가능한 단면), 열려 있으면 경로. 호는 bulge 그대로 (DXF 와 같은 규칙)
 * - 단위: 헤더 $INSUNITS (인치·피트·cm·m → mm). 없으면 mm 로 본다
 * - 돌출 방향이 -Z 인 요소(OCS 뒤집힘)는 x 를 반전
 */
import type { CadCommand, ObjectId, Point2 } from './commandTypes';
import { LIMITS } from './commandTypes';
import { simplifyToLimit } from './simplify';

export interface DxfSeg {
  a: Point2;
  b: Point2;
  /** 0 = 직선, 양수 = a 에서 반시계로 도는 호 (|bulge| ≤ 1, 반원까지) */
  bulge: number;
}
export interface DxfShapes {
  segs: DxfSeg[];
  circles: { c: Point2; r: number }[];
  ellipses: { c: Point2; w: number; h: number; angle: number }[];
  /** 읽지 않은 요소 종류별 개수 (TEXT·INSERT·HATCH …) */
  skipped: Record<string, number>;
  /** mm 로 바꾼 배율 (1 = mm) */
  scale: number;
  unitLabel: string;
}

const UNITS: Record<number, [number, string]> = { 1: [25.4, '인치'], 2: [304.8, '피트'], 4: [1, 'mm'], 5: [10, 'cm'], 6: [1000, 'm'] };
const SUPPORTED = new Set(['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE', 'POLYLINE', 'ELLIPSE', 'SPLINE']);
const MAX_SEGS = 5000;

type Pair = [number, string];
interface RawEntity {
  type: string;
  codes: Pair[];
  vertices?: Pair[][];
}

function pairsOf(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    if (!Number.isInteger(code)) throw new Error(`DXF 형식이 아닙니다 (${i + 1}번째 줄)`);
    out.push([code, lines[i + 1]!.trim()]);
  }
  return out;
}

/** 요소의 첫 번째 code 값 (숫자) */
const num = (e: Pair[], code: number, d = 0) => {
  const p = e.find((x) => x[0] === code);
  return p ? Number(p[1]) : d;
};

/** 호(중심·반지름·시작/끝 각도 rad, 반시계)를 반원 이하 조각으로 */
function arcSegs(c: Point2, r: number, a0: number, sweep: number): DxfSeg[] {
  const n = Math.max(1, Math.ceil(sweep / Math.PI - 1e-9));
  const step = sweep / n;
  const at = (t: number): Point2 => [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
  return Array.from({ length: n }, (_, k) => ({ a: at(a0 + k * step), b: at(a0 + (k + 1) * step), bulge: Math.tan(step / 4) }));
}

/** B-스플라인 (de Boor) 위의 점 n 개 — 유리(무게) 포함 */
function sampleSpline(degree: number, knots: number[], ctrl: Point2[], weights: number[], n: number): Point2[] {
  const p = degree;
  if (ctrl.length <= p || knots.length !== ctrl.length + p + 1) return ctrl;
  const w = ctrl.map((_, i) => weights[i] ?? 1);
  const t0 = knots[p]!;
  const t1 = knots[ctrl.length]!;
  const out: Point2[] = [];
  for (let s = 0; s <= n; s++) {
    const t = s === n ? t1 : t0 + ((t1 - t0) * s) / n;
    let k = p;
    while (k < ctrl.length - 1 && t >= knots[k + 1]!) k++;
    const d = Array.from({ length: p + 1 }, (_, j) => {
      const q = ctrl[j + k - p]!;
      const wj = w[j + k - p]!;
      return [q[0] * wj, q[1] * wj, wj];
    });
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = j + k - p;
        const den = knots[i + p - r + 1]! - knots[i]!;
        const alpha = den === 0 ? 0 : (t - knots[i]!) / den;
        d[j] = d[j]!.map((v, m) => (1 - alpha) * d[j - 1]![m]! + alpha * v);
      }
    }
    const [x, y, ww] = d[p]!;
    out.push([x! / ww!, y! / ww!]);
  }
  return out;
}

/** ASCII DXF 를 2D 도형으로 읽는다 (mm) */
export function parseDxf(text: string): DxfShapes {
  const pairs = pairsOf(text);
  let section = '';
  let scale = 1;
  let unitLabel = 'mm';
  const entities: RawEntity[] = [];
  let cur: RawEntity | null = null;
  let poly: RawEntity | null = null; // POLYLINE … VERTEX … SEQEND
  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i]!;
    if (code === 0) {
      if (value === 'SECTION') {
        section = pairs[i + 1]?.[0] === 2 ? pairs[i + 1]![1] : '';
        cur = null;
        continue;
      }
      if (value === 'ENDSEC') {
        section = '';
        cur = null;
        continue;
      }
      if (section !== 'ENTITIES') continue;
      if (value === 'VERTEX' && poly) {
        cur = { type: 'VERTEX', codes: [] };
        poly.vertices!.push(cur.codes);
        continue;
      }
      if (value === 'SEQEND') {
        poly = null;
        cur = null;
        continue;
      }
      cur = { type: value, codes: [] };
      if (value === 'POLYLINE') {
        poly = cur;
        cur.vertices = [];
      }
      entities.push(cur);
      continue;
    }
    if (section === 'HEADER' && code === 9 && value === '$INSUNITS') {
      const u = UNITS[Number(pairs[i + 1]?.[1])];
      if (u) [scale, unitLabel] = u;
    }
    if (section === 'ENTITIES' && cur) cur.codes.push([code, value]);
  }

  const segs: DxfSeg[] = [];
  const circles: DxfShapes['circles'] = [];
  const ellipses: DxfShapes['ellipses'] = [];
  const skipped: Record<string, number> = {};
  const S = (p: Point2, flip: boolean): Point2 => [(flip ? -p[0] : p[0]) * scale, p[1] * scale];
  const addSegs = (list: DxfSeg[], flip: boolean) => {
    for (const s of list) {
      if (segs.length >= MAX_SEGS) return;
      const a = S(s.a, flip);
      const b = S(s.b, flip);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) continue;
      segs.push({ a, b, bulge: flip ? -s.bulge : s.bulge });
    }
  };
  const polySegs = (verts: { p: Point2; bulge: number }[], closed: boolean): DxfSeg[] => {
    const out: DxfSeg[] = [];
    const n = verts.length;
    for (let k = 0; k < (closed ? n : n - 1); k++) {
      const v = verts[k]!;
      const w = verts[(k + 1) % n]!;
      // |bulge| > 1 (반원 넘는 호) → 반으로 나눠 반원 이하로
      if (Math.abs(v.bulge) > 1) {
        const sweep = 4 * Math.atan(Math.abs(v.bulge));
        const chord = Math.hypot(w.p[0] - v.p[0], w.p[1] - v.p[1]);
        const r = chord / (2 * Math.sin(sweep / 2));
        const m: Point2 = [(v.p[0] + w.p[0]) / 2, (v.p[1] + w.p[1]) / 2];
        const nL: Point2 = [-(w.p[1] - v.p[1]) / chord, (w.p[0] - v.p[0]) / chord];
        const sgn = Math.sign(v.bulge);
        // 반시계 호(양수)는 현의 오른쪽으로 볼록 → 중심은 왼쪽으로 r·cos(θ/2) (반원 넘으면 음수 = 오른쪽)
        const c: Point2 = [m[0] + sgn * nL[0] * r * Math.cos(sweep / 2), m[1] + sgn * nL[1] * r * Math.cos(sweep / 2)];
        const mid: Point2 = [c[0] - sgn * nL[0] * r, c[1] - sgn * nL[1] * r];
        const hb = sgn * Math.tan(sweep / 8);
        out.push({ a: v.p, b: mid, bulge: hb }, { a: mid, b: w.p, bulge: hb });
      } else out.push({ a: v.p, b: w.p, bulge: v.bulge });
    }
    return out;
  };

  for (const e of entities) {
    if (!SUPPORTED.has(e.type)) {
      skipped[e.type] = (skipped[e.type] ?? 0) + 1;
      continue;
    }
    const c = e.codes;
    const flip = num(c, 230, 1) < 0;
    if (e.type === 'LINE') addSegs([{ a: [num(c, 10), num(c, 20)], b: [num(c, 11), num(c, 21)], bulge: 0 }], flip);
    else if (e.type === 'CIRCLE') {
      const r = num(c, 40) * scale;
      if (r > 0) circles.push({ c: S([num(c, 10), num(c, 20)], flip), r });
    } else if (e.type === 'ARC') {
      const a0 = (num(c, 50) * Math.PI) / 180;
      let sweep = ((num(c, 51) - num(c, 50)) % 360 + 360) % 360;
      if (sweep < 1e-9) sweep = 360;
      addSegs(arcSegs([num(c, 10), num(c, 20)], num(c, 40), a0, (sweep * Math.PI) / 180), flip);
    } else if (e.type === 'LWPOLYLINE') {
      const verts: { p: Point2; bulge: number }[] = [];
      for (const [k, v] of c) {
        if (k === 10) verts.push({ p: [Number(v), 0], bulge: 0 });
        else if (k === 20 && verts.length) verts[verts.length - 1]!.p[1] = Number(v);
        else if (k === 42 && verts.length) verts[verts.length - 1]!.bulge = Number(v);
      }
      if (verts.length >= 2) addSegs(polySegs(verts, (num(c, 70) & 1) === 1), flip);
    } else if (e.type === 'POLYLINE') {
      const flags = num(c, 70);
      if (flags & (16 | 64)) {
        skipped['POLYLINE(3D 메시)'] = (skipped['POLYLINE(3D 메시)'] ?? 0) + 1;
        continue;
      }
      const verts = (e.vertices ?? []).map((v) => ({ p: [num(v, 10), num(v, 20)] as Point2, bulge: num(v, 42) }));
      if (verts.length >= 2) addSegs(polySegs(verts, (flags & 1) === 1), flip);
    } else if (e.type === 'ELLIPSE') {
      const ctr: Point2 = [num(c, 10), num(c, 20)];
      const maj: Point2 = [num(c, 11), num(c, 21)];
      const ratio = num(c, 40, 1);
      const t0 = num(c, 41, 0);
      let t1 = num(c, 42, 2 * Math.PI);
      if (t1 <= t0) t1 += 2 * Math.PI;
      const a = Math.hypot(maj[0], maj[1]);
      if (a <= 0) continue;
      const ang = Math.atan2(maj[1], maj[0]);
      if (t1 - t0 >= 2 * Math.PI - 1e-6) {
        const cc = S(ctr, flip);
        const deg = (ang * 180) / Math.PI;
        ellipses.push({ c: cc, w: 2 * a * scale, h: 2 * a * ratio * scale, angle: Math.round((flip ? 180 - deg : deg) * 1e6) / 1e6 });
      } else {
        // 타원 호: 꺾은선으로 (조각 수는 각도에 비례)
        const n = Math.max(4, Math.ceil(((t1 - t0) / (2 * Math.PI)) * 32));
        const pt = (t: number): Point2 => {
          const x = a * Math.cos(t);
          const y = a * ratio * Math.sin(t);
          return [ctr[0] + x * Math.cos(ang) - y * Math.sin(ang), ctr[1] + x * Math.sin(ang) + y * Math.cos(ang)];
        };
        const pts = Array.from({ length: n + 1 }, (_, k) => pt(t0 + ((t1 - t0) * k) / n));
        addSegs(pts.slice(1).map((b, k) => ({ a: pts[k]!, b, bulge: 0 })), flip);
      }
    } else if (e.type === 'SPLINE') {
      const ctrl: Point2[] = [];
      const fit: Point2[] = [];
      const knots: number[] = [];
      const weights: number[] = [];
      for (const [k, v] of c) {
        if (k === 10) ctrl.push([Number(v), 0]);
        else if (k === 20 && ctrl.length) ctrl[ctrl.length - 1]![1] = Number(v);
        else if (k === 11) fit.push([Number(v), 0]);
        else if (k === 21 && fit.length) fit[fit.length - 1]![1] = Number(v);
        else if (k === 40) knots.push(Number(v));
        else if (k === 41) weights.push(Number(v));
      }
      const pts = ctrl.length >= 2 ? sampleSpline(num(c, 71, 3), knots, ctrl, weights, 24) : fit;
      if (pts.length >= 2) addSegs(pts.slice(1).map((b, k) => ({ a: pts[k]!, b, bulge: 0 })), flip);
    }
  }
  return { segs, circles, ellipses, skipped, scale, unitLabel };
}

const close = (p: Point2, q: Point2, tol: number) => Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol;
const rev = (s: DxfSeg): DxfSeg => ({ a: s.b, b: s.a, bulge: -s.bulge });

/** 끝점이 맞닿는 조각을 이어 사슬로. closed = 끝이 시작으로 돌아옴 */
export function chainSegments(segs: DxfSeg[], tol = 1e-3): { segs: DxfSeg[]; closed: boolean }[] {
  const used = new Array<boolean>(segs.length).fill(false);
  const out: { segs: DxfSeg[]; closed: boolean }[] = [];
  const take = (p: Point2): DxfSeg | null => {
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      const s = segs[i]!;
      if (close(s.a, p, tol)) return (used[i] = true), s;
      if (close(s.b, p, tol)) return (used[i] = true), rev(s);
    }
    return null;
  };
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const chain = [segs[i]!];
    for (let s = take(chain[chain.length - 1]!.b); s; s = close(chain[chain.length - 1]!.b, chain[0]!.a, tol) ? null : take(chain[chain.length - 1]!.b)) chain.push(s);
    const closedFwd = chain.length > 1 && close(chain[chain.length - 1]!.b, chain[0]!.a, tol);
    if (!closedFwd) for (let s = take(chain[0]!.a); s; s = take(chain[0]!.a)) chain.unshift(rev(s));
    const closed = (chain.length > 1 || Math.abs(chain[0]!.bulge) > 0) && close(chain[chain.length - 1]!.b, chain[0]!.a, tol);
    out.push({ segs: chain, closed });
  }
  return out;
}

/** 호 조각을 반으로 (닫힌 윤곽이 점 셋 미만일 때) */
function splitSeg(s: DxfSeg): [DxfSeg, DxfSeg] {
  const dx = s.b[0] - s.a[0];
  const dy = s.b[1] - s.a[1];
  const m: Point2 = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
  if (Math.abs(s.bulge) < 1e-12) return [{ a: s.a, b: m, bulge: 0 }, { a: m, b: s.b, bulge: 0 }];
  // 호 가운데: 현 가운데에서 오른쪽(반시계 호면 오른쪽으로 볼록) 수직으로 sagitta
  const sag = (s.bulge * Math.hypot(dx, dy)) / 2;
  const len = Math.hypot(dx, dy);
  const mid: Point2 = [m[0] + (dy / len) * sag, m[1] - (dx / len) * sag];
  const hb = Math.tan(Math.atan(s.bulge) / 2);
  return [{ a: s.a, b: mid, bulge: hb }, { a: mid, b: s.b, bulge: hb }];
}

/** 닫힌 사슬의 넓이 부호 (호 볼록분 포함, 양수 = 반시계) */
function signedArea(chain: DxfSeg[]): number {
  let a = 0;
  for (const s of chain) {
    a += (s.a[0] * s.b[1] - s.b[0] * s.a[1]) / 2;
    if (s.bulge) {
      const chord = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      const th = 4 * Math.atan(Math.abs(s.bulge));
      const r = chord / (2 * Math.sin(th / 2));
      a += Math.sign(s.bulge) * ((r * r) / 2) * (th - Math.sin(th));
    }
  }
  return a;
}

const round = (p: Point2): Point2 => [Math.round(p[0] * 1e6) / 1e6 + 0, Math.round(p[1] * 1e6) / 1e6 + 0];

export interface DxfImportResult {
  commands: CadCommand[];
  counts: { polygons: number; paths: number; circles: number; ellipses: number };
  warnings: string[];
}

/**
 * 읽은 도형 → 스케치 명령. taken = 스케치에 이미 있는 요소 ID (겹치지 않게, 이 함수가 채운다).
 * room = 더 넣을 수 있는 요소 수 (스케치 요소 한도)
 */
export function dxfSketchCommands(shapes: DxfShapes, sketch: ObjectId, taken: Set<string>, room: number = LIMITS.maxSketchEntities): DxfImportResult {
  const commands: CadCommand[] = [];
  const counts = { polygons: 0, paths: 0, circles: 0, ellipses: 0 };
  const warnings: string[] = [];
  const newId = (prefix: string) => {
    let n = 1;
    while (taken.has(`${prefix}${n}`)) n++;
    taken.add(`${prefix}${n}`);
    return `${prefix}${n}`;
  };
  let left = room;
  let dropped = 0;
  const minD = LIMITS.minDimension;
  const maxPts = LIMITS.maxPolygonPoints;

  const pushPoly = (chain: DxfSeg[], closed: boolean) => {
    if (left <= 0) return void dropped++;
    left--;
    const id = newId(closed ? 'poly' : 'path');
    const pts = closed ? chain.map((s) => round(s.a)) : [...chain.map((s) => round(s.a)), round(chain[chain.length - 1]!.b)];
    commands.push({ type: closed ? 'add_polygon' : 'add_path', sketch, id, points: pts } as CadCommand);
    chain.forEach((s, k) => {
      if (Math.abs(s.bulge) > 1e-9) commands.push({ type: 'set_arc', sketch, entity: id, edge: k, bulge: Math.max(-1, Math.min(1, Math.round(s.bulge * 1e9) / 1e9)) });
    });
    if (closed) counts.polygons++;
    else counts.paths++;
  };

  for (const { segs, closed } of chainSegments(shapes.segs)) {
    let chain = segs;
    if (closed) {
      if (signedArea(chain) < 0) chain = [...chain].reverse().map(rev);
      while (chain.length < 3) {
        const k = chain.reduce((best, s, i) => (Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) > Math.hypot(chain[best]!.b[0] - chain[best]!.a[0], chain[best]!.b[1] - chain[best]!.a[1]) ? i : best), 0);
        chain = [...chain.slice(0, k), ...splitSeg(chain[k]!), ...chain.slice(k + 1)];
      }
      if (chain.length > maxPts && chain.every((sg) => Math.abs(sg.bulge) < 1e-9)) {
        // 곡선을 잘게 꺾은 윤곽 (SVG 베지어·스플라인): 모양이 거의 같도록 점을 줄인다
        const pts = chain.map((sg) => sg.a);
        let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
        for (const [x, y] of pts) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
        const simple = simplifyToLimit(pts, maxPts, Math.max(x1 - x0, y1 - y0) * 0.001);
        if (simple.length >= 3) {
          chain = simple.map((a, k) => ({ a, b: simple[(k + 1) % simple.length]!, bulge: 0 }));
          warnings.push(`점이 많은 닫힌 윤곽은 ${maxPts}점 이하로 단순화했습니다`);
        }
      }
      if (chain.length <= maxPts) {
        pushPoly(chain, true);
        continue;
      }
      warnings.push(`점이 ${maxPts}개를 넘는 닫힌 윤곽은 열린 경로 여러 개로 나눴습니다 (돌출하려면 단순화가 필요합니다)`);
    }
    for (let k = 0; k < chain.length; k += maxPts - 1) pushPoly(chain.slice(k, k + maxPts - 1), false);
  }
  for (const c of shapes.circles) {
    if (2 * c.r < minD) continue;
    if (left <= 0) {
      dropped++;
      continue;
    }
    left--;
    commands.push({ type: 'add_circle', sketch, id: newId('c'), center: round(c.c), diameter: Math.round(2 * c.r * 1e6) / 1e6 });
    counts.circles++;
  }
  for (const e of shapes.ellipses) {
    if (e.h < minD || e.w < minD) continue;
    if (left <= 0) {
      dropped++;
      continue;
    }
    left--;
    commands.push({ type: 'add_ellipse', sketch, id: newId('ellipse'), center: round(e.c), width: Math.round(e.w * 1e6) / 1e6, height: Math.round(e.h * 1e6) / 1e6, angle: e.angle });
    counts.ellipses++;
  }
  if (dropped) warnings.push(`스케치 요소 한도(${LIMITS.maxSketchEntities}개)를 넘어 ${dropped}개는 넣지 못했습니다`);
  const sk = Object.entries(shapes.skipped);
  if (sk.length) warnings.push(`읽지 않은 요소: ${sk.map(([t, n]) => `${t} ${n}`).join(', ')}`);
  return { commands, counts, warnings: [...new Set(warnings)] };
}

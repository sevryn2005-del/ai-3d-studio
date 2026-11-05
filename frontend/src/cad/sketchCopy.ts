/**
 * 스케치 요소 대칭·패턴 복사 (솔리드웍스 Mirror Entities / Linear·Circular Sketch Pattern) — 순수 함수.
 * 결과는 보통의 요소 추가 명령들(add_rectangle, add_polygon …)이라 저장 형식이 바뀌지 않는다.
 * 대칭 축이 구성선·변이면 원본·복사본 점마다 대칭 구속을 붙여 원본을 고치면 복사본이 따라오게 할 수 있다(withRelations).
 */
import type { CadCommand, ObjectId, Point2, Sketch, SketchEntity } from './commandTypes';
import { dimensionValue } from './sketch';
import type { Relation } from './autoRelations';

export interface CopyXform {
  map: (p: Point2) => Point2;
  /** 방향(°) 변환: 슬롯·타원 각도 */
  angle: (deg: number) => number;
  /** 대칭이면 true → 다각형·경로 점 순서를 뒤집어 반시계 유지 */
  mirror: boolean;
  /** 사각형이 축 정렬을 유지하는지 (0 = 그대로, 90 = 폭·높이 바뀜, null = 다각형으로) */
  rectTurn: 0 | 90 | null;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
const rp = (p: Point2): Point2 => [r6(p[0]), r6(p[1])];
const normDeg = (a: number) => {
  let d = a % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return r6(d);
};

/** 직선 a–b 에 대한 대칭 */
export function mirrorXform(a: Point2, b: Point2): CopyXform {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const l2 = dx * dx + dy * dy;
  const axisDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const turn = Math.abs(dx) < 1e-12 || Math.abs(dy) < 1e-12 ? 0 : null; // 가로·세로 축이면 사각형 그대로
  return {
    map: ([x, y]) => {
      const t = ((x - a[0]) * dx + (y - a[1]) * dy) / l2;
      const fx = a[0] + t * dx;
      const fy = a[1] + t * dy;
      return rp([2 * fx - x, 2 * fy - y]);
    },
    angle: (deg) => normDeg(2 * axisDeg - deg),
    mirror: true,
    rectTurn: turn,
  };
}

export function translateXform(du: number, dv: number): CopyXform {
  return { map: ([x, y]) => rp([x + du, y + dv]), angle: (d) => normDeg(d), mirror: false, rectTurn: 0 };
}

export function rotateXform(center: Point2, deg: number): CopyXform {
  const a = (deg * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  const q = ((deg % 360) + 360) % 360;
  const turn = Math.abs(q % 90) < 1e-9 ? (q % 180 === 0 ? 0 : 90) : null;
  return {
    map: ([x, y]) => {
      const [px, py] = [x - center[0], y - center[1]];
      return rp([center[0] + px * c - py * s, center[1] + px * s + py * c]);
    },
    angle: (d) => normDeg(d + deg),
    mirror: false,
    rectTurn: turn,
  };
}

const PREFIX: Partial<Record<SketchEntity['type'], string>> = {
  rectangle: 'r', circle: 'c', polygon: 'poly', path: 'path', line: 'line', slot: 'slot', ellipse: 'ellipse',
};

/**
 * 요소들을 변환한 복사본 명령. taken = 이미 쓰는 요소 ID (새 ID 를 겹치지 않게, 이 함수가 채운다).
 * pairs = (원본 점, 복사본 점) — 대칭 구속용
 */
export function copyEntityCommands(sketch: Sketch, ids: ObjectId[], x: CopyXform, taken: Set<string>): { commands: CadCommand[]; pairs: [string, string][] } {
  const sid = sketch.id;
  const commands: CadCommand[] = [];
  const pairs: [string, string][] = [];
  const newId = (prefix: string) => {
    let n = 1;
    while (taken.has(`${prefix}${n}`)) n++;
    taken.add(`${prefix}${n}`);
    return `${prefix}${n}`;
  };
  for (const id of ids) {
    const e = sketch.entities.find((k) => k.id === id);
    if (!e || !PREFIX[e.type]) continue;
    const dim = (k: 'width' | 'height' | 'diameter' | 'length') => dimensionValue(sketch, e.id, k) ?? 0;
    if (e.type === 'rectangle') {
      const [w, h] = [dim('width'), dim('height')];
      if (x.rectTurn === null) {
        // 기울어진 결과: 네 모서리를 다각형으로
        const c = e.center;
        let pts: Point2[] = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([u, v]) => x.map([c[0] + u!, c[1] + v!]));
        if (x.mirror) pts = pts.reverse();
        commands.push({ type: 'add_polygon', sketch: sid, id: newId('poly'), points: pts });
      } else {
        const nid = newId('r');
        commands.push({ type: 'add_rectangle', sketch: sid, id: nid, center: x.map(e.center), width: x.rectTurn === 90 ? h : w, height: x.rectTurn === 90 ? w : h });
        pairs.push([`${e.id}.center`, `${nid}.center`]);
      }
    } else if (e.type === 'circle') {
      const nid = newId('c');
      commands.push({ type: 'add_circle', sketch: sid, id: nid, center: x.map(e.center), diameter: dim('diameter') });
      pairs.push([`${e.id}.center`, `${nid}.center`]);
    } else if (e.type === 'slot') {
      const nid = newId('slot');
      commands.push({ type: 'add_slot', sketch: sid, id: nid, center: x.map(e.center), length: dim('length'), width: dim('width'), angle: x.angle(e.angle) });
      pairs.push([`${e.id}.center`, `${nid}.center`]);
    } else if (e.type === 'ellipse') {
      const nid = newId('ellipse');
      commands.push({ type: 'add_ellipse', sketch: sid, id: nid, center: x.map(e.center), width: dim('width'), height: dim('height'), angle: x.angle(e.angle) });
      pairs.push([`${e.id}.center`, `${nid}.center`]);
    } else if (e.type === 'line') {
      const nid = newId('line');
      commands.push({ type: 'add_line', sketch: sid, id: nid, points: [x.map(e.points[0]), x.map(e.points[1])] });
      pairs.push([`${e.id}.p0`, `${nid}.p0`], [`${e.id}.p1`, `${nid}.p1`]);
    } else if (e.type === 'polygon' || e.type === 'path') {
      const n = e.points.length;
      const closed = e.type === 'polygon';
      const idx = (k: number) => (x.mirror ? n - 1 - k : k); // 원래 점 k → 새 번호
      const edgeIdx = (k: number) => (!x.mirror ? k : closed ? (((n - 2 - k) % n) + n) % n : n - 2 - k);
      const pts = e.points.map(x.map);
      const nid = newId(closed ? 'poly' : 'path');
      commands.push({ type: closed ? 'add_polygon' : 'add_path', sketch: sid, id: nid, points: x.mirror ? [...pts].reverse() : pts } as CadCommand);
      e.points.forEach((_, k) => pairs.push([`${e.id}.p${k}`, `${nid}.p${idx(k)}`]));
      for (const a of e.arcs ?? []) commands.push({ type: 'set_arc', sketch: sid, entity: nid, edge: edgeIdx(a.k), bulge: a.bulge });
      const groups = new Map<string, number[]>();
      for (const c of e.corners ?? []) groups.set(`${c.type}:${c.size}`, [...(groups.get(`${c.type}:${c.size}`) ?? []), idx(c.k)]);
      for (const [k, vertices] of groups) {
        const [type, size] = k.split(':');
        commands.push({ type: 'set_corner', sketch: sid, entity: nid, corner: type as 'fillet' | 'chamfer', size: Number(size), vertices });
      }
      if (e.spline) commands.push({ type: 'set_spline', sketch: sid, entity: nid, spline: true });
    }
  }
  return { commands, pairs };
}

/** 대칭 구속 (축이 구성선·변일 때): 원본·복사본 점 짝마다 [점, 점, 축] — 축 위에 있는 점(같은 자리)은 건너뜀 */
export function symmetricRelations(pairs: [string, string][], axisEdge: string): Relation[] {
  return pairs.map(([a, b]) => ({ constraint: 'symmetric' as const, refs: [a, b, axisEdge] }));
}

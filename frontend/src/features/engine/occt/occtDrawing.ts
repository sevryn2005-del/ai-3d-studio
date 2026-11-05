/**
 * 도면 투상 (숨은선 제거, OCCT HLRBRep_Algo) — 서버 app/cad/drawing.py 와 같은 호출·같은 규칙.
 * 보기 좌표계 gp_Ax2(원점, toward, right) 로 투상한 결과의 날카로운 모서리 + 윤곽선(실루엣)을 보이는 선·숨은선으로 나눈다.
 * 보이는 선은 서로 겹친 부분을, 숨은선은 보이는 선·다른 숨은선과 겹친 부분을 지운다 (features/drawing/clean.ts).
 * 매끈한 이음 모서리(필렛 접선 모서리)는 그리지 않는다 (솔리드웍스 기본 '접선 모서리 숨기기'와 같음).
 *
 * 단면도 (형식 v14): 정면도 = 평면 y = offset 앞쪽(y < offset)을, 우측면도 = 평면 x = offset 오른쪽(x > offset)을 걷어낸 뒤 투상.
 * 숨은선은 그리지 않고, 잘린 면(절단 평면 위의 평면)의 경계를 section 으로 돌려준다 (시트가 해칭).
 * 축선: 축이 보기 방향과 나란하지 않은 원통면의 축 (면 모서리 점이 축 위에 걸친 범위).
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { DrawingSection, ModelDefinition } from '../../../cad/commandTypes';
import { cleanHidden } from '../../drawing/clean';
import { cross, DRAWING_VIEWS } from '../../drawing/views';
import { GeometryError } from '../browser/geometry';
import type { DrawingCircle, DrawingView, DrawingViewName } from '../types';
import { boundsOf, Gc, occtWorldShapes, volumeOf, type OC } from './occtGeometry';

/** 곡선 표본 간격 (rad) — 서버 drawing.py 와 같음 */
const ARC_STEP = Math.PI / 48;
const SPLINE_SEGMENTS = 64;
type V3 = [number, number, number];

const round = (v: number) => Math.round(v * 1e6) / 1e6 + 0;

function edgeSamples(oc: OC, gc: Gc, e: unknown): { pts: V3[]; type: string; a: InstanceType<OC['BRepAdaptor_Curve']> } {
  const a = gc.k(new oc.BRepAdaptor_Curve(e as never));
  const t = a.GetType() as unknown as string;
  const u0 = a.FirstParameter();
  const u1 = a.LastParameter();
  const n = t === 'GeomAbs_Line' ? 1 : t === 'GeomAbs_Circle' ? Math.max(4, Math.ceil(Math.abs(u1 - u0) / ARC_STEP)) : SPLINE_SEGMENTS;
  const pts: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const p = gc.k(a.Value(u0 + ((u1 - u0) * i) / n));
    pts.push([p.X(), p.Y(), p.Z()]);
  }
  return { pts, type: t, a };
}

function edgesOf(oc: OC, gc: Gc, s: TopoDS_Shape) {
  const out = [];
  const ex = gc.k(new oc.TopExp_Explorer(s, 'TopAbs_EDGE' as never, 'TopAbs_SHAPE' as never));
  for (; ex.More(); ex.Next()) out.push(gc.k(oc.TopoDS.Edge(gc.k(ex.Current()))));
  return out;
}

function facesOf(oc: OC, gc: Gc, s: TopoDS_Shape) {
  const out = [];
  const ex = gc.k(new oc.TopExp_Explorer(s, 'TopAbs_FACE' as never, 'TopAbs_SHAPE' as never));
  for (; ex.More(); ex.Next()) out.push(gc.k(oc.TopoDS.Face(gc.k(ex.Current()))));
  return out;
}

/** HLR 결과 (보기 평면 z = 0 의 모서리) → 꺾은선 */
function polylines(oc: OC, gc: Gc, s: TopoDS_Shape | null, circles: DrawingCircle[] | null, visible: boolean): number[][] {
  if (!s || s.IsNull()) return [];
  oc.BRepLib.BuildCurves3d(s);
  const out: number[][] = [];
  for (const e of edgesOf(oc, gc, s)) {
    const { pts, type, a } = edgeSamples(oc, gc, e);
    const flat = pts.flatMap((p) => [round(p[0]), round(p[1])]);
    const span = Math.abs(a.LastParameter() - a.FirstParameter());
    if (flat.length >= 4 && Math.hypot(flat[flat.length - 2]! - flat[0]!, flat[flat.length - 1]! - flat[1]!) + span > 1e-9) out.push(flat);
    if (circles && type === 'GeomAbs_Circle') {
      const c = gc.k(a.Circle());
      const o = gc.k(c.Location());
      circles.push({ center: [round(o.X()), round(o.Y())], radius: round(c.Radius()), full: Math.abs(span - 2 * Math.PI) < 1e-6, visible });
    }
  }
  return out;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 단면: 걷어낼 쪽 상자 (모델 범위보다 1mm 크게). 아무것도 걷어내지 않으면 null */
function sectionBox(oc: OC, gc: Gc, B: number[], s: DrawingSection): TopoDS_Shape | null {
  const [x0, y0, z0, x1, y1, z1] = [B[0]! - 1, B[1]! - 1, B[2]! - 1, B[3]! + 1, B[4]! + 1, B[5]! + 1];
  const lo: V3 = s.view === 'front' ? [x0, y0, z0] : [s.offset, y0, z0];
  const hi: V3 = s.view === 'front' ? [x1, s.offset, z1] : [x1, y1, z1];
  if (hi[0] - lo[0] < 1e-9 || hi[1] - lo[1] < 1e-9) return null;
  return gc.k(gc.k(new oc.BRepPrimAPI_MakeBox(gc.k(new oc.gp_Pnt(...lo)), gc.k(new oc.gp_Pnt(...hi)))).Shape());
}

/** 잘린 면 (절단 평면 위의 평면) 경계 → 보기 좌표 꺾은선 */
function sectionLines(oc: OC, gc: Gc, s: TopoDS_Shape, sec: DrawingSection, project: (p: V3) => [number, number]): number[][] {
  const axis: V3 = sec.view === 'front' ? [0, 1, 0] : [1, 0, 0];
  const out: number[][] = [];
  for (const f of facesOf(oc, gc, s)) {
    const a = gc.k(new oc.BRepAdaptor_Surface(f, true));
    if ((a.GetType() as unknown as string) !== 'GeomAbs_Plane') continue;
    const ax = gc.k(gc.k(a.Plane()).Axis());
    const d = gc.k(ax.Direction());
    const o = gc.k(ax.Location());
    if (Math.abs(dot([d.X(), d.Y(), d.Z()], axis)) < 1 - 1e-9 || Math.abs(dot([o.X(), o.Y(), o.Z()], axis) - sec.offset) > 1e-6) continue;
    for (const e of edgesOf(oc, gc, f)) out.push(edgeSamples(oc, gc, e).pts.flatMap((p) => project(p).map(round)));
  }
  return out;
}

/** 원통면 축선 (보기 방향과 나란한 축은 빼고, 같은 축은 하나로) */
function cylinderAxes(oc: OC, gc: Gc, shapes: TopoDS_Shape[], toward: V3, project: (p: V3) => [number, number]): number[][] {
  const out: number[][] = [];
  for (const s of shapes)
    for (const f of facesOf(oc, gc, s)) {
      const a = gc.k(new oc.BRepAdaptor_Surface(f, true));
      if ((a.GetType() as unknown as string) !== 'GeomAbs_Cylinder') continue;
      const ax = gc.k(gc.k(a.Cylinder()).Axis());
      const dd = gc.k(ax.Direction());
      const oo = gc.k(ax.Location());
      const d: V3 = [dd.X(), dd.Y(), dd.Z()];
      const o: V3 = [oo.X(), oo.Y(), oo.Z()];
      if (Math.abs(dot(d, toward)) > 0.999) continue;
      let t0 = Infinity;
      let t1 = -Infinity;
      for (const e of edgesOf(oc, gc, f))
        for (const p of edgeSamples(oc, gc, e).pts) {
          const t = dot([p[0] - o[0], p[1] - o[1], p[2] - o[2]], d);
          t0 = Math.min(t0, t);
          t1 = Math.max(t1, t);
        }
      if (!(t1 - t0 > 1e-6)) continue;
      const seg = [...project([o[0] + d[0] * t0, o[1] + d[1] * t0, o[2] + d[2] * t0]), ...project([o[0] + d[0] * t1, o[1] + d[1] * t1, o[2] + d[2] * t1])].map(round);
      if (Math.hypot(seg[2]! - seg[0]!, seg[3]! - seg[1]!) < 1e-6) continue;
      const same = (q: number[]) =>
        (Math.hypot(q[0]! - seg[0]!, q[1]! - seg[1]!) < 1e-4 && Math.hypot(q[2]! - seg[2]!, q[3]! - seg[3]!) < 1e-4) ||
        (Math.hypot(q[0]! - seg[2]!, q[1]! - seg[3]!) < 1e-4 && Math.hypot(q[2]! - seg[0]!, q[3]! - seg[1]!) < 1e-4);
      if (!out.some(same)) out.push(seg);
    }
  return out;
}

/** 보기마다 투상: 보이는 객체(숨김·억제 제외)를 한꺼번에 (서로 가리는 선도 숨은선으로) */
export function occtDrawing(oc: OC, model: ModelDefinition, views: readonly DrawingViewName[], section?: DrawingSection): DrawingView[] {
  const gc = new Gc();
  try {
    const shapes = occtWorldShapes(oc, model, gc, true).map((s) => s.shape);
    if (shapes.length === 0) throw new GeometryError('도면에 그릴 객체가 없습니다');
    const B = shapes.map((s) => boundsOf(oc, s)).reduce((a, b) => [0, 1, 2].map((k) => Math.min(a[k]!, b[k]!)).concat([3, 4, 5].map((k) => Math.max(a[k]!, b[k]!))));
    return views.map((name) => {
      const { toward, right } = DRAWING_VIEWS[name];
      const up = cross(toward, right);
      const project = (p: V3): [number, number] => [dot(p, right), dot(p, up)];
      const sec = section && section.view === name ? section : undefined;
      let viewShapes = shapes;
      if (sec) {
        const box = sectionBox(oc, gc, B, sec);
        if (box) viewShapes = shapes.map((s) => gc.k(gc.k(new oc.BRepAlgoAPI_Cut(s, box, gc.k(new oc.Message_ProgressRange()))).Shape())).filter((s) => volumeOf(oc, s) > 1e-9);
        if (!viewShapes.length) throw new GeometryError('단면 위치가 형상 밖입니다 (자른 뒤 남는 것이 없음)');
      }
      const algo = gc.k(new oc.HLRBRep_Algo());
      for (const s of viewShapes) algo.Add(s, 0);
      const ax = gc.k(new oc.gp_Ax2(gc.k(new oc.gp_Pnt(0, 0, 0)), gc.k(new oc.gp_Dir(...toward)), gc.k(new oc.gp_Dir(...right))));
      algo.Projector(gc.k(new oc.HLRAlgo_Projector(ax)));
      algo.Update();
      algo.Hide();
      const res = gc.k(new oc.HLRBRep_HLRToShape(algo));
      const circles: DrawingCircle[] = [];
      const visible = cleanHidden([], [...polylines(oc, gc, gc.k(res.VCompound()), circles, true), ...polylines(oc, gc, gc.k(res.OutLineVCompound()), circles, true)]);
      const hidden = sec ? [] : cleanHidden(visible, [...polylines(oc, gc, gc.k(res.HCompound()), circles, false), ...polylines(oc, gc, gc.k(res.OutLineHCompound()), circles, false)]);
      const view: DrawingView = {
        name,
        visible,
        hidden,
        circles: dedupeCircles(sec ? circles.filter((c) => c.visible) : circles),
        axes: cylinderAxes(oc, gc, viewShapes, toward, project),
        bounds: linesBounds(visible),
      };
      if (sec) view.section = viewShapes.flatMap((s) => sectionLines(oc, gc, s, sec, project));
      return view;
    });
  } finally {
    gc.dispose();
  }
}

export function linesBounds(lines: number[][]): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const l of lines)
    for (let i = 0; i + 1 < l.length; i += 2) {
      x0 = Math.min(x0, l[i]!);
      x1 = Math.max(x1, l[i]!);
      y0 = Math.min(y0, l[i + 1]!);
      y1 = Math.max(y1, l[i + 1]!);
    }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}

/** 같은 원이 여러 조각(이음선으로 나뉜 반원 둘)으로 나오면 하나로: 보이는 쪽 우선, 조각이 모이면 온전한 원 */
export function dedupeCircles(cs: DrawingCircle[]): DrawingCircle[] {
  const out: (DrawingCircle & { arcs: number })[] = [];
  for (const c of cs) {
    const same = out.find((o) => Math.hypot(o.center[0] - c.center[0], o.center[1] - c.center[1]) < 1e-4 && Math.abs(o.radius - c.radius) < 1e-4);
    if (!same) out.push({ ...c, arcs: 1 });
    else {
      same.arcs++;
      same.visible ||= c.visible;
      same.full ||= c.full || same.arcs >= 2;
    }
  }
  return out.map(({ arcs: _arcs, ...c }) => c);
}

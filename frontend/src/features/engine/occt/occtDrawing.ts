/**
 * 도면 투상 (숨은선 제거, OCCT HLRBRep_Algo) — 서버 app/cad/drawing.py 와 같은 호출·같은 규칙.
 * 보기 좌표계 gp_Ax2(원점, toward, right) 로 투상한 결과의 날카로운 모서리 + 윤곽선(실루엣)을 보이는 선·숨은선으로 나눈다.
 * 숨은선은 보이는 선·다른 숨은선과 겹치는 부분을 지운다 (features/drawing/clean.ts).
 * 매끈한 이음 모서리(필렛 접선 모서리)는 그리지 않는다 (솔리드웍스 기본 '접선 모서리 숨기기'와 같음).
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { ModelDefinition } from '../../../cad/commandTypes';
import { cleanHidden } from '../../drawing/clean';
import { DRAWING_VIEWS } from '../../drawing/views';
import { GeometryError } from '../browser/geometry';
import type { DrawingCircle, DrawingView, DrawingViewName } from '../types';
import { Gc, occtWorldShapes, type OC } from './occtGeometry';

/** 곡선 표본 간격 (rad) — 서버 drawing.py 와 같음 */
const ARC_STEP = Math.PI / 48;
const SPLINE_SEGMENTS = 64;

function polylines(oc: OC, gc: Gc, s: TopoDS_Shape | null, circles: DrawingCircle[] | null, visible: boolean): number[][] {
  if (!s || s.IsNull()) return [];
  oc.BRepLib.BuildCurves3d(s);
  const out: number[][] = [];
  const ex = gc.k(new oc.TopExp_Explorer(s, 'TopAbs_EDGE' as never, 'TopAbs_SHAPE' as never));
  for (; ex.More(); ex.Next()) {
    const e = gc.k(oc.TopoDS.Edge(gc.k(ex.Current())));
    const a = gc.k(new oc.BRepAdaptor_Curve(e));
    const t = a.GetType() as unknown as string;
    const u0 = a.FirstParameter();
    const u1 = a.LastParameter();
    const n = t === 'GeomAbs_Line' ? 1 : t === 'GeomAbs_Circle' ? Math.max(4, Math.ceil(Math.abs(u1 - u0) / ARC_STEP)) : SPLINE_SEGMENTS;
    const pts: number[] = [];
    for (let i = 0; i <= n; i++) {
      const p = gc.k(a.Value(u0 + ((u1 - u0) * i) / n));
      pts.push(round(p.X()), round(p.Y()));
    }
    if (pts.length >= 4 && Math.hypot(pts[pts.length - 2]! - pts[0]!, pts[pts.length - 1]! - pts[1]!) + Math.abs(u1 - u0) > 1e-9) out.push(pts);
    if (circles && t === 'GeomAbs_Circle') {
      const c = gc.k(a.Circle());
      const o = gc.k(c.Location());
      circles.push({ center: [round(o.X()), round(o.Y())], radius: round(c.Radius()), full: Math.abs(Math.abs(u1 - u0) - 2 * Math.PI) < 1e-6, visible });
    }
  }
  return out;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6 + 0;

/** 보기마다 투상: 보이는 객체(숨김·억제 제외)를 한꺼번에 (서로 가리는 선도 숨은선으로) */
export function occtDrawing(oc: OC, model: ModelDefinition, views: readonly DrawingViewName[]): DrawingView[] {
  const gc = new Gc();
  try {
    const shapes = occtWorldShapes(oc, model, gc, true);
    if (shapes.length === 0) throw new GeometryError('도면에 그릴 객체가 없습니다');
    return views.map((name) => {
      const { toward, right } = DRAWING_VIEWS[name];
      const algo = gc.k(new oc.HLRBRep_Algo());
      for (const { shape } of shapes) algo.Add(shape, 0);
      const ax = gc.k(new oc.gp_Ax2(gc.k(new oc.gp_Pnt(0, 0, 0)), gc.k(new oc.gp_Dir(...toward)), gc.k(new oc.gp_Dir(...right))));
      algo.Projector(gc.k(new oc.HLRAlgo_Projector(ax)));
      algo.Update();
      algo.Hide();
      const res = gc.k(new oc.HLRBRep_HLRToShape(algo));
      const circles: DrawingCircle[] = [];
      const visible = [...polylines(oc, gc, gc.k(res.VCompound()), circles, true), ...polylines(oc, gc, gc.k(res.OutLineVCompound()), circles, true)];
      const hidden = [...polylines(oc, gc, gc.k(res.HCompound()), circles, false), ...polylines(oc, gc, gc.k(res.OutLineHCompound()), circles, false)];
      return { name, visible, hidden: cleanHidden(visible, hidden), circles: dedupeCircles(circles), bounds: boundsOf(visible) };
    });
  } finally {
    gc.dispose();
  }
}

export function boundsOf(lines: number[][]): [number, number, number, number] {
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

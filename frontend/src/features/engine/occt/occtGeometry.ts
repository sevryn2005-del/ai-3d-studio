/**
 * 브라우저 정밀 엔진 (형식 v9): OpenCascade(OCCT) WASM — replicad-opencascadejs (LGPL-2.1).
 *
 * 서버 backend/app/cad/primitives.py (CadQuery = 같은 OCCT) 를 그대로 옮긴 B-rep 계산이다.
 * manifold(메시) 엔진으로는 정확히 만들 수 없는 임의 모서리 필렛·모따기, 구배, STEP 가져오기·내보내기를 웹에서 처리한다.
 * 워커는 이런 피처가 들어 있는 최상위 객체만 이 엔진으로 계산하고, 나머지는 빠른 manifold 엔진을 그대로 쓴다.
 *
 * 규칙 (서버와 같음)
 * - 모서리 선택 규칙(all·vertical·top·bottom)과 구배 면은 감싸는 피처의 좌표계(= 원본에 원본 변환을 적용한 뒤)에서 고른다.
 * - 구배: 중립면 = 바닥(z 최소), 당김 방향 = +Z. 양수 각도는 위로 갈수록 재료가 좁아진다(빼기 쉬운 방향).
 * - STEP: 파일 좌표를 바운딩 박스 바닥면 중심이 원점이 되도록 옮긴다 (가져온 메시와 같은 원점 규칙).
 *
 * 메모리: OCCT 객체는 WASM 메모리에 있으므로 Gc 가 모아서 해제한다 (manifold 엔진의 Scope 와 같은 원칙).
 */
import type { OpenCascadeInstance, TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from 'replicad-opencascadejs';
import { Matrix4, Vector3 } from 'three';
import type { CadObject, EdgeRule, ModelDefinition, ObjectId, Sketch } from '../../../cad/commandTypes';
import { byId, sketchIndex, topLevelObjects } from '../../../cad/modelGraph';
import { resolveProfile, revolveProfileError, type Profile } from '../../../cad/sketch';
import { extrudeLocalMatrix, sketchLocalMatrix } from '../../../cad/sketchPlane';
import { helixError, helixProfilePoints, helixRings, loftSegments, sectionPoints } from '../../../cad/sections';
import { decodeMesh, fromBase64 } from '../../../cad/meshData';
import { toMatrix } from '../../../cad/transformMath';
import { isSuppressed, patternMatrices } from '../../../cad/features';
import { DISPLAY_TOLERANCE, EXPORT_TOLERANCE, GeometryError, type PlainMesh } from '../browser/geometry';

export type OC = OpenCascadeInstance;

/** 화면·출력 각도 허용 오차 (서버 DISPLAY/EXPORT_ANGULAR_TOLERANCE 와 같음) */
export const DISPLAY_ANGULAR = 0.2;
export const EXPORT_ANGULAR = 0.1;
/** 헬릭스·로프트 단면 분할 = 서버 HELIX_TOLERANCE */
const SECTION_TOLERANCE = 0.01;
/** 서버 MAX_SERVER_MESH_TRIANGLES 와 같음: 삼각형마다 면을 꿰매므로 느리다 */
export const MAX_OCCT_MESH_TRIANGLES = 20_000;
const EPS = 1e-4;

const OPERATION_LABEL = { cut: '빼기', union: '합치기', intersect: '교차' } as const;

type Deletable = { delete(): void };

/** 만든 OCCT 객체를 모아 한 번에 해제한다 */
export class Gc {
  private items: Deletable[] = [];
  k<T>(x: T): T {
    this.items.push(x as unknown as Deletable);
    return x;
  }
  dispose() {
    for (const x of this.items.reverse()) {
      try {
        x.delete();
      } catch {
        // 이미 해제된 객체
      }
    }
    this.items = [];
  }
}

/** STEP 파싱은 느리므로 최근 몇 개를 보관한다 (데이터 문자열 → 원점 맞춘 형상) */
const stepCache = new Map<string, TopoDS_Shape>();
const STEP_CACHE_SIZE = 4;

interface Ctx {
  oc: OC;
  gc: Gc;
  index: Map<ObjectId, CadObject>;
  sketches: Map<ObjectId, Sketch>;
}

const modelOf = (c: Ctx): ModelDefinition => ({ schemaVersion: 9, units: 'mm', objects: [...c.index.values()], sketches: [...c.sketches.values()] });

const progress = (c: Ctx) => c.gc.k(new c.oc.Message_ProgressRange());
const pnt = (c: Ctx, x: number, y: number, z: number) => c.gc.k(new c.oc.gp_Pnt(x, y, z));
const dir = (c: Ctx, x: number, y: number, z: number) => c.gc.k(new c.oc.gp_Dir(x, y, z));
const axis2 = (c: Ctx, o: [number, number, number] = [0, 0, 0], n: [number, number, number] = [0, 0, 1]) =>
  c.gc.k(new c.oc.gp_Ax2(pnt(c, ...o), dir(c, ...n)));

export function volumeOf(oc: OC, s: TopoDS_Shape): number {
  const p = new oc.GProp_GProps();
  try {
    oc.BRepGProp.VolumeProperties(s, p, false, false, false);
    return p.Mass();
  } finally {
    p.delete();
  }
}

/** [xmin, ymin, zmin, xmax, ymax, zmax] — 정확한 곡선·곡면 기준 */
export function boundsOf(oc: OC, s: TopoDS_Shape): number[] {
  const b = new oc.Bnd_Box();
  try {
    oc.BRepBndLib.AddOptimal(s, b, false, false);
    const lo = b.CornerMin();
    const hi = b.CornerMax();
    const out = [lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z()];
    lo.delete();
    hi.delete();
    return out;
  } finally {
    b.delete();
  }
}

function isValid(c: Ctx, s: TopoDS_Shape): boolean {
  return c.gc.k(new c.oc.BRepCheck_Analyzer(s, true, false)).IsValid();
}

function solidCount(c: Ctx, s: TopoDS_Shape): number {
  const ex = c.gc.k(new c.oc.TopExp_Explorer(s, 'TopAbs_SOLID' as never, 'TopAbs_SHAPE' as never));
  let n = 0;
  for (; ex.More(); ex.Next()) n++;
  return n;
}

/** three.js 행렬(열 우선) → gp_Trsf. 강체 + 균일 배율 + 반사만 가능 */
function trsfOf(c: Ctx, m: Matrix4): InstanceType<OC['gp_Trsf']> {
  const e = m.elements;
  const t = c.gc.k(new c.oc.gp_Trsf());
  t.SetValues(e[0]!, e[4]!, e[8]!, e[12]!, e[1]!, e[5]!, e[9]!, e[13]!, e[2]!, e[6]!, e[10]!, e[14]!);
  return t;
}

/** 3×3 부분이 (반사 포함) 균일 배율 × 직교 행렬인가 */
function isConformal(m: Matrix4): boolean {
  const e = m.elements;
  const cols = [0, 4, 8].map((i) => new Vector3(e[i], e[i + 1], e[i + 2]));
  const l = cols.map((v) => v.length());
  const s = l[0]!;
  if (s < 1e-12 || l.some((x) => Math.abs(x - s) > 1e-9 * Math.max(1, s))) return false;
  return Math.abs(cols[0]!.dot(cols[1]!)) < 1e-9 * s * s && Math.abs(cols[0]!.dot(cols[2]!)) < 1e-9 * s * s && Math.abs(cols[1]!.dot(cols[2]!)) < 1e-9 * s * s;
}

function transformed(c: Ctx, s: TopoDS_Shape, m: Matrix4, name: string): TopoDS_Shape {
  if (isConformal(m)) return c.gc.k(c.gc.k(new c.oc.BRepBuilderAPI_Transform(s, trsfOf(c, m), true, false)).Shape());
  // 비균일 배율: 이 OCCT 빌드에는 BRepBuilderAPI_GTransform 이 없다 → 출력 정밀도 메시로 바꿔 늘인 뒤 다시 꿰맨다
  const mesh = tessellate(c.oc, s, EXPORT_TOLERANCE, EXPORT_ANGULAR);
  const v = new Vector3();
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    v.set(p[i]!, p[i + 1]!, p[i + 2]!).applyMatrix4(m);
    p[i] = v.x;
    p[i + 1] = v.y;
    p[i + 2] = v.z;
  }
  return sewMesh(c, p, mesh.indices, name, Infinity);
}

function polygonWire(c: Ctx, pts: [number, number, number][]) {
  const mw = c.gc.k(new c.oc.BRepBuilderAPI_MakeWire());
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9) continue;
    mw.Add(c.gc.k(c.gc.k(new c.oc.BRepBuilderAPI_MakeEdge(pnt(c, ...a), pnt(c, ...b))).Edge()));
  }
  return c.gc.k(mw.Wire());
}

function faceOf(c: Ctx, wire: ReturnType<typeof polygonWire>): TopoDS_Face {
  const mf = c.gc.k(new c.oc.BRepBuilderAPI_MakeFace(wire, true));
  if (!mf.IsDone()) throw new GeometryError('단면을 만들 수 없습니다');
  return c.gc.k(mf.Face());
}

/** 평면 좌표(u, v) 단면 — CadQuery rect·circle·polyline·slot2D 와 같은 윤곽 */
function profileFace(c: Ctx, p: Profile): TopoDS_Face {
  if (p.type === 'polygon') return faceOf(c, polygonWire(c, p.points.map(([u, v]) => [u, v, 0])));
  const [cx, cy] = p.center;
  if (p.type === 'rectangle') {
    const w = p.width / 2;
    const h = p.height / 2;
    return faceOf(c, polygonWire(c, [[cx - w, cy - h, 0], [cx + w, cy - h, 0], [cx + w, cy + h, 0], [cx - w, cy + h, 0]]));
  }
  if (p.type === 'circle') {
    const circ = c.gc.k(new c.oc.gp_Circ(axis2(c, [cx, cy, 0]), p.diameter / 2));
    const edge = c.gc.k(c.gc.k(new c.oc.BRepBuilderAPI_MakeEdge(circ)).Edge());
    const mw = c.gc.k(new c.oc.BRepBuilderAPI_MakeWire(edge));
    return faceOf(c, c.gc.k(mw.Wire()));
  }
  // 슬롯: 두 직선 + 두 반원(반시계). 반원 중심 거리 = length, 폭 = width
  const a = (p.angle * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const at = (x: number, y: number) => pnt(c, cx + x * ca - y * sa, cy + x * sa + y * ca, 0);
  const L = p.length / 2;
  const r = p.width / 2;
  const mw = c.gc.k(new c.oc.BRepBuilderAPI_MakeWire());
  const line = (x0: number, y0: number, x1: number, y1: number) =>
    mw.Add(c.gc.k(c.gc.k(new c.oc.BRepBuilderAPI_MakeEdge(at(x0, y0), at(x1, y1))).Edge()));
  const arc = (x: number, y0: number, y1: number) => {
    const ctr = at(x, 0);
    const circ = c.gc.k(new c.oc.gp_Circ(axis2(c, [ctr.X(), ctr.Y(), 0]), r));
    mw.Add(c.gc.k(c.gc.k(new c.oc.BRepBuilderAPI_MakeEdge(circ, at(x, y0), at(x, y1))).Edge()));
  };
  line(-L, -r, L, -r);
  arc(L, -r, r);
  line(L, r, -L, r);
  arc(-L, r, -r);
  return faceOf(c, c.gc.k(mw.Wire()));
}

function prism(c: Ctx, s: TopoDS_Shape, dz: number): TopoDS_Shape {
  return c.gc.k(c.gc.k(new c.oc.BRepPrimAPI_MakePrism(s, c.gc.k(new c.oc.gp_Vec(0, 0, dz)), false, true)).Shape());
}

function moved(c: Ctx, s: TopoDS_Shape, x: number, y: number, z: number): TopoDS_Shape {
  return transformed(c, s, new Matrix4().makeTranslation(x, y, z), '');
}

const cut = (c: Ctx, a: TopoDS_Shape, b: TopoDS_Shape) => c.gc.k(c.gc.k(new c.oc.BRepAlgoAPI_Cut(a, b, progress(c))).Shape());
const fuse = (c: Ctx, a: TopoDS_Shape, b: TopoDS_Shape) => c.gc.k(c.gc.k(new c.oc.BRepAlgoAPI_Fuse(a, b, progress(c))).Shape());
const common = (c: Ctx, a: TopoDS_Shape, b: TopoDS_Shape) => c.gc.k(c.gc.k(new c.oc.BRepAlgoAPI_Common(a, b, progress(c))).Shape());

/** 같은 평면·곡면으로 나뉜 면과 경계선을 합친다 (CadQuery clean() 과 같음) */
function clean(c: Ctx, s: TopoDS_Shape): TopoDS_Shape {
  const u = c.gc.k(new c.oc.ShapeUpgrade_UnifySameDomain(s, true, true, false));
  u.Build();
  return c.gc.k(u.Shape());
}

const box = (c: Ctx, x0: number, y0: number, z0: number, w: number, d: number, h: number) =>
  c.gc.k(c.gc.k(new c.oc.BRepPrimAPI_MakeBox(pnt(c, x0, y0, z0), w, d, h)).Shape());
const cylinder = (c: Ctx, r: number, h: number, z0 = 0) =>
  c.gc.k(c.gc.k(new c.oc.BRepPrimAPI_MakeCylinder(axis2(c, [0, 0, z0]), r, h)).Shape());

/** 원뿔대: 이 빌드에는 MakeCone 이 없어 (0,0)–(r1,0)–(r2,h)–(0,h) 단면을 Z 축 둘레로 회전 */
function cone(c: Ctx, r1: number, r2: number, h: number, z0 = 0): TopoDS_Shape {
  if (Math.abs(r1 - r2) < 1e-9) return cylinder(c, r1, h, z0);
  const pts: [number, number, number][] = [[0, 0, z0], [r1, 0, z0], [r2, 0, z0 + h], [0, 0, z0 + h]].filter(
    (q, i, all) => i === 0 || Math.hypot(q[0]! - all[i - 1]![0]!, q[2]! - all[i - 1]![2]!) > 1e-9,
  ) as [number, number, number][];
  const face = faceOf(c, polygonWire(c, pts));
  const ax = c.gc.k(new c.oc.gp_Ax1(pnt(c, 0, 0, 0), dir(c, 0, 0, 1)));
  return c.gc.k(c.gc.k(new c.oc.BRepPrimAPI_MakeRevol(face, ax, 2 * Math.PI, false)).Shape());
}

/** 단면 고리들을 직선(룰드) 면으로 잇기 — 서버 _ring_solid 와 같음 */
function ringSolid(c: Ctx, rings: [number, number, number][][], name: string): TopoDS_Shape {
  const ts = c.gc.k(new c.oc.BRepOffsetAPI_ThruSections(true, true, 1e-6));
  for (const r of rings) ts.AddWire(polygonWire(c, r));
  let s: TopoDS_Shape;
  try {
    ts.Build(progress(c));
    if (!ts.IsDone()) throw new Error('loft');
    s = c.gc.k(ts.Shape());
  } catch {
    throw new GeometryError(`'${name}': 단면을 이을 수 없습니다 (단면이 겹치거나 꼬였습니다)`);
  }
  return volumeOf(c.oc, s) < 0 ? c.gc.k(s.Reversed()) : s;
}

/** 삼각형 메시를 꿰매 솔리드로 — 서버 mesh_import.mesh_solid 와 같음 */
function sewMesh(c: Ctx, v: ArrayLike<number>, t: ArrayLike<number>, name: string, maxTriangles = MAX_OCCT_MESH_TRIANGLES): TopoDS_Shape {
  if (t.length / 3 > maxTriangles)
    throw new GeometryError(`'${name}': 정밀 엔진은 삼각형 ${maxTriangles.toLocaleString()}개까지 가져온 메시를 다룹니다. 메시를 줄이세요`);
  const sew = c.gc.k(new c.oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false));
  const P = (i: number): [number, number, number] => [v[i * 3]!, v[i * 3 + 1]!, v[i * 3 + 2]!];
  for (let i = 0; i < t.length; i += 3) {
    const a = P(t[i]!);
    const b = P(t[i + 1]!);
    const d = P(t[i + 2]!);
    const n = new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).cross(new Vector3(d[0] - a[0], d[1] - a[1], d[2] - a[2]));
    if (n.length() < 1e-12) continue; // 넓이 0 삼각형
    const mf = c.gc.k(new c.oc.BRepBuilderAPI_MakeFace(polygonWire(c, [a, b, d]), true));
    if (mf.IsDone()) sew.Add(c.gc.k(mf.Face()));
  }
  sew.Perform(progress(c));
  const sewed = c.gc.k(sew.SewedShape());
  if (sewed.ShapeType() !== ('TopAbs_SHELL' as never)) throw new GeometryError(`'${name}': 가져온 메시가 닫혀 있지 않습니다 (구멍·떨어진 모서리)`);
  const solid = c.gc.k(c.gc.k(new c.oc.BRepBuilderAPI_MakeSolid(c.oc.TopoDS.Shell(sewed))).Solid());
  const fix = c.gc.k(new c.oc.ShapeFix_Solid(solid));
  fix.Perform(progress(c));
  const out = c.gc.k(fix.Solid());
  if (volumeOf(c.oc, out) <= 0) throw new GeometryError(`'${name}': 가져온 메시의 안팎(면 방향)이 뒤집혀 있습니다`);
  return out;
}

// ── 모서리·면 선택 (서버 app/cad/precise.py 와 같은 규칙) ──────────────────────────────

function explore<T>(c: Ctx, s: TopoDS_Shape, kind: 'TopAbs_EDGE' | 'TopAbs_FACE', cast: (x: TopoDS_Shape) => T): T[] {
  const ex = c.gc.k(new c.oc.TopExp_Explorer(s, kind as never, 'TopAbs_SHAPE' as never));
  const out: T[] = [];
  for (; ex.More(); ex.Next()) out.push(c.gc.k(cast(c.gc.k(ex.Current()))));
  return out;
}

/** 규칙에 맞는 모서리 (중복·이음선·퇴화 모서리 제외) */
export function selectEdges(oc: OC, gc: Gc, s: TopoDS_Shape, rule: EdgeRule): TopoDS_Edge[] {
  const c = { oc, gc } as Ctx;
  const [, , zmin, , , zmax] = boundsOf(oc, s);
  const skip: TopoDS_Edge[] = []; // 원통 이음선처럼 한 면에 두 번 붙은 모서리는 필렛할 수 없다
  for (const f of explore(c, s, 'TopAbs_FACE', (x) => oc.TopoDS.Face(x)))
    for (const e of explore(c, f, 'TopAbs_EDGE', (x) => oc.TopoDS.Edge(x))) if (oc.BRep_Tool.IsClosed(e, f)) skip.push(e);
  const kept: TopoDS_Edge[] = [];
  for (const e of explore(c, s, 'TopAbs_EDGE', (x) => oc.TopoDS.Edge(x))) {
    if (oc.BRep_Tool.Degenerated(e) || skip.some((x) => x.IsSame(e)) || kept.some((x) => x.IsSame(e))) continue;
    const [x0, y0, z0, x1, y1, z1] = boundsOf(oc, e);
    const ok =
      rule === 'all' ? true
      : rule === 'top' ? Math.abs(z0! - zmax!) < EPS && Math.abs(z1! - zmax!) < EPS
      : rule === 'bottom' ? Math.abs(z0! - zmin!) < EPS && Math.abs(z1! - zmin!) < EPS
      : x1! - x0! < EPS && y1! - y0! < EPS && z1! - z0! > EPS;
    if (ok) kept.push(e);
  }
  return kept;
}

/** 구배할 면: 옆면(법선이 수평인 평면, 축이 Z 와 평행한 원통면) */
export function draftFaces(oc: OC, gc: Gc, s: TopoDS_Shape): TopoDS_Face[] {
  const c = { oc, gc } as Ctx;
  return explore(c, s, 'TopAbs_FACE', (x) => oc.TopoDS.Face(x)).filter((f) => {
    const a = gc.k(new oc.BRepAdaptor_Surface(f, true));
    const t = a.GetType() as unknown as string;
    if (t === 'GeomAbs_Plane') {
      const n = gc.k(gc.k(gc.k(a.Plane()).Axis()).Direction());
      return Math.abs(n.Z()) < 1e-9;
    }
    if (t === 'GeomAbs_Cylinder') {
      const d = gc.k(gc.k(gc.k(a.Cylinder()).Axis()).Direction());
      return Math.abs(d.X()) < 1e-9 && Math.abs(d.Y()) < 1e-9;
    }
    return false;
  });
}

function edgeFeature(c: Ctx, s: TopoDS_Shape, type: 'fillet' | 'chamfer', size: number, rule: EdgeRule, name: string): TopoDS_Shape {
  const edges = selectEdges(c.oc, c.gc, s, rule);
  if (edges.length === 0) throw new GeometryError(`'${name}': 규칙에 맞는 모서리가 없습니다`);
  const what = type === 'fillet' ? '모서리를 둥글게' : '모따기를';
  try {
    let result: TopoDS_Shape;
    if (type === 'fillet') {
      const mk = c.gc.k(new c.oc.BRepFilletAPI_MakeFillet(s, 'ChFi3d_Rational' as never));
      for (const e of edges) mk.Add(size, e);
      mk.Build(progress(c));
      if (!mk.IsDone()) throw new Error('fillet');
      result = c.gc.k(mk.Shape());
    } else {
      const mk = c.gc.k(new c.oc.BRepFilletAPI_MakeChamfer(s));
      for (const e of edges) mk.Add(size, e);
      mk.Build(progress(c));
      if (!mk.IsDone()) throw new Error('chamfer');
      result = c.gc.k(mk.Shape());
    }
    if (!isValid(c, result) || volumeOf(c.oc, result) <= 0) throw new Error('invalid');
    return result;
  } catch (e) {
    if (e instanceof GeometryError) throw e;
    throw new GeometryError(`'${name}': ${what} 할 수 없습니다 (크기를 줄여 보세요)`);
  }
}

function draft(c: Ctx, s: TopoDS_Shape, angle: number, name: string): TopoDS_Shape {
  if (Math.abs(angle) < 1e-9) return s;
  const faces = draftFaces(c.oc, c.gc, s);
  if (faces.length === 0) throw new GeometryError(`'${name}': 구배를 줄 옆면(수직 평면·원통면)이 없습니다`);
  const zmin = boundsOf(c.oc, s)[2]!;
  const pln = c.gc.k(new c.oc.gp_Pln(pnt(c, 0, 0, zmin), dir(c, 0, 0, 1)));
  const up = dir(c, 0, 0, 1);
  try {
    const dr = c.gc.k(new c.oc.BRepOffsetAPI_DraftAngle(s));
    for (const f of faces) {
      dr.Add(f, up, (angle * Math.PI) / 180, pln, true);
      if (!dr.AddDone()) throw new Error('draft add');
    }
    dr.Build(progress(c));
    if (!dr.IsDone()) throw new Error('draft');
    const result = c.gc.k(dr.Shape());
    if (!isValid(c, result)) throw new Error('invalid');
    return result;
  } catch {
    throw new GeometryError(`'${name}': 구배를 줄 수 없습니다 (구배는 필렛·모따기보다 먼저 주세요. 또는 각도를 줄여 보세요)`);
  }
}

/** STEP 파일 → 원점(바운딩 박스 바닥면 중심)에 맞춘 형상. 결과는 캐시에 남으므로 gc 에 넣지 않는다 */
export function readStep(oc: OC, data: string, name: string): TopoDS_Shape {
  const hit = stepCache.get(data);
  if (hit) return hit;
  const path = `/import-${Date.now()}-${Math.random().toString(36).slice(2)}.step`;
  const gc = new Gc();
  try {
    oc.FS.writeFile(path, fromBase64(data));
    const r = gc.k(new oc.STEPControl_Reader());
    if ((r.ReadFile(path) as unknown as string) !== 'IFSelect_RetDone') throw new GeometryError(`'${name}': STEP 파일을 읽을 수 없습니다`);
    r.TransferRoots(gc.k(new oc.Message_ProgressRange()));
    if (r.NbShapes() < 1) throw new GeometryError(`'${name}': STEP 파일에 형상이 없습니다`);
    const raw = gc.k(r.OneShape());
    const c = { oc, gc } as Ctx;
    if (solidCount(c, raw) === 0) throw new GeometryError(`'${name}': STEP 파일에 솔리드가 없습니다 (곡면·선만 있는 파일은 지원하지 않습니다)`);
    const [x0, y0, z0, x1, y1] = boundsOf(oc, raw);
    const t = new oc.gp_Trsf();
    t.SetTranslation(gc.k(new oc.gp_Vec(-(x0! + x1!) / 2, -(y0! + y1!) / 2, -z0!)));
    const shape = gc.k(new oc.BRepBuilderAPI_Transform(raw, t, true, false)).Shape();
    t.delete();
    if (stepCache.size >= STEP_CACHE_SIZE) {
      const [oldKey, old] = stepCache.entries().next().value!;
      stepCache.delete(oldKey);
      old.delete();
    }
    stepCache.set(data, shape);
    return shape;
  } catch (e) {
    if (e instanceof GeometryError) throw e;
    throw new GeometryError(`'${name}': STEP 파일을 읽을 수 없습니다`);
  } finally {
    try {
      oc.FS.unlink(path);
    } catch {
      // 쓰기 전에 실패
    }
    gc.dispose();
  }
}

// ── 객체 → 로컬 형상 (서버 build_solid 와 같은 구조) ─────────────────────────────────

function placed(c: Ctx, id: ObjectId): TopoDS_Shape {
  const child = c.index.get(id);
  if (!child) throw new GeometryError(`존재하지 않는 객체입니다: ${id}`);
  return transformed(c, localShape(c, child), toMatrix(child.transform), child.name);
}

function sketchProfile(c: Ctx, obj: CadObject, sketch: ObjectId, profile: ObjectId): Profile {
  const sk = c.sketches.get(sketch);
  const p = sk ? resolveProfile(sk, profile) : null;
  if (!p) throw new GeometryError(`'${obj.name}': 참조한 스케치 프로파일을 찾을 수 없습니다`);
  return p;
}

function localShape(c: Ctx, obj: CadObject): TopoDS_Shape {
  switch (obj.kind) {
    case 'box': {
      const { width: w, depth: d, height: h } = obj.params;
      const solid = box(c, -w / 2, -d / 2, 0, w, d, h);
      if (obj.shell) {
        const t = obj.shell.thickness;
        const o = obj.shell.open;
        const lo = [o.includes('-X') ? -w / 2 - 1 : -w / 2 + t, o.includes('-Y') ? -d / 2 - 1 : -d / 2 + t, o.includes('bottom') ? -1 : t];
        const hi = [o.includes('+X') ? w / 2 + 1 : w / 2 - t, o.includes('+Y') ? d / 2 + 1 : d / 2 - t, o.includes('top') ? h + 1 : h - t];
        return cut(c, solid, box(c, lo[0]!, lo[1]!, lo[2]!, hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!));
      }
      const f = obj.edgeFeature;
      return f ? edgeFeature(c, solid, f.type, f.size, f.edges, obj.name) : solid;
    }
    case 'cylinder': {
      const { radius: r, height: h } = obj.params;
      const solid = cylinder(c, r, h);
      if (!obj.shell) return solid;
      const t = obj.shell.thickness;
      const z0 = obj.shell.open.includes('bottom') ? -1 : t;
      const z1 = obj.shell.open.includes('top') ? h + 1 : h - t;
      return cut(c, solid, cylinder(c, r - t, z1 - z0, z0));
    }
    case 'hole': {
      const p = obj.params;
      let tool = cylinder(c, p.diameter / 2, p.depth);
      if (p.cboreDiameter > 0) tool = fuse(c, tool, cylinder(c, p.cboreDiameter / 2, p.cboreDepth, p.depth - p.cboreDepth));
      if (p.csinkDiameter > 0) {
        const ch = (p.csinkDiameter - p.diameter) / 2;
        tool = fuse(c, tool, cone(c, p.diameter / 2, p.csinkDiameter / 2, ch, p.depth - ch));
      }
      return clean(c, tool);
    }
    case 'sphere': {
      const r = obj.params.radius;
      return c.gc.k(c.gc.k(new c.oc.BRepPrimAPI_MakeSphere(pnt(c, 0, 0, r), r)).Shape());
    }
    case 'cone':
      return cone(c, obj.params.radiusBottom, obj.params.radiusTop, obj.params.height);
    case 'extrude':
    case 'revolve': {
      const ref = obj.kind === 'extrude' ? obj.extrude : obj.revolve;
      const p = sketchProfile(c, obj, ref.sketch, ref.profile);
      const local = extrudeLocalMatrix(modelOf(c), obj);
      if (!local) throw new GeometryError(`'${obj.name}': 스케치를 붙인 면을 찾을 수 없습니다`);
      const face = profileFace(c, p);
      let solid: TopoDS_Shape;
      if (obj.kind === 'revolve') {
        const err = revolveProfileError(p);
        if (err) throw new GeometryError(`'${obj.name}': ${err}`);
        const ax = c.gc.k(new c.oc.gp_Ax1(pnt(c, 0, 0, 0), dir(c, 0, 1, 0)));
        solid = c.gc.k(c.gc.k(new c.oc.BRepPrimAPI_MakeRevol(face, ax, (obj.params.angle * Math.PI) / 180, false)).Shape());
      } else {
        const d = obj.params.distance;
        solid = prism(c, face, Math.abs(d));
        if (obj.shell) {
          const t = obj.shell.thickness;
          const lowOpen = obj.shell.open.includes(d > 0 ? 'start' : 'end');
          const highOpen = obj.shell.open.includes(d > 0 ? 'end' : 'start');
          const z0 = lowOpen ? -1 : t;
          const z1 = highOpen ? Math.abs(d) + 1 : Math.abs(d) - t;
          let inner: TopoDS_Face;
          try {
            const off = c.gc.k(new c.oc.BRepOffsetAPI_MakeOffset(face, 'GeomAbs_Intersection' as never, false));
            off.Perform(-t, 0);
            if (!off.IsDone()) throw new Error('offset');
            inner = faceOf(c, c.oc.TopoDS.Wire(c.gc.k(off.Shape())));
          } catch {
            throw new GeometryError(`'${obj.name}': 쉘 두께가 단면보다 큽니다`);
          }
          solid = cut(c, solid, moved(c, prism(c, inner, z1 - z0), 0, 0, z0));
        }
        if (d < 0) solid = moved(c, solid, 0, 0, d);
      }
      return transformed(c, solid, local, obj.name);
    }
    case 'helix': {
      const p = sketchProfile(c, obj, obj.helix.sketch, obj.helix.profile);
      const pts = helixProfilePoints(p, SECTION_TOLERANCE);
      const err = helixError(pts, obj.params.pitch);
      if (err) throw new GeometryError(`'${obj.name}': ${err}`);
      const local = extrudeLocalMatrix(modelOf(c), obj);
      if (!local) throw new GeometryError(`'${obj.name}': 스케치를 붙인 면을 찾을 수 없습니다`);
      return transformed(c, ringSolid(c, helixRings(pts, obj.params.pitch, obj.params.turns, SECTION_TOLERANCE), obj.name), local, obj.name);
    }
    case 'loft': {
      const model = modelOf(c);
      const profs = obj.loft.sections.map((s) => {
        const sk = c.sketches.get(s.sketch);
        const p = sk ? resolveProfile(sk, s.profile) : null;
        const m = p ? sketchLocalMatrix(model, obj.id, s.sketch) : null;
        if (!p || !m) throw new GeometryError(`'${obj.name}': 단면 ${s.sketch}·${s.profile} 을(를) 찾을 수 없습니다`);
        return { p, m };
      });
      const n = loftSegments(profs.map((x) => x.p), SECTION_TOLERANCE);
      const rings = profs.map(({ p, m }) =>
        sectionPoints(p, n).map(([u, v]) => new Vector3(u, v, 0).applyMatrix4(m).toArray() as [number, number, number]),
      );
      return ringSolid(c, rings, obj.name);
    }
    case 'mesh': {
      const m = decodeMesh(obj.mesh);
      return sewMesh(c, m.positions, m.indices, obj.name);
    }
    case 'step':
      return readStep(c.oc, obj.step.data, obj.name);
    case 'fillet': {
      const f = obj.fillet;
      return edgeFeature(c, placed(c, f.source), f.type, f.size, f.edges, obj.name);
    }
    case 'draft':
      return draft(c, placed(c, obj.draft.source), obj.draft.angle, obj.name);
    case 'pattern': {
      const src = placed(c, obj.pattern.source);
      const mats = patternMatrices(obj.pattern);
      let result = transformed(c, src, mats[0]!, obj.name);
      for (const m of mats.slice(1)) result = fuse(c, result, transformed(c, src, m, obj.name));
      if (mats.length > 1) result = clean(c, result);
      if (!isValid(c, result)) throw new GeometryError(`'${obj.name}': 패턴 결과 형상이 올바르지 않습니다`);
      return result;
    }
    case 'boolean': {
      const op = obj.boolean.operation;
      let result = placed(c, obj.boolean.base);
      for (const toolId of obj.boolean.tools) {
        const toolObj = c.index.get(toolId);
        if (toolObj && isSuppressed(toolObj, c.index)) continue;
        const tool = placed(c, toolId);
        result = op === 'cut' ? cut(c, result, tool) : op === 'union' ? fuse(c, result, tool) : common(c, result, tool);
      }
      if (op === 'union') result = clean(c, result);
      if (solidCount(c, result) === 0) throw new GeometryError(`'${obj.name}': ${OPERATION_LABEL[op]} 결과가 비어 있습니다 (겹치는 부분이 없습니다)`);
      if (!isValid(c, result)) throw new GeometryError(`'${obj.name}': ${OPERATION_LABEL[op]} 결과 형상이 올바르지 않습니다`);
      return result;
    }
  }
}

// ── 메시 변환 ─────────────────────────────────────────────────────────────────

/** 형상 → 삼각형 메시 (면 사이 정점 공유 = 브라우저 엔진 계약 welded) */
export function tessellate(oc: OC, s: TopoDS_Shape, lin: number, ang: number): PlainMesh {
  const gc = new Gc();
  try {
    gc.k(new oc.BRepMesh_IncrementalMesh(s, lin, false, ang, false));
    const pos: number[] = [];
    const idx: number[] = [];
    const weld = new Map<string, number>();
    const ex = gc.k(new oc.TopExp_Explorer(s, 'TopAbs_FACE' as never, 'TopAbs_SHAPE' as never));
    for (; ex.More(); ex.Next()) {
      const face = gc.k(oc.TopoDS.Face(gc.k(ex.Current())));
      const loc = gc.k(new oc.TopLoc_Location());
      const tri = oc.BRep_Tool.Triangulation(face, loc, 0 as never) as unknown as {
        NbNodes(): number; NbTriangles(): number; Node(i: number): { X(): number; Y(): number; Z(): number; Transformed(t: unknown): { X(): number; Y(): number; Z(): number; delete(): void }; delete(): void };
        Triangle(i: number): { Value(i: number): number; delete(): void }; delete(): void;
      } | null;
      if (!tri) continue;
      gc.k(tri);
      const trsf = gc.k(loc.Transformation());
      const map: number[] = [0];
      for (let i = 1; i <= tri.NbNodes(); i++) {
        const n0 = tri.Node(i);
        const n = n0.Transformed(trsf);
        const x = n.X();
        const y = n.Y();
        const z = n.Z();
        n0.delete();
        n.delete();
        const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
        let at = weld.get(key);
        if (at === undefined) {
          at = pos.length / 3;
          pos.push(x, y, z);
          weld.set(key, at);
        }
        map.push(at);
      }
      const reversed = (face.Orientation() as unknown as string) === 'TopAbs_REVERSED';
      for (let i = 1; i <= tri.NbTriangles(); i++) {
        const t = tri.Triangle(i);
        const a = map[t.Value(1)]!;
        const b = map[t.Value(2)]!;
        const d = map[t.Value(3)]!;
        t.delete();
        if (a === b || b === d || a === d) continue;
        if (reversed) idx.push(a, d, b);
        else idx.push(a, b, d);
      }
    }
    return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
  } finally {
    gc.dispose();
  }
}

function ctxOf(oc: OC, model: ModelDefinition, gc: Gc): Ctx {
  return { oc, gc, index: byId(model), sketches: sketchIndex(model) };
}

/** 객체 하나의 로컬 메시 (워커가 정밀 엔진이 필요한 최상위 객체에만 쓴다) */
export function occtLocalMesh(oc: OC, model: ModelDefinition, obj: CadObject, tol = DISPLAY_TOLERANCE, ang = DISPLAY_ANGULAR): PlainMesh {
  const gc = new Gc();
  try {
    return tessellate(oc, localShape(ctxOf(oc, model, gc), obj), tol, ang);
  } catch (e) {
    throw asGeometryError(e, obj.name);
  } finally {
    gc.dispose();
  }
}

/** 객체 하나의 월드 좌표 메시 (내보내기) */
export function occtWorldMesh(oc: OC, model: ModelDefinition, obj: CadObject, tol = EXPORT_TOLERANCE, ang = EXPORT_ANGULAR): PlainMesh {
  const m = occtLocalMesh(oc, model, obj, tol, ang);
  const world = toMatrix(obj.transform);
  const v = new Vector3();
  for (let i = 0; i < m.positions.length; i += 3) {
    v.set(m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!).applyMatrix4(world);
    m.positions[i] = v.x;
    m.positions[i + 1] = v.y;
    m.positions[i + 2] = v.z;
  }
  return m;
}

/** 객체 하나의 로컬 B-rep 부피·바운딩 박스 (테스트·검증용) */
export function occtLocalProps(oc: OC, model: ModelDefinition, obj: CadObject): { volume: number; bounds: number[] } {
  const gc = new Gc();
  try {
    const s = localShape(ctxOf(oc, model, gc), obj);
    return { volume: volumeOf(oc, s), bounds: boundsOf(oc, s) };
  } catch (e) {
    throw asGeometryError(e, obj.name);
  } finally {
    gc.dispose();
  }
}

/** 최상위 객체를 월드 좌표로 STEP(AP214) 파일로 — 서버 exporter.to_step 과 같은 내용 */
export function occtStep(oc: OC, model: ModelDefinition): Uint8Array {
  const gc = new Gc();
  const path = `/export-${Date.now()}.step`;
  try {
    const c = ctxOf(oc, model, gc);
    const objs = topLevelObjects(model).filter((o) => !isSuppressed(o, c.index));
    if (objs.length === 0) throw new GeometryError('내보낼 객체가 없습니다');
    const w = gc.k(new oc.STEPControl_Writer());
    for (const o of objs) {
      let s: TopoDS_Shape;
      try {
        s = transformed(c, localShape(c, o), toMatrix(o.transform), o.name);
      } catch (e) {
        throw asGeometryError(e, o.name);
      }
      w.Transfer(s, 'STEPControl_AsIs' as never, true, gc.k(new oc.Message_ProgressRange()));
    }
    if ((w.Write(path) as unknown as string) !== 'IFSelect_RetDone') throw new GeometryError('STEP 파일을 쓸 수 없습니다');
    return oc.FS.readFile(path) as Uint8Array;
  } finally {
    try {
      oc.FS.unlink(path);
    } catch {
      // 쓰기 전에 실패
    }
    gc.dispose();
  }
}

/** OCCT 예외(숫자 포인터 등)를 사용자 메시지로 */
function asGeometryError(e: unknown, name: string): GeometryError {
  if (e instanceof GeometryError) return e;
  return new GeometryError(`'${name}': 정밀 엔진(OCCT)이 형상을 만들지 못했습니다`);
}

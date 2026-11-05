/**
 * 모델링 모드 동작 (블렌더 단축키에 대응) — 모델 변경은 전부 명령(submitNow)으로.
 * 키보드(ModelingKeys)·메뉴(ModelingHeader)·속성 패널이 같은 함수를 쓴다.
 */
import type { CadObject, MeshEdit, ObjectId } from '../../cad/commandTypes';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { edges, loopCut, selectedFaces, type MeshPrimitive, type PolyMesh, type PrimitiveParams } from '../../cad/polymesh';
import { nextFreePosition } from '../../cad/placement';
import { growSelection, selectLinked } from '../../cad/polymeshSelect';
import { notify } from '../projects/projectActions';
import { useModelingStore } from './modelingStore';

/** Shift+A 메뉴 항목 (크기는 mm — 블렌더의 2m 대신 책상 위 물건 크기) */
export const ADD_MESH_ITEMS: { primitive: MeshPrimitive; label: string; params: PrimitiveParams; height: number }[] = [
  { primitive: 'plane', label: '평면', params: { size: 20 }, height: 0 },
  { primitive: 'cube', label: '큐브', params: { size: 20 }, height: 20 },
  { primitive: 'uv_sphere', label: 'UV 구', params: { radius: 10, segments: 32, rings: 16 }, height: 20 },
  { primitive: 'cylinder', label: '원기둥', params: { radius: 10, depth: 20, segments: 32 }, height: 20 },
  { primitive: 'cone', label: '원뿔', params: { radius: 10, depth: 20, segments: 32 }, height: 20 },
  { primitive: 'torus', label: '도넛', params: { radius: 10, minorRadius: 3, segments: 48, rings: 12 }, height: 6 },
  { primitive: 'grid', label: '격자', params: { size: 20, subdivisions: 10 }, height: 0 },
];

export function activeObject(): CadObject | null {
  const s = useSceneStore.getState();
  return s.history.present.model.objects.find((o) => o.id === s.selectedId) ?? null;
}

export function editTarget(): (CadObject & { kind: 'polymesh' }) | null {
  const o = activeObject();
  return o && o.kind === 'polymesh' ? o : null;
}

/** 메시 추가: 바닥(격자) 위, 다른 객체 옆에 놓는다 */
export function addMesh(primitive: MeshPrimitive) {
  const item = ADD_MESH_ITEMS.find((i) => i.primitive === primitive)!;
  const model = selectModel(useSceneStore.getState());
  const [x, y] = nextFreePosition(model, 20);
  const r = useSceneStore.getState().submitNow({ type: 'add_mesh', primitive, params: item.params, position: [x, y, item.height / 2] });
  if (r.status === 'applied') useModelingStore.getState().setMode('object');
}

/** Tab: 오브젝트 ↔ 편집 모드 (메시 객체만 편집 모드). 스컬프트 모드에서는 편집 모드로 */
export function toggleEditMode() {
  const st = useModelingStore.getState();
  if (st.mode === 'edit') return st.setMode('object');
  if (!editTarget()) return notify('편집 모드는 메시 객체에서만 됩니다 — 메시를 먼저 고르세요 (Shift+A 로 추가)');
  st.setMode('edit');
}

/** A: 전체 선택 (이미 전부면 해제) · Alt+A: 해제 */
export function selectAll(deselect = false) {
  const t = editTarget();
  const st = useModelingStore.getState();
  if (st.mode !== 'edit' || !t) return;
  const all = t.polymesh.verts.length;
  st.setSel(deselect || st.selVerts.length === all ? [] : Array.from({ length: all }, (_, i) => i));
}

export function selectedFaceIds(m: PolyMesh): number[] {
  return selectedFaces(m, new Set(useModelingStore.getState().selVerts));
}

/** 고른 점 둘을 잇는 선들 */
export function selectedEdges(m: PolyMesh): [number, number][] {
  const s = new Set(useModelingStore.getState().selVerts);
  return edges(m).filter(([a, b]) => s.has(a) && s.has(b));
}

function edit(target: ObjectId, e: MeshEdit, after: number[] = []): boolean {
  const r = useSceneStore.getState().submitNow({ type: 'mesh_edit', target, edit: e });
  if (r.status !== 'applied') return false;
  useModelingStore.getState().setSel(after);
  return true;
}

/** X / Delete: 오브젝트 모드 = 객체 삭제, 편집 모드 = 선택 모드에 따라 점·선·면 */
export function deleteSelection() {
  const st = useModelingStore.getState();
  const s = useSceneStore.getState();
  if (st.mode === 'object') {
    if (s.selectedId) s.submitNow({ type: 'delete_object', target: s.selectedId });
    return;
  }
  const t = editTarget();
  if (!t || !st.selVerts.length) return;
  edit(t.id, { op: 'delete', verts: st.selVerts, mode: st.selectMode === 'vert' ? 'verts' : st.selectMode === 'edge' ? 'edges' : 'faces' });
}

/** Ctrl+R: 고른 선 하나를 가로지르는 고리 (블렌더는 마우스 아래 선 — 여기서는 고른 선) */
export function loopCutSelected() {
  const t = editTarget();
  if (!t) return;
  const es = selectedEdges(t.polymesh);
  if (es.length !== 1) return notify('루프 컷: 선 하나를 고르세요 (2 = 선 선택 모드)');
  const [a, b] = es[0]!;
  const { sel } = loopCut(t.polymesh, a, b, 0.5);
  if (!sel.length) return notify('그 선을 지나는 사각형 띠가 없습니다');
  edit(t.id, { op: 'loop_cut', edge: [a, b], factor: 0.5 }, sel);
}

/** M: 가운데로 병합 */
export function mergeSelected() {
  const t = editTarget();
  const sel = useModelingStore.getState().selVerts;
  if (!t || sel.length < 2) return notify('병합: 점을 둘 이상 고르세요');
  edit(t.id, { op: 'merge', verts: sel });
}

/** F: 고른 점들로 면 (고른 순서대로) */
export function fillSelected() {
  const t = editTarget();
  const sel = useModelingStore.getState().selVerts;
  if (!t || sel.length < 3) return notify('면 채우기: 점을 셋 이상 고르세요');
  edit(t.id, { op: 'fill', verts: sel }, sel);
}

/** 세분: 고른 면마다 가운데 점 */
export function subdivideSelected() {
  const t = editTarget();
  if (!t) return;
  const faces = selectedFaceIds(t.polymesh);
  if (!faces.length) return notify('세분: 면을 고르세요');
  edit(t.id, { op: 'subdivide', faces });
}

/** 모달 시작 전 확인: 편집 모드에서 G/R/S 는 점, E/I 는 면이 있어야 */
export function canStartModal(kind: 'grab' | 'rotate' | 'scale' | 'extrude' | 'inset' | 'bevel'): boolean {
  const st = useModelingStore.getState();
  if (st.mode === 'object') {
    const o = activeObject();
    if (!o) return false;
    if (kind === 'extrude' || kind === 'inset' || kind === 'bevel') return false;
    if (kind === 'scale' && o.kind !== 'polymesh') {
      notify('오브젝트 크기(S)는 메시 객체만 됩니다 — 설계 부품은 설계 모드의 크기 조정을 쓰세요');
      return false;
    }
    return true;
  }
  const t = editTarget();
  if (!t) return false;
  if (kind === 'bevel') {
    if (!selectedEdges(t.polymesh).length) {
      notify('베벨: 선을 고르세요 (2 = 선 선택 모드, Alt+클릭 = 루프)');
      return false;
    }
    return true;
  }
  if (kind === 'extrude' || kind === 'inset') {
    if (!selectedFaceIds(t.polymesh).length) {
      notify(`${kind === 'extrude' ? '돌출' : '인셋'}: 면을 고르세요 (3 = 면 선택 모드)`);
      return false;
    }
    return true;
  }
  return st.selVerts.length > 0;
}

/** Ctrl+1~3: 세분 표면 단계 (없으면 추가), Ctrl+0: 세분 표면 빼기 (블렌더와 같음) */
export function setSubsurfLevel(level: number) {
  const o = activeObject();
  if (!o || o.kind !== 'polymesh') return notify('세분 표면은 메시 객체에만 — 메시를 먼저 고르세요');
  const mods = o.modifiers ?? [];
  const i = mods.findIndex((m) => m.type === 'subsurf');
  let next = [...mods];
  if (level === 0) next = mods.filter((m) => m.type !== 'subsurf');
  else if (i >= 0) next[i] = { type: 'subsurf', levels: level };
  else next = [...mods, { type: 'subsurf', levels: level }];
  useSceneStore.getState().submitNow({ type: 'set_modifiers', target: o.id, modifiers: next });
}

/** 스컬프트 모드 (블렌더 Ctrl+Tab 메뉴의 Sculpt Mode): 메시 객체를 브러시로 다듬는다 */
export function enterSculpt() {
  const st = useModelingStore.getState();
  if (!editTarget()) return notify('스컬프트는 메시 객체에서만 됩니다 — 메시를 먼저 고르세요 (Shift+A 로 추가)');
  st.setMode('sculpt');
}

/** 촘촘하게: 세분 표면 1단계를 메시에 굳힌다 (스컬프트할 점을 늘리기). 실행 취소 1번 */
export function densify() {
  const t = editTarget();
  if (!t) return;
  const r = useSceneStore.getState().dispatchBatch([
    { type: 'set_modifiers', target: t.id, modifiers: [{ type: 'subsurf', levels: 1 }, ...(t.modifiers ?? [])] },
    { type: 'apply_modifier', target: t.id },
  ]);
  if (r.ok) notify(`점 ${editTarget()?.polymesh.verts.length.toLocaleString() ?? ''}개로 촘촘하게 했습니다`);
}

/** Ctrl+L: 고른 점과 이어진 조각 전체 */
export function selectLinkedVerts() {
  const t = editTarget();
  const st = useModelingStore.getState();
  if (!t || st.mode !== 'edit' || !st.selVerts.length) return;
  st.setSel(selectLinked(t.polymesh, st.selVerts));
}

/** Ctrl+숫자패드 + / −: 선택 넓히기·좁히기 */
export function growSelected(shrink = false) {
  const t = editTarget();
  const st = useModelingStore.getState();
  if (!t || st.mode !== 'edit' || !st.selVerts.length) return;
  st.setSel(growSelection(t.polymesh, st.selVerts, shrink));
}

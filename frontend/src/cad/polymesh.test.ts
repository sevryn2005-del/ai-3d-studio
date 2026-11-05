import { describe, expect, it } from 'vitest';
import {
  boundaryEdgeCount, deleteElements, edges, extrudeFaces, faceNormal, fillFace, insetFaces, loopCut, mergeVerts,
  polyMeshError, polyVolume, primitiveMesh, selectedFaces, subdivideFaces, transformVerts, triangulate, type PolyMesh,
} from './polymesh';
import { executeCommand } from './commandExecutor';
import { emptyModel } from './commandTypes';

const closedOk = (m: PolyMesh) => {
  expect(polyMeshError(m)).toBeNull();
  expect(boundaryEdgeCount(m)).toBe(0);
};
const top = (m: PolyMesh) => m.faces.findIndex((f) => faceNormal(m, f)[2] > 0.99);
const translate = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

describe('폴리메시 기본 도형 (닫힘·바깥 법선 = 양의 부피)', () => {
  it('큐브 2×2×2 = 8, 선 12개', () => {
    const c = primitiveMesh('cube');
    closedOk(c);
    expect(polyVolume(c)).toBeCloseTo(8, 9);
    expect(edges(c)).toHaveLength(12);
    expect(triangulate(c)).toHaveLength(36);
  });
  it('원통·원뿔·구·도넛: 닫힘, 부피가 이론값에 가깝다', () => {
    const cyl = primitiveMesh('cylinder', { radius: 1, depth: 2, segments: 64 });
    closedOk(cyl);
    expect(polyVolume(cyl) / (Math.PI * 2)).toBeCloseTo(1, 2);
    const cone = primitiveMesh('cone', { radius: 1, depth: 3, segments: 64 });
    closedOk(cone);
    expect(polyVolume(cone) / Math.PI).toBeCloseTo(1, 2);
    const sph = primitiveMesh('uv_sphere', { radius: 1, segments: 64, rings: 32 });
    closedOk(sph);
    expect(polyVolume(sph) / ((4 / 3) * Math.PI)).toBeCloseTo(1, 1);
    const tor = primitiveMesh('torus', { radius: 2, minorRadius: 0.5, segments: 64, rings: 32 });
    closedOk(tor);
    expect(polyVolume(tor) / (2 * Math.PI * Math.PI * 2 * 0.25)).toBeCloseTo(1, 1);
    const plane = primitiveMesh('plane');
    expect(boundaryEdgeCount(plane)).toBe(4);
    expect(primitiveMesh('grid', { subdivisions: 4 }).faces).toHaveLength(16);
  });
});

describe('폴리메시 편집 (블렌더 편집 모드)', () => {
  const cube = primitiveMesh('cube');

  it('점 옮기기 (G): 윗면 점을 1 올리면 부피 12', () => {
    const t = top(cube);
    const m = transformVerts(cube, cube.faces[t]!, translate(0, 0, 1));
    expect(polyVolume(m)).toBeCloseTo(12, 9);
  });

  it('면 돌출 (E): 윗면을 1 돌출 → 면 10, 닫힘, 부피 12, 새 점이 선택', () => {
    const { mesh, sel } = extrudeFaces(cube, [top(cube)], [0, 0, 1]);
    closedOk(mesh);
    expect(mesh.faces).toHaveLength(10);
    expect(polyVolume(mesh)).toBeCloseTo(12, 9);
    expect(sel).toHaveLength(4);
    expect(sel.every((v) => mesh.verts[v]![2] === 2)).toBe(true);
    // 이웃한 두 면을 함께 돌출하면 둘 사이엔 옆면이 생기지 않는다 (영역 돌출)
    const two = extrudeFaces(cube, [top(cube), cube.faces.findIndex((f) => faceNormal(cube, f)[0] > 0.99)], [0.5, 0, 0.5]);
    closedOk(two.mesh);
    expect(two.mesh.faces).toHaveLength(6 + 6);
  });

  it('인셋 (I): 윗면 안쪽에 면 → 면 10, 닫힘, 부피 그대로', () => {
    const { mesh, sel } = insetFaces(cube, [top(cube)], 0.3);
    closedOk(mesh);
    expect(mesh.faces).toHaveLength(10);
    expect(polyVolume(mesh)).toBeCloseTo(8, 9);
    expect(sel).toHaveLength(4);
  });

  it('삭제 (X): 면만 지우면 구멍, 점을 지우면 그 점의 면까지', () => {
    const noTop = deleteElements(cube, cube.faces[top(cube)]!, 'faces');
    expect(noTop.faces).toHaveLength(5);
    expect(boundaryEdgeCount(noTop)).toBe(4);
    const noVert = deleteElements(cube, [0], 'verts');
    expect(noVert.faces).toHaveLength(3);
    expect(noVert.verts).toHaveLength(7);
    expect(polyMeshError(noVert)).toBeNull();
    // 면 채우기 (F): 지운 윗면을 다시 → 닫힘
    const t = cube.faces[top(cube)]!;
    const filled = fillFace(noTop, t.map((v) => noTop.verts.findIndex((p) => p.every((c, k) => c === cube.verts[v]![k]))));
    closedOk(filled);
    expect(polyVolume(filled)).toBeCloseTo(8, 9);
  });

  it('루프 컷 (Ctrl+R): 옆면 띠를 가로질러 새 고리 → 면 10, 닫힘, 새 점 4', () => {
    // 세로 선 하나 (바닥 0 → 위 4) 를 고르면 옆면 띠를 따라 가로로 자른다
    const { mesh, sel } = loopCut(cube, 0, 4, 0.5);
    closedOk(mesh);
    expect(mesh.faces).toHaveLength(10);
    expect(sel).toHaveLength(4);
    expect(sel.every((v) => Math.abs(mesh.verts[v]![2]) < 1e-9)).toBe(true);
    expect(polyVolume(mesh)).toBeCloseTo(8, 9);
  });

  it('세분: 큐브 모든 면 → 면 24, 닫힘, 부피 그대로', () => {
    const m = subdivideFaces(cube, cube.faces.map((_, i) => i));
    closedOk(m);
    expect(m.faces).toHaveLength(24);
    expect(polyVolume(m)).toBeCloseTo(8, 9);
    // 일부만 나눠도 갈라지지 않는다 (이웃 면에 새 점이 끼워진다)
    closedOk(subdivideFaces(cube, [top(cube)]));
  });

  it('병합 (M): 윗면 네 점을 가운데로 → 피라미드 지붕 (닫힘)', () => {
    const m = mergeVerts(cube, cube.faces[top(cube)]!);
    closedOk(m);
    expect(m.verts).toHaveLength(5);
    expect(polyVolume(m)).toBeCloseTo((4 * 2) / 3, 9); // 바닥 2×2 · 높이 2 피라미드
  });

  it('선택한 점으로 면 고르기', () => {
    const t = top(cube);
    expect(selectedFaces(cube, new Set(cube.faces[t]))).toEqual([t]);
  });
});

describe('메시 명령 (add_mesh / mesh_edit, 형식 v20)', () => {
  const add = () => {
    const r = executeCommand({ ...emptyModel(), workspace: 'modeling' }, { type: 'add_mesh', primitive: 'cube', params: { size: 20 }, position: [0, 0, 10] });
    if (!r.ok) throw new Error(r.error);
    return r;
  };

  it('큐브 추가: 이름·크기·위치', () => {
    const r = add();
    const o = r.model.objects[0]!;
    expect(o.kind).toBe('polymesh');
    expect(o.name).toBe('큐브 1');
    if (o.kind !== 'polymesh') return;
    expect(o.polymesh.verts).toHaveLength(8);
    expect(polyVolume(o.polymesh)).toBeCloseTo(8000);
  });

  it('편집: 돌출 → 인셋, 메시가 아닌 객체·없는 면은 거부', () => {
    let m = add().model;
    const id = m.objects[0]!.id;
    const ex = executeCommand(m, { type: 'mesh_edit', target: id, edit: { op: 'extrude', faces: [1], offset: [0, 0, 5] } });
    expect(ex.ok).toBe(true);
    if (!ex.ok) return;
    m = ex.model;
    const o = m.objects[0]!;
    if (o.kind !== 'polymesh') throw new Error();
    expect(o.polymesh.faces).toHaveLength(10);
    expect(polyVolume(o.polymesh)).toBeCloseTo(20 * 20 * 25);
    const bad = executeCommand(m, { type: 'mesh_edit', target: id, edit: { op: 'subdivide', faces: [99] } });
    expect(bad).toEqual({ ok: false, error: '없는 면을 가리킵니다' });
    const box = executeCommand(m, { type: 'create_box', id: 'b', width: 1, depth: 1, height: 1 });
    if (!box.ok) throw new Error();
    const notMesh = executeCommand(box.model, { type: 'mesh_edit', target: 'b', edit: { op: 'merge', verts: [0, 1] } });
    expect(notMesh.ok).toBe(false);
  });

  it('루프 컷이 걸리지 않는 선은 이유와 함께 거부', () => {
    const r = executeCommand({ ...emptyModel() }, { type: 'add_mesh', id: 'p', primitive: 'plane' });
    if (!r.ok) throw new Error();
    // 평면 하나: 띠는 그 사각형 하나 — 0–1 선을 가로질러 자를 수 있다
    expect(executeCommand(r.model, { type: 'mesh_edit', target: 'p', edit: { op: 'loop_cut', edge: [0, 1], factor: 0.5 } }).ok).toBe(true);
    // 두 점이 선으로 이어져 있지 않으면 거부
    expect(executeCommand(r.model, { type: 'mesh_edit', target: 'p', edit: { op: 'loop_cut', edge: [0, 2], factor: 0.5 } }).ok).toBe(false);
  });
});

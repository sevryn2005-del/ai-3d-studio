/**
 * 단면 고리들(같은 점 수, 같은 방향)을 직선으로 이은 닫힌 솔리드 (로프트·헬릭스).
 * 옆면 = 이웃 고리의 사각형마다 삼각형 2개, 양 끝 = 단면 다각형 삼각분할. 서버는 같은 고리로 CadQuery makeLoft(ruled).
 */
import { ShapeUtils, Vector2 } from 'three';
import type { ManifoldToplevel, Manifold } from 'manifold-3d';
import type { Point2 } from '../../../cad/commandTypes';

export function ringSolid(
  wasm: ManifoldToplevel,
  rings: [number, number, number][][],
  firstCap2d: Point2[],
  lastCap2d: Point2[],
): Manifold {
  const n = rings[0]!.length;
  const vert: number[] = rings.flatMap((r) => r.flat());
  const tri: number[] = [];
  for (let i = 0; i + 1 < rings.length; i++)
    for (let j = 0; j < n; j++) {
      const a = i * n + j;
      const b = i * n + ((j + 1) % n);
      const c = (i + 1) * n + j;
      const d = (i + 1) * n + ((j + 1) % n);
      tri.push(a, b, d, a, d, c);
    }
  const cap = (pts: Point2[], base: number, flip: boolean) => {
    const faces = ShapeUtils.triangulateShape(pts.map(([x, y]) => new Vector2(x, y)), []);
    for (const [p, q, r] of faces) tri.push(...(flip ? [base + p!, base + r!, base + q!] : [base + p!, base + q!, base + r!]));
  };
  cap(firstCap2d, 0, true);
  cap(lastCap2d, (rings.length - 1) * n, false);
  const make = (t: number[]) => new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(vert), triVerts: Uint32Array.from(t) }));
  let m = make(tri);
  if (m.volume() < 0) {
    m.delete();
    const flipped: number[] = [];
    for (let k = 0; k < tri.length; k += 3) flipped.push(tri[k]!, tri[k + 2]!, tri[k + 1]!);
    m = make(flipped);
  }
  return m;
}

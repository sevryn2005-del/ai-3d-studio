/**
 * 질량 특성 (솔리드웍스 "질량 특성", 블렌더 3D Print Toolbox 의 부피·면적): 닫힌 삼각형 메시에서
 * 부피·겉넓이·무게 중심·바운딩 박스. 엔진 메시(객체 로컬) + 객체 월드 행렬 → 월드 값.
 */
import { Matrix4, Vector3 } from 'three';

export interface MassProperties {
  volume: number; // mm³
  area: number; // mm²
  centroid: [number, number, number]; // mm (월드)
  min: [number, number, number];
  max: [number, number, number];
}

/** 부호 있는 사면체 부피의 합 (발산 정리). 메시가 닫혀 있고 바깥을 향하면 부피 > 0 */
export function meshProperties(positions: ArrayLike<number>, indices: ArrayLike<number> | null, world: Matrix4 = new Matrix4()): MassProperties {
  const n = indices ? indices.length : positions.length / 3;
  const v = (i: number) => new Vector3(positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!).applyMatrix4(world);
  let volume = 0;
  let area = 0;
  const c = new Vector3();
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let t = 0; t < n; t += 3) {
    const a = v(indices ? indices[t]! : t);
    const b = v(indices ? indices[t + 1]! : t + 1);
    const d = v(indices ? indices[t + 2]! : t + 2);
    const vol = a.dot(new Vector3().crossVectors(b, d)) / 6;
    volume += vol;
    c.addScaledVector(a.clone().add(b).add(d), vol / 4); // 사면체(원점, a, b, d) 중심 × 부피
    area += new Vector3().crossVectors(b.clone().sub(a), d.clone().sub(a)).length() / 2;
    for (const p of [a, b, d]) {
      min.min(p);
      max.max(p);
    }
  }
  const centroid = volume !== 0 ? c.divideScalar(volume) : new Vector3();
  return { volume, area, centroid: centroid.toArray(), min: min.toArray(), max: max.toArray() };
}

/** 여러 물체 합산 (부피 가중 무게 중심) */
export function combine(parts: MassProperties[]): MassProperties | null {
  if (!parts.length) return null;
  const volume = parts.reduce((s, p) => s + p.volume, 0);
  const c = parts.reduce((acc, p) => acc.addScaledVector(new Vector3(...p.centroid), p.volume), new Vector3());
  return {
    volume,
    area: parts.reduce((s, p) => s + p.area, 0),
    centroid: (volume ? c.divideScalar(volume) : c).toArray(),
    min: [0, 1, 2].map((k) => Math.min(...parts.map((p) => p.min[k]!))) as [number, number, number],
    max: [0, 1, 2].map((k) => Math.max(...parts.map((p) => p.max[k]!))) as [number, number, number],
  };
}

/** 3D 프린팅·가공 재료 밀도 (g/cm³) */
export const MATERIALS = [
  { id: 'pla', label: 'PLA', density: 1.24 },
  { id: 'petg', label: 'PETG', density: 1.27 },
  { id: 'abs', label: 'ABS', density: 1.04 },
  { id: 'tpu', label: 'TPU', density: 1.21 },
  { id: 'nylon', label: '나일론(PA12)', density: 1.01 },
  { id: 'resin', label: '레진(표준)', density: 1.18 },
  { id: 'al', label: '알루미늄 6061', density: 2.7 },
  { id: 'steel', label: '강철', density: 7.85 },
  { id: 'wood', label: '목재(소나무)', density: 0.5 },
] as const;

/** mm³ × g/cm³ → g */
export const massGrams = (volumeMm3: number, density: number) => (volumeMm3 / 1000) * density;

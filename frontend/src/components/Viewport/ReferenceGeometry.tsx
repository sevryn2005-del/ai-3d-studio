/**
 * 참조 형상 (형식 v34): 3D 화면 표시 (평면 = 반투명 사각형, 축 = 긴 선, 점 = 작은 구, 좌표계 = 세 화살표)
 * + 만들기 패널 (모델 위 점 클릭 또는 좌표 입력 → ✓).
 */
import { useMemo, useState } from 'react';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Matrix4, Quaternion, Vector3 } from 'three';
import type { Reference, Vec3 } from '../../cad/commandTypes';
import { REF_LABEL, REF_POINT_HINT, REF_POINTS, referenceFromPoints, type RefType } from '../../cad/references';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { useEditorStore } from '../../features/selection/editorStore';

const REF_COLOR = '#d08a2c';
const PLANE_SIZE = 40;
const AXIS_HALF = 60;

function basis(normal: Vec3, xDir: Vec3): Matrix4 {
  const z = new Vector3(...normal).normalize();
  const x = new Vector3(...xDir).normalize();
  const y = new Vector3().crossVectors(z, x);
  return new Matrix4().makeBasis(x, y, z);
}

function Line({ a, b, color, dashed }: { a: Vector3; b: Vector3; color: string; dashed?: boolean }) {
  const g = useMemo(() => new BufferGeometry().setAttribute('position', new Float32BufferAttribute([...a.toArray(), ...b.toArray()], 3)), [a, b]);
  return (
    <lineSegments geometry={g} onUpdate={(l) => dashed && l.computeLineDistances()} raycast={() => null}>
      {dashed ? <lineDashedMaterial color={color} dashSize={3} gapSize={2} /> : <lineBasicMaterial color={color} />}
    </lineSegments>
  );
}

function RefItem({ r, active }: { r: Reference; active: boolean }) {
  const color = active ? '#4c9aff' : REF_COLOR;
  if (r.type === 'point')
    return (
      <mesh position={r.position} raycast={() => null} userData={{ referenceId: r.id }}>
        <sphereGeometry args={[1.2, 12, 8]} />
        <meshBasicMaterial color={color} />
      </mesh>
    );
  if (r.type === 'axis') {
    const o = new Vector3(...r.origin);
    const d = new Vector3(...r.direction).normalize().multiplyScalar(AXIS_HALF);
    return <Line a={o.clone().sub(d)} b={o.clone().add(d)} color={color} dashed />;
  }
  const m = r.type === 'plane' ? basis(r.normal, r.xDir) : basis(r.zDir, r.xDir);
  const q = new Quaternion().setFromRotationMatrix(m);
  if (r.type === 'plane')
    return (
      <group position={r.origin} quaternion={q} userData={{ referenceId: r.id }}>
        <mesh raycast={() => null}>
          <planeGeometry args={[PLANE_SIZE, PLANE_SIZE]} />
          <meshBasicMaterial color={color} transparent opacity={active ? 0.25 : 0.12} side={DoubleSide} depthWrite={false} />
        </mesh>
        <lineLoop raycast={() => null}>
          <bufferGeometry>
            <float32BufferAttribute attach="attributes-position" args={[[-20, -20, 0, 20, -20, 0, 20, 20, 0, -20, 20, 0], 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={color} />
        </lineLoop>
      </group>
    );
  // 좌표계: x 빨강, y 초록, z 파랑 (15 mm)
  const o = new Vector3(...r.origin);
  const ax = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].map((v) => v.applyMatrix4(m).multiplyScalar(15).add(o));
  return (
    <group userData={{ referenceId: r.id }}>
      <Line a={o} b={ax[0]!} color="#e5534b" />
      <Line a={o} b={ax[1]!} color="#57ab5a" />
      <Line a={o} b={ax[2]!} color="#539bf5" />
      <mesh position={r.origin} raycast={() => null}>
        <sphereGeometry args={[0.9, 10, 6]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  );
}

/** Canvas 안: 저장된 참조 형상 + 고르는 중인 점 */
export function ReferenceGeometry() {
  const refs = useSceneStore((s) => selectModel(s).references);
  const activeRef = useEditorStore((s) => s.activeReference);
  const pick = useEditorStore((s) => s.refPick);
  return (
    <group name="references">
      {(refs ?? []).map((r) => (
        <RefItem key={r.id} r={r} active={r.id === activeRef} />
      ))}
      {pick?.points.map((p, i) => (
        <mesh key={i} position={p} raycast={() => null}>
          <sphereGeometry args={[1, 12, 8]} />
          <meshBasicMaterial color="#ff8c1a" />
        </mesh>
      ))}
    </group>
  );
}

/** Canvas 밖: 만들기 패널 */
export function ReferencePanel() {
  const pick = useEditorStore((s) => s.refPick);
  const setPick = useEditorStore((s) => s.setRefPick);
  const [error, setError] = useState<string | null>(null);
  if (!pick) return null;
  const need = REF_POINTS[pick.type];
  const setPoint = (i: number, k: number, v: number) => {
    const pts = pick.points.map((p) => [...p] as Vec3);
    while (pts.length <= i) pts.push([0, 0, 0]);
    pts[i]![k] = v;
    setPick({ ...pick, points: pts });
  };
  const create = () => {
    const body = referenceFromPoints(pick.type, pick.points as Vec3[]);
    if (typeof body === 'string') return setError(body);
    const r = useSceneStore.getState().submitNow({ type: 'add_reference', reference: body as never });
    if (r.status === 'applied') {
      setError(null);
      setPick(null);
    } else setError(r.status === 'rejected' ? r.error : '만들지 못했습니다');
  };
  return (
    <div className="view-panel ref-panel" role="group" aria-label="참조 형상 만들기" data-testid="ref-panel">
      <strong>참조 형상</strong>
      {(Object.keys(REF_LABEL) as RefType[]).map((t) => (
        <button key={t} aria-pressed={pick.type === t} onClick={() => setPick({ type: t, points: pick.points.slice(0, REF_POINTS[t]) })} data-testid={`ref-type-${t}`}>
          {REF_LABEL[t]}
        </button>
      ))}
      <div className="ref-points">
        {Array.from({ length: need }, (_, i) => (
          <div key={i} className="ref-point" data-testid={`ref-point-${i}`}>
            <span className="muted">{REF_POINT_HINT[pick.type][i]}</span>
            {[0, 1, 2].map((k) => (
              <input
                key={k}
                type="number"
                step={1}
                aria-label={`${REF_POINT_HINT[pick.type][i]} ${'XYZ'[k]}`}
                value={pick.points[i]?.[k] ?? ''}
                placeholder={'XYZ'[k]}
                onChange={(e) => e.target.value !== '' && Number.isFinite(Number(e.target.value)) && setPoint(i, k, Number(e.target.value))}
              />
            ))}
          </div>
        ))}
      </div>
      <span className="muted">모델 위를 클릭하거나 좌표를 입력하세요 ({Math.min(pick.points.length, need)}/{need})</span>
      <button onClick={() => setPick({ ...pick, points: [] })} title="고른 점 지우기">
        지우기
      </button>
      <button className="primary" disabled={pick.points.length < need} onClick={create} data-testid="ref-create">
        ✓ 만들기
      </button>
      <button onClick={() => setPick(null)} title="취소">
        ✕
      </button>
      {error && (
        <p className="error" role="alert" data-testid="ref-error">
          {error}
        </p>
      )}
    </div>
  );
}

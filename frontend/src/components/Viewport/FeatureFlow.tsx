/**
 * 솔리드웍스식 피처 흐름 (뷰포트 쪽):
 * - PlanePicker: "스케치" 를 눌렀는데 평면이 없으면 기준 평면 3개를 띄워 클릭으로 고르게 한다 → 스케치 생성 + 그 평면을 정면으로
 * - PendingPreview: 속성 관리자에서 확인(✓)을 기다리는 피처를 반투명 미리보기 (설계 원본은 그대로)
 * - ConfirmationCorner: 뷰포트 오른쪽 위 ✓ / ✗ (Enter / Esc 와 같음)
 */
import { useMemo, useState } from 'react';
import { Box3, DoubleSide, Vector3 } from 'three';
import { Html } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import type { StandardPlane } from '../../cad/commandTypes';
import { executeCommand } from '../../cad/commandExecutor';
import { byId } from '../../cad/modelGraph';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { DEG2RAD } from '../../cad/units';
import { useEditorStore } from '../../features/selection/editorStore';
import { cancelPending, commitPending, pendingCommand, startSketchOnPlane } from '../../features/selection/featureFlow';
import { PreviewBody } from './CadObjectMesh';

/** 기준 평면 표시 (월드 좌표, 원점 중심, 크기는 모델에 맞춤): 회전·이름표 위치(평면 로컬 모서리) */
const PLANES: { type: StandardPlane['type']; label: string; rotation: [number, number, number]; color: string }[] = [
  { type: 'XY', label: '윗면', rotation: [0, 0, 0], color: '#5b8def' },
  { type: 'XZ', label: '정면', rotation: [Math.PI / 2, 0, 0], color: '#4fb06d' },
  { type: 'YZ', label: '우측면', rotation: [0, Math.PI / 2, 0], color: '#e0814c' },
];

export function PlanePicker() {
  const picking = useEditorStore((s) => s.pickingPlane);
  const selectedPlane = useEditorStore((s) => s.selectedPlane);
  const [hover, setHover] = useState<string | null>(null);
  const scene = useThree((s) => s.scene);
  const model = useSceneStore(selectModel);
  // 평면 크기 = 모델보다 조금 크게 (빈 모델이면 40mm). 너무 크면 화면을 덮어 무엇을 고르는지 알 수 없다
  const size = useMemo(() => {
    const box = new Box3();
    scene.traverse((o) => {
      if (o.userData.cadObject) box.expandByObject(o);
    });
    if (box.isEmpty()) return 40;
    const reach = Math.max(...box.min.toArray().map(Math.abs), ...box.max.toArray().map(Math.abs));
    return Math.min(2000, Math.max(40, Math.ceil(reach * 2.4)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, model, picking]);
  if (!picking && !selectedPlane) return null;
  const shown = picking ? PLANES : PLANES.filter((p) => p.type === selectedPlane);
  return (
    <>
      {shown.map((p) => (
        <mesh
          key={p.type}
          rotation={p.rotation}
          name={`plane-${p.type}`}
          userData={{ fitHelper: true }}
          onPointerOver={(e: ThreeEvent<PointerEvent>) => {
            e.stopPropagation();
            setHover(p.type);
          }}
          onPointerOut={() => setHover(null)}
          onClick={(e: ThreeEvent<MouseEvent>) => {
            if (!picking) return;
            e.stopPropagation();
            startSketchOnPlane(p.type);
          }}
        >
          <planeGeometry args={[size, size]} />
          <meshBasicMaterial color={p.color} transparent opacity={hover === p.type ? 0.4 : 0.15} side={DoubleSide} depthWrite={false} />
          {picking && (
            <Html position={new Vector3(-size / 2, size / 2, 0)} style={{ pointerEvents: 'none' }}>
              <span className={`plane-label${hover === p.type ? ' hover' : ''}`}>{p.label}</span>
            </Html>
          )}
        </mesh>
      ))}
    </>
  );
}

export function PendingPreview() {
  const pending = useEditorStore((s) => s.pending);
  const model = useSceneStore(selectModel);
  const preview = useMemo(() => {
    if (!pending) return null;
    const r = executeCommand(model, pendingCommand(pending));
    if (!r.ok || !r.affectedId) return null;
    const obj = r.model.objects.find((o) => o.id === r.affectedId);
    return obj ? { obj, index: byId(r.model) } : null;
  }, [pending, model]);
  if (!preview) return null;
  const { position, rotation } = preview.obj.transform;
  return (
    <group position={position} rotation={[rotation[0] * DEG2RAD, rotation[1] * DEG2RAD, rotation[2] * DEG2RAD]} userData={{ fitHelper: true }}>
      <PreviewBody object={preview.obj} index={preview.index} selectId={preview.obj.id} variant="ghost" />
    </group>
  );
}

export function ConfirmationCorner() {
  const pending = useEditorStore((s) => s.pending);
  const drawTool = useEditorStore((s) => s.drawTool);
  const picking = useEditorStore((s) => s.pickingPlane);
  if (!pending && !drawTool && !picking) return null;
  const cancel = () => {
    const ed = useEditorStore.getState();
    if (pending) cancelPending();
    if (ed.drawTool) ed.setDrawTool(null);
    if (ed.pickingPlane) ed.setPickingPlane(false);
  };
  return (
    <div className="confirm-corner" role="group" aria-label="확인 또는 취소">
      {picking && <span className="confirm-hint">스케치할 평면을 클릭하세요</span>}
      {(pending || drawTool) && (
        <button className="ok" data-testid="confirm-ok" title="확인 (Enter)" onClick={() => (pending ? commitPending() : useEditorStore.getState().setDrawTool(null))}>
          ✓
        </button>
      )}
      <button className="cancel" data-testid="confirm-cancel" title="취소 (Esc)" onClick={cancel}>
        ✕
      </button>
    </div>
  );
}

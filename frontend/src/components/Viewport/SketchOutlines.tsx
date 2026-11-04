import { useEffect, useMemo } from 'react';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import type { ModelDefinition, ObjectId, Sketch, SketchEntity } from '../../cad/commandTypes';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { dimensionValue, sketchFeatureRef, sketchRefs, slotOutline } from '../../cad/sketch';
import { degreesOfFreedom } from '../../cad/solver';
import { sketchWorldMatrix } from '../../cad/sketchPlane';

/**
 * 스케치 윤곽 표시 (보기 전용, 선택·편집은 속성 패널).
 * - 돌출에 쓰이지 않은 스케치와 선택한 스케치: 항상 표시
 * - 선택한 돌출 객체의 원본 스케치: 표시
 * 스케치를 쓰는 돌출이 있으면 그 돌출 객체의 월드 변환 위에 그린다 (돌출 형상과 겹쳐 보이도록).
 */
export function SketchOutlines() {
  const model = useSceneStore(selectModel);
  const selectedId = useSceneStore((s) => s.selectedId);
  const visible = useMemo(() => visibleSketches(model, selectedId), [model, selectedId]);
  return (
    <>
      {visible.map(({ sketch, frame, highlighted, dof }) => (
        <group key={sketch.id} matrixAutoUpdate={false} matrix={frame} userData={{ sketchId: sketch.id }}>
          {sketch.entities.map((e) => (
            <EntityOutline key={e.id} sketch={sketch} entity={e} color={highlighted ? (dof > 0 ? '#6fb0ff' : '#f2f4f7') : '#7f8ea6'} />
          ))}
        </group>
      ))}
    </>
  );
}

function visibleSketches(model: ModelDefinition, selectedId: ObjectId | null) {
  const selectedObj = model.objects.find((o) => o.id === selectedId);
  const activeSketch = (selectedObj && sketchFeatureRef(selectedObj)?.sketch) || selectedId;
  return model.sketches
    .map((sketch) => {
      const used = model.objects.some((o) => sketchRefs(o).some((r) => r.sketch === sketch.id));
      if (sketch.id !== activeSketch && used) return null;
      // 스케치 좌표 → 월드: (돌출 객체의 월드 변환) ∘ (평면)
      const frame = sketchWorldMatrix(model, sketch, selectedObj?.id);
      // 솔리드웍스 관례: 선택한 스케치는 덜 정의되면 파랑, 완전 정의(자유도 0)면 흰색 (어두운 배경용, 솔리드웍스의 검정에 해당)
      const highlighted = sketch.id === activeSketch;
      return frame ? { sketch, frame, highlighted, dof: highlighted ? degreesOfFreedom(sketch) : 0 } : null;
    })
    .filter((x) => x !== null);
}

function EntityOutline({ sketch, entity, color }: { sketch: Sketch; entity: SketchEntity; color: string }) {
  const geometry = useMemo(() => {
    const z = 0.02; // 돌출 바닥면과 겹쳐 깜빡이지 않도록 평면에서 살짝 띄움
    const pts: number[] = [];
    if (entity.type === 'polygon' || entity.type === 'line') {
      for (const [x, y] of entity.points) pts.push(x, y, z);
    } else if (entity.type === 'slot') {
      const length = dimensionValue(sketch, entity.id, 'length') ?? 0;
      const width = dimensionValue(sketch, entity.id, 'width') ?? 0;
      for (const [x, y] of slotOutline({ center: entity.center, angle: entity.angle, length, width }, 24)) pts.push(x, y, z);
    } else if (entity.type === 'rectangle') {
      const [cx, cy] = entity.center;
      const w = (dimensionValue(sketch, entity.id, 'width') ?? 0) / 2;
      const h = (dimensionValue(sketch, entity.id, 'height') ?? 0) / 2;
      for (const [x, y] of [[-w, -h], [w, -h], [w, h], [-w, h]] as const) pts.push(cx + x, cy + y, z);
    } else {
      const [cx, cy] = entity.center;
      const r = (dimensionValue(sketch, entity.id, 'diameter') ?? 0) / 2;
      for (let i = 0; i < 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a), z);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pts, 3));
    return g;
  }, [sketch, entity]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <lineLoop geometry={geometry} raycast={() => null}>
      <lineBasicMaterial color={color} depthTest={false} transparent opacity={0.9} />
    </lineLoop>
  );
}

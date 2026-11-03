import { useState, type ReactNode } from 'react';
import type { BufferGeometry } from 'three';
import { Edges } from '@react-three/drei';
import type { CadObject, ObjectId, PrimitiveObject } from '../../cad/commandTypes';
import { childIds } from '../../cad/modelGraph';
import { useSceneStore } from '../../cad/sceneStore';
import { DEG2RAD } from '../../cad/units';
import { useBackendStore } from '../../features/backend/backendStore';
import { geometryKey } from '../../features/backend/renderMesh';

type Index = Map<ObjectId, CadObject>;

/**
 * 객체 트리의 한 노드를 그린다.
 *
 * - 최상위 객체(mode='solid'): 서버(CadQuery) 메시가 있으면 그것을, 없으면 클라이언트 미리보기를 표시.
 *   불리언의 미리보기는 계산 전까지 피연산자를 반투명하게 보여준다.
 * - 불리언의 자식(mode='child'): 형상은 부모 결과에 포함되므로 평소엔 그리지 않고,
 *   선택되었을 때만 "고스트"로 표시한다. 그룹은 항상 존재하므로 기즈모로 자식을 직접 옮길 수 있다
 *   (그룹 계층 = 부모 기준 변환 → 기즈모 결과가 그대로 부모 좌표계 값).
 */
export function CadNode({ object, index, mode }: { object: CadObject; index: Index; mode: 'solid' | 'child' }) {
  const selected = useSceneStore((s) => s.selectedId === object.id);
  const serverGeometry = useBackendStore((s) =>
    mode === 'solid' ? s.geometries[geometryKey(object, index)] : undefined,
  );
  const { position, rotation } = object.transform;

  let body: ReactNode = null;
  if (mode === 'solid') {
    body = serverGeometry ? (
      <ObjectMesh
        key="engine"
        selectId={object.id}
        geometry={serverGeometry}
        variant="solid"
        source={serverGeometry.userData.engine === 'browser' ? 'browser' : 'server'}
      />
    ) : (
      <PreviewBody object={object} index={index} selectId={object.id} variant="solid" />
    );
  } else if (selected) {
    body = <PreviewBody object={object} index={index} selectId={object.id} variant="ghost" />;
  }

  return (
    <group
      name={object.id} // SelectionGizmo 가 이 이름으로 객체를 찾는다
      userData={{ cadObject: true }}
      position={position}
      rotation={[rotation[0] * DEG2RAD, rotation[1] * DEG2RAD, rotation[2] * DEG2RAD]}
    >
      {body}
      {childIds(object).map((id) => {
        const child = index.get(id);
        return child ? <CadNode key={id} object={child} index={index} mode="child" /> : null;
      })}
    </group>
  );
}

type Variant = 'solid' | 'translucent' | 'ghost';

/** 클라이언트 미리보기. 불리언은 피연산자를 반투명하게 그린다(정확한 결과는 서버 계산 후 표시). */
function PreviewBody({
  object,
  index,
  selectId,
  variant,
}: {
  object: CadObject;
  index: Index;
  selectId: ObjectId;
  variant: Variant;
}) {
  if (object.kind !== 'boolean') {
    return <ObjectMesh key="preview" selectId={selectId} primitive={object} variant={variant} source={variant === 'ghost' ? 'ghost' : 'preview'} />;
  }
  return (
    <>
      {childIds(object).map((id) => {
        const child = index.get(id);
        if (!child) return null;
        const { position: p, rotation: r } = child.transform;
        return (
          <group key={id} position={p} rotation={[r[0] * DEG2RAD, r[1] * DEG2RAD, r[2] * DEG2RAD]}>
            <PreviewBody object={child} index={index} selectId={selectId} variant={variant === 'ghost' ? 'ghost' : 'translucent'} />
          </group>
        );
      })}
    </>
  );
}

function ObjectMesh({
  selectId,
  geometry,
  primitive,
  variant,
  source,
}: {
  selectId: ObjectId;
  geometry?: BufferGeometry;
  primitive?: PrimitiveObject;
  variant: Variant;
  source: 'server' | 'browser' | 'preview' | 'ghost';
}) {
  const selected = useSceneStore((s) => s.selectedId === selectId);
  const select = useSceneStore((s) => s.select);
  const [hovered, setHovered] = useState(false);

  const color = variant === 'ghost' ? '#7fb0ff' : selected ? '#4f8cff' : hovered ? '#b9c2cf' : '#a3adba';
  const transparent = variant !== 'solid';

  return (
    <mesh
      {...(primitive ? primitivePlacement(primitive) : {})}
      geometry={geometry}
      userData={{ source }}
      onClick={(e) => {
        e.stopPropagation();
        select(selectId);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHovered(false);
        document.body.style.cursor = '';
      }}
    >
      {primitive && <PrimitiveGeometry object={primitive} />}
      <meshStandardMaterial
        color={color}
        roughness={0.55}
        metalness={0.05}
        transparent={transparent}
        opacity={variant === 'ghost' ? 0.18 : variant === 'translucent' ? 0.4 : 1}
        depthWrite={!transparent}
      />
      {/* 곡면의 분할선은 숨기고 실제 모서리(평면 경계)만 표시 */}
      <Edges threshold={20} color={variant === 'ghost' ? '#cfe0ff' : selected ? '#cfe0ff' : '#2a2f36'} />
    </mesh>
  );
}

const SEGMENTS = 64;

/**
 * 원점 규칙(바운딩 박스 바닥면 중심)에 맞추는 메시 배치.
 * Three.js 기본 도형은 중심이 원점이고, 원통은 Y축 방향이므로 Z축으로 눕힌다.
 */
function primitivePlacement(o: PrimitiveObject): {
  position: [number, number, number];
  rotation?: [number, number, number];
} {
  switch (o.kind) {
    case 'box':
      return { position: [0, 0, o.params.height / 2] };
    case 'cylinder':
    case 'cone':
      return { position: [0, 0, o.params.height / 2], rotation: [Math.PI / 2, 0, 0] };
    case 'sphere':
      return { position: [0, 0, o.params.radius] };
  }
}

function PrimitiveGeometry({ object: o }: { object: PrimitiveObject }) {
  switch (o.kind) {
    case 'box':
      return <boxGeometry args={[o.params.width, o.params.depth, o.params.height]} />;
    case 'cylinder':
      return <cylinderGeometry args={[o.params.radius, o.params.radius, o.params.height, SEGMENTS]} />;
    case 'cone':
      // Z축으로 눕히면(X축 +90°) 로컬 +Y(위)가 +Z가 된다 → radiusTop 이 위쪽
      return <cylinderGeometry args={[o.params.radiusTop, o.params.radiusBottom, o.params.height, SEGMENTS]} />;
    case 'sphere':
      return <sphereGeometry args={[o.params.radius, SEGMENTS, SEGMENTS / 2]} />;
  }
}

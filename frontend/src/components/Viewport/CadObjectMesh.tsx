import { useMemo, useState, type ReactNode } from 'react';
import { DoubleSide, Euler, FrontSide, Matrix4, Quaternion, Shape, Vector2, Vector3, type BufferGeometry } from 'three';
import { LATHE_TO_PLANE, extrudeLocalMatrix, extrudePreviewMatrix } from '../../cad/sketchPlane';
import { Edges } from '@react-three/drei';
import type { CadObject, ObjectId, PrimitiveObject } from '../../cad/commandTypes';
import { childIds, sketchIndex } from '../../cad/modelGraph';
import { ellipseOutline, profileOf, slotOutline, type Profile } from '../../cad/sketch';
import { roundedPoints } from '../../cad/curves';
import { pickBusy } from '../../features/selection/pick';
import { useEditorStore } from '../../features/selection/editorStore';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { DEG2RAD } from '../../cad/units';
import { useBackendStore } from '../../features/backend/backendStore';
import { geometryKey } from '../../features/backend/renderMesh';
import { isSuppressed, patternMatrices } from '../../cad/features';
import { toMatrix } from '../../cad/transformMath';

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
/** 스케치 목록 (바뀌지 않으면 같은 참조 → 재계산 없음) */
function useSketches() {
  const sketches = useSceneStore((s) => s.history.present.model.sketches);
  return useMemo(() => sketchIndex({ schemaVersion: 23, units: 'mm', sketches, objects: [] }), [sketches]);
}

export function CadNode({ object, index, mode }: { object: CadObject; index: Index; mode: 'solid' | 'child' }) {
  const selected = useSceneStore((s) => s.selectedId === object.id);
  const sketches = useSketches();
  const serverGeometry = useBackendStore((s) =>
    mode === 'solid' ? s.geometries[geometryKey(object, index, sketches)] : undefined,
  );
  const { position, rotation } = object.transform;

  let body: ReactNode = null;
  const off = isSuppressed(object, index) || object.hidden;
  if (mode === 'solid' && off) {
    // 억제·숨김: 그리지 않는다 (선택하면 위치만 유령으로)
    body = selected ? <PreviewBody object={object} index={index} selectId={object.id} variant="ghost" /> : null;
  } else if (mode === 'solid') {
    body = serverGeometry ? (
      <ObjectMesh
        key="engine"
        selectId={object.id}
        geometry={serverGeometry}
        variant="solid"
        baseColor={object.color}
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
export function PreviewBody({
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
  const sketches = useSketches();
  const model = useSceneStore(selectModel);
  if (object.kind === 'pattern') {
    // 패턴 미리보기: 원본을 사본 위치마다 (대칭은 음의 배율로 뒤집힘)
    const src = index.get(object.pattern.source);
    if (!src) return null;
    return (
      <>
        {patternMatrices(object.pattern).map((m, k) => {
          const full = m.clone().multiply(toMatrix(src.transform));
          const pos = new Vector3();
          const q = new Quaternion();
          const scl = new Vector3();
          full.decompose(pos, q, scl);
          return (
            <group key={k} position={pos} quaternion={q} scale={scl}>
              <PreviewBody object={src} index={index} selectId={selectId} variant={variant === 'ghost' ? 'ghost' : 'translucent'} />
            </group>
          );
        })}
      </>
    );
  }
  // 로프트·메시·헬릭스: 엔진 메시가 올 때까지 미리보기 없음 (브라우저·서버 엔진 모두 빠름)
  if (object.kind === 'loft' || object.kind === 'mesh' || object.kind === 'helix' || object.kind === 'step' || object.kind === 'sweep') return null;
  // 폴리메시(3D 모델링 모드)는 모델 데이터를 그대로 그린다 (components/Modeling/PolyMeshView)
  if (object.kind === 'polymesh') return null;
  if (object.kind === 'fillet' || object.kind === 'draft') {
    // 계산 전 미리보기: 원본 그대로
    const src = index.get(object.kind === 'fillet' ? object.fillet.source : object.draft.source);
    if (!src) return null;
    const { position: p, rotation: r } = src.transform;
    return (
      <group position={p} rotation={[r[0] * DEG2RAD, r[1] * DEG2RAD, r[2] * DEG2RAD]}>
        <PreviewBody object={src} index={index} selectId={selectId} variant={variant === 'ghost' ? 'ghost' : 'translucent'} />
      </group>
    );
  }
  if (object.kind !== 'boolean') {
    let profile: Profile | null = null;
    let local: Matrix4 | null = null;
    if (object.kind === 'extrude' || object.kind === 'revolve') {
      const ref = object.kind === 'extrude' ? object.extrude : object.revolve;
      const sk = sketches.get(ref.sketch);
      profile = sk ? profileOf(sk, ref) : null;
      local = extrudeLocalMatrix(model, object);
      if (!profile || !local) return null; // 참조가 깨진 돌출은 그리지 않는다 (파일 검증에서 거부되는 상태)
    }
    return (
      <ObjectMesh key="preview" selectId={selectId} primitive={object} profile={profile} local={local} variant={variant} baseColor={object.color} source={variant === 'ghost' ? 'ghost' : 'preview'} />
    );
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
  profile,
  local,
  variant,
  source,
  baseColor,
}: {
  /** 외관 색 (없으면 기본 회색) */
  baseColor?: string;
  selectId: ObjectId;
  geometry?: BufferGeometry;
  primitive?: PrimitiveObject;
  /** 돌출 미리보기용 단면 */
  profile?: Profile | null;
  /** 돌출: 스케치 평면 → 객체 로컬 (sketchPlane.extrudeLocalMatrix) */
  local?: Matrix4 | null;
  variant: Variant;
  source: 'server' | 'browser' | 'preview' | 'ghost';
}) {
  const selected = useSceneStore((s) => s.selectedId === selectId);
  const select = useSceneStore((s) => s.select);
  const [hovered, setHovered] = useState(false);

  // 밝은 배경용: 기본 회청색, 선택은 옅은 파랑, 미리보기(유령)는 반투명 파랑
  const displayMode = useEditorStore((s) => s.displayMode);
  const sectioned = useEditorStore((s) => !!s.section);
  const color = variant === 'ghost' ? '#4c9aff' : selected ? '#7fb6ff' : hovered ? '#c9d0da' : (baseColor ?? '#aeb6c2');
  const xray = displayMode === 'xray' && variant === 'solid';
  const transparent = variant !== 'solid' || xray;

  return (
    <mesh
      {...(primitive ? primitivePlacement(primitive, profile ?? null, local ?? null) : {})}
      geometry={geometry}
      userData={{ source }}
      onClick={(e) => {
        const ed = useEditorStore.getState();
        if (ed.drawTool) return; // 그리기 중 클릭은 그리기 평면이 처리
        if (pickBusy()) return; // 면·모서리 고르는 중 (PickOverlay 가 처리)
        e.stopPropagation();
        if (ed.measuring) {
          ed.addMeasurePoint(e.point.toArray() as [number, number, number]);
          return;
        }
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
      {primitive && <PrimitiveGeometry object={primitive} profile={profile ?? null} />}
      <meshStandardMaterial
        color={color}
        roughness={0.55}
        metalness={0.05}
        transparent={transparent}
        opacity={variant === 'ghost' ? 0.18 : variant === 'translucent' ? 0.4 : xray ? 0.3 : 1}
        depthWrite={!transparent}
        wireframe={displayMode === 'wireframe' && variant === 'solid'}
        side={sectioned ? DoubleSide : FrontSide}
      />
      {/* 곡면의 분할선은 숨기고 실제 모서리(평면 경계)만 표시. 음영 모드·와이어프레임에서는 생략 */}
      {(displayMode === 'shadedEdges' || displayMode === 'xray' || variant !== 'solid') && (
        <Edges threshold={20} color={variant === 'ghost' ? '#8cc0ff' : selected ? '#cfe3ff' : xray ? '#9fb4cc' : '#1a1d22'} />
      )}
    </mesh>
  );
}

const SEGMENTS = 64;

/**
 * 원점 규칙(바운딩 박스 바닥면 중심)에 맞추는 메시 배치.
 * Three.js 기본 도형은 중심이 원점이고, 원통은 Y축 방향이므로 Z축으로 눕힌다.
 */
function primitivePlacement(o: PrimitiveObject, profile: Profile | null, local: Matrix4 | null): {
  position: [number, number, number];
  rotation?: [number, number, number];
} {
  switch (o.kind) {
    case 'helix':
      return { position: [0, 0, 0] };
    case 'box':
      return { position: [0, 0, o.params.height / 2] };
    case 'cylinder':
    case 'cone':
      return { position: [0, 0, o.params.height / 2], rotation: [Math.PI / 2, 0, 0] };
    case 'hole':
      return { position: [0, 0, o.params.depth / 2], rotation: [Math.PI / 2, 0, 0] };
    case 'sphere':
      return { position: [0, 0, o.params.radius] };
    case 'extrude': {
      // 돌출: 평면 좌표에서 단면 중심 + 법선으로 distance/2 → 평면 기저로 객체 로컬에 놓는다
      if (!profile || !local) return { position: [0, 0, 0] };
      // 다각형: 평면 좌표의 ExtrudeGeometry(z 0..|d|) → 음수 거리는 법선 반대쪽으로 내린다
      const m =
        profile.type === 'polygon' || profile.type === 'slot' || profile.type === 'ellipse'
          ? local.clone().multiply(new Matrix4().makeTranslation(0, 0, Math.min(0, o.params.distance)))
          : extrudePreviewMatrix(profile, o.params.distance, local);
      const pos = new Vector3();
      const q = new Quaternion();
      m.decompose(pos, q, new Vector3());
      const e = new Euler().setFromQuaternion(q, 'XYZ');
      return { position: [pos.x, pos.y, pos.z], rotation: [e.x, e.y, e.z] };
    }
    case 'revolve': {
      // 회전: LatheGeometry(Y 축 둘레) → 스케치 평면 좌표(엔진과 같은 회전 방향) → 객체 로컬
      if (!local) return { position: [0, 0, 0] };
      const m = local.clone().multiply(LATHE_TO_PLANE);
      const pos = new Vector3();
      const q = new Quaternion();
      m.decompose(pos, q, new Vector3());
      const e = new Euler().setFromQuaternion(q, 'XYZ');
      return { position: [pos.x, pos.y, pos.z], rotation: [e.x, e.y, e.z] };
    }
  }
}

/** 회전 미리보기용 단면 윤곽 (스케치 평면 u·v, 닫힌 선) */
function profileOutline(p: Profile): Vector2[] {
  // 영역: 미리보기는 첫(합치기) 단면 윤곽으로 — 실제 형상은 엔진 메시
  if (p.type === 'region') return profileOutline(p.items[0]!.profile);
  if (p.type === 'polygon') {
    const pts = roundedPoints(p.points, p.corners, true, undefined, p.arcs, p.spline);
    return [...pts, pts[0]!].map(([x, y]) => new Vector2(x, y));
  }
  if (p.type === 'slot') {
    const pts = slotOutline(p, 16);
    return [...pts, pts[0]!].map(([x, y]) => new Vector2(x, y));
  }
  if (p.type === 'ellipse') {
    const pts = ellipseOutline(p, 48);
    return [...pts, pts[0]!].map(([x, y]) => new Vector2(x, y));
  }
  if (p.type === 'rectangle') {
    const [cx, cy] = p.center;
    const [w, h] = [p.width / 2, p.height / 2];
    return [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h], [cx - w, cy - h]].map(([x, y]) => new Vector2(x, y));
  }
  const pts: Vector2[] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    pts.push(new Vector2(p.center[0] + (p.diameter / 2) * Math.cos(a), p.center[1] + (p.diameter / 2) * Math.sin(a)));
  }
  return pts;
}

function PrimitiveGeometry({ object: o, profile }: { object: PrimitiveObject; profile: Profile | null }) {
  switch (o.kind) {
    case 'helix':
      return null;
    case 'box':
      return <boxGeometry args={[o.params.width, o.params.depth, o.params.height]} />;
    case 'cylinder':
      return <cylinderGeometry args={[o.params.radius, o.params.radius, o.params.height, SEGMENTS]} />;
    case 'cone':
      // Z축으로 눕히면(X축 +90°) 로컬 +Y(위)가 +Z가 된다 → radiusTop 이 위쪽
      return <cylinderGeometry args={[o.params.radiusTop, o.params.radiusBottom, o.params.height, SEGMENTS]} />;
    case 'sphere':
      return <sphereGeometry args={[o.params.radius, SEGMENTS, SEGMENTS / 2]} />;
    case 'extrude':
      if (profile?.type === 'polygon' || profile?.type === 'slot' || profile?.type === 'ellipse') {
        const pts = profile.type === 'slot' ? slotOutline(profile, 16) : profile.type === 'ellipse' ? ellipseOutline(profile, 48) : roundedPoints(profile.points, profile.corners, true, undefined, profile.arcs, profile.spline);
        const shape = new Shape(pts.map(([x, y]) => new Vector2(x, y)));
        return <extrudeGeometry args={[shape, { depth: Math.abs(o.params.distance), bevelEnabled: false }]} />;
      }
      if (profile?.type === 'circle') {
        const r = profile.diameter / 2;
        return <cylinderGeometry args={[r, r, Math.abs(o.params.distance), SEGMENTS]} />;
      }
      return <boxGeometry args={[profile?.type === 'rectangle' ? profile.width : 1, profile?.type === 'rectangle' ? profile.height : 1, Math.abs(o.params.distance)]} />;
    case 'revolve':
      return profile ? <latheGeometry args={[profileOutline(profile), SEGMENTS, 0, (o.params.angle * Math.PI) / 180]} /> : null;
    case 'hole':
      return <cylinderGeometry args={[o.params.diameter / 2, o.params.diameter / 2, o.params.depth, SEGMENTS]} />;
  }
}

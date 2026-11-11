import { useEffect, useRef, useState } from 'react';
import { Html, Line } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { DoubleSide, type Matrix4 } from 'three';
import type { Point2 } from '../../cad/commandTypes';
import { selectSelectedSketch, useSceneStore } from '../../cad/sceneStore';
import { completesAlone, dimensionCommand, hitTarget, planDimension, type DimPlan, type DimTarget } from '../../cad/smartDimension';
import { useActiveSketch } from '../../features/sketch/activeSketch';
import { useSketchView } from '../../features/sketch/sketchSettings';
import { useEditorStore } from '../../features/selection/editorStore';

type Editing = { at: Point2; plan: Exclude<DimPlan, { type: 'error' }> };

/**
 * 지능형 치수 도구 (솔리드웍스 Smart Dimension, D): 변·원·점을 클릭하면 대상에 맞는 치수가 정해지고
 * 그 자리에 값 입력 칸이 뜬다 (Enter = 적용, Esc = 취소). 변·점 하나 뒤에는 다음 대상을 클릭하거나,
 * 빈 곳을 클릭해 (변 = 길이) 바로 치수를 놓는다. 계산은 cad/smartDimension.ts.
 */
export function SketchDimensionTool() {
  const tool = useEditorStore((s) => s.drawTool);
  const sketch = useSceneStore(selectSelectedSketch);
  const active = useActiveSketch();
  const mmPerPx = useSketchView((s) => s.mmPerPx);
  const [hover, setHover] = useState<DimTarget | null>(null);
  const [picked, setPicked] = useState<DimTarget[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const on = tool === 'dimension' && !!sketch && !!active;

  // 도구를 끄거나 스케치가 바뀌면 고른 것 비우기
  useEffect(() => {
    setPicked([]);
    setEditing(null);
    setHover(null);
  }, [on, sketch?.id]);

  // Esc: 입력 중이면 입력만, 고른 것이 있으면 고른 것만 취소 (전역 Esc = 도구 끝내기보다 먼저)
  const state = useRef({ picked, editing });
  state.current = { picked, editing };
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const { picked: p, editing: ed } = state.current;
      if (!ed && !p.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setEditing(null);
      setPicked([]);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [on]);

  if (!on) return null;
  const frame: Matrix4 = active.frame;
  const inverse = frame.clone().invert();
  const tol = mmPerPx * 8;
  const localOf = (e: ThreeEvent<PointerEvent>): Point2 => {
    const p = e.point.clone().applyMatrix4(inverse);
    return [p.x, p.y];
  };
  const open = (targets: DimTarget[], at: Point2) => {
    const plan = planDimension(sketch, targets);
    setPicked([]);
    if (plan.type === 'error') {
      useSceneStore.getState().reportError(`치수: ${plan.message}`);
      return;
    }
    setEditing({ at, plan });
  };
  const down = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (editing) return setEditing(null); // 입력 중 바깥 클릭 = 취소
    const p = localOf(e);
    const t = hitTarget(sketch, p, tol);
    if (t) {
      if (!picked.length && completesAlone(t)) return open([t], p);
      if (picked.length === 1) return open([picked[0]!, t], p);
      return setPicked([t]);
    }
    // 빈 곳: 변 하나면 길이(폭·높이) 치수를 여기에
    if (picked.length === 1 && picked[0]!.kind === 'edge') return open(picked, p);
    if (picked.length === 1) useSceneStore.getState().reportError('치수: 점은 두 개를 고르세요 (두 점 사이 거리)');
    setPicked([]);
  };
  const commit = (value: number) => {
    if (!editing || !(value > 0)) return setEditing(null);
    useSceneStore.getState().submitNow(dimensionCommand(sketch, editing.plan, value));
    setEditing(null);
  };
  const z = 0.05;
  const mark = (t: DimTarget, color: string, key: string) =>
    t.kind === 'edge' ? (
      <Line key={key} points={[[...t.a, z], [...t.b!, z]]} color={color} lineWidth={4} depthTest={false} raycast={() => null} />
    ) : t.kind === 'circle' ? (
      <Line
        key={key}
        points={Array.from({ length: 65 }, (_, i) => [t.a[0] + t.r! * Math.cos((i / 64) * 2 * Math.PI), t.a[1] + t.r! * Math.sin((i / 64) * 2 * Math.PI), z] as [number, number, number])}
        color={color}
        lineWidth={4}
        depthTest={false}
        raycast={() => null}
      />
    ) : (
      <mesh key={key} position={[t.a[0], t.a[1], z]} raycast={() => null} renderOrder={6}>
        <circleGeometry args={[mmPerPx * 6, 20]} />
        <meshBasicMaterial color={color} depthTest={false} />
      </mesh>
    );
  return (
    <group matrixAutoUpdate={false} matrix={frame}>
      <mesh
        onPointerMove={(e) => setHover(hitTarget(sketch, localOf(e), tol))}
        onPointerDown={down}
        onPointerLeave={() => setHover(null)}
        name="sketch-dimension-plane"
      >
        <planeGeometry args={[20000, 20000]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={DoubleSide} />
      </mesh>
      {picked.map((t, i) => mark(t, '#f2a33a', `p${i}`))}
      {hover && !editing && mark(hover, '#4c9aff', 'hover')}
      {editing && <DimensionInput at={editing.at} plan={editing.plan} onCommit={commit} onCancel={() => setEditing(null)} />}
    </group>
  );
}

/** 클릭한 자리의 값 입력 칸: 지금 값이 미리 들어가 있고 전체 선택 — 숫자를 치고 Enter */
export function DimensionInput({ at, plan, onCommit, onCancel }: { at: Point2; plan: { label: string; value: number; type: string; constraint?: string }; onCommit: (v: number) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(String(plan.value));
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const unit = plan.type === 'constraint' && plan.constraint === 'angle' ? '°' : 'mm';
  return (
    <Html position={[at[0], at[1], 0]} zIndexRange={[20, 10]}>
      <div className="dim-input" data-testid="dim-input" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        <span className="muted small">{plan.label}</span>
        <input
          ref={ref}
          value={text}
          inputMode="decimal"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') onCommit(Number(text));
            else if (e.key === 'Escape') onCancel();
          }}
          aria-label={`${plan.label} 값`}
          data-testid="dim-value"
        />
        <span className="muted small">{unit}</span>
        <button onClick={() => onCommit(Number(text))} title="적용 (Enter)" data-testid="dim-ok">
          ✓
        </button>
      </div>
    </Html>
  );
}

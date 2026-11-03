/**
 * 형식 v6 피처의 속성 편집: 외관(색·숨기기)·억제, 쉘, 패턴·대칭, 패턴 만들기, 구멍 가공.
 * 모든 변경은 CAD 명령(submitNow)으로만 — AI 와 같은 경로.
 */
import { useState } from 'react';
import type { Axis, CadObject, FaceName, ModelDefinition, PatternDef } from '../../cad/commandTypes';
import { useSceneStore } from '../../cad/sceneStore';
import { shellFaces } from '../../cad/features';
import { facesOf } from '../../cad/sketchPlane';
import { PATTERN_LABEL } from '../../cad/objectKinds';
import { NumberField } from './NumberField';

const FACE_LABEL: Record<string, string> = {
  top: '윗면', bottom: '아랫면', '+X': '+X 면', '-X': '−X 면', '+Y': '+Y 면', '-Y': '−Y 면', end: '끝면', start: '시작면',
  '+u': '+u 면', '-u': '−u 면', '+v': '+v 면', '-v': '−v 면',
};
const AXES: Axis[] = ['x', 'y', 'z'];

/** 외관 색 견본 (자주 쓰는 색) */
const SWATCHES = ['#aeb6c2', '#e5534b', '#f0883e', '#e3b341', '#57ab5a', '#39c5cf', '#539bf5', '#b083f0', '#f778ba', '#2d333b', '#f5f5f5'];

export function AppearanceFields({ object }: { object: CadObject }) {
  const submit = useSceneStore((s) => s.submitNow);
  return (
    <fieldset>
      <legend>표시 · 억제</legend>
      <div className="swatches" role="group" aria-label="외관 색">
        {SWATCHES.map((c) => (
          <button
            key={c}
            className={`swatch${object.color === c ? ' active' : ''}`}
            style={{ background: c }}
            title={c}
            aria-label={`색 ${c}`}
            onClick={() => submit({ type: 'set_appearance', target: object.id, color: c === SWATCHES[0] ? 'default' : c })}
          />
        ))}
        <input
          type="color"
          aria-label="다른 색"
          value={object.color ?? '#aeb6c2'}
          onChange={(e) => submit({ type: 'set_appearance', target: object.id, color: e.target.value.toLowerCase() })}
        />
      </div>
      <label className="check">
        <input
          type="checkbox"
          data-testid="toggle-hidden"
          checked={!!object.hidden}
          onChange={(e) => submit({ type: 'set_appearance', target: object.id, hidden: e.target.checked })}
        />
        숨기기 (화면에서만 — 계산·내보내기는 그대로)
      </label>
      <label className="check">
        <input
          type="checkbox"
          data-testid="toggle-suppressed"
          checked={!!object.suppressed}
          onChange={(e) => submit({ type: 'set_suppressed', target: object.id, suppressed: e.target.checked })}
        />
        억제 (계산·내보내기에서 잠시 빼기)
      </label>
    </fieldset>
  );
}

export function ShellFields({ object }: { object: Extract<CadObject, { kind: 'box' | 'cylinder' | 'extrude' }> }) {
  const submit = useSceneStore((s) => s.submitNow);
  const shell = object.shell;
  const faces = shellFaces(object);
  const toggle = (f: FaceName) => {
    if (!shell) return;
    const open = shell.open.includes(f) ? shell.open.filter((x) => x !== f) : [...shell.open, f];
    submit({ type: 'shell', target: object.id, thickness: shell.thickness, open });
  };
  return (
    <fieldset>
      <legend>쉘 (속 비우기)</legend>
      <NumberField
        label="두께 (0 = 없음)"
        unit="mm"
        value={shell?.thickness ?? 0}
        onCommit={(v) => submit({ type: 'shell', target: object.id, thickness: v, open: shell?.open ?? (faces.includes('top') ? ['top'] : faces.includes('end') ? ['end'] : []) })}
        testId="shell-thickness"
      />
      {shell && (
        <div className="face-toggles" role="group" aria-label="열린 면">
          <span className="muted small">열린 면:</span>
          {faces.map((f) => (
            <label key={f} className="check small">
              <input type="checkbox" checked={shell.open.includes(f)} onChange={() => toggle(f)} data-testid={`shell-open-${f}`} />
              {FACE_LABEL[f] ?? f}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function PatternFields({ object }: { object: Extract<CadObject, { kind: 'pattern' }> }) {
  const submit = useSceneStore((s) => s.submitNow);
  const select = useSceneStore((s) => s.select);
  const p = object.pattern;
  const set = (patch: Partial<PatternDef>) => submit({ type: 'set_pattern', target: object.id, pattern: { ...p, ...patch } as PatternDef });
  const model = useSceneStore((s) => s.history.present.model);
  const src = model.objects.find((o) => o.id === p.source);
  return (
    <fieldset>
      <legend>{PATTERN_LABEL[p.type]}</legend>
      <div className="operands">
        원본: <button onClick={() => select(p.source)}>{src?.name ?? p.source}</button>
      </div>
      {p.type === 'mirror' ? (
        <>
          <AxisSelect label="대칭 평면" value={p.plane} options={['XY', 'XZ', 'YZ']} onChange={(v) => set({ plane: v as 'XY' })} />
          <NumberField label="평면 위치 (법선 방향)" unit="mm" value={p.offset} onCommit={(v) => set({ offset: v })} testId="pattern-offset" />
        </>
      ) : p.type === 'circular' ? (
        <>
          <AxisSelect label="회전축 (원점 지남)" value={p.axis} options={AXES} onChange={(v) => set({ axis: v as Axis })} />
          <NumberField label="개수 (원본 포함)" unit="mm" value={p.count} onCommit={(v) => set({ count: Math.round(v) })} testId="pattern-count" />
          <NumberField label="전체 각도 (360 = 균등)" unit="°" value={p.angle} onCommit={(v) => set({ angle: v })} testId="pattern-angle" />
        </>
      ) : (
        <>
          <AxisSelect label="방향 1" value={p.axis} options={AXES} onChange={(v) => set({ axis: v as Axis })} />
          <NumberField label="개수 (원본 포함)" unit="mm" value={p.count} onCommit={(v) => set({ count: Math.round(v) })} testId="pattern-count" />
          <NumberField label="간격" unit="mm" value={p.spacing} onCommit={(v) => set({ spacing: v })} testId="pattern-spacing" />
          <label className="check">
            <input
              type="checkbox"
              checked={!!p.axis2}
              data-testid="pattern-dir2"
              onChange={(e) =>
                e.target.checked
                  ? set({ axis2: p.axis === 'y' ? 'x' : 'y', count2: 2, spacing2: p.spacing })
                  : submit({ type: 'set_pattern', target: object.id, pattern: { type: 'linear', source: p.source, axis: p.axis, count: p.count, spacing: p.spacing } })
              }
            />
            방향 2 사용
          </label>
          {p.axis2 && (
            <>
              <AxisSelect label="방향 2" value={p.axis2} options={AXES} onChange={(v) => set({ axis2: v as Axis })} />
              <NumberField label="개수 2" unit="mm" value={p.count2 ?? 1} onCommit={(v) => set({ count2: Math.round(v) })} testId="pattern-count2" />
              <NumberField label="간격 2" unit="mm" value={p.spacing2 ?? 0} onCommit={(v) => set({ spacing2: v })} testId="pattern-spacing2" />
            </>
          )}
        </>
      )}
    </fieldset>
  );
}

function AxisSelect({ label, value, options, onChange }: { label: string; value: string; options: readonly string[]; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o.toUpperCase()}
          </option>
        ))}
      </select>
    </div>
  );
}

/** 최상위 객체에서 패턴·대칭 만들기 (기본값으로 만든 뒤 속성에서 조정) */
export function PatternActions({ object }: { object: CadObject }) {
  const submit = useSceneStore((s) => s.submitNow);
  const make = (pattern: PatternDef) => submit({ type: 'pattern', pattern });
  const step = 30;
  return (
    <fieldset>
      <legend>패턴 · 대칭</legend>
      <div className="row wrap">
        <button data-testid="make-linear" onClick={() => make({ type: 'linear', source: object.id, axis: 'x', count: 3, spacing: step })}>
          선형 패턴
        </button>
        <button data-testid="make-circular" onClick={() => make({ type: 'circular', source: object.id, axis: 'z', count: 6, angle: 360 })}>
          원형 패턴
        </button>
        <button data-testid="make-mirror" onClick={() => make({ type: 'mirror', source: object.id, plane: 'YZ', offset: 0 })}>
          대칭 복사
        </button>
      </div>
      <p className="muted small">축·평면은 월드 원점을 지납니다. 만든 뒤 개수·간격을 바꾸세요.</p>
    </fieldset>
  );
}

/** 구멍 가공 (Hole Wizard 에 해당): 면·위치·종류를 고르고 뚫기 */
export function HoleActions({ object, model }: { object: CadObject; model: ModelDefinition }) {
  const submit = useSceneStore((s) => s.submitNow);
  const faces = facesOf(model, object);
  const [face, setFace] = useState<FaceName>(faces[0] ?? 'top');
  const [u, setU] = useState(0);
  const [v, setV] = useState(0);
  const [kind, setKind] = useState<'simple' | 'cbore' | 'csink'>('simple');
  const [d, setD] = useState(3.4);
  const [depth, setDepth] = useState(10);
  if (!faces.length) return null;
  const run = () =>
    submit({
      type: 'hole',
      target: object.id,
      face: faces.includes(face) ? face : faces[0]!,
      at: [u, v],
      diameter: d,
      depth,
      ...(kind === 'cbore' ? { cboreDiameter: Math.round(d * 1.8 * 10) / 10, cboreDepth: Math.min(depth / 2, Math.round(d * 10) / 10) } : {}),
      ...(kind === 'csink' ? { csinkDiameter: Math.round(d * 2 * 10) / 10 } : {}),
    });
  return (
    <fieldset>
      <legend>구멍 가공</legend>
      <div className="field">
        <label>면</label>
        <select value={face} onChange={(e) => setFace(e.target.value as FaceName)} aria-label="구멍 면">
          {faces.map((f) => (
            <option key={f} value={f}>
              {FACE_LABEL[f] ?? f}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>종류</label>
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="구멍 종류">
          <option value="simple">단순 구멍</option>
          <option value="cbore">카운터보어 (볼트 머리 묻힘)</option>
          <option value="csink">카운터싱크 (접시머리)</option>
        </select>
      </div>
      <NumberField label="지름" unit="mm" value={d} onCommit={setD} testId="hole-diameter" />
      <NumberField label="깊이" unit="mm" value={depth} onCommit={setDepth} testId="hole-depth" />
      <NumberField label="면 위치 u" unit="mm" value={u} onCommit={setU} testId="hole-u" />
      <NumberField label="면 위치 v" unit="mm" value={v} onCommit={setV} testId="hole-v" />
      <button data-testid="make-hole" onClick={run}>
        구멍 뚫기
      </button>
      <p className="muted small">u·v 는 면 중심 기준 (mm). 볼트 M3 → 지름 3.4, M4 → 4.5, M5 → 5.5.</p>
    </fieldset>
  );
}

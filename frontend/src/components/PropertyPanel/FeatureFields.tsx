import { MaterialFields } from './MaterialFields';
/**
 * 형식 v6 피처의 속성 편집: 외관(색·숨기기)·억제, 쉘, 패턴·대칭, 패턴 만들기, 구멍 가공.
 * 모든 변경은 CAD 명령(submitNow)으로만 — AI 와 같은 경로.
 */
import { alignPatternToAxisCommands } from '../../cad/references';
import { curvePathOptions, sketchPatternOptions } from '../../cad/features';
import { splitOtherSide } from '../../features/selection/featureFlow';
import type { Reference } from '../../cad/commandTypes';
import { useState } from 'react';
import type { Axis, CadObject, FaceName, ModelDefinition, PatternDef } from '../../cad/commandTypes';
import { useSceneStore } from '../../cad/sceneStore';
import { shellFaces } from '../../cad/features';
import { facesOf } from '../../cad/sketchPlane';
import { EDGE_RULE_LABEL, PATTERN_LABEL } from '../../cad/objectKinds';
import { startEdgePick } from '../Viewport/PickFlows';
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
      <MaterialFields object={object} />
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
  const axes = (model.references ?? []).filter((r): r is Extract<Reference, { type: 'axis' }> => r.type === 'axis');
  return (
    <fieldset>
      <legend>{PATTERN_LABEL[p.type]}</legend>
      <div className="operands">
        원본: <button onClick={() => select(p.source)}>{src?.name ?? p.source}</button>
      </div>
      {p.type === 'scale' ? (
        <>
          {(['x', 'y', 'z'] as const).map((k) => (
            <NumberField key={k} label={`배율 ${k.toUpperCase()}`} unit="×" value={p[k]} onCommit={(v) => set({ [k]: v })} testId={`scale-${k}`} />
          ))}
          <button onClick={() => set({ x: p.x, y: p.x, z: p.x })} title="Y·Z 를 X 와 같게 (균일)">
            균일하게
          </button>
          <p className="muted small">패턴 원점(만들 때 월드 원점) 기준으로 늘리거나 줄입니다.</p>
        </>
      ) : p.type === 'mirror' ? (
        <>
          <AxisSelect label="대칭 평면" value={p.plane} options={['XY', 'XZ', 'YZ']} onChange={(v) => set({ plane: v as 'XY' })} />
          <NumberField label="평면 위치 (법선 방향)" unit="mm" value={p.offset} onCommit={(v) => set({ offset: v })} testId="pattern-offset" />
        </>
      ) : p.type === 'circular' ? (
        <>
          <AxisSelect label="회전축 (패턴 원점 지남)" value={p.axis} options={AXES} onChange={(v) => set({ axis: v as Axis })} />
          {axes.length > 0 && src && (
            <label className="drawing-field" title="패턴 좌표계를 기준 축에 맞춥니다 (원본 위치는 그대로) — 실행 취소 1번">
              <span>기준 축 둘레로</span>
              <select
                value=""
                onChange={(e) => {
                  const ax = axes.find((a) => a.id === e.target.value);
                  if (ax) useSceneStore.getState().dispatchBatch(alignPatternToAxisCommands(object, src, ax));
                }}
                data-testid="pattern-ref-axis"
              >
                <option value="">기준 축 고르기…</option>
                {axes.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <NumberField label="개수 (원본 포함)" unit="개" value={p.count} onCommit={(v) => set({ count: Math.round(v) })} testId="pattern-count" />
          <NumberField label="전체 각도 (360 = 균등)" unit="°" value={p.angle} onCommit={(v) => set({ angle: v })} testId="pattern-angle" />
        </>
      ) : p.type === 'split' ? (
        <>
          <AxisSelect label="자르는 평면" value={p.plane} options={['XY', 'XZ', 'YZ']} onChange={(v) => set({ plane: v as 'XY' })} />
          <NumberField label="평면 위치 (법선 방향)" unit="mm" value={p.offset} onCommit={(v) => set({ offset: v })} testId="split-offset" />
          <label className="drawing-field">
            <span>남길 쪽</span>
            <select value={p.keep} onChange={(e) => set({ keep: e.target.value as 'positive' })} data-testid="split-keep">
              <option value="positive">+ 쪽 ({p.plane === 'XY' ? '위' : p.plane === 'XZ' ? '+Y' : '+X'})</option>
              <option value="negative">− 쪽 ({p.plane === 'XY' ? '아래' : p.plane === 'XZ' ? '−Y' : '−X'})</option>
            </select>
          </label>
          <button
            onClick={() => splitOtherSide(object)}
            title="같은 원본을 복제해 반대쪽을 남긴 객체를 하나 더 만듭니다 (두 조각 — 실행 취소 1번)"
            data-testid="split-both"
          >
            반대쪽도 별도 객체로 (두 조각)
          </button>
        </>
      ) : p.type === 'sketch' ? (
        <>
          <label className="drawing-field">
            <span>원 중심 스케치</span>
            <select value={p.sketch} onChange={(e) => set({ sketch: e.target.value })} data-testid="pattern-sketch">
              {sketchPatternOptions(model).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">스케치의 첫 원 중심에 있던 원본을 다른 원 중심마다 옮겨 놓습니다 (원은 구성선이어도 됩니다).</p>
        </>
      ) : p.type === 'curve' ? (
        <>
          <CurvePathSelect value={{ sketch: p.sketch, path: p.path }} onChange={(v) => set(v)} />
          <NumberField label="개수 (원본 포함)" unit="개" value={p.count} onCommit={(v) => set({ count: Math.round(v) })} testId="pattern-count" />
          <label className="check">
            <input type="checkbox" checked={p.align} onChange={(e) => set({ align: e.target.checked })} data-testid="pattern-align" />
            선의 방향을 따라 돌리기
          </label>
          <p className="muted small">선 시작점에 있던 원본을 선 길이로 같은 간격씩 옮깁니다.</p>
        </>
      ) : (
        <>
          <AxisSelect label="방향 1" value={p.axis} options={AXES} onChange={(v) => set({ axis: v as Axis })} />
          <NumberField label="개수 (원본 포함)" unit="개" value={p.count} onCommit={(v) => set({ count: Math.round(v) })} testId="pattern-count" />
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
              <NumberField label="개수 2" unit="개" value={p.count2 ?? 1} onCommit={(v) => set({ count2: Math.round(v) })} testId="pattern-count2" />
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

/** 로프트: 단면 목록 (스케치로 이동) · 가져온 메시: 삼각형 수 */
export function LoftOrMeshInfo({ object }: { object: Extract<CadObject, { kind: 'loft' | 'mesh' }> }) {
  const select = useSceneStore((s) => s.select);
  const model = useSceneStore((s) => s.history.present.model);
  if (object.kind === 'mesh') {
    return (
      <fieldset>
        <legend>가져온 메시</legend>
        <p className="muted small">
          삼각형 {Math.round((object.mesh.indices.length * 3) / 4 / 12).toLocaleString()}개. 위치·회전·패턴·불리언·내보내기에 쓸 수 있습니다
          (치수 편집은 원래 CAD 에서).
        </p>
      </fieldset>
    );
  }
  return (
    <fieldset>
      <legend>로프트 단면</legend>
      <ol className="loft-sections">
        {object.loft.sections.map((s, i) => (
          <li key={i}>
            <button onClick={() => select(s.sketch)}>{model.sketches.find((k) => k.id === s.sketch)?.name ?? s.sketch}</button>
            <span className="muted"> · {s.profile}</span>
          </li>
        ))}
      </ol>
      <p className="muted small">단면 스케치의 치수·평면 거리를 바꾸면 로프트가 다시 계산됩니다.</p>
    </fieldset>
  );
}

/** 정밀 엔진 피처: 모서리 처리(규칙 선택) · 구배 · STEP */
export function PreciseFields({ object }: { object: Extract<CadObject, { kind: 'fillet' | 'draft' | 'step' }> }) {
  const submit = useSceneStore((s) => s.submitNow);
  const select = useSceneStore((s) => s.select);
  if (object.kind === 'step') {
    return (
      <fieldset>
        <legend>가져온 STEP</legend>
        <p className="muted small">정확한 곡면(B-rep) 그대로입니다. 위치·회전·불리언·모서리 처리·내보내기에 쓸 수 있습니다.</p>
      </fieldset>
    );
  }
  const source = object.kind === 'fillet' ? object.fillet.source : object.draft.source;
  return (
    <fieldset>
      <legend>{object.kind === 'draft' ? '구배' : '모서리 처리'}</legend>
      <div className="operands">
        원본: <button onClick={() => select(source)}>{source}</button>
      </div>
      {object.kind === 'draft' ? (
        <NumberField
          label="각도 (+ 위로 갈수록 안쪽)"
          unit="°"
          value={object.draft.angle}
          onCommit={(v) => submit({ type: 'set_draft', target: object.id, angle: v })}
          testId="draft-angle"
        />
      ) : (
        <>
          <div className="field">
            <label htmlFor="ef-type">처리</label>
            <select id="ef-type" value={object.fillet.type} onChange={(e) => submit({ type: 'set_edge_feature', target: object.id, feature: e.target.value as 'fillet' })}>
              <option value="fillet">필렛 (둥글게)</option>
              <option value="chamfer">모따기 (비스듬히)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="ef-edges">모서리</label>
            <select
              id="ef-edges"
              data-testid="ef-edges"
              value={typeof object.fillet.edges === 'string' ? object.fillet.edges : 'picked'}
              onChange={(e) => submit({ type: 'set_edge_feature', target: object.id, edges: e.target.value as 'all' })}
            >
              {typeof object.fillet.edges !== 'string' && <option value="picked" disabled>고른 모서리 {object.fillet.edges.at.length}개</option>}
              {(Object.keys(EDGE_RULE_LABEL) as (keyof typeof EDGE_RULE_LABEL)[]).map((k) => (
                <option key={k} value={k}>
                  {EDGE_RULE_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          <NumberField
            label={object.fillet.type === 'fillet' ? '반지름' : '거리'}
            unit="mm"
            value={object.fillet.size}
            onCommit={(v) => submit({ type: 'set_edge_feature', target: object.id, size: v })}
            testId="ef-size"
          />
          {object.fillet.type === 'fillet' && (
            <>
              <label className="check" title="모서리 시작에서 끝으로 반지름이 고르게 바뀌는 필렛 (솔리드웍스 가변 반경 필렛)">
                <input
                  type="checkbox"
                  checked={object.fillet.size2 !== undefined}
                  onChange={(e) => submit({ type: 'set_edge_feature', target: object.id, size2: e.target.checked ? Math.round(object.fillet.size * 2 * 1000) / 1000 : 0 })}
                  data-testid="ef-variable"
                />
                가변 반경 (시작 → 끝)
              </label>
              {object.fillet.size2 !== undefined && (
                <NumberField label="끝 반지름" unit="mm" value={object.fillet.size2} onCommit={(v) => submit({ type: 'set_edge_feature', target: object.id, size2: v })} testId="ef-size2" />
              )}
            </>
          )}
          <button onClick={() => startEdgePick(object)} data-testid="ef-pick" title="원본 형상의 모서리를 화면에서 클릭해 고릅니다 (다시 클릭하면 뺌, Enter 적용)">
            화면에서 모서리 고르기
          </button>
        </>
      )}
      <p className="muted small">정밀 엔진(OCCT)으로 계산합니다. 모서리를 고르는 기준: 월드 Z (위·아래·세로).</p>
    </fieldset>
  );
}

function CurvePathSelect({ value, onChange }: { value: { sketch: string; path: string }; onChange: (v: { sketch: string; path: string }) => void }) {
  const model = useSceneStore((s) => s.history.present.model);
  const opts = curvePathOptions(model);
  const key = `${value.sketch}/${value.path}`;
  return (
    <label className="drawing-field">
      <span>따라갈 선</span>
      <select
        value={key}
        onChange={(e) => {
          const o = opts.find((x) => `${x.sketch}/${x.path}` === e.target.value);
          if (o) onChange({ sketch: o.sketch, path: o.path });
        }}
        data-testid="pattern-curve-path"
      >
        {!opts.some((o) => `${o.sketch}/${o.path}` === key) && <option value={key}>{key} (없음)</option>}
        {opts.map((o) => (
          <option key={`${o.sketch}/${o.path}`} value={`${o.sketch}/${o.path}`}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

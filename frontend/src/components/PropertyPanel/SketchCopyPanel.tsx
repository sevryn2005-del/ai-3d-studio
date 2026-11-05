import { useState } from 'react';
import type { CadCommand, Point2, Sketch } from '../../cad/commandTypes';
import { useSceneStore } from '../../cad/sceneStore';
import { copyEntityCommands, mirrorXform, rotateXform, symmetricRelations, translateXform } from '../../cad/sketchCopy';
import { withRelations } from '../../cad/autoRelations';
import { NumberField } from './NumberField';

type Mode = 'mirror' | 'linear' | 'circular';
const ENTITY_LABEL: Record<string, string> = { rectangle: '사각형', circle: '원', polygon: '다각형', path: '경로', line: '구성선', slot: '슬롯', ellipse: '타원' };

/**
 * 스케치 요소 대칭·패턴 복사 (솔리드웍스 요소 대칭 복사 / 직선·원형 스케치 패턴).
 * 구성선을 축으로 대칭하면 대칭 구속도 넣어 원본을 고치면 복사본이 따라온다. 복사 전체 = 실행 취소 1번.
 */
export function SketchCopyPanel({ sketch }: { sketch: Sketch }) {
  const copyable = sketch.entities.filter((e) => ENTITY_LABEL[e.type]);
  const lines = sketch.entities.filter((e) => e.type === 'line');
  const [picked, setPicked] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>('mirror');
  const [axis, setAxis] = useState('v'); // 'u' | 'v' | 구성선 ID
  const [keep, setKeep] = useState(true);
  const [count, setCount] = useState(3);
  const [du, setDu] = useState(20);
  const [dv, setDv] = useState(0);
  const [center, setCenter] = useState<Point2>([0, 0]);
  const [total, setTotal] = useState(360);
  if (!copyable.length) return null;
  const sel = picked.filter((id) => copyable.some((e) => e.id === id));

  const run = () => {
    const store = useSceneStore.getState();
    const model = store.history.present.model;
    const taken = new Set(sketch.entities.map((e) => e.id));
    let commands: CadCommand[] = [];
    let rels: ReturnType<typeof symmetricRelations> = [];
    if (mode === 'mirror') {
      const line = lines.find((l) => l.id === axis);
      const [a, b]: [Point2, Point2] = line && line.type === 'line' ? [line.points[0], line.points[1]] : axis === 'u' ? [[0, 0], [1, 0]] : [[0, 0], [0, 1]];
      const r = copyEntityCommands(sketch, sel, mirrorXform(a, b), taken);
      commands = r.commands;
      if (line && keep) rels = symmetricRelations(r.pairs, `${line.id}.e0`);
    } else {
      for (let k = 1; k < count; k++) {
        const x = mode === 'linear' ? translateXform(du * k, dv * k) : rotateXform(center, ((total === 360 ? 360 / count : total / Math.max(1, count - 1)) * k));
        commands.push(...copyEntityCommands(sketch, sel, x, taken).commands);
      }
    }
    if (!commands.length) return;
    const { commands: all } = withRelations(model, commands, sketch.id, rels);
    store.dispatchBatch(all);
  };

  return (
    <fieldset className="sketch-copy" data-testid="sketch-copy">
      <legend>대칭·패턴 복사</legend>
      <div className="copy-pick">
        {copyable.map((e) => (
          <label key={e.id} className="check">
            <input
              type="checkbox"
              checked={sel.includes(e.id)}
              onChange={(ev) => setPicked(ev.target.checked ? [...sel, e.id] : sel.filter((x) => x !== e.id))}
              data-testid={`copy-pick-${e.id}`}
            />
            {ENTITY_LABEL[e.type]} {e.id}
          </label>
        ))}
      </div>
      <div className="field">
        <label htmlFor="copy-mode">방법</label>
        <select id="copy-mode" value={mode} onChange={(e) => setMode(e.target.value as Mode)} data-testid="copy-mode">
          <option value="mirror">대칭 복사</option>
          <option value="linear">직선 패턴</option>
          <option value="circular">원형 패턴</option>
        </select>
      </div>
      {mode === 'mirror' && (
        <>
          <div className="field">
            <label htmlFor="copy-axis">대칭 축</label>
            <select id="copy-axis" value={axis} onChange={(e) => setAxis(e.target.value)} data-testid="copy-axis">
              <option value="v">세로 축 (u = 0)</option>
              <option value="u">가로 축 (v = 0)</option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  구성선 {l.id}
                </option>
              ))}
            </select>
          </div>
          {lines.some((l) => l.id === axis) && (
            <label className="check">
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> 대칭 구속 (원본을 고치면 따라옴)
            </label>
          )}
        </>
      )}
      {mode !== 'mirror' && <NumberField label="개수 (원본 포함)" unit="개" value={count} onCommit={(v) => setCount(Math.max(2, Math.min(50, Math.round(v))))} testId="copy-count" />}
      {mode === 'linear' && (
        <>
          <NumberField label="간격 u" unit="mm" value={du} onCommit={setDu} testId="copy-du" />
          <NumberField label="간격 v" unit="mm" value={dv} onCommit={setDv} testId="copy-dv" />
        </>
      )}
      {mode === 'circular' && (
        <>
          <NumberField label="중심 u" unit="mm" value={center[0]} onCommit={(v) => setCenter([v, center[1]])} />
          <NumberField label="중심 v" unit="mm" value={center[1]} onCommit={(v) => setCenter([center[0], v])} />
          <NumberField label="전체 각도" unit="°" value={total} onCommit={(v) => setTotal(Math.max(1, Math.min(360, v)))} />
        </>
      )}
      <button disabled={!sel.length} onClick={run} data-testid="copy-run">
        복사 ({sel.length}개 요소)
      </button>
    </fieldset>
  );
}

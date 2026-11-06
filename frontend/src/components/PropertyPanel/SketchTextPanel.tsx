import { useState } from 'react';
import type { Point2, Sketch } from '../../cad/commandTypes';
import { useSceneStore } from '../../cad/sceneStore';
import { missingChars, textContours, textSketchCommands } from '../../cad/sketchText';
import { loadSketchFont } from '../../features/sketch/sketchFont';
import { useProjectStore } from '../../features/projects/projectStore';
import { NumberField } from './NumberField';

/**
 * 스케치 텍스트 (솔리드웍스 스케치 텍스트): 글자를 글꼴 윤곽(다각형)과 영역 하나로 넣는다 → 영역을 돌출·컷하면 양각·음각.
 * 넣은 글자는 보통의 윤곽이라 다시 고칠 수 없다 (지우고 새로 넣기). 전체 = 실행 취소 1번
 */
export function SketchTextPanel({ sketch }: { sketch: Sketch }) {
  const [text, setText] = useState('');
  const [size, setSize] = useState(10);
  const [center, setCenter] = useState<Point2>([0, 0]);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    const scene = useSceneStore.getState();
    try {
      const font = await loadSketchFont();
      const missing = missingChars(font, t);
      if (missing.length) return scene.reportError(`텍스트: 글꼴에 없는 글자가 있습니다 (${missing.join(' ')}) — 자주 쓰는 한글 2,350자·영문·숫자를 쓸 수 있습니다`);
      const sk = scene.history.present.model.sketches.find((s) => s.id === sketch.id);
      if (!sk) return;
      const contours = textContours(font, { text: t, size, center });
      const r = textSketchCommands(contours, sk.id, new Set(sk.entities.map((e) => e.id)), 100 - sk.entities.length);
      if (!r.commands.length) return scene.reportError(`텍스트: ${r.warnings.join(' · ')}`);
      const res = scene.dispatchBatch(r.commands);
      if (res.ok) {
        scene.select(sk.id);
        useProjectStore.getState().set({ notice: `텍스트 "${t.replace(/\n/g, ' ')}": 윤곽 ${r.contours}개 → 영역 ${r.regionId} (영역을 돌출하면 양각, 돌출 컷하면 음각)` });
        setText('');
      }
    } catch (e) {
      scene.reportError(`텍스트: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="sketch-text" data-testid="sketch-text">
      <legend>텍스트</legend>
      <textarea
        value={text}
        rows={2}
        placeholder="새길 글자 (한글·영문·숫자, 줄바꿈 가능)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        data-testid="sketch-text-input"
        aria-label="텍스트 내용"
      />
      <NumberField label="글자 크기" unit="mm" value={size} onCommit={(v) => v >= 0.5 && v <= 1000 && setSize(v)} testId="sketch-text-size" />
      <NumberField label="가운데 u" unit="mm" value={center[0]} onCommit={(v) => setCenter([v, center[1]])} />
      <NumberField label="가운데 v" unit="mm" value={center[1]} onCommit={(v) => setCenter([center[0], v])} />
      <button onClick={() => void run()} disabled={busy || !text.trim()} data-testid="sketch-text-add" title="글자를 윤곽으로 넣고 영역 하나로 묶습니다 (실행 취소 1번)">
        {busy ? '글꼴 읽는 중…' : '텍스트 넣기'}
      </button>
    </fieldset>
  );
}

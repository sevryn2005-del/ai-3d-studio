import { useEffect, useState } from 'react';
import { DEFAULT_MATERIAL, type CadObject } from '../../cad/commandTypes';
import { useSceneStore } from '../../cad/sceneStore';

/** 자주 쓰는 재질 (금속성·거칠기). 첫 항목 = 기본 (재질 지우기) */
export const MATERIAL_PRESETS: { id: string; label: string; m: { metallic: number; roughness: number } | null }[] = [
  { id: 'default', label: '기본 (플라스틱)', m: null },
  { id: 'gloss', label: '광택 플라스틱', m: { metallic: 0, roughness: 0.2 } },
  { id: 'matte', label: '무광 플라스틱', m: { metallic: 0, roughness: 0.85 } },
  { id: 'rubber', label: '고무', m: { metallic: 0, roughness: 0.95 } },
  { id: 'metal', label: '금속 (광택)', m: { metallic: 1, roughness: 0.2 } },
  { id: 'brushed', label: '금속 (무광·헤어라인)', m: { metallic: 1, roughness: 0.5 } },
];

const presetOf = (m: CadObject['material']) => MATERIAL_PRESETS.find((p) => (p.m === null ? !m : m && p.m.metallic === m.metallic && p.m.roughness === m.roughness))?.id ?? 'custom';

/**
 * PBR 재질 (형식 v29): 미리 정한 재질 + 금속성·거칠기 막대. 막대는 놓을 때 set_appearance 하나 (실행 취소 1번).
 * 화면과 GLB 내보내기(두 엔진)에 같이 쓰인다
 */
export function MaterialFields({ object }: { object: CadObject }) {
  const submit = useSceneStore((s) => s.submitNow);
  const cur = object.material ?? DEFAULT_MATERIAL;
  const [draft, setDraft] = useState({ metallic: cur.metallic, roughness: cur.roughness });
  useEffect(() => setDraft({ metallic: cur.metallic, roughness: cur.roughness }), [cur.metallic, cur.roughness]);
  const commit = () => {
    if (draft.metallic !== cur.metallic || draft.roughness !== cur.roughness) submit({ type: 'set_appearance', target: object.id, material: { ...draft } });
  };
  const slider = (k: 'metallic' | 'roughness', label: string) => (
    <label className="slider" title={k === 'metallic' ? '0 = 비금속(플라스틱·나무), 1 = 금속' : '0 = 거울처럼 매끈, 1 = 거칠어 반사가 흐림'}>
      {label}
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={draft[k]}
        onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        data-testid={`material-${k}`}
      />
      <span>{Math.round(draft[k] * 100)}%</span>
    </label>
  );
  return (
    <div className="material-fields" data-testid="material-fields">
      <label className="drawing-field">
        <span>재질</span>
        <select
          value={presetOf(object.material)}
          onChange={(e) => {
            const p = MATERIAL_PRESETS.find((x) => x.id === e.target.value);
            if (p) submit({ type: 'set_appearance', target: object.id, material: p.m ?? 'default' });
          }}
          data-testid="material-preset"
        >
          {MATERIAL_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          {presetOf(object.material) === 'custom' && <option value="custom">직접 정함</option>}
        </select>
      </label>
      {slider('metallic', '금속성')}
      {slider('roughness', '거칠기')}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { DEFAULT_MATERIAL, MAX_TEXTURE_CHARS, type CadObject } from '../../cad/commandTypes';
import { useSceneStore } from '../../cad/sceneStore';
import { NumberField } from './NumberField';

/** 텍스처 한 장이 덮는 기본 크기 (mm) */
export const DEFAULT_TEXTURE_TILE = 50;

/** 파일 → data URL (로컬에서만 읽음, 업로드 없음) */
function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('파일을 읽지 못했습니다'));
    r.readAsDataURL(file);
  });
}

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
      <TextureFields object={object} />
    </div>
  );
}

/**
 * 텍스처 이미지 (형식 v30): PNG·JPEG 를 저장 파일 안에 넣고 객체 로컬 박스 투영으로 입힌다 (한 장 = tile mm).
 * 화면과 GLB 내보내기(두 엔진)에 같은 규칙 — STL·3MF·STEP 에는 형상만 나간다
 */
function TextureFields({ object }: { object: CadObject }) {
  const submit = useSceneStore((s) => s.submitNow);
  const [error, setError] = useState<string | null>(null);
  const tex = object.texture;
  const pick = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) return setError('PNG 또는 JPEG 이미지만 넣을 수 있습니다');
    const image = await readDataUrl(file);
    if (image.length > MAX_TEXTURE_CHARS) return setError(`이미지가 너무 큽니다 (약 ${Math.floor((MAX_TEXTURE_CHARS * 3) / 4 / 1e6)}MB 까지) — 줄여서 넣으세요`);
    submit({ type: 'set_appearance', target: object.id, texture: { image, tile: tex?.tile ?? DEFAULT_TEXTURE_TILE } });
  };
  return (
    <div className="texture-fields" data-testid="texture-fields">
      <label className="drawing-field" title="PNG·JPEG 이미지를 겉면에 반복해 입힙니다 (저장 파일에 함께 들어가고, GLB 로 내보내짐)">
        <span>텍스처</span>
        <input
          type="file"
          accept="image/png,image/jpeg"
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = '';
          }}
          data-testid="texture-file"
        />
      </label>
      {tex && (
        <>
          <div className="texture-current">
            <img src={tex.image} alt="텍스처" className="texture-thumb" data-testid="texture-thumb" />
            <button type="button" onClick={() => submit({ type: 'set_appearance', target: object.id, texture: 'default' })} data-testid="texture-remove">
              텍스처 지우기
            </button>
          </div>
          <label className="field" title="박스 투영: 면 방향마다 반복 무늬 (한 장 = 크기 mm). 스마트 UV: 면 묶음마다 펼쳐 이미지 한 장에 겹치지 않게 (스티커·라벨·도색용)">
            UV
            <select
              value={tex.projection ?? 'box'}
              onChange={(e) => {
                const { projection: _p, ...rest } = tex;
                submit({ type: 'set_appearance', target: object.id, texture: e.target.value === 'smart' ? { ...rest, projection: 'smart' } : rest });
              }}
              data-testid="texture-projection"
            >
              <option value="box">박스 투영 (반복)</option>
              <option value="smart">스마트 UV 펼치기 (한 장)</option>
            </select>
          </label>
          {tex.projection !== 'smart' && (
            <NumberField
              label="한 장 크기"
              value={tex.tile}
              unit="mm"
              onCommit={(tile) => submit({ type: 'set_appearance', target: object.id, texture: { ...tex, tile } })}
              testId="texture-tile"
            />
          )}
        </>
      )}
      {error && (
        <p className="error" role="alert" data-testid="texture-error">
          {error}
        </p>
      )}
    </div>
  );
}

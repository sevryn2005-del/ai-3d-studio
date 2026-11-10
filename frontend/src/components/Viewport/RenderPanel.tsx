/**
 * 렌더 패널 (블렌더 F12): 크기·품질·그림자·앰비언트 오클루전·배경 → 렌더 → 미리보기 → PNG 저장.
 * RenderTaker 는 캔버스 안에서 실제로 그린다 (지금 카메라 그대로).
 */
import { useEffect, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { RENDER_SIZES, renderImage, type RenderOptions } from '../../features/render/renderImage';
import { useRenderStore } from '../../features/render/renderStore';
import { downloadBlob } from '../../features/projects/projectStorage';
import { useProjectStore } from '../../features/projects/projectStore';
import { useSceneStore } from '../../cad/sceneStore';

/** 캔버스 안: 요청이 오면 그리고 결과를 넘긴다 */
export function RenderTaker() {
  const request = useRenderStore((s) => s.request);
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    if (!request) return;
    const t0 = performance.now();
    // 선택 강조색 없이 원래 색으로: 잠시 선택을 풀고 두 프레임 뒤에 그린 다음 되돌린다
    const scene0 = useSceneStore.getState();
    const selected = scene0.selectedId;
    if (selected) scene0.select(null);
    const restore = () => {
      if (selected) useSceneStore.getState().select(selected);
    };
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        renderImage(gl, scene, camera, request.options).then(
          (blob) => {
            restore();
            useRenderStore.getState().finish({ blob, width: request.options.width, height: request.options.height, ms: Math.round(performance.now() - t0) });
          },
          (e: unknown) => {
            restore();
            useRenderStore.getState().finish({ error: e instanceof Error ? e.message : String(e) });
          },
        );
      }),
    );
    // 요청 번호가 바뀔 때만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.n]);
  return null;
}

const QUALITY = [
  { id: 'fast', label: '빠르게 (AA 4번)', samples: 2 },
  { id: 'good', label: '좋게 (AA 16번)', samples: 4 },
] as const;

export function RenderPanel() {
  const open = useRenderStore((s) => s.open);
  const busy = useRenderStore((s) => s.busy);
  const result = useRenderStore((s) => s.result);
  const error = useRenderStore((s) => s.error);
  const [size, setSize] = useState<(typeof RENDER_SIZES)[number]['id']>('fhd');
  const [quality, setQuality] = useState<(typeof QUALITY)[number]['id']>('good');
  const [shadows, setShadows] = useState(true);
  const [ao, setAo] = useState(true);
  const [background, setBackground] = useState<RenderOptions['background']>('white');
  if (!open) return null;
  const start = () => {
    const s = RENDER_SIZES.find((x) => x.id === size)!;
    useRenderStore.getState().start({ width: s.w, height: s.h, samples: QUALITY.find((q) => q.id === quality)!.samples, shadows, ao, background });
  };
  const save = async () => {
    if (!result) return;
    const blob = await (await fetch(result.url)).blob();
    await downloadBlob(blob, `${useProjectStore.getState().name || '렌더'} 렌더.png`);
  };
  return (
    <div className="view-panel mass-panel render-panel" role="dialog" aria-label="렌더" data-testid="render-panel">
      <div className="pm-head">
        <strong>렌더</strong>
        <button onClick={() => useRenderStore.getState().setOpen(false)} title="닫기">
          ✕
        </button>
      </div>
      <label className="drawing-field">
        <span>크기</span>
        <select value={size} onChange={(e) => setSize(e.target.value as typeof size)} data-testid="render-size">
          {RENDER_SIZES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label className="drawing-field">
        <span>품질</span>
        <select value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)} data-testid="render-quality">
          {QUALITY.map((q) => (
            <option key={q.id} value={q.id}>
              {q.label}
            </option>
          ))}
        </select>
      </label>
      <label className="drawing-field">
        <span>배경</span>
        <select value={background} onChange={(e) => setBackground(e.target.value as RenderOptions['background'])} data-testid="render-background">
          <option value="white">흰색</option>
          <option value="dark">어두운 색</option>
          <option value="transparent">투명 (PNG)</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={shadows} onChange={(e) => setShadows(e.target.checked)} data-testid="render-shadows" /> 바닥 그림자
      </label>
      <label className="check">
        <input type="checkbox" checked={ao} onChange={(e) => setAo(e.target.checked)} data-testid="render-ao" /> 구석 그늘 (앰비언트 오클루전)
      </label>
      <button className="primary" disabled={busy} onClick={start} data-testid="render-start">
        {busy ? '렌더 중…' : '렌더'}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <img src={result.url} alt="렌더 결과" className="render-preview" data-testid="render-preview" />
          <p className="muted small" data-testid="render-info">
            {result.width} × {result.height} · {(result.ms / 1000).toFixed(1)}초
          </p>
          <button onClick={() => void save()} data-testid="render-save">
            PNG 저장
          </button>
        </>
      )}
      <p className="muted small">지금 카메라 그대로 그립니다. 격자·선·스케치는 빠집니다 (실사 경로 추적은 다음 단계).</p>
    </div>
  );
}

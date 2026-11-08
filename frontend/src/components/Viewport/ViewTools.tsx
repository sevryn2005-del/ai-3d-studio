/**
 * 보기·분석 도구 (솔리드웍스 "보기" 도구 모음 / 블렌더 뷰포트 셰이딩·측정에 해당).
 * Canvas 안: SectionClip(단면 자르기), MeasureOverlay(측정 선·값), ScreenshotTaker(PNG 저장)
 * Canvas 밖: SectionPanel(단면 위치), MassPanel(질량 특성), MeasureReadout(측정 값)
 * 모두 표시 상태만 바꾼다 — 설계 원본은 그대로.
 */
import { DRAFT_COLORS, DRAFT_LABELS, useDraftStats, type DraftClass } from '../../cad/draftAnalysis';
import { useEffect, useMemo, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import { Plane, Vector3 } from 'three';
import { useEditorStore, type SectionView, type DraftView } from '../../features/selection/editorStore';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { byId, sketchIndex, topLevelObjects } from '../../cad/modelGraph';
import { isSuppressed } from '../../cad/features';
import { useBackendStore } from '../../features/backend/backendStore';
import { geometryKey } from '../../features/backend/renderMesh';
import { toMatrix } from '../../cad/transformMath';
import { MATERIALS, combine, massGrams, meshProperties } from '../../cad/massProperties';
import { formatMm } from '../../cad/units';
import { downloadBlob } from '../../features/projects/projectStorage';
import { useProjectStore } from '../../features/projects/projectStore';
import { resolveProfile } from '../../cad/sketch';

const NORMAL = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } as const;

/** 단면: 렌더러 전역 자르기 평면. 평면의 양(+)쪽이 남는다 → 기본은 축의 음(−)쪽을 남기도록 법선을 뒤집는다 */
export function SectionClip() {
  const section = useEditorStore((s) => s.section);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    if (!section) {
      gl.clippingPlanes = [];
      return;
    }
    const n = new Vector3(...NORMAL[section.axis]).multiplyScalar(section.flip ? 1 : -1);
    gl.clippingPlanes = [new Plane(n, section.flip ? -section.offset : section.offset)];
    return () => {
      gl.clippingPlanes = [];
    };
  }, [section, gl]);
  return null;
}

export function MeasureOverlay() {
  const pts = useEditorStore((s) => s.measurePoints);
  const measuring = useEditorStore((s) => s.measuring);
  if (!measuring || pts.length === 0) return null;
  return (
    <>
      {pts.map((p, i) => (
        <mesh key={i} position={p} renderOrder={10}>
          <sphereGeometry args={[0.8, 12, 8]} />
          <meshBasicMaterial color="#ffd166" depthTest={false} />
        </mesh>
      ))}
      {pts.length === 2 && (
        <>
          <Line points={pts} color="#ffd166" lineWidth={2} depthTest={false} />
          <Html position={new Vector3(...pts[0]!).add(new Vector3(...pts[1]!)).multiplyScalar(0.5)} center style={{ pointerEvents: 'none' }}>
            <span className="measure-label">{formatMm(new Vector3(...pts[0]!).distanceTo(new Vector3(...pts[1]!)))} mm</span>
          </Html>
        </>
      )}
    </>
  );
}

/** 화면 이미지 저장 (PNG). 요청 시 한 번 그리고 바로 읽는다 (preserveDrawingBuffer 없이) */
export function ScreenshotTaker() {
  const n = useEditorStore((s) => s.screenshotRequest);
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    if (!n) return;
    gl.render(scene, camera);
    gl.domElement.toBlob((blob) => {
      if (blob) void downloadBlob(blob, `${useProjectStore.getState().name || '화면'}.png`);
    }, 'image/png');
  }, [n, gl, scene, camera]);
  return null;
}

export function SectionPanel() {
  const section = useEditorStore((s) => s.section);
  const setSection = useEditorStore((s) => s.setSection);
  if (!section) return null;
  const set = (patch: Partial<SectionView>) => setSection({ ...section, ...patch });
  return (
    <div className="view-panel section-panel" role="group" aria-label="단면 보기">
      <strong>단면</strong>
      {(['x', 'y', 'z'] as const).map((a) => (
        <button key={a} aria-pressed={section.axis === a} onClick={() => set({ axis: a })}>
          {a.toUpperCase()}
        </button>
      ))}
      <input
        type="range"
        min={-200}
        max={200}
        step={0.5}
        value={section.offset}
        aria-label="단면 위치"
        data-testid="section-offset"
        onChange={(e) => set({ offset: Number(e.target.value) })}
      />
      <span className="muted">{formatMm(section.offset)} mm</span>
      <button onClick={() => set({ flip: !section.flip })} title="반대쪽 보기">
        ⇄
      </button>
      <button onClick={() => setSection(null)} title="단면 끄기">
        ✕
      </button>
    </div>
  );
}

/** 구배 분석 패널: 빼는 방향(축·뒤집기)·한계 각, 색 범례와 넓이 비율 */
export function DraftPanel() {
  const draft = useEditorStore((s) => s.draft);
  const setDraft = useEditorStore((s) => s.setDraft);
  const stats = useDraftStats((s) => s.byObject);
  if (!draft) return null;
  const set = (patch: Partial<DraftView>) => setDraft({ ...draft, ...patch });
  const total: Record<DraftClass, number> = { positive: 0, negative: 0, insufficient: 0 };
  for (const a of Object.values(stats)) for (const k of Object.keys(total) as DraftClass[]) total[k] += a[k];
  const sum = total.positive + total.negative + total.insufficient;
  return (
    <div className="view-panel draft-panel" role="group" aria-label="구배 분석" data-testid="draft-panel">
      <strong>구배 분석</strong>
      <span className="muted">빼는 방향</span>
      {(['x', 'y', 'z'] as const).map((a) => (
        <button key={a} aria-pressed={draft.axis === a} onClick={() => set({ axis: a })} data-testid={`draft-axis-${a}`}>
          {draft.flip ? '−' : '+'}
          {a.toUpperCase()}
        </button>
      ))}
      <button onClick={() => set({ flip: !draft.flip })} title="빼는 방향 뒤집기" data-testid="draft-flip">
        ⇅
      </button>
      <label className="muted">
        한계{' '}
        <input
          type="number"
          min={0}
          max={45}
          step={0.5}
          value={draft.angle}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) set({ angle: Math.max(0, Math.min(45, v)) });
          }}
          data-testid="draft-angle"
          style={{ width: 52 }}
        />
        °
      </label>
      {(Object.keys(DRAFT_LABELS) as DraftClass[]).map((k) => (
        <span key={k} className="draft-legend" data-testid={`draft-${k}`}>
          <i style={{ background: `rgb(${DRAFT_COLORS[k].map((c) => Math.round(c * 255)).join(',')})` }} />
          {DRAFT_LABELS[k]} {sum > 0 ? `${Math.round((total[k] / sum) * 100)}%` : '—'}
        </span>
      ))}
      <button onClick={() => setDraft(null)} title="구배 분석 끄기">
        ✕
      </button>
    </div>
  );
}

export function MeasureReadout() {
  const measuring = useEditorStore((s) => s.measuring);
  const pts = useEditorStore((s) => s.measurePoints);
  if (!measuring) return null;
  const d = pts.length === 2 ? new Vector3(...pts[1]!).sub(new Vector3(...pts[0]!)) : null;
  return (
    <div className="view-panel measure-panel" data-testid="measure-readout">
      <strong>측정</strong>{' '}
      {pts.length < 2 ? (
        <span className="muted">모델 위 두 점을 클릭하세요 ({pts.length}/2)</span>
      ) : (
        <span>
          거리 {formatMm(d!.length())} mm · ΔX {formatMm(d!.x)} · ΔY {formatMm(d!.y)} · ΔZ {formatMm(d!.z)}
        </span>
      )}
      <button onClick={() => useEditorStore.getState().toggleMeasure()} title="측정 끝내기 (Esc)">
        ✕
      </button>
    </div>
  );
}

/** 질량 특성: 계산된 엔진 메시(억제 제외)로 부피·겉넓이·무게 중심·크기·질량 */
export function MassPanel() {
  const open = useEditorStore((s) => s.massOpen);
  const model = useSceneStore(selectModel);
  const geometries = useBackendStore((s) => s.geometries);
  const [material, setMaterial] = useState<string>('pla');
  const props = useMemo(() => {
    if (!open) return null;
    const index = byId(model);
    const sketches = sketchIndex(model);
    const parts = topLevelObjects(model)
      .filter((o) => !isSuppressed(o, index))
      .map((o) => {
        const g = geometries[geometryKey(o, index, sketches)];
        return g ? meshProperties(g.getAttribute('position').array, g.getIndex()?.array ?? null, toMatrix(o.transform)) : null;
      });
    if (parts.some((p) => !p)) return 'pending' as const;
    return combine(parts as NonNullable<(typeof parts)[number]>[]);
  }, [open, model, geometries]);
  if (!open) return null;
  const density = MATERIALS.find((m) => m.id === material)!.density;
  const v3 = (v: number[]) => `(${v.map((x) => formatMm(Math.round(x * 100) / 100)).join(', ')})`;
  return (
    <div className="view-panel mass-panel" data-testid="mass-panel" role="dialog" aria-label="질량 특성">
      <div className="pm-head">
        <strong>질량 특성</strong>
        <button onClick={() => useEditorStore.getState().toggleMass()} aria-label="닫기">
          ✕
        </button>
      </div>
      {props === 'pending' ? (
        <p className="muted">형상 계산 중…</p>
      ) : !props ? (
        <p className="muted">계산할 객체가 없습니다</p>
      ) : (
        <dl>
          <dt>재료</dt>
          <dd>
            <select value={material} onChange={(e) => setMaterial(e.target.value)} aria-label="재료">
              {MATERIALS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.density} g/cm³)
                </option>
              ))}
            </select>
          </dd>
          <dt>질량</dt>
          <dd data-testid="mass-grams">{formatMm(Math.round(massGrams(props.volume, density) * 100) / 100)} g</dd>
          <dt>부피</dt>
          <dd data-testid="mass-volume">{formatMm(Math.round(props.volume * 10) / 10)} mm³</dd>
          <dt>겉넓이</dt>
          <dd>{formatMm(Math.round(props.area * 10) / 10)} mm²</dd>
          <dt>무게 중심</dt>
          <dd>{v3(props.centroid)} mm</dd>
          <dt>크기</dt>
          <dd>{props.max.map((x, i) => formatMm(Math.round((x - props.min[i]!) * 100) / 100)).join(' × ')} mm</dd>
        </dl>
      )}
    </div>
  );
}

/** 로프트 단면 고르기: 단면이 있는 스케치를 순서대로 체크 (평면 거리 순으로 정렬해 보여 줌) */
export function LoftPanel() {
  const open = useEditorStore((s) => s.loftOpen);
  const model = useSceneStore(selectModel);
  const [chosen, setChosen] = useState<string[]>([]);
  if (!open) return null;
  const usable = model.sketches
    .map((sk) => ({ sk, profile: sk.entities.find((e) => e.type !== 'line' && resolveProfile(sk, e.id))?.id }))
    .filter((x): x is { sk: (typeof model.sketches)[number]; profile: string } => !!x.profile)
    .sort((a, b) => a.sk.plane.offset - b.sk.plane.offset);
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const close = () => {
    setChosen([]);
    useEditorStore.getState().setLoftOpen(false);
  };
  const run = () => {
    const sections = chosen.map((id) => ({ sketch: id, profile: usable.find((u) => u.sk.id === id)!.profile }));
    const r = useSceneStore.getState().submitNow({ type: 'loft', sections });
    if (r.status === 'applied') close();
  };
  return (
    <div className="view-panel mass-panel" role="dialog" aria-label="로프트" data-testid="loft-panel">
      <div className="pm-head">
        <strong>로프트 — 단면을 잇는 순서대로 고르세요</strong>
      </div>
      {usable.map(({ sk, profile }) => (
        <label key={sk.id} className="check">
          <input type="checkbox" checked={chosen.includes(sk.id)} onChange={() => toggle(sk.id)} data-testid={`loft-${sk.id}`} />
          {chosen.includes(sk.id) && <strong>{chosen.indexOf(sk.id) + 1}.</strong>} {sk.name} <span className="muted">({profile}, 평면 거리 {formatMm(sk.plane.offset)})</span>
        </label>
      ))}
      <div className="row">
        <button className="ok" disabled={chosen.length < 2} onClick={run} data-testid="loft-ok">
          ✓ 로프트
        </button>
        <button className="cancel" onClick={close}>
          ✕ 취소
        </button>
      </div>
    </div>
  );
}

/** 스윕: 단면(닫힌 요소)과 경로(열린 선)를 고른다 */
export function SweepPanel() {
  const open = useEditorStore((s) => s.sweepOpen);
  const model = useSceneStore(selectModel);
  const [profile, setProfile] = useState('');
  const [path, setPath] = useState('');
  if (!open) return null;
  const profiles = model.sketches.flatMap((sk) => sk.entities.filter((e) => resolveProfile(sk, e.id)).map((e) => ({ key: `${sk.id}/${e.id}`, label: `${sk.name} · ${e.id}` })));
  const paths = model.sketches.flatMap((sk) => sk.entities.filter((e) => e.type === 'path' || e.type === 'line').map((e) => ({ key: `${sk.id}/${e.id}`, label: `${sk.name} · ${e.id}` })));
  const p = profile || profiles[0]?.key || '';
  const q = path || paths.at(-1)?.key || '';
  const close = () => useEditorStore.getState().setSweepOpen(false);
  const run = () => {
    const [sketch, prof] = p.split('/') as [string, string];
    const [pathSketch, pathId] = q.split('/') as [string, string];
    const r = useSceneStore.getState().submitNow({ type: 'sweep', sketch, profile: prof, pathSketch, path: pathId });
    if (r.status === 'applied') close();
  };
  return (
    <div className="view-panel mass-panel" role="dialog" aria-label="스윕" data-testid="sweep-panel">
      <div className="pm-head">
        <strong>스윕 — 단면을 경로를 따라</strong>
      </div>
      <label className="field">
        단면
        <select value={p} onChange={(e) => setProfile(e.target.value)} data-testid="sweep-profile">
          {profiles.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
        </select>
      </label>
      <label className="field">
        경로
        <select value={q} onChange={(e) => setPath(e.target.value)} data-testid="sweep-path">
          {paths.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
        </select>
      </label>
      <p className="muted small">단면은 경로 시작점에 경로와 수직으로 세웁니다 (단면의 위쪽 = 경로 평면의 법선).</p>
      <div className="row">
        <button className="ok" disabled={!p || !q} onClick={run} data-testid="sweep-ok">
          ✓ 스윕
        </button>
        <button className="cancel" onClick={close}>
          ✕ 취소
        </button>
      </div>
    </div>
  );
}

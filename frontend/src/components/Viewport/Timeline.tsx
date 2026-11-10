/**
 * 타임라인 (형식 v43, 블렌더 타임라인): 재생·멈춤, 프레임 끌기, 고른 객체에 키 넣기(I)·지우기, 초당 프레임·끝 프레임.
 * 열려 있는 동안 키가 있는 객체는 그 프레임 자세로 보이고, 기즈모로 옮기면 지금 프레임에 키가 들어간다.
 */
import { useEffect } from 'react';
import { DEFAULT_ANIMATION, trackOf } from '../../cad/animation';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { topLevelObjects } from '../../cad/modelGraph';
import { useEditorStore } from '../../features/selection/editorStore';

export function Timeline() {
  const tl = useEditorStore((s) => s.timeline);
  const model = useSceneStore(selectModel);
  const selectedId = useSceneStore((s) => s.selectedId);
  const anim = model.animation ?? DEFAULT_ANIMATION;
  const set = useEditorStore.getState().setTimeline;
  const frame = Math.round(tl.frame);
  const selTop = topLevelObjects(model).find((o) => o.id === selectedId);
  const track = selTop ? trackOf(model, selTop.id) : undefined;
  const hasKey = !!track?.keys.some((k) => k.frame === frame);

  // 재생: 실제 시간에 맞춰 프레임을 넘긴다 (끝에서 처음으로)
  useEffect(() => {
    if (!tl.open || !tl.playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const { timeline } = useEditorStore.getState();
      const end = (useSceneStore.getState().history.present.model.animation ?? DEFAULT_ANIMATION).end;
      let f = timeline.frame + dt * anim.fps;
      if (f > end) f = 0;
      useEditorStore.getState().setTimeline({ frame: f });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [tl.open, tl.playing, anim.fps]);

  // I = 고른 객체에 키 (입력 칸에서는 아님)
  useEffect(() => {
    if (!tl.open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'i' || e.key === 'I') {
        const id = useSceneStore.getState().selectedId;
        if (id) useSceneStore.getState().submitNow({ type: 'insert_keyframe', target: id, frame: Math.round(useEditorStore.getState().timeline.frame) });
      } else if (e.key === ' ' && !e.repeat) {
        e.preventDefault();
        set({ playing: !useEditorStore.getState().timeline.playing });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tl.open, set]);

  if (!tl.open) return null;
  const submit = useSceneStore.getState().submitNow;
  return (
    <div className="timeline" role="group" aria-label="타임라인" data-testid="timeline">
      <button onClick={() => set({ playing: !tl.playing })} title="재생·멈춤 (스페이스)" data-testid="tl-play" aria-pressed={tl.playing}>
        {tl.playing ? '⏸' : '▶'}
      </button>
      <button onClick={() => set({ frame: 0, playing: false })} title="처음으로" data-testid="tl-start">
        ⏮
      </button>
      <div className="tl-track">
        <input
          type="range"
          min={0}
          max={anim.end}
          step={1}
          value={frame}
          onChange={(e) => set({ frame: Number(e.target.value), playing: false })}
          aria-label="프레임"
          data-testid="tl-frame"
        />
        {track?.keys.map((k) => (
          <i key={k.frame} className="tl-key" style={{ left: `${(k.frame / anim.end) * 100}%` }} title={`키 ${k.frame}`} />
        ))}
      </div>
      <span className="tl-num" data-testid="tl-frame-num">
        {frame} / {anim.end}
      </span>
      <button disabled={!selTop} onClick={() => selTop && submit({ type: 'insert_keyframe', target: selTop.id, frame })} title="고른 객체의 지금 자세를 이 프레임에 (I)" data-testid="tl-key">
        ◆ 키
      </button>
      <button disabled={!hasKey} onClick={() => selTop && submit({ type: 'delete_keyframe', target: selTop.id, frame })} title="이 프레임의 키 지우기" data-testid="tl-unkey">
        ◇ 지우기
      </button>
      <label className="muted">
        fps{' '}
        <input type="number" min={1} max={120} value={anim.fps} onChange={(e) => Number(e.target.value) >= 1 && submit({ type: 'set_animation', fps: Math.min(120, Math.round(Number(e.target.value))) })} style={{ width: 48 }} data-testid="tl-fps" />
      </label>
      <label className="muted">
        끝{' '}
        <input type="number" min={1} max={100000} value={anim.end} onChange={(e) => Number(e.target.value) >= 1 && submit({ type: 'set_animation', end: Math.round(Number(e.target.value)) })} style={{ width: 64 }} data-testid="tl-end" />
      </label>
      <button onClick={() => set({ open: false, playing: false })} title="타임라인 닫기 (설계 위치로 보기)">
        ✕
      </button>
    </div>
  );
}

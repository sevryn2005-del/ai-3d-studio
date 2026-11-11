/**
 * 애니메이션 영상 저장 (블렌더 애니메이션 렌더처럼): 뷰포트 캔버스를 처음부터 끝 프레임까지 실제 속도로 재생하며
 * 브라우저 MediaRecorder 로 WebM 에 담는다. 새 의존성·원격 자원 없음 (웹·Windows WebView2 모두 내장).
 */

/** 이 브라우저가 담을 수 있는 WebM 형식 (없으면 null) */
export function videoMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) if (MediaRecorder.isTypeSupported(t)) return t;
  return null;
}

/**
 * canvas 를 fps 로 담으며 setFrame(0 → end) 을 실제 시간에 맞춰 넘긴다. signal 로 멈추면 거기까지 담긴 영상.
 * onProgress(0~1) 로 진행 표시.
 */
export async function recordTimeline(
  canvas: HTMLCanvasElement,
  fps: number,
  end: number,
  setFrame: (f: number) => void,
  opts: { signal?: AbortSignal; onProgress?: (p: number) => void } = {},
): Promise<Blob> {
  const mimeType = videoMimeType();
  if (!mimeType) throw new Error('이 브라우저는 영상 저장(MediaRecorder WebM)을 지원하지 않습니다');
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  setFrame(0);
  // 첫 프레임이 그려질 때까지 한 번 기다린 뒤 시작
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  rec.start(250);
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const step = (now: number) => {
      const f = ((now - t0) / 1000) * fps;
      if (f >= end || opts.signal?.aborted) {
        setFrame(Math.min(end, f));
        resolve();
        return;
      }
      setFrame(f);
      opts.onProgress?.(f / end);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  // 마지막 프레임이 담기도록 잠깐 더
  await new Promise((r) => setTimeout(r, 1000 / fps + 50));
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  return new Blob(chunks, { type: 'video/webm' });
}

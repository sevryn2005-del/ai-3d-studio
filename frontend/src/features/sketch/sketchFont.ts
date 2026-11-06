/**
 * 스케치 텍스트 글꼴: Noto Sans KR Bold (SIL OFL 1.1) — 영문·숫자·기호 + 자주 쓰는 한글 2,350자(KS X 1001)만 남긴 서브셋.
 * 프로그램에 함께 들어 있어 인터넷 없이 동작하고, 텍스트를 처음 넣을 때만 불러온다 (첫 화면 크기에 영향 없음).
 */
import fontUrl from '../../assets/fonts/NotoSansKR-Bold-subset.ttf?url';
import type { GlyphSource } from '../../cad/sketchText';

let loading: Promise<GlyphSource> | null = null;

export function loadSketchFont(): Promise<GlyphSource> {
  loading ??= (async () => {
    const [{ default: opentype }, buf] = await Promise.all([
      import('opentype.js'),
      fetch(fontUrl).then((r) => {
        if (!r.ok) throw new Error(`글꼴을 읽지 못했습니다 (${r.status})`);
        return r.arrayBuffer();
      }),
    ]);
    const font = opentype.parse(buf);
    const src: GlyphSource = { getPath: (t, x, y, s) => font.getPath(t, x, y, s), hasChar: (ch) => font.charToGlyphIndex(ch) > 0 };
    return src;
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

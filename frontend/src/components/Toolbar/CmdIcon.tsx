/**
 * 명령 버튼 기호 (자체 제작 SVG, 24×24 선 그림). 글꼴 기호(◯ ⬠ 등)는 글꼴마다 크기가 달라 버튼이 들쭉날쭉해진다.
 * 상용 CAD 프로그램의 아이콘을 베끼지 않는다 — 동작을 나타내는 단순한 모양만.
 */
const PATHS: Record<string, string> = {
  extrude: 'M4 17l8 4 8-4M4 17V9l8-4 8 4v8M12 21v-8M4 9l8 4 8-4M12 5V1m0 0l-3 3m3-3l3 3',
  revolve: 'M12 3v18M7 7a7 3 0 1 0 10 0M16 4.5L17 7l-2.6.6',
  sketch: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  rectangle: 'M4 6h16v12H4z',
  circle: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z',
  ellipse: 'M12 7c5 0 9 2.2 9 5s-4 5-9 5-9-2.2-9-5 4-5 9-5z',
  polygon: 'M12 3l8.5 6.2-3.2 10H6.7L3.5 9.2z',
  front: 'M5 5h14v14H5z',
  top: 'M3 9l6-5h12l-6 5zM3 9h12v11H3z',
  right: 'M9 4h12v12H9zM9 4L3 9v11l6-4M3 20h12',
  iso: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  normal: 'M5 19h14M12 19V5m0 0l-3 3m3-3l3 3',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M9 9h6v6H9z',
  hole: 'M3 9l9-5 9 5-9 5zM3 9v6l9 5 9-5V9M9 9a3 1.6 0 1 0 6 0a3 1.6 0 1 0-6 0M9 9v4M15 9v4',
  shell: 'M3 8l9-5 9 5v8l-9 5-9-5zM6 9.5l6-3.3 6 3.3v5l-6 3.3-6-3.3z',
  fillet: 'M4 20V10a6 6 0 0 1 6-6h10M4 20h16',
  sketchFace: 'M3 9l9-5 9 5-9 5zM8 9l4 2 4-2M12 14v7',
  measureEntity: 'M4 20L20 4M4 20v-5M4 20h5M20 4v5M20 4h-5',
  insert: 'M12 3v10m0 0l-4-4m4 4l4-4M4 15v5h16v-5',
  mate: 'M3 10h8v8H3zM13 6h8v8h-8zM11 14h2',
  interference: 'M8 8a6 6 0 1 0 .01 0M16 8a6 6 0 1 0 .01 0',
  bom: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
  drawing: 'M3 4h18v16H3zM6 7h6v4H6zM6 13h6v4H6zM14 13h4v4h-4zM14 7l4 4',
  sweep: 'M4 18c4 0 6-12 16-12M2 16h4v4H2zM18 4h4v4h-4z',
  rib: 'M3 20h18M8 20V8h2v12M14 20V8h2v12M8 8h8',
  path: 'M3 18l6-8 5 4 7-9M3 18h.01M21 5h.01',
  arc: 'M4 18a9 9 0 0 1 16 0M4 18h.01M20 18h.01',
  spline: 'M3 17c3-9 6-9 9-3s6 6 9-6M3 17h.01M12 14h.01M21 8h.01',
  chamfer: 'M4 20V10l6-6h10M4 20h16',
  draft: 'M4 20h16M7 20L9 4h6l2 16M12 4v16',
  linear: 'M3 8h5v8H3zM10 8h5v8h-5zM17 8h4v8h-4',
  circular: 'M12 3a2 2 0 1 0 0 .1M19.8 16.5a2 2 0 1 0 0 .1M4.2 16.5a2 2 0 1 0 0 .1M7 6.5a8 8 0 0 0-3 7M17 6.5a8 8 0 0 1 3 7M8 20a8 8 0 0 0 8 0',
  mirror: 'M12 2v20M4 7h5v10H4zM15 7h5v10h-5z',
  shadedEdges: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  shaded: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z',
  wireframe: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5M4 7.5l16 9M20 7.5L4 16.5M12 3v18',
  xray: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10',
  section: 'M3 9l9-5 9 5-9 5zM3 9v6l9 5 9-5V9M2 13h20',
  draftAnalysis: 'M12 2v6M9 5l3-3 3 3M5 21l2-11h10l2 11zM9 14h6',
  reference: 'M4 17l6-12 10 4-6 12zM12 3v18M3 12h18',
  thicknessAnalysis: 'M4 4h16v16H4zM8 8h8v8H8zM4 12h4M16 12h4',
  measure: 'M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2',
  mass: 'M6 8h12l2 13H4zM9 8a3 3 0 0 1 6 0',
  extrudeCut: 'M4 8l8-4 8 4v8l-8 4-8-4zM9 9.5l3 1.5 3-1.5v5l-3 1.5-3-1.5zM12 2v6',
  revolveCut: 'M12 3v18M7 7a7 3 0 1 0 10 0M9 12h6v4H9z',
  scale: 'M4 20h7v-7H4zM10 4h10v10M20 4l-9 9M15 4h5v5',
  slot: 'M8 8h8a4 4 0 0 1 0 8H8a4 4 0 0 1 0-8z',
  line: 'M3 20L21 4M3 20h2M19 4h2',
  trim: 'M3 12h7M14 12h7M12 5v14M8 8l8 8',
  extend: 'M3 12h12M15 12l-3-3M15 12l-3 3M20 4v16',
  loft: 'M5 20h14M8 4h8M5 20L8 4M19 20L16 4M6.5 12h11',
  helix: 'M6 4c8 0 12 2 12 3s-12 2-12 3 12 2 12 3-12 2-12 3 12 2 12 3',
  thread: 'M9 3h6v18H9zM9 6l6 2M9 10l6 2M9 14l6 2M9 18l6 2',
  perspective: 'M4 6h16M6 18h12M4 6l2 12M20 6l-2 12',
  camera: 'M3 8h4l2-3h6l2 3h4v12H3zM12 10a4 4 0 1 0 0 8a4 4 0 1 0 0-8',
};

export type IconName = keyof typeof PATHS;

export function CmdIcon({ name }: { name: IconName }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

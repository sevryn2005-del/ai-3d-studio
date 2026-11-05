import { useEffect, useMemo, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Matrix4, OrthographicCamera, PerspectiveCamera, ShaderMaterial, Vector3 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { autoGridStep, sketchSnapPoints } from '../../cad/sketchSnap';
import { gridSteps, useSketchView } from '../../features/sketch/sketchSettings';
import { useActiveSketch } from '../../features/sketch/activeSketch';

/** 종이 + 격자 (모눈종이처럼): 잔 칸·굵은 칸 선을 화면 해상도에 맞춰 부드럽게 (fwidth) */
const VERT = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = /* glsl */ `
uniform float minor;
uniform float major;
uniform vec3 paper;
uniform vec3 minorColor;
uniform vec3 majorColor;
uniform float paperAlpha;
uniform float gridOn;
uniform vec2 center;
uniform float halfSize;
varying vec2 vP;
float gridLine(vec2 p, float step, float width) {
  vec2 q = p / step;
  vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
  return 1.0 - min(min(g.x, g.y) / width, 1.0);
}
void main() {
  // 종이 가장자리는 부드럽게 사라진다 (끝없는 도면 판)
  vec2 d = abs(vP - center) / halfSize;
  float edge = 1.0 - smoothstep(0.75, 1.0, max(d.x, d.y));
  vec3 c = paper;
  float a = paperAlpha;
  if (gridOn > 0.5) {
    float m = gridLine(vP, minor, 1.0);
    float M = gridLine(vP, major, 1.4);
    c = mix(c, minorColor, m * 0.9);
    c = mix(c, majorColor, M);
    a = max(a, max(m * 0.35, M * 0.6));
  }
  gl_FragColor = vec4(c, a * edge);
}`;

/**
 * 스케치 중일 때 스케치 평면에 깔리는 종이·격자·원점·축선·중심점 (솔리드웍스 스케치 화면처럼).
 * 화면 확대에 따라 격자 간격이 바뀌고(1·2·5 계열), 그 간격을 그리기 스냅이 쓴다 (sketchSettings).
 */
export function SketchPaper() {
  const active = useActiveSketch();
  const view = useSketchView();
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const [place, setPlace] = useState<{ cx: number; cy: number; half: number }>({ cx: 0, cy: 0, half: 500 });

  const inverse = useMemo(() => active?.frame.clone().invert() ?? new Matrix4(), [active]);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        uniforms: {
          minor: { value: 1 },
          major: { value: 10 },
          paper: { value: [0.985, 0.98, 0.955] },
          minorColor: { value: [0.84, 0.88, 0.93] },
          majorColor: { value: [0.64, 0.72, 0.82] },
          paperAlpha: { value: 0.94 },
          gridOn: { value: 1 },
          center: { value: [0, 0] },
          halfSize: { value: 500 },
        },
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  // 확대·이동을 따라: mm/픽셀, 자동 격자 간격, 종이 위치·크기
  useFrame(() => {
    if (!active) return;
    const target = controls?.target ?? new Vector3();
    const local = target.clone().applyMatrix4(inverse);
    const onPlane = new Vector3(local.x, local.y, 0).applyMatrix4(active.frame);
    let mmPerPx: number;
    if (camera instanceof OrthographicCamera) mmPerPx = (camera.top - camera.bottom) / camera.zoom / size.height;
    else {
      const fov = ((camera as PerspectiveCamera).fov * Math.PI) / 180;
      mmPerPx = (camera.position.distanceTo(onPlane) * 2 * Math.tan(fov / 2)) / size.height;
    }
    const auto = autoGridStep(mmPerPx);
    useSketchView.getState().setScale(mmPerPx, auto);
    const half = Math.max(200, mmPerPx * Math.max(size.width, size.height) * 2.5);
    const snapTo = auto.major * 10;
    const cx = Math.round(local.x / snapTo) * snapTo;
    const cy = Math.round(local.y / snapTo) * snapTo;
    if (cx !== place.cx || cy !== place.cy || Math.abs(half - place.half) / place.half > 0.25) setPlace({ cx, cy, half });
  });

  const steps = gridSteps(view);
  material.uniforms.minor!.value = steps.minor;
  material.uniforms.major!.value = steps.major;
  material.uniforms.gridOn!.value = view.grid ? 1 : 0;
  material.uniforms.paperAlpha!.value = view.paper ? 0.94 : 0;
  material.uniforms.paper!.value = view.paper ? [0.985, 0.98, 0.955] : [0.2, 0.23, 0.28];
  material.uniforms.minorColor!.value = view.paper ? [0.84, 0.88, 0.93] : [0.33, 0.37, 0.44];
  material.uniforms.majorColor!.value = view.paper ? [0.64, 0.72, 0.82] : [0.45, 0.51, 0.6];
  // 종이를 켜면 불투명한 바탕으로 맨 먼저 그린다 (깊이를 쓰지 않으므로 모델·선·표시는 모두 그 위에 보인다)
  if (material.transparent === view.paper) {
    material.transparent = !view.paper;
    material.needsUpdate = true;
  }
  material.uniforms.center!.value = [place.cx, place.cy];
  material.uniforms.halfSize!.value = place.half;

  if (!active) return null;
  const px = view.mmPerPx;
  const h = place.half;
  return (
    <group matrixAutoUpdate={false} matrix={active.frame} name="sketch-paper">
      {(view.paper || view.grid) && (
        <mesh position={[place.cx, place.cy, 0.01]} material={material} raycast={() => null} renderOrder={-10} name="sketch-paper-sheet">
          <planeGeometry args={[h * 2, h * 2]} />
        </mesh>
      )}
      {/* 축선 (일점쇄선): 원점을 지나는 가로(u)·세로(v) */}
      <Line points={[[place.cx - h, 0, 0.015], [place.cx + h, 0, 0.015]]} color="#d0646a" lineWidth={1} dashed dashSize={px * 14} gapSize={px * 5} transparent opacity={0.7} raycast={() => null} />
      <Line points={[[0, place.cy - h, 0.015], [0, place.cy + h, 0.015]]} color="#4f9d62" lineWidth={1} dashed dashSize={px * 14} gapSize={px * 5} transparent opacity={0.7} raycast={() => null} />
      <OriginMark px={px} />
      <SketchPoints sketch={active.sketch} px={px} paper={view.paper} />
    </group>
  );
}

/** 원점 표시: 빨간 점 + u(빨강)·v(초록) 화살표 — 화면 크기는 확대와 무관하게 일정 */
function OriginMark({ px }: { px: number }) {
  const L = px * 42;
  const a = px * 8;
  return (
    <group raycast={() => null} name="sketch-origin">
      <Line points={[[0, 0, 0.02], [L, 0, 0.02], [L - a, a * 0.5, 0.02], [L, 0, 0.02], [L - a, -a * 0.5, 0.02]]} color="#d83c44" lineWidth={2} depthTest={false} />
      <Line points={[[0, 0, 0.02], [0, L, 0.02], [a * 0.5, L - a, 0.02], [0, L, 0.02], [-a * 0.5, L - a, 0.02]]} color="#2f9a4a" lineWidth={2} depthTest={false} />
      <mesh position={[0, 0, 0.02]} renderOrder={5}>
        <circleGeometry args={[px * 4, 20]} />
        <meshBasicMaterial color="#d83c44" depthTest={false} />
      </mesh>
    </group>
  );
}

/** 요소의 중심점(+)과 꼭짓점(점) — 그릴 때 어디에 붙는지 보인다 */
function SketchPoints({ sketch, px, paper }: { sketch: import('../../cad/commandTypes').Sketch | null; px: number; paper: boolean }) {
  const { crosses, dots } = useMemo(() => {
    const pts = sketchSnapPoints(sketch).filter((p) => p.kind !== 'origin');
    const crosses = pts.filter((p) => p.kind === 'center');
    const dots = pts.filter((p) => p.kind === 'endpoint');
    return { crosses, dots };
  }, [sketch]);
  const crossGeo = useMemo(() => {
    const s = px * 6;
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(crosses.flatMap(({ p: [x, y] }) => [x - s, y, 0.025, x + s, y, 0.025, x, y - s, 0.025, x, y + s, 0.025]), 3));
    return g;
  }, [crosses, px]);
  const dotGeo = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(dots.flatMap(({ p: [x, y] }) => [x, y, 0.025]), 3));
    return g;
  }, [dots]);
  useEffect(() => () => crossGeo.dispose(), [crossGeo]);
  useEffect(() => () => dotGeo.dispose(), [dotGeo]);
  const color = paper ? '#2a3442' : '#d5dbe4';
  return (
    <>
      <lineSegments geometry={crossGeo} raycast={() => null} name="sketch-centers">
        <lineBasicMaterial color={color} depthTest={false} />
      </lineSegments>
      <points geometry={dotGeo} raycast={() => null}>
        <pointsMaterial color={color} size={5} sizeAttenuation={false} depthTest={false} />
      </points>
    </>
  );
}

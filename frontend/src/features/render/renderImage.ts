/**
 * 렌더 (1단계, 블렌더 F12 처럼 "보이는 장면을 고품질 그림으로"): 지금 카메라로 원하는 크기의 PNG.
 * - 보조 표시(격자·기즈모·스케치·모서리 선·참조 형상)는 숨기고 CAD 객체만 그린다
 * - 그림자: 바닥 그림자 판 + 부드러운 그림자를 드리우는 조명 (객체 크기에 맞춤)
 * - 앰비언트 오클루전(GTAO): 구석·틈이 어둡게
 * - 안티에일리어싱(SSAA): 2^n 번 흔들어 평균
 * three.js 기본 예제 패스만 쓴다 (새 의존성·원격 자원 없음). 끝나면 장면·렌더러를 원래대로 되돌린다.
 */
import {
  Box3,
  Color,
  DirectionalLight,
  Mesh,
  OrthographicCamera,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  ShadowMaterial,
  Vector2,
  Vector3,
  type Camera,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SSAARenderPass } from 'three/examples/jsm/postprocessing/SSAARenderPass.js';

export interface RenderOptions {
  width: number;
  height: number;
  /** 안티에일리어싱 2^n 표본 (0 = 끔, 최대 4 = 16번) */
  samples: number;
  shadows: boolean;
  ao: boolean;
  background: 'transparent' | 'white' | 'dark';
}

export const RENDER_SIZES = [
  { id: 'hd', label: '1280 × 720', w: 1280, h: 720 },
  { id: 'fhd', label: '1920 × 1080', w: 1920, h: 1080 },
  { id: 'uhd', label: '3840 × 2160 (4K)', w: 3840, h: 2160 },
  { id: 'square', label: '1080 × 1080', w: 1080, h: 1080 },
  { id: 'small', label: '640 × 360 (빠른 확인)', w: 640, h: 360 },
] as const;

const BACKGROUND = { white: '#ffffff', dark: '#1f232a' } as const;

/** CAD 객체 그룹(최상위·편집 메시) 안에 있는가 */
function underCad(o: Object3D): boolean {
  for (let p: Object3D | null = o; p; p = p.parent) if (p.userData.cadObject) return true;
  return false;
}

/** 그릴 것만 남기기: 조명·CAD 객체의 면(메시)만 보이게, 나머지(보조 표시·선·점)는 잠시 숨김 */
function hideHelpers(scene: Scene): () => void {
  const hidden: Object3D[] = [];
  scene.traverse((o) => {
    if (o === scene || !o.visible) return;
    const isLight = (o as { isLight?: boolean }).isLight;
    if (isLight) return;
    if (underCad(o)) {
      // 객체 안: 면만 (모서리 선·점·유령 미리보기 없이)
      // drei Edges·Line 은 굵은 선(LineSegments2 = 메시)이라 isLine 이 아니다 → 선 재질로도 거른다
      const f = o as { isLine?: boolean; isPoints?: boolean; isLineSegments2?: boolean; isLine2?: boolean; material?: { type?: string; isLineMaterial?: boolean } };
      const isLine = f.isLine || f.isPoints || f.isLineSegments2 || f.isLine2 || f.material?.isLineMaterial || f.material?.type === 'LineMaterial';
      if (isLine) {
        o.visible = false;
        hidden.push(o);
      }
      return;
    }
    // 객체 밖: CAD 객체를 품은 그룹이 아니면 숨긴다
    let hasCad = false;
    o.traverse((c) => {
      if (c.userData.cadObject) hasCad = true;
    });
    if (!hasCad && !o.userData.cadObject) {
      o.visible = false;
      hidden.push(o);
    }
  });
  return () => hidden.forEach((o) => (o.visible = true));
}

/** 지금 보이는 장면을 options 크기로 그려 PNG 로 */
export async function renderImage(gl: WebGLRenderer, scene: Scene, camera: Camera, o: RenderOptions): Promise<Blob> {
  const restoreHelpers = hideHelpers(scene);
  const box = new Box3();
  scene.traverse((m) => {
    if ((m as Mesh).isMesh && m.visible && underCad(m)) box.expandByObject(m);
  });
  const extras: Object3D[] = [];
  const shadowed: { m: Mesh; cast: boolean; receive: boolean }[] = [];
  const prev = {
    size: gl.getSize(new Vector2()),
    ratio: gl.getPixelRatio(),
    shadowMap: gl.shadowMap.enabled,
    shadowType: gl.shadowMap.type,
    background: scene.background,
    clearColor: gl.getClearColor(new Color()),
    clearAlpha: gl.getClearAlpha(),
    aspect: camera instanceof PerspectiveCamera ? camera.aspect : 0,
    ortho: camera instanceof OrthographicCamera ? { left: camera.left, right: camera.right } : null,
  };
  let pending: Promise<Blob | null>;
  try {
    if (o.shadows && !box.isEmpty()) {
      gl.shadowMap.enabled = true;
      gl.shadowMap.type = PCFSoftShadowMap;
      const center = box.getCenter(new Vector3());
      const radius = Math.max(1, box.getSize(new Vector3()).length() / 2);
      const light = new DirectionalLight('#ffffff', 1.2);
      light.position.copy(center).add(new Vector3(0.9, -0.7, 1.1).normalize().multiplyScalar(radius * 4)); // 비스듬한 빛: 그림자가 옆으로 보이게
      light.target.position.copy(center);
      light.castShadow = true;
      light.shadow.mapSize.set(2048, 2048);
      const cam = light.shadow.camera;
      cam.left = cam.bottom = -radius * 1.6;
      cam.right = cam.top = radius * 1.6;
      cam.near = radius * 0.5;
      cam.far = radius * 8;
      light.shadow.bias = -0.0005;
      light.shadow.radius = 4;
      const ground = new Mesh(new PlaneGeometry(radius * 12, radius * 12), new ShadowMaterial({ opacity: 0.32 }));
      ground.position.set(center.x, center.y, box.min.z - radius * 0.002);
      ground.receiveShadow = true;
      scene.add(light, light.target, ground);
      extras.push(light, light.target, ground);
      scene.traverse((m) => {
        if ((m as Mesh).isMesh && underCad(m) && m.visible) {
          const mesh = m as Mesh;
          shadowed.push({ m: mesh, cast: mesh.castShadow, receive: mesh.receiveShadow });
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        }
      });
      // 그림자 켜기는 재질을 다시 컴파일해야 반영된다
      scene.traverse((m) => {
        const mat = (m as Mesh).material;
        if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x) => (x.needsUpdate = true));
      });
    }
    // 배경은 투명하게 그린 뒤 마지막에 2D 로 깐다 (톤 매핑이 배경색까지 바꾸지 않게 — 흰색이 정확히 흰색)
    scene.background = null;
    gl.setClearColor('#000000', 0);
    // 카메라 비율을 그림 크기에 맞춘다 (원근: aspect, 직교: 좌우 폭)
    const aspect = o.width / o.height;
    if (camera instanceof PerspectiveCamera) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    } else if (camera instanceof OrthographicCamera && prev.ortho) {
      const half = (camera.top - camera.bottom) / 2;
      camera.left = -half * aspect;
      camera.right = half * aspect;
      camera.updateProjectionMatrix();
    }
    gl.setPixelRatio(1);
    gl.setSize(o.width, o.height, false);
    const composer = new EffectComposer(gl);
    composer.setPixelRatio(1);
    composer.setSize(o.width, o.height);
    const ssaa = new SSAARenderPass(scene, camera, '#000000', 0);
    ssaa.sampleLevel = Math.max(0, Math.min(4, Math.round(o.samples)));
    ssaa.unbiased = true;
    composer.addPass(ssaa);
    if (o.ao) {
      const ao = new GTAOPass(scene, camera, o.width, o.height);
      ao.blendIntensity = 0.85;
      composer.addPass(ao);
    }
    composer.addPass(new OutputPass());
    composer.render();
    // toBlob 은 부르는 순간의 그림을 잡는다 → 바로 원래대로 되돌려도 된다 (아래 finally)
    pending = new Promise<Blob | null>((resolve) => gl.domElement.toBlob(resolve, 'image/png'));
    composer.dispose();
  } finally {
    for (const e of extras) {
      scene.remove(e);
      const m = e as Mesh;
      m.geometry?.dispose();
      if (m.material && !Array.isArray(m.material)) m.material.dispose();
    }
    for (const s of shadowed) {
      s.m.castShadow = s.cast;
      s.m.receiveShadow = s.receive;
    }
    if (gl.shadowMap.enabled !== prev.shadowMap) {
      gl.shadowMap.enabled = prev.shadowMap;
      gl.shadowMap.type = prev.shadowType;
      scene.traverse((m) => {
        const mat = (m as Mesh).material;
        if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x) => (x.needsUpdate = true));
      });
    }
    scene.background = prev.background;
    gl.setClearColor(prev.clearColor, prev.clearAlpha);
    if (camera instanceof PerspectiveCamera) {
      camera.aspect = prev.aspect;
      camera.updateProjectionMatrix();
    } else if (camera instanceof OrthographicCamera && prev.ortho) {
      camera.left = prev.ortho.left;
      camera.right = prev.ortho.right;
      camera.updateProjectionMatrix();
    }
    gl.setPixelRatio(prev.ratio);
    gl.setSize(prev.size.x, prev.size.y, false);
    restoreHelpers();
  }
  const blob = await pending;
  if (!blob) throw new Error('렌더 결과를 그림으로 바꾸지 못했습니다');
  if (o.background === 'transparent') return blob;
  return withBackground(blob, BACKGROUND[o.background], o.width, o.height);
}

/** 투명 PNG 아래에 단색 배경 깔기 */
async function withBackground(blob: Blob, color: string, w: number, h: number): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.fillRect(0, 0, w, h);
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const out = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'));
  if (!out) throw new Error('렌더 결과를 그림으로 바꾸지 못했습니다');
  return out;
}

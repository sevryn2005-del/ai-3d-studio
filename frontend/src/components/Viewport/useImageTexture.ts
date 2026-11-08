import { useEffect, useMemo } from 'react';
import { RepeatWrapping, SRGBColorSpace, TextureLoader, type Texture } from 'three';

/**
 * 객체 텍스처 이미지 (data URL, 저장 파일 안에 들어 있음 — 원격 로드 없음) → three 텍스처.
 * 반복(타일) + sRGB, flipY = false (GLB 와 같은 UV 방향 — cad/textureMap.ts).
 */
export function useImageTexture(image: string | undefined): Texture | null {
  const texture = useMemo(() => {
    if (!image) return null;
    const t = new TextureLoader().load(image);
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.colorSpace = SRGBColorSpace;
    t.flipY = false;
    return t;
  }, [image]);
  useEffect(() => () => texture?.dispose(), [texture]);
  return texture;
}

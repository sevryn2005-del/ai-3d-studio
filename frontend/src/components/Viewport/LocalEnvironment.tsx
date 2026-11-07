import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { PMREMGenerator } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * 반사 환경 (형식 v29 PBR 재질): 금속 재질은 비출 주변이 없으면 검게 보이므로, three.js 에 들어 있는 실내 환경(RoomEnvironment)을
 * 그 자리에서 만들어 장면 반사로 쓴다. 원격 이미지(HDRI) 없이 — 오프라인 원칙. 세기는 낮게 해 기존 조명 느낌은 그대로
 */
export function LocalEnvironment({ intensity = 0.35 }: { intensity?: number }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = intensity;
    return () => {
      if (scene.environment === env) scene.environment = null;
      env.dispose();
      room.dispose();
      pmrem.dispose();
    };
  }, [gl, scene, intensity]);
  return null;
}

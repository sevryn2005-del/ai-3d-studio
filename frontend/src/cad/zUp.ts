/**
 * CAD 표준인 Z-up 좌표계를 Three.js 전역 기본값으로 설정한다.
 * CadQuery/Open CASCADE 및 STL/3MF 출력 좌표계와 일치시켜
 * 백엔드 메시를 변환 없이 그대로 표시하기 위함이다.
 */
import { Object3D } from 'three';

Object3D.DEFAULT_UP.set(0, 0, 1);

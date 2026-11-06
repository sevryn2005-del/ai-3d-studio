/** 글꼴 파일을 data URL 로 (단위 시험에서 글꼴을 읽을 때) */
declare module '*.ttf?inline' {
  const src: string;
  export default src;
}

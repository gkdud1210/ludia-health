// ════════════════════════════════════════════════════════════════════════
// iris3d-viewer.js — LUDIA 3D 안구 디지털 트윈 인터랙티브 뷰어 v2
// ════════════════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const GRID_RINGS = 8;
export const GRID_SECTORS = 10;
// [8,28]: 림버스 28° — 36°보다 완만하여 가장자리 왜곡 감소, 자율신경선 정확도 향상
export const PHI_BAND_DEG = [8, 28];

const ATLAS_W = 720, ATLAS_H = 360;
const PUPIL_V  = PHI_BAND_DEG[0] / 180;
const SCLERA_V = PHI_BAND_DEG[1] / 180;

function clockPolarToPixel(clockDeg, rNorm, geom, pupilR = geom.pupilR) {
  const thetaMath = (clockDeg - 90) * Math.PI / 180;
  const rPx = pupilR + Math.max(0, Math.min(1, rNorm)) * (geom.limbusR - pupilR);
  return { x: geom.cx + rPx * Math.cos(thetaMath), y: geom.cy + rPx * Math.sin(thetaMath) };
}

function detectPupilCenter(srcData, srcW, srcH, geom) {
  function gray(x, y) {
    x = Math.max(0, Math.min(srcW - 1, x | 0)); y = Math.max(0, Math.min(srcH - 1, y | 0));
    const i = (y * srcW + x) * 4;
    return (srcData[i] * 0.299 + srcData[i+1] * 0.587 + srcData[i+2] * 0.114) / 255;
  }
  const DARK_THRESH = 0.16, searchR = geom.pupilR * 2.2;
  const x0 = Math.max(0, Math.floor(geom.cx - searchR)), x1 = Math.min(srcW - 1, Math.ceil(geom.cx + searchR));
  const y0 = Math.max(0, Math.floor(geom.cy - searchR)), y1 = Math.min(srcH - 1, Math.ceil(geom.cy + searchR));
  let sumX = 0, sumY = 0, sumW = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const g = gray(x, y);
    if (g < DARK_THRESH) { const w = DARK_THRESH - g; sumX += x*w; sumY += y*w; sumW += w; }
  }
  if (sumW < 1e-3) return { cx: geom.cx, cy: geom.cy };
  return { cx: sumX / sumW, cy: sumY / sumW };
}

const PUPIL_ANGLE_SAMPLES = 360;

function detectPupilBoundary(blurData, srcW, srcH, geom) {
  function gray(x, y) {
    x = Math.max(0, Math.min(srcW - 1, x | 0)); y = Math.max(0, Math.min(srcH - 1, y | 0));
    const i = (y * srcW + x) * 4;
    return (blurData[i] * 0.299 + blurData[i+1] * 0.587 + blurData[i+2] * 0.114) / 255;
  }
  const minR = geom.pupilR * 0.55, maxR = geom.pupilR * 1.6, BRIGHT_THRESH = 0.22;
  const raw = new Float32Array(PUPIL_ANGLE_SAMPLES);
  for (let a = 0; a < PUPIL_ANGLE_SAMPLES; a++) {
    const thetaMath = (a - 90) * Math.PI / 180, cos = Math.cos(thetaMath), sin = Math.sin(thetaMath);
    let found = geom.pupilR;
    for (let r = minR; r <= maxR; r += 1) {
      const g = gray(geom.cx + r * cos, geom.cy + r * sin);
      if (g > BRIGHT_THRESH) {
        const g2 = gray(geom.cx + (r + 4) * cos, geom.cy + (r + 4) * sin);
        if (g2 > BRIGHT_THRESH) { found = r; break; }
      }
    }
    raw[a] = found;
  }
  const SMOOTH_WINDOW = 8, smoothed = new Float32Array(PUPIL_ANGLE_SAMPLES);
  for (let a = 0; a < PUPIL_ANGLE_SAMPLES; a++) {
    let sum = 0, n = 0;
    for (let d = -SMOOTH_WINDOW; d <= SMOOTH_WINDOW; d++) { sum += raw[(a + d + PUPIL_ANGLE_SAMPLES) % PUPIL_ANGLE_SAMPLES]; n++; }
    smoothed[a] = sum / n;
  }
  return smoothed;
}

const ZONE_TABLE = {
  left: [
    ['L01',0,30],['L02',30,60],['L03',60,85],['L04',85,97],['L05',97,127],
    ['L06',127,150],['L07',150,162],['L08',162,185],['L09',185,215],['L10',215,243],
    ['L11',243,265],['L12',265,277],['L13',277,302],['L14',302,332],['L15',332,360],
  ],
  right: [
    ['R01',0,30],['R02',30,58],['R03',58,82],['R04',82,95],['R05',95,125],
    ['R06',125,155],['R07',155,178],['R08',178,190],['R09',190,220],['R10',220,250],
    ['R11',250,280],['R12',280,310],['R13',310,338],['R14',338,360],
  ],
};

// ── 병소 타입 정의 (색상·한글 레이블)
const LESION_DEFS = [
  { id:'lac',   ko:'빈공간',  color:[239,68,68]   },
  { id:'cry',   ko:'크립트',  color:[234,179,8]   },
  { id:'pgm',   ko:'색소침착', color:[180,83,9]    },
  { id:'rad',   ko:'방사선',  color:[249,115,22]  },
  { id:'anr',   ko:'신경환',  color:[6,182,212]   },
  { id:'contr', ko:'수축환',  color:[16,185,129]  },
  { id:'bv',    ko:'혈관확장', color:[220,38,38]   },
  { id:'def',   ko:'결손',    color:[139,92,246]  },
];

function clockDegToZoneId(clockDeg, side) {
  const table = ZONE_TABLE[side];
  const d = ((clockDeg % 360) + 360) % 360;
  for (const [zid, s, e] of table) if (d >= s && d < e) return zid;
  return table[table.length - 1][0];
}

export function mapGridToLegacyZones(gridStats, side, thresholds = { cryDepth: 0.55, lacDepth: 0.35 }) {
  const byZone = {};
  for (const cell of gridStats) {
    const midDeg = (cell.thetaRange[0] + cell.thetaRange[1]) / 2;
    const zid = clockDegToZoneId(midDeg, side);
    if (!byZone[zid]) byZone[zid] = { depthSum: 0, brightSum: 0, n: 0 };
    byZone[zid].depthSum += cell.depth; byZone[zid].brightSum += cell.brightness; byZone[zid].n += 1;
  }
  const suggestions = {};
  for (const [zid, agg] of Object.entries(byZone)) {
    const avgDepth = agg.depthSum / agg.n;
    const codes = [];
    // 깊은 함몰(어두운) = 크립트, 살짝 파임 = 라쿠나
    if (avgDepth >= thresholds.cryDepth) codes.push('cry');
    else if (avgDepth >= thresholds.lacDepth) codes.push('lac');
    suggestions[zid] = codes;
  }
  return suggestions;
}

function buildAtlasesFromImage(imgEl, geom, side) {
  const src = document.createElement('canvas');
  src.width = imgEl.naturalWidth || imgEl.width; src.height = imgEl.naturalHeight || imgEl.height;
  const sctx = src.getContext('2d'); sctx.drawImage(imgEl, 0, 0, src.width, src.height);
  const srcData = sctx.getImageData(0, 0, src.width, src.height).data;

  const blur = document.createElement('canvas'); blur.width = src.width; blur.height = src.height;
  const bctx = blur.getContext('2d'); bctx.filter = 'blur(6px)'; bctx.drawImage(src, 0, 0);
  const blurData = bctx.getImageData(0, 0, src.width, src.height).data;

  const centered = detectPupilCenter(srcData, src.width, src.height, geom);
  geom = { ...geom, cx: centered.cx, cy: centered.cy };
  const pupilRByAngle = detectPupilBoundary(blurData, src.width, src.height, geom);

  const localPupilVByUx = new Float32Array(ATLAS_W);
  for (let ux = 0; ux < ATLAS_W; ux++) {
    const clockDeg = (ux / ATLAS_W) * 360;
    const angleIdx = Math.round(clockDeg) % PUPIL_ANGLE_SAMPLES;
    const detectedR = pupilRByAngle[angleIdx];
    const extraRNorm = (detectedR - geom.pupilR) / (geom.limbusR - geom.pupilR);
    const localV = PUPIL_V + extraRNorm * (SCLERA_V - PUPIL_V);
    localPupilVByUx[ux] = Math.max(PUPIL_V * 0.35, Math.min(SCLERA_V * 0.85, localV));
  }

  function sampleGray(data, x, y) {
    x = Math.max(0, Math.min(src.width - 1, x | 0)); y = Math.max(0, Math.min(src.height - 1, y | 0));
    const i = (y * src.width + x) * 4;
    return (data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114) / 255;
  }
  function sampleRGB(data, x, y) {
    x = Math.max(0, Math.min(src.width - 1, x | 0)); y = Math.max(0, Math.min(src.height - 1, y | 0));
    const i = (y * src.width + x) * 4;
    return [data[i] / 255, data[i+1] / 255, data[i+2] / 255];
  }

  const colorCanvas = document.createElement('canvas'); colorCanvas.width = ATLAS_W; colorCanvas.height = ATLAS_H;
  const cctx = colorCanvas.getContext('2d'); const cimg = cctx.createImageData(ATLAS_W, ATLAS_H);

  const depthCanvas = document.createElement('canvas'); depthCanvas.width = ATLAS_W; depthCanvas.height = ATLAS_H;
  const dctx = depthCanvas.getContext('2d'); const dimg = dctx.createImageData(ATLAS_W, ATLAS_H);

  const depthBuf  = new Float32Array(ATLAS_W * ATLAS_H);
  const brightBuf = new Float32Array(ATLAS_W * ATLAS_H); // ANR 감지용 원본 밝기
  const cellSum   = new Array(GRID_RINGS * GRID_SECTORS).fill(0).map(() => ({ depth: 0, bright: 0, n: 0 }));

  for (let vy = 0; vy < ATLAS_H; vy++) {
    const v = vy / ATLAS_H;
    for (let ux = 0; ux < ATLAS_W; ux++) {
      const u = ux / ATLAS_W, clockDeg = u * 360;
      const idx = (vy * ATLAS_W + ux) * 4;
      const localPupilV = localPupilVByUx[ux];
      const angleIdx    = Math.round(clockDeg) % PUPIL_ANGLE_SAMPLES;
      const pupilRHere  = pupilRByAngle[angleIdx];
      let rgb, depth;
      if (v < localPupilV) {
        rgb = [0.02, 0.02, 0.02]; depth = 0;
      } else if (v > SCLERA_V) {
        rgb = [0.94, 0.93, 0.90]; depth = 0;
      } else {
        const rNorm = (v - localPupilV) / (SCLERA_V - localPupilV);
        const { x, y } = clockPolarToPixel(clockDeg, rNorm, geom, pupilRHere);
        rgb = sampleRGB(srcData, x, y);
        const gray     = sampleGray(srcData, x, y);
        const grayBlur = sampleGray(blurData, x, y);
        const darkness    = 1 - gray;
        const lowContrast = 1 - Math.min(1, Math.abs(gray - grayBlur) * 6);
        depth = Math.max(0, Math.min(1, 0.6 * darkness + 0.4 * lowContrast));
        brightBuf[vy * ATLAS_W + ux] = gray; // 원본 밝기 (ANR 프로파일용)
        const ringI = Math.min(GRID_RINGS-1, Math.floor(rNorm * GRID_RINGS));
        const secI  = Math.min(GRID_SECTORS-1, Math.floor(u * GRID_SECTORS));
        const cell  = cellSum[ringI * GRID_SECTORS + secI];
        cell.depth += depth; cell.bright += gray; cell.n += 1;
      }
      cimg.data[idx] = rgb[0]*255; cimg.data[idx+1] = rgb[1]*255; cimg.data[idx+2] = rgb[2]*255; cimg.data[idx+3] = 255;
      const dv = depth * 255;
      dimg.data[idx] = dv; dimg.data[idx+1] = dv; dimg.data[idx+2] = dv;
      dimg.data[idx+3] = Math.round(localPupilVByUx[ux] * 255);
      depthBuf[vy * ATLAS_W + ux] = depth;
    }
  }
  cctx.putImageData(cimg, 0, 0); dctx.putImageData(dimg, 0, 0);

  const normalCanvas = document.createElement('canvas'); normalCanvas.width = ATLAS_W; normalCanvas.height = ATLAS_H;
  const nctx = normalCanvas.getContext('2d'); const nimg = nctx.createImageData(ATLAS_W, ATLAS_H);
  const aoCanvas = document.createElement('canvas'); aoCanvas.width = ATLAS_W; aoCanvas.height = ATLAS_H;
  const actx = aoCanvas.getContext('2d'); const aimg = actx.createImageData(ATLAS_W, ATLAS_H);

  const NORMAL_STRENGTH = 0.7, AO_BLUR = 4, AO_STRENGTH = 0.4;
  function sampleDepthBuf(x, y) {
    return depthBuf[Math.max(0,Math.min(ATLAS_H-1,y))*ATLAS_W + Math.max(0,Math.min(ATLAS_W-1,x))];
  }
  const aoContext = new Float32Array(ATLAS_W * ATLAS_H);
  for (let y = 0; y < ATLAS_H; y++) for (let x = 0; x < ATLAS_W; x++) {
    let sum = 0, n = 0;
    for (let dy = -AO_BLUR; dy <= AO_BLUR; dy++) for (let dx = -AO_BLUR; dx <= AO_BLUR; dx++) { sum += sampleDepthBuf(x+dx, y+dy); n++; }
    aoContext[y * ATLAS_W + x] = sum / n;
  }
  for (let y = 0; y < ATLAS_H; y++) for (let x = 0; x < ATLAS_W; x++) {
    const i = (y * ATLAS_W + x) * 4;
    const dzdx = (sampleDepthBuf(x+1,y-1)+2*sampleDepthBuf(x+1,y)+sampleDepthBuf(x+1,y+1))
               - (sampleDepthBuf(x-1,y-1)+2*sampleDepthBuf(x-1,y)+sampleDepthBuf(x-1,y+1));
    const dzdy = (sampleDepthBuf(x-1,y+1)+2*sampleDepthBuf(x,y+1)+sampleDepthBuf(x+1,y+1))
               - (sampleDepthBuf(x-1,y-1)+2*sampleDepthBuf(x,y-1)+sampleDepthBuf(x+1,y-1));
    let nx = dzdx * NORMAL_STRENGTH, ny = dzdy * NORMAL_STRENGTH, nz = 1;
    const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
    nimg.data[i] = (nx*0.5+0.5)*255; nimg.data[i+1] = (ny*0.5+0.5)*255;
    nimg.data[i+2] = (nz*0.5+0.5)*255; nimg.data[i+3] = 255;
    const cavity = Math.max(0, depthBuf[y*ATLAS_W+x] - aoContext[y*ATLAS_W+x]) * AO_STRENGTH;
    const ao = Math.max(0, 1 - Math.min(1, cavity)) * 255;
    aimg.data[i] = ao; aimg.data[i+1] = ao; aimg.data[i+2] = ao; aimg.data[i+3] = 255;
  }
  nctx.putImageData(nimg, 0, 0); actx.putImageData(aimg, 0, 0);

  const gridStats = [];
  for (let ri = 0; ri < GRID_RINGS; ri++) for (let si = 0; si < GRID_SECTORS; si++) {
    const cell = cellSum[ri * GRID_SECTORS + si];
    gridStats.push({
      ring: ri, sector: si, gridId: `G${ri}_${si}`,
      thetaRange: [si * 360 / GRID_SECTORS, (si+1) * 360 / GRID_SECTORS],
      rNormRange: [ri / GRID_RINGS, (ri+1) / GRID_RINGS],
      brightness: cell.n ? cell.bright / cell.n : 0,
      depth:      cell.n ? cell.depth / cell.n : 0,
    });
  }
  return { colorCanvas, depthCanvas, normalCanvas, aoCanvas, gridStats, depthBuf, brightBuf };
}

// ════════════════════════════════════════════════════════════════════════
// VERTEX SHADER — displacement + 각막 돌출 + 해부학적 주름 변위
// ════════════════════════════════════════════════════════════════════════
const VERTEX_SHADER = /* glsl */ `
  uniform sampler2D depthMap;
  uniform float displacementScale;
  uniform float cornealBulge;
  varying vec3 vLocalNormal;
  varying vec3 vNormalW;
  varying vec3 vTangentW;
  varying vec3 vBitangentW;
  varying vec3 vViewPos;

  const float SCLERA_V    = ${PHI_BAND_DEG[1].toFixed(4)} / 180.0;
  const float EDGE_FEATHER = 0.011;
  const float PI           = 3.14159265;

  float hash1(float n) { return fract(sin(n) * 43758.5453); }

  void main() {
    float phiDeg       = degrees(acos(clamp(normal.z, -1.0, 1.0)));
    float thetaMathDeg = degrees(atan(normal.y, normal.x));
    float clockDeg     = mod(90.0 - thetaMathDeg + 360.0, 360.0);
    float v = phiDeg / 180.0;
    float u = clockDeg / 360.0;
    vec2  dispUv = vec2(u, v);

    vec4  depthSample  = texture2D(depthMap, dispUv);
    float localPupilV  = depthSample.a;

    float mask = smoothstep(localPupilV - EDGE_FEATHER, localPupilV + EDGE_FEATHER, v)
               * (1.0 - smoothstep(SCLERA_V - EDGE_FEATHER, SCLERA_V + EDGE_FEATHER, v));
    float depth = depthSample.r * mask;

    float rNorm = clamp((v - localPupilV) / (SCLERA_V - localPupilV), 0.0, 1.0);
    float theta_rad = u * 2.0 * PI;

    // 수축 주름(Contraction Furrows) — 평탄한 표면에서도 굴곡이 보이도록 유지
    float furrowZone = smoothstep(0.55, 0.65, rNorm) * (1.0 - smoothstep(0.95, 1.0, rNorm));
    float furrow     = sin(rNorm * 28.0 + u * 0.5) * 0.009 * furrowZone;

    // 콜라렛(Collarette) 능선
    float collaretteR    = 0.28 + sin(theta_rad * 7.0) * 0.030;
    float collaretteMask = smoothstep(0.04, 0.0, abs(rNorm - collaretteR)) * mask;
    float collaretteRidge = collaretteMask * 0.014;

    // 방사형 섬유 능선(Stromal Ridges)
    float ridge = pow(abs(sin(theta_rad * 70.0 * 0.5)), 5.0) * 0.006 * mask;

    // 각막 돌출 — 매우 완만한 프로파일 (cos 기반으로 림버스까지 부드럽게)
    float bulgeShape;
    if (v < localPupilV) {
      bulgeShape = 0.0; // 동공은 돌출 없음
    } else {
      float t = clamp((v - localPupilV) / (SCLERA_V - localPupilV), 0.0, 1.0);
      bulgeShape = 0.5 - 0.5 * cos(t * PI); // 0→1→0 부드러운 종 모양 (sin보다 완만)
    }
    float bulge = bulgeShape * cornealBulge;

    float totalDisp = depth * displacementScale + furrow + collaretteRidge + ridge;
    vec3  displaced = position - normal * totalDisp + normal * bulge;

    vec3 tangent   = normalize(cross(normal, vec3(0.0, 0.0, 1.0)));
    vec3 bitangent = cross(normal, tangent);
    vLocalNormal = normal;
    vNormalW     = normalize(normalMatrix * normal);
    vTangentW    = normalize(normalMatrix * tangent);
    vBitangentW  = normalize(normalMatrix * bitangent);
    vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
    vViewPos    = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

// ════════════════════════════════════════════════════════════════════════
// FRAGMENT SHADER — 해부학 레이어 + 다중 조명 + 각막 광택
// ════════════════════════════════════════════════════════════════════════
const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D colorMap;
  uniform sampler2D normalMap;
  uniform sampler2D aoMap;
  uniform sampler2D depthMap;
  uniform sampler2D lesionMap;
  uniform float uTime;
  uniform vec3  rimColor;
  uniform float uAOStrength;
  uniform float uSSSStrength;
  uniform float uShowLesions;
  varying vec3 vLocalNormal;
  varying vec3 vNormalW;
  varying vec3 vTangentW;
  varying vec3 vBitangentW;
  varying vec3 vViewPos;

  const float PI       = 3.14159265;
  const float SCLERA_V = ${PHI_BAND_DEG[1].toFixed(4)} / 180.0;

  float hash2(vec2 p)  { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float hash1(float n) { return fract(sin(n) * 43758.5453); }

  void main() {
    vec3  n0           = normalize(vLocalNormal);
    float phiDeg       = degrees(acos(clamp(n0.z, -1.0, 1.0)));
    float thetaMathDeg = degrees(atan(n0.y, n0.x));
    float clockDeg     = mod(90.0 - thetaMathDeg + 360.0, 360.0);
    vec2  vUv          = vec2(clockDeg / 360.0, phiDeg / 180.0);

    float v_phi        = phiDeg / 180.0;
    vec4  depthSample  = texture2D(depthMap, vUv);
    float localPupilV  = depthSample.a;
    float rNorm        = clamp((v_phi - localPupilV) / (SCLERA_V - localPupilV), 0.0, 1.0);
    float irisZone     = step(localPupilV, v_phi) * (1.0 - step(SCLERA_V, v_phi));
    float pupilZone    = 1.0 - step(localPupilV, v_phi);
    float scleraZone   = step(SCLERA_V, v_phi);

    vec3  base     = texture2D(colorMap, vUv).rgb;
    vec3  viewDir  = normalize(vViewPos);
    vec3  lightDir = normalize(vec3(0.4, 0.7, 1.0));
    vec3  fillDir  = normalize(vec3(-0.6, 0.3, 0.8));
    vec3  catchDir = normalize(vec3(0.85, 1.3, 2.5));

    vec3  nTS = texture2D(normalMap, vUv).rgb * 2.0 - 1.0;
    mat3  TBN = mat3(normalize(vTangentW), normalize(vBitangentW), normalize(vNormalW));
    vec3  n   = normalize(TBN * nTS);
    float ao  = mix(1.0, texture2D(aoMap, vUv).r, uAOStrength);

    float theta_rad = vUv.x * 2.0 * PI;

    // ── 사진 원본 위주 렌더링 — 인위적 해부학 레이어 제거
    // 크립트·라쿠나만 실측 depth로 미세하게 강조
    float rawDepth   = depthSample.r;
    float cryptMask  = smoothstep(0.62, 0.86, rawDepth) * irisZone;
    float lacunaMask = smoothstep(0.32, 0.52, rawDepth)
                     * (1.0 - smoothstep(0.52, 0.74, rawDepth)) * irisZone;

    // ── [5] 동공
    float pupilGrad = smoothstep(0.0, 1.0, clamp(v_phi / (localPupilV + 0.001), 0.0, 1.0));
    vec3  pupilBase = mix(vec3(0.0, 0.0, 0.0), vec3(0.015, 0.02, 0.04), pupilGrad);
    float pupilRefl = pow(max(dot(normalize(vNormalW), catchDir), 0.0), 6.0) * 0.05 * pupilZone;
    vec3  pupilColor = pupilBase + vec3(0.04, 0.07, 0.12) * pupilRefl;

    // ── [6] 공막 (Sclera)
    float scleraR    = (v_phi - SCLERA_V) / max(1.0 - SCLERA_V, 0.001);
    float scleraTint = smoothstep(0.0, 0.22, scleraR) * 0.18;
    float vessel     = 0.0;
    for (int j = 0; j < 5; j++) {
      float fj      = float(j);
      float vAngle  = hash1(fj * 7.3 + 2.1) * 2.0 * PI;
      float dA      = abs(mod(theta_rad - vAngle + PI, 2.0*PI) - PI);
      float vCurve  = sin(scleraR * PI * 2.0 + fj) * 0.055;
      float dV      = abs(dA + vCurve);
      float vZone   = smoothstep(0.0, 0.1, scleraR) * (1.0 - smoothstep(0.6, 0.9, scleraR));
      vessel = max(vessel, smoothstep(0.022, 0.0, dV) * vZone * 0.24 * scleraZone);
    }
    vec3 vesselColor = vec3(0.7, 0.16, 0.16);

    // ── 색상 합산 — 사진 베이스 그대로, 크립트·라쿠나만 미세 강조
    vec3 irisColor = base;
    irisColor = mix(irisColor, vec3(0.010, 0.010, 0.018), cryptMask * 0.38);
    irisColor = mix(irisColor, irisColor * 0.75, lacunaMask * 0.28);
    irisColor = max(vec3(0.0), irisColor);

    vec3 scleraColor = base + vec3(scleraTint * 0.4, scleraTint * 0.14, scleraTint * 0.1);
    scleraColor = mix(scleraColor, vesselColor, vessel);

    vec3 anatomyColor = pupilColor * pupilZone + irisColor * irisZone + scleraColor * scleraZone;

    // ── 조명 없음 — 사진 원본 색 그대로 표시 (flat)
    vec3 color = anatomyColor;

    // ── 병소 오버레이 (Lesion Overlay) — fd.irisZoneData 병소를 홍채 위에 표시
    vec4 lesion = texture2D(lesionMap, vUv);
    float lAlpha = lesion.a * uShowLesions * irisZone;
    if (lAlpha > 0.01) {
      float pulse = 0.80 + 0.20 * sin(uTime * 3.2);
      color = mix(color, lesion.rgb * 0.75 + color * 0.25, lAlpha * 0.62);
      color += lesion.rgb * lAlpha * 0.22 * pulse;
    }

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  }
`;

// ════════════════════════════════════════════════════════════════════════
// Iris3DViewer — 메인 클래스
// ════════════════════════════════════════════════════════════════════════
export class Iris3DViewer {
  constructor(container, opts = {}) {
    this.container      = container;
    this.aiServer       = opts.aiServer || null;
    this.onExamComplete = opts.onExamComplete || (() => {});
    this.onLesionToggle = opts.onLesionToggle || null;
    this.side           = 'left';
    this.gridStats      = null;
    this.backendResult  = null;
    this._irisZoneData  = {};
    this._lesionSide    = 'left';
    this._currentPopupCell = null;
    window._ludiaIris3D = this; // 팝업 버튼 onclick에서 참조

    this._initThree();
    this._buildCorneaMesh();
    this._buildGridOverlay();
    this._bindEvents();
    this._animate();
  }

  _initThree() {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x060e1c, 1);
    this.renderer.outputColorSpace  = THREE.SRGBColorSpace;
    this.renderer.toneMapping       = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.container.appendChild(this.renderer.domElement);

    this.scene  = new THREE.Scene();
    // FOV 34° + 거리 1.75 → PHI_BAND_DEG 28° 축소로 줄어든 홍채 크기 보상
    this.camera = new THREE.PerspectiveCamera(34, w / h, 0.02, 100);
    this.camera.position.set(0, 0, 1.75);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan     = true;
    this.controls.minDistance   = 0.18;   // 매우 가까이 확대 허용
    this.controls.maxDistance   = 6.0;
    this.controls.touches       = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this._initialCamPos = this.camera.position.clone();
    this._initialTarget = this.controls.target.clone();

    // ── 조명 ──
    this.scene.add(new THREE.HemisphereLight(0x8ab4d4, 0x3a2510, 0.55));    // 환경
    const key = new THREE.DirectionalLight(0xfff8ee, 1.1);                   // 주광
    key.position.set(0.5, 0.8, 1.5); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xb0c8e0, 0.35);                 // 보조
    fill.position.set(-1.0, 0.2, 1.0); this.scene.add(fill);
    const catchLight = new THREE.PointLight(0xffffff, 2.8, 10);              // 캐치라이트
    catchLight.position.set(0.85, 1.25, 2.8); this.scene.add(catchLight);

    // 파티클 배경
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(400 * 3);
    for (let i = 0; i < 400; i++) {
      const r = 8 + Math.random() * 6, th = Math.random() * Math.PI * 2, ph = Math.acos(2*Math.random()-1);
      starPos[i*3] = r*Math.sin(ph)*Math.cos(th); starPos[i*3+1] = r*Math.sin(ph)*Math.sin(th); starPos[i*3+2] = r*Math.cos(ph);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x2E5D8E, size: 0.025, transparent: true, opacity: 0.45 })));

    // 홍채 구체 — 320×200 세그먼트로 변위 표현이 훨씬 세밀해짐
    const geo = new THREE.SphereGeometry(1, 320, 200);
    this.material = new THREE.ShaderMaterial({
      vertexShader:   VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        colorMap:          { value: this._solidTexture('#1E3A5F') },
        depthMap:          { value: this._solidTexture('#000000') },
        normalMap:         { value: this._solidTexture('#8080ff') },
        aoMap:             { value: this._solidTexture('#ffffff') },
        lesionMap:         { value: this._transparentTexture() },
        displacementScale: { value: 0.0 },
        cornealBulge:      { value: 0.022 },
        uAOStrength:       { value: 1.1 },
        uSSSStrength:      { value: 1.0 },
        uShowLesions:      { value: 0.0 },
        uTime:             { value: 0 },
        rimColor:          { value: new THREE.Color(0x55aaff) },
      },
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.scene.add(this.mesh);

    this.raycaster = new THREE.Raycaster();
    this.clock     = new THREE.Clock();
  }

  // 각막 유리 돔 — 실제 눈의 젖은 광택 + 캐치라이트 재현
  _buildCorneaMesh() {
    const geo = new THREE.SphereGeometry(1.034, 160, 120);
    const mat = new THREE.MeshPhysicalMaterial({
      color:              0x000000,
      transparent:        true,
      opacity:            0.0,
      roughness:          0.0,
      metalness:          0.0,
      clearcoat:          1.0,
      clearcoatRoughness: 0.02,
      reflectivity:       0.55,
      blending:           THREE.AdditiveBlending,
      depthWrite:         false,
      side:               THREE.FrontSide,
    });
    this.corneaMesh = new THREE.Mesh(geo, mat);
    this.corneaMesh.renderOrder = 1;
    this.scene.add(this.corneaMesh);
  }

  _solidTexture(cssColor) {
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const ctx = c.getContext('2d'); ctx.fillStyle = cssColor; ctx.fillRect(0, 0, 4, 4);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _buildGridOverlay() {
    const pts = [], R = 1.008;
    const toXYZ = (clockDeg, rNorm) => {
      const thetaMath = THREE.MathUtils.degToRad(clockDeg - 90);
      const phiDeg    = PHI_BAND_DEG[0] + rNorm * (PHI_BAND_DEG[1] - PHI_BAND_DEG[0]);
      const phi       = THREE.MathUtils.degToRad(phiDeg);
      return new THREE.Vector3(R*Math.sin(phi)*Math.cos(thetaMath), R*Math.sin(phi)*Math.sin(thetaMath), R*Math.cos(phi));
    };
    for (let ri = 0; ri <= GRID_RINGS; ri++) {
      const rNorm = ri / GRID_RINGS;
      for (let s = 0; s < 64; s++) pts.push(toXYZ(s*360/64, rNorm), toXYZ((s+1)*360/64, rNorm));
    }
    for (let si = 0; si <= GRID_SECTORS; si++) {
      const clockDeg = si * 360 / GRID_SECTORS;
      for (let r = 0; r < 20; r++) pts.push(toXYZ(clockDeg, r/20), toXYZ(clockDeg, (r+1)/20));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    this.gridLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x6db8ff, transparent: true, opacity: 0.28 }));
    this.scene.add(this.gridLines);
  }

  async build(photoSrc, side = 'left', geomOverride = null) {
    this.side = side;
    const img  = await this._loadImage(photoSrc);
    const geom = geomOverride || {
      cx: img.naturalWidth / 2, cy: img.naturalHeight / 2,
      pupilR:  Math.min(img.naturalWidth, img.naturalHeight) * 0.14,
      limbusR: Math.min(img.naturalWidth, img.naturalHeight) * 0.48,
    };

    const local = buildAtlasesFromImage(img, geom, side);
    this.gridStats = local.gridStats; this.backendResult = null;
    this._depthBuf   = local.depthBuf;   // depth Float32Array (cry/lac 감지)
    this._brightBuf  = local.brightBuf;  // 원본 밝기 Float32Array (ANR 감지)
    this._colorCanvas = local.colorCanvas; // 반사광 제거용 원본 캔버스
    this._applyTextures(local.colorCanvas, local.depthCanvas, local.normalCanvas, local.aoCanvas);

    if (this.aiServer) {
      try {
        const res = await fetch(`${this.aiServer}/iris3d/build`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_base64: photoSrc, side }),
          signal: AbortSignal.timeout(8000),
        }).then(r => r.json());
        if (res && res.success) {
          this.backendResult = res;
          this.gridStats = res.grid_stats.map(c => ({
            ring: c.ring, sector: c.sector, gridId: c.grid_id,
            thetaRange: c.theta_deg_range, rNormRange: c.r_norm_range,
            brightness: c.avg_brightness, depth: c.avg_depth, zoneId: c.zone_id,
          }));
          if (res.color_atlas_url) await this._applyBackendAtlases(res);
        }
      } catch (e) {
        console.warn('[iris3d] ai-engine 미연결:', e.message);
      }
    }
    return this.backendResult;
  }

  async _applyBackendAtlases(res) {
    const loader = new THREE.TextureLoader(); loader.setCrossOrigin('anonymous');
    const load = url => new Promise((resolve, reject) => loader.load(`${this.aiServer}${url}`, resolve, undefined, reject));
    try {
      const [colorTex, depthTex, normalTex, aoTex] = await Promise.all([
        load(res.color_atlas_url), load(res.depth_atlas_url),
        load(res.normal_atlas_url), load(res.ao_atlas_url),
      ]);
      colorTex.colorSpace = THREE.SRGBColorSpace;
      [colorTex, depthTex, normalTex, aoTex].forEach(t => { t.flipY = false; t.needsUpdate = true; });
      this.material.uniforms.colorMap.value  = colorTex;
      this.material.uniforms.depthMap.value  = depthTex;
      this.material.uniforms.normalMap.value = normalTex;
      this.material.uniforms.aoMap.value     = aoTex;
    } catch (e) {
      console.warn('[iris3d] 서버 아틀라스 로드 실패:', e.message);
    }
  }

  _loadImage(src) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('이미지 로드 타임아웃')), 10000);
      const img   = new Image(); img.crossOrigin = 'anonymous';
      img.onload  = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); reject(new Error('이미지 로드 실패')); };
      img.src = src;
    });
  }

  _applyTextures(colorCanvas, depthCanvas, normalCanvas, aoCanvas) {
    const colorTex = new THREE.CanvasTexture(colorCanvas);
    colorTex.flipY = false; colorTex.colorSpace = THREE.SRGBColorSpace;
    const depthTex = new THREE.CanvasTexture(depthCanvas); depthTex.flipY = false;
    this.material.uniforms.colorMap.value = colorTex;
    this.material.uniforms.depthMap.value = depthTex;
    if (normalCanvas) {
      const t = new THREE.CanvasTexture(normalCanvas); t.flipY = false;
      this.material.uniforms.normalMap.value = t;
    }
    if (aoCanvas) {
      const t = new THREE.CanvasTexture(aoCanvas); t.flipY = false;
      this.material.uniforms.aoMap.value = t;
    }
  }

  _bindEvents() {
    const dom = this.renderer.domElement;
    let downPos = null, downTime = 0;
    const getPos = e => {
      const rect = dom.getBoundingClientRect(), p = e.touches ? e.touches[0] : e;
      return { x: ((p.clientX-rect.left)/rect.width)*2-1, y: -((p.clientY-rect.top)/rect.height)*2+1, cx: p.clientX, cy: p.clientY };
    };
    dom.addEventListener('pointerdown', e => { downPos = getPos(e); downTime = performance.now(); });
    dom.addEventListener('pointerup',   e => {
      if (!downPos) return;
      const up = getPos(e);
      if (Math.hypot(up.cx-downPos.cx, up.cy-downPos.cy) < 8 && performance.now()-downTime < 400) this._pickCell(up);
      downPos = null;
    });
    window.addEventListener('resize', () => this._onResize());
    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(this.container);
  }

  _pickCell(pos) {
    this.raycaster.setFromCamera(new THREE.Vector2(pos.x, pos.y), this.camera);
    const hit = this.raycaster.intersectObject(this.mesh)[0];
    if (!hit) { this._hidePopup(); return; }

    // hit.uv.y는 Three.js SphereGeometry UV 기준 (v=0 = Y+ 극)이라서
    // 셰이더의 phiDeg(Z축 기준)와 좌표계가 달라 hit.point 법선벡터에서 직접 계산
    const n = hit.point.clone().normalize(); // 구체 원점 기준, 로컬 법선 = 위치 벡터
    const phiDeg    = Math.acos(Math.max(-1, Math.min(1, n.z))) * 180 / Math.PI;
    const thetaMathDeg = Math.atan2(n.y, n.x) * 180 / Math.PI;
    const clockDeg  = ((90 - thetaMathDeg) + 360) % 360; // 셰이더와 동일한 clock 방향
    const v         = phiDeg / 180;

    if (v < PUPIL_V || v > SCLERA_V) { this._hidePopup(); return; }
    const rNorm = (v - PUPIL_V) / (SCLERA_V - PUPIL_V);
    const ringI = Math.min(GRID_RINGS-1, Math.floor(rNorm * GRID_RINGS));
    const secI  = Math.min(GRID_SECTORS-1, Math.floor((clockDeg / 360) * GRID_SECTORS));
    const cell  = this.gridStats?.[ringI * GRID_SECTORS + secI];
    const zoneId = clockDegToZoneId(clockDeg, this._lesionSide || this.side);
    const cellWithZone = cell
      ? { ...cell, zoneId }
      : { gridId: `G${ringI}_${secI}`, brightness: 0, depth: 0, thetaRange: [clockDeg, clockDeg], rNormRange: [rNorm, rNorm], zoneId };
    this._showPopup(pos.cx, pos.cy, cellWithZone);
  }

  _showPopup(clientX, clientY, cell) {
    if (!this._popupEl) {
      this._popupEl = document.createElement('div');
      Object.assign(this._popupEl.style, {
        position: 'fixed', zIndex: 10000, pointerEvents: 'auto',
        background: 'rgba(4,10,26,.97)', border: '1px solid #2563EB',
        color: '#E0F2FE', font: '600 12px/1.6 -apple-system,sans-serif',
        padding: '11px 14px', borderRadius: '11px', minWidth: '195px',
        boxShadow: '0 8px 28px rgba(0,0,0,.7)',
      });
      document.body.appendChild(this._popupEl);
    }
    this._currentPopupCell = cell;
    this._popupClientX = clientX;
    this._popupClientY = clientY;

    const zid = cell.zoneId;
    const side = this._lesionSide || this.side;
    const sideData = (this._irisZoneData || {})[side] || {};
    const activeLesions = zid ? (sideData[zid] || []) : [];
    const zoneEntry = zid ? (ZONE_TABLE[side] || []).find(z => z[0] === zid) : null;
    const degRange = zoneEntry ? `${zoneEntry[1]}°–${zoneEntry[2]}°` : '';

    const btnHtml = LESION_DEFS.map(d => {
      const active = activeLesions.includes(d.id);
      const [r,g,b] = d.color;
      const bg = active ? `rgba(${r},${g},${b},0.88)` : `rgba(${r},${g},${b},0.14)`;
      const bd = active ? `rgba(${r},${g},${b},1)` : `rgba(${r},${g},${b},0.45)`;
      const fg = active ? '#fff' : `rgba(${r},${g},${b},0.9)`;
      return `<button onclick="if(window._ludiaIris3D)window._ludiaIris3D._toggleLC('${zid}','${d.id}')" ` +
        `style="background:${bg};border:1.5px solid ${bd};color:${fg};padding:3px 8px;border-radius:5px;` +
        `font-size:11px;font-weight:700;cursor:pointer;margin:2px 2px 0 0;font-family:inherit">` +
        `${d.ko}</button>`;
    }).join('');

    this._popupEl.innerHTML =
      `<div style="display:flex;align-items:baseline;gap:6px;margin-bottom:2px">` +
      `<span style="color:#7DD3FC;font-weight:900;font-size:13px">👁 ${zid || cell.gridId}</span>` +
      (degRange ? `<span style="font-size:10px;color:#64748B">${degRange}</span>` : '') +
      `</div>` +
      `<div style="font-size:11px;color:#64748B;margin-bottom:8px">` +
      `명도 ${(cell.brightness*100).toFixed(0)}% · 깊이 ${(cell.depth*100).toFixed(0)}%</div>` +
      `<div style="font-size:10px;color:#94A3B8;letter-spacing:.4px;margin-bottom:5px">▼ 병소 선택 (탭하여 ON/OFF)</div>` +
      `<div style="display:flex;flex-wrap:wrap">${btnHtml}</div>` +
      `<div onclick="if(window._ludiaIris3D)window._ludiaIris3D._hidePopup()" ` +
      `style="text-align:right;font-size:10px;color:#475569;cursor:pointer;margin-top:8px;padding-top:6px;` +
      `border-top:1px solid #1e3a5f">닫기 ×</div>`;

    const pw = 210, ph = 180;
    const lx = Math.min(clientX + 16, window.innerWidth - pw - 8);
    const ty = Math.max(Math.min(clientY - 30, window.innerHeight - ph - 8), 8);
    this._popupEl.style.left    = `${lx}px`;
    this._popupEl.style.top     = `${ty}px`;
    this._popupEl.style.display = 'block';
  }

  _hidePopup() {
    if (this._popupEl) this._popupEl.style.display = 'none';
    this._currentPopupCell = null;
  }

  startExam() {
    if (!this.gridStats) return null;
    this.onExamComplete(this.gridStats, this.side, this.backendResult);
    return this.gridStats;
  }

  _onResize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _dolly(factor) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const dist   = THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    offset.setLength(dist);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }
  zoomIn()  { this._dolly(0.78); }  // 한 번에 22% 더 가까이
  zoomOut() { this._dolly(1 / 0.78); }

  panBy(dx, dy) {
    const offset   = this.camera.position.clone().sub(this.controls.target);
    const panScale = offset.length() * 0.12;
    const panX = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0).multiplyScalar(dx * panScale);
    const panY = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1).multiplyScalar(dy * panScale);
    const pan  = panX.clone().add(panY);
    this.camera.position.add(pan); this.controls.target.add(pan.clone());
    this.controls.update();
  }

  resetView() {
    this.camera.position.copy(this._initialCamPos);
    this.controls.target.copy(this._initialTarget);
    this.controls.update();
  }

  _animate() {
    this._raf = requestAnimationFrame(() => this._animate());
    this.material.uniforms.uTime.value = this.clock.getElapsedTime();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // ── 투명 기본 텍스처 (lesionMap 초기값)
  _transparentTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const tex = new THREE.CanvasTexture(c); tex.flipY = false;
    return tex;
  }

  // ── 병소 아틀라스 생성 — ZONE_TABLE 영역을 lesion 색상으로 칠함
  _buildLesionAtlas() {
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_W; canvas.height = ATLAS_H;
    const ctx = canvas.getContext('2d');

    const side     = this._lesionSide || this.side;
    const sideData = (this._irisZoneData || {})[side] || {};
    const table    = ZONE_TABLE[side] || [];

    // 홍채 밴드: PHI_BAND_DEG → atlas 픽셀 행
    const yTop    = Math.floor(PUPIL_V  * ATLAS_H) + 3;
    const yBot    = Math.ceil (SCLERA_V * ATLAS_H) - 3;
    const yMid    = (yTop + yBot) / 2;

    for (const [zid, startDeg, endDeg] of table) {
      const lesions = sideData[zid];
      if (!lesions?.length) continue;

      const xLeft  = Math.floor(startDeg / 360 * ATLAS_W);
      const xRight = Math.ceil (endDeg   / 360 * ATLAS_W);
      const xW     = Math.max(1, xRight - xLeft);

      // 첫 번째 병소 색상 (넓은 기본 채색)
      const d0 = LESION_DEFS.find(d => d.id === lesions[0]) || LESION_DEFS[0];
      const [r0,g0,b0] = d0.color;
      ctx.fillStyle = `rgba(${r0},${g0},${b0},0.68)`;
      ctx.fillRect(xLeft, yTop, xW, yBot - yTop);

      // 두 번째 병소 색상 (아래 절반에 오버레이)
      if (lesions.length > 1) {
        const d1 = LESION_DEFS.find(d => d.id === lesions[1]) || LESION_DEFS[1];
        const [r1,g1,b1] = d1.color;
        ctx.fillStyle = `rgba(${r1},${g1},${b1},0.55)`;
        ctx.fillRect(xLeft, yMid | 0, xW, yBot - (yMid | 0));
      }

      // 테두리 하이라이트 (1px 왼쪽·오른쪽 엣지)
      ctx.fillStyle = `rgba(255,255,255,0.35)`;
      ctx.fillRect(xLeft,   yTop, 1, yBot - yTop);
      ctx.fillRect(xRight-1,yTop, 1, yBot - yTop);
    }
    return canvas;
  }

  // ── 병소 맵 업데이트 (외부에서 호출 — fd.irisZoneData 변경 시)
  updateLesionMap(irisZoneData, side) {
    this._irisZoneData = irisZoneData || {};
    this._lesionSide   = side || this.side;
    const canvas = this._buildLesionAtlas();
    const prev   = this.material.uniforms.lesionMap.value;
    const tex    = new THREE.CanvasTexture(canvas); tex.flipY = false;
    this.material.uniforms.lesionMap.value = tex;
    if (prev) prev.dispose();
    const hasLesions = Object.values((this._irisZoneData[this._lesionSide] || {}))
      .some(v => Array.isArray(v) && v.length > 0);
    this.material.uniforms.uShowLesions.value = hasLesions ? 1.0 : 0.0;
  }

  // ── 병소 토글 (팝업 버튼 onclick에서 호출)
  _toggleLC(zoneId, code) {
    if (!zoneId) return;
    const side = this._lesionSide || this.side;
    if (!this._irisZoneData)       this._irisZoneData = {};
    if (!this._irisZoneData[side]) this._irisZoneData[side] = {};
    const arr = this._irisZoneData[side][zoneId] ? [...this._irisZoneData[side][zoneId]] : [];
    const idx = arr.indexOf(code);
    if (idx >= 0) arr.splice(idx, 1); else arr.push(code);
    this._irisZoneData[side][zoneId] = arr;
    this.updateLesionMap(this._irisZoneData, side);
    if (typeof this.onLesionToggle === 'function') this.onLesionToggle(zoneId, [...arr], side);
    // 팝업 즉시 갱신 (버튼 active 상태 반영)
    if (this._currentPopupCell) this._showPopup(this._popupClientX, this._popupClientY, this._currentPopupCell);
  }

  // ── 병소 자동감지 — depthBuf Float32Array로 직접 스캔해 cry/lac 구역을 3D에 오버레이
  autoDetectLesions({ cryThresh = 0.65, lacMin = 0.35, lacMax = 0.60 } = {}) {
    if (!this._depthBuf) return {};
    const side = this._lesionSide || this.side;
    const W = ATLAS_W, H = ATLAS_H;

    // 1) Float32Array에서 직접 depth 읽기 (캔버스 알파 프리멀티플라이 문제 없음)
    const depthBuf = this._depthBuf;

    // 2) 픽셀별 cry/lac 마스크 캔버스 생성
    const raw  = document.createElement('canvas'); raw.width = W; raw.height = H;
    const rctx = raw.getContext('2d');
    const img  = rctx.createImageData(W, H);
    const px   = img.data;
    const zoneStats = {};

    for (let y = 0; y < H; y++) {
      const v = y / H;
      if (v < PUPIL_V || v > SCLERA_V) continue;   // 홍채 밴드만
      for (let x = 0; x < W; x++) {
        const depth = depthBuf[y * W + x]; // 0.0 ~ 1.0 float
        const pi    = (y * W + x) * 4;

        // 크립트: 매우 어두운 픽셀 → 빨강
        if (depth >= cryThresh) {
          px[pi] = 220; px[pi+1] = 50;  px[pi+2] = 50;  px[pi+3] = 218;
        // 라쿠나: 중간 깊이 → 황금빛
        } else if (depth >= lacMin && depth < lacMax) {
          px[pi] = 245; px[pi+1] = 172; px[pi+2] = 22;  px[pi+3] = 195;
        }

        // 구역별 통계 (fd.irisZoneData 업데이트용)
        const zid = clockDegToZoneId(x / W * 360, side);
        if (!zoneStats[zid]) zoneStats[zid] = { cry: 0, lac: 0, n: 0 };
        zoneStats[zid].n++;
        if (depth >= cryThresh)                     zoneStats[zid].cry++;
        else if (depth >= lacMin && depth < lacMax) zoneStats[zid].lac++;
      }
    }
    rctx.putImageData(img, 0, 0);

    // 3) 가장자리를 부드럽게 블러 (픽셀 경계선 제거)
    const blurred = document.createElement('canvas'); blurred.width = W; blurred.height = H;
    const bctx = blurred.getContext('2d');
    bctx.filter = 'blur(5px)';
    bctx.drawImage(raw, 0, 0);

    // 4) lesionMap 텍스처로 3D에 적용
    const prev = this.material.uniforms.lesionMap.value;
    const tex  = new THREE.CanvasTexture(blurred); tex.flipY = false;
    this.material.uniforms.lesionMap.value = tex;
    this.material.uniforms.uShowLesions.value = 1.0;
    if (prev) prev.dispose();

    // 5) 구역별 결과 반환 (fd.irisZoneData 업데이트 위해)
    const result = {};
    for (const [zid, s] of Object.entries(zoneStats)) {
      if (!s.n) continue;
      const codes = [];
      if (s.cry / s.n > 0.04) codes.push('cry');
      if (s.lac / s.n > 0.08) codes.push('lac');
      if (codes.length) result[zid] = codes;
    }
    return result;
  }

  // ── 자율신경환(ANR) 감지 — 섹터별 방사형 밝기 프로파일로 수축/확장/정상 판별
  detectANR() {
    if (!this._brightBuf) return null;
    const W = ATLAS_W, H = ATLAS_H;
    const brightBuf = this._brightBuf;
    const side = this._lesionSide || this.side;

    const BANDS = 50, N_SEC = 24, SMOOTH = 3;
    const ANR_MIN = Math.floor(0.18 * BANDS), ANR_MAX = Math.floor(0.60 * BANDS);

    // 주어진 밝기 프로파일에서 [minBand, maxBand] 범위 내 국소 최솟값 탐색
    const findMin = (rawProfile) => {
      const sm = new Float32Array(BANDS);
      for (let i = 0; i < BANDS; i++) {
        let s = 0, c = 0;
        for (let j = Math.max(0, i-SMOOTH); j <= Math.min(BANDS-1, i+SMOOTH); j++) {
          if (rawProfile[j] >= 0) { s += rawProfile[j]; c++; }
        }
        sm[i] = c > 0 ? s / c : 0;
      }
      let minVal = Infinity, minB = -1;
      for (let i = ANR_MIN; i <= ANR_MAX; i++) {
        if (sm[i] < minVal) { minVal = sm[i]; minB = i; }
      }
      const contrast = minB >= 0
        ? (sm[Math.max(0, minB-5)] + sm[Math.min(BANDS-1, minB+5)]) / 2 - minVal
        : 0;
      return { minB, contrast };
    };

    // 1) 전체 프로파일 (글로벌 ANR 위치)
    const gSum = new Float32Array(BANDS).fill(-1), gCnt = new Uint32Array(BANDS);
    // 2) 섹터별 프로파일 (N_SEC × BANDS)
    const sSum = Array.from({length: N_SEC}, () => new Float32Array(BANDS).fill(-1));
    const sCnt = Array.from({length: N_SEC}, () => new Uint32Array(BANDS));

    for (let y = 0; y < H; y++) {
      const v = y / H;
      if (v < PUPIL_V || v > SCLERA_V) continue;
      const rNorm = (v - PUPIL_V) / (SCLERA_V - PUPIL_V);
      const band  = Math.min(BANDS - 1, Math.floor(rNorm * BANDS));
      for (let x = 0; x < W; x++) {
        const b = brightBuf[y * W + x];
        if (b === 0) continue;
        if (gSum[band] < 0) gSum[band] = 0;
        gSum[band] += b; gCnt[band]++;
        const sec = Math.min(N_SEC - 1, Math.floor(x / W * N_SEC));
        if (sSum[sec][band] < 0) sSum[sec][band] = 0;
        sSum[sec][band] += b; sCnt[sec][band]++;
      }
    }

    const gProf = new Float32Array(BANDS);
    for (let i = 0; i < BANDS; i++) gProf[i] = gCnt[i] > 0 ? gSum[i] / gCnt[i] : -1;
    const global = findMin(gProf);
    const globalRNorm = global.minB >= 0 ? global.minB / BANDS : 0.35;

    // 3) 섹터별 ANR rNorm + 인접 섹터로 스무딩 (원형 이동평균 1칸)
    const rawSec = new Float32Array(N_SEC);
    const secContrast = new Float32Array(N_SEC);
    for (let s = 0; s < N_SEC; s++) {
      const p = new Float32Array(BANDS);
      for (let i = 0; i < BANDS; i++) p[i] = sCnt[s][i] > 0 ? sSum[s][i] / sCnt[s][i] : -1;
      const res = findMin(p);
      rawSec[s] = res.minB >= 0 ? res.minB / BANDS : globalRNorm;
      secContrast[s] = res.contrast;
    }
    // 원형 이동평균으로 섹터 간 rNorm 스무딩 (과도한 픽셀 잡음 제거)
    const sectorRNorm = new Float32Array(N_SEC);
    for (let s = 0; s < N_SEC; s++) {
      const prev = (s - 1 + N_SEC) % N_SEC, next = (s + 1) % N_SEC;
      sectorRNorm[s] = (rawSec[prev] * 0.25 + rawSec[s] * 0.5 + rawSec[next] * 0.25);
    }

    // 4) 평균·표준편차 계산 → 수축/확장 임계값
    let meanR = 0;
    for (let s = 0; s < N_SEC; s++) meanR += sectorRNorm[s];
    meanR /= N_SEC;
    let variance = 0;
    for (let s = 0; s < N_SEC; s++) variance += Math.pow(sectorRNorm[s] - meanR, 2);
    const stdR = Math.sqrt(variance / N_SEC);
    // 임계값: 표준편차 기반 (최소 2%, 최대 8%)
    const thresh = Math.max(0.02, Math.min(0.08, stdR * 1.2));

    // 5) 섹터 분류
    const sectorClass = new Array(N_SEC); // 'normal' | 'constricted' | 'expanded'
    for (let s = 0; s < N_SEC; s++) {
      const dev = sectorRNorm[s] - meanR;
      if (dev < -thresh) sectorClass[s] = 'constricted';
      else if (dev > thresh) sectorClass[s] = 'expanded';
      else sectorClass[s] = 'normal';
    }

    // 6) 섹터별 색상 맵핑 후 x축 선형 보간으로 링 그리기
    const BAND_W = 0.058; // 더 두껍게 — 3D에서 잘 보이도록
    const raw = document.createElement('canvas'); raw.width = W; raw.height = H;
    const rctx = raw.getContext('2d');
    const idat = rctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const v = y / H;
      if (v < PUPIL_V || v > SCLERA_V) continue;
      const rNorm = (v - PUPIL_V) / (SCLERA_V - PUPIL_V);
      for (let x = 0; x < W; x++) {
        // 두 인접 섹터 사이를 선형 보간
        const fSec = (x / W) * N_SEC;
        const s0 = Math.floor(fSec) % N_SEC, s1 = (s0 + 1) % N_SEC;
        const t  = fSec - Math.floor(fSec);
        const anrR = sectorRNorm[s0] * (1 - t) + sectorRNorm[s1] * t;
        const dist = Math.abs(rNorm - anrR);
        if (dist > BAND_W) continue;
        const alpha = Math.pow(1 - dist / BAND_W, 1.5);
        const pi = (y * W + x) * 4;
        // 인접 섹터 중 지배적 클래스로 색 결정
        const cls = t < 0.5 ? sectorClass[s0] : sectorClass[s1];
        let cr, cg, cb;
        if      (cls === 'constricted') { cr=245; cg=90;  cb=40;  } // 오렌지-레드 (수축)
        else if (cls === 'expanded')    { cr=50;  cg=210; cb=120; } // 초록 (확장)
        else                            { cr=6;   cg=182; cb=212; } // 시안 (정상)
        idat.data[pi]=cr; idat.data[pi+1]=cg; idat.data[pi+2]=cb;
        idat.data[pi+3] = Math.round(alpha * 230);
      }
    }
    rctx.putImageData(idat, 0, 0);

    // 7) 기존 lesionMap 위에 합성 + 블러
    const merged = document.createElement('canvas'); merged.width = W; merged.height = H;
    const mctx = merged.getContext('2d');
    const prevTex = this.material.uniforms.lesionMap.value;
    if (prevTex && prevTex.image) mctx.drawImage(prevTex.image, 0, 0);
    mctx.filter = 'blur(3px)';
    mctx.drawImage(raw, 0, 0);

    const prev = this.material.uniforms.lesionMap.value;
    const tex = new THREE.CanvasTexture(merged); tex.flipY = false;
    this.material.uniforms.lesionMap.value = tex;
    this.material.uniforms.uShowLesions.value = 1.0;
    if (prev) prev.dispose();

    // 8) 구역별 결과 요약 (시계 방향 각도 → 구역 ID)
    const zoneSummary = {};
    for (let s = 0; s < N_SEC; s++) {
      const clockDeg = ((s + 0.5) / N_SEC) * 360;
      const zid = clockDegToZoneId(clockDeg, side);
      if (!zid) continue;
      if (!zoneSummary[zid]) zoneSummary[zid] = { cls: 'normal', rNorm: 0, n: 0 };
      zoneSummary[zid].rNorm += sectorRNorm[s];
      zoneSummary[zid].n++;
      // 수축/확장이 하나라도 있으면 우선 적용
      if (sectorClass[s] !== 'normal') zoneSummary[zid].cls = sectorClass[s];
    }
    for (const z of Object.values(zoneSummary)) z.rNorm = +(z.rNorm / z.n).toFixed(3);

    const constrictedSecs = sectorClass.reduce((a,c,i) => c==='constricted' ? [...a,i] : a, []);
    const expandedSecs    = sectorClass.reduce((a,c,i) => c==='expanded'    ? [...a,i] : a, []);

    return {
      detected: global.contrast >= 0.01,
      meanRNorm: +meanR.toFixed(3),
      stdRNorm:  +stdR.toFixed(3),
      sectorRNorm: Array.from(sectorRNorm),
      sectorClass,
      zoneSummary,
      constrictedSecs,
      expandedSecs,
    };
  }

  // ── 반사광 제거 — 흰색 하이라이트를 감지 후 주변 홍채 색으로 인페인팅
  removeSpecularHighlights({ lumThresh = 0.82, satThresh = 0.28 } = {}) {
    const canvas = this._colorCanvas;
    if (!canvas) return 0;
    const W = ATLAS_W, H = ATLAS_H;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, W, H);
    const src = imgData.data;

    // 1) 반사광 마스크 생성 (홍채 대역 내 고휘도·저채도 픽셀)
    const mask = new Uint8Array(W * H); // 1 = 반사광, 0 = 정상
    for (let y = 0; y < H; y++) {
      const v = y / H;
      if (v < PUPIL_V || v > SCLERA_V) continue;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = src[i], g = src[i+1], b = src[i+2];
        const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
        const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
        const sat  = maxC > 0 ? (maxC - minC) / maxC : 0;
        if (lum > lumThresh && sat < satThresh) mask[y * W + x] = 1;
      }
    }

    // 2) 마스크 2픽셀 팽창 (경계부 부드럽게)
    const dilated = new Uint8Array(W * H);
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        outer: for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          if (mask[(y+dy)*W + ((x+dx+W)%W)]) { dilated[y*W+x] = 1; break outer; }
        }
      }
    }

    // 3) 단계적 인페인팅 (바깥쪽에서 안쪽으로 — 최대 25패스)
    const filled = new Uint8Array(W * H); // 이미 채워진 픽셀
    const cur    = new Uint8ClampedArray(src); // 채워나갈 버퍼
    let remaining = 0;
    for (let i = 0; i < W * H; i++) if (dilated[i]) remaining++;

    for (let pass = 0; pass < 25 && remaining > 0; pass++) {
      let changed = 0;
      for (let y = 1; y < H - 1; y++) {
        const v = y / H;
        if (v < PUPIL_V - 0.01 || v > SCLERA_V + 0.01) continue;
        for (let x = 0; x < W; x++) {
          if (!dilated[y*W+x] || filled[y*W+x]) continue;
          let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
          for (let dy = -3; dy <= 3; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= H) continue;
            const nv = ny / H;
            if (nv < PUPIL_V || nv > SCLERA_V) continue;
            for (let dx = -3; dx <= 3; dx++) {
              const nx = ((x + dx) % W + W) % W;
              if (dilated[ny*W+nx] && !filled[ny*W+nx]) continue; // 아직 안 채워진 마스크 픽셀 건너뜀
              const d2 = dx*dx + dy*dy;
              const w  = 1.0 / (d2 + 0.5);
              const ni = (ny*W+nx) * 4;
              sumR += cur[ni]*w; sumG += cur[ni+1]*w; sumB += cur[ni+2]*w;
              sumW += w;
            }
          }
          if (sumW > 0.8) {
            const pi = (y*W+x) * 4;
            cur[pi]   = Math.round(sumR / sumW);
            cur[pi+1] = Math.round(sumG / sumW);
            cur[pi+2] = Math.round(sumB / sumW);
            cur[pi+3] = 255;
            filled[y*W+x] = 1;
            if (this._brightBuf) this._brightBuf[y*W+x] = 0; // ANR 프로파일에서도 제거
            remaining--; changed++;
          }
        }
      }
      if (changed === 0) break;
    }

    // 4) 텍스처 갱신
    ctx.putImageData(new ImageData(cur, W, H), 0, 0);
    const colorTex = this.material.uniforms.colorMap?.value;
    if (colorTex) colorTex.needsUpdate = true;

    return W * H - remaining; // 처리된 픽셀 수
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._resizeObserver?.disconnect();
    this._popupEl?.remove();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    if (window._ludiaIris3D === this) window._ludiaIris3D = null;
  }
}

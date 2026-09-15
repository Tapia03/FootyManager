import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as THREE from "three";
import { hashStr, SKIN_TONES, HAIR_COLORS } from "@/game/player-appearance";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import {
  Camera,
  Sun,
  CloudRain,
  Moon,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  Eye,
  EyeOff,
} from "lucide-react";

// -----------------------------------------------------------------------------
// Visualizador 3D da partida — Three.js, adaptado de um protótipo gerado no
// Google AI Studio (motor de renderização mantido quase intacto: campo,
// estádio, iluminação, boneco articulado por junta, câmeras). O que muda é a
// fonte dos dados: aqui os `dots`/`ball` vêm de src/game/live-positions.ts,
// a mesma lógica de posicionamento que o visualizador 2D (match-pitch.tsx)
// usa — não uma simulação tática contínua própria como o protótipo original
// tinha (nosso motor de partida produz eventos discretos por minuto, não uma
// simulação espacial; ver src/game/simulation.ts).
//
// Convenção de coordenadas do projeto (ver src/game/formation-layout.ts):
// x = largura do campo (0-100), y = comprimento (0-100, 100 = gol do
// mandante). O mundo 3D usa comprimento no eixo X e largura no eixo Z — por
// isso os dois mapeamentos abaixo trocam x/y na hora de converter.
// -----------------------------------------------------------------------------

export type CameraView = "tv" | "sideline" | "behind_goal" | "tactical" | "dugout";
export type WeatherType = "sol" | "noite" | "chuva";
// Nível de pós-processamento / desempenho (e3-post). "baixa" pula o
// EffectComposer inteiro (render direto); "media" liga bloom + vinheta;
// "alta" acrescenta SMAA e pixelRatio 2.
export type Quality3D = "baixa" | "media" | "alta";
const QUALITY_LS_KEY = "footymanager-3d-quality";

export interface Match3DDot {
  id: string;
  playerName: string;
  // Nosso modelo de jogador não tem número de camisa — a legenda mostra só
  // o nome quando ausente, em vez de inventar um número.
  number?: number;
  side: "home" | "away";
  slot: string; // "GK" identifica o goleiro (ver src/game/formation-layout.ts)
  x: number; // 0-100, largura do campo
  y: number; // 0-100, comprimento do campo (100 = gol do mandante)
  // Pose especial deste instante (ver src/game/live-positions.ts::DotAnim).
  anim?: string;
}

// `dots`/`ball` entram por um handle imperativo (ver Match3DPitchHandle), NÃO
// por props. São recriados a cada frame (a posição de todo mundo muda o
// tempo todo) — se fossem props, o React re-renderizaria a árvore inteira de
// JSX deste componente (câmeras/zoom/clima/qualidade — 15+ botões) 60x por
// segundo só porque a posição de alguém mudou, mesmo esse JSX não
// dependendo de nada disso. Era a causa real da trava progressiva reportada
// em partidas longas (lixo de GC contínuo, sem parar). Os outros valores
// "ao vivo" (isGoalHappening, isDangerousMoment, matchSpeed, tickerText) são
// booleanos/primitivos que mudam raramente — continuam props normais,
// `React.memo` já lida bem com eles (só re-renderiza quando o VALOR muda).
export interface Match3DLiveUpdate {
  dots: Match3DDot[];
  ball: { x: number; y: number };
}

export interface Match3DPitchHandle {
  update(next: Match3DLiveUpdate): void;
}

interface Match3DPitchProps {
  homePrimaryColor: string;
  homeSecondaryColor: string;
  awayPrimaryColor: string;
  awaySecondaryColor: string;
  isGoalHappening?: boolean;
  isDangerousMoment?: boolean;
  specialActionTitle?: string | null;
  // Capacidade do estádio do mandante — controla o tamanho da torcida
  // (mais gente = mais lugares ocupados). Ver buildCrowd().
  stadiumCapacity?: number;
  // Capitães — ganham braçadeira no modelo 3D.
  homeCaptainId?: string | null;
  awayCaptainId?: string | null;
  activeCamera: CameraView;
  onCameraChange: (cam: CameraView) => void;
  weather: WeatherType;
  onWeatherChange: (w: WeatherType) => void;
  matchSpeed?: number;
  tickerText?: string;
  matchKey: string; // troca (ex: `${homeId}-${awayId}`) recria a cena do zero
}

interface PlayerMeshModel {
  id: string;
  group: THREE.Group;
  pelvis: THREE.Group;
  leftHip: THREE.Group;
  rightHip: THREE.Group;
  leftKnee: THREE.Group;
  rightKnee: THREE.Group;
  leftShoulder: THREE.Group;
  rightShoulder: THREE.Group;
  leftElbow: THREE.Group;
  rightElbow: THREE.Group;
  nameSprite: THREE.Sprite;
  isGk: boolean;
  runPhase: number;
}

function toHex(color: string, fallback: number): number {
  const c = color?.trim();
  if (!c) return fallback;
  const parsed = parseInt(c.replace("#", ""), 16);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// hashStr/SKIN_TONES/HAIR_COLORS agora vêm de src/game/player-appearance.ts
// (compartilhado com o retrato 2D em src/components/player-face.tsx — o
// mesmo jogador tem a mesma pele/cabelo nos dois lugares).

// Número na canvas → textura pra colar nas costas da camisa.
function makeNumberTexture(num: number, dark: boolean): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, 128, 128);
    ctx.font = "bold 92px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = dark ? "#0b0f19" : "#ffffff";
    ctx.fillText(String(num), 64, 70);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

const Match3DPitchInner = forwardRef<Match3DPitchHandle, Match3DPitchProps>(({
  homePrimaryColor,
  homeSecondaryColor,
  awayPrimaryColor,
  awaySecondaryColor,
  isGoalHappening = false,
  isDangerousMoment = false,
  specialActionTitle = null,
  stadiumCapacity = 30000,
  homeCaptainId = null,
  awayCaptainId = null,
  activeCamera,
  onCameraChange,
  weather,
  onWeatherChange,
  matchSpeed = 2,
  tickerText = "★ TÁTICAFC ★ PARTIDA AO VIVO ★",
  matchKey,
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);

  const matchSpeedRef = useRef(matchSpeed);
  matchSpeedRef.current = matchSpeed;

  const tickerTextRef = useRef(tickerText);
  tickerTextRef.current = tickerText;

  const [zoomLevel, setZoomLevel] = useState<number>(1.1);
  const [showPlayerTags, setShowPlayerTags] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [quality, setQuality] = useState<Quality3D>(() => {
    try {
      const saved = localStorage.getItem(QUALITY_LS_KEY);
      if (saved === "baixa" || saved === "media" || saved === "alta") return saved;
    } catch { /* localStorage indisponível */ }
    const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
    const small = typeof window !== "undefined" && window.innerWidth < 900;
    // "alta" (sombra 2048 recalculada todo frame + bloom + SMAA) é pesado
    // sustentado por muitos minutos de partida — "media" é o padrão mais
    // seguro; quem quiser o visual máximo troca no toggle B/M/A.
    return coarse || small ? "baixa" : "media";
  });

  // `dots`/`ball` chegam pelo handle imperativo (`update()`, abaixo) — nunca
  // por props — pra não forçar este componente a re-renderizar a árvore
  // inteira de JSX (câmeras/zoom/clima/qualidade) 60x por segundo. Ver
  // Match3DLiveUpdate mais acima.
  const dotsRef = useRef<Match3DDot[]>([]);
  const ballRef = useRef({ x: 50, y: 50 });
  // Elenco em campo na última chamada de `update()` — só muda numa
  // substituição de verdade; dispara `syncPlayerModels` quando muda (não a
  // cada frame). Era a causa real da trava progressiva reportada.
  const lastRosterKeyRef = useRef<string>("");

  const isGoalHappeningRef = useRef(isGoalHappening);
  isGoalHappeningRef.current = isGoalHappening;

  const isDangerousMomentRef = useRef(isDangerousMoment);
  isDangerousMomentRef.current = isDangerousMoment;

  const zoomLevelRef = useRef(zoomLevel);
  zoomLevelRef.current = zoomLevel;

  const activeCameraRef = useRef(activeCamera);
  activeCameraRef.current = activeCamera;

  const showPlayerTagsRef = useRef(showPlayerTags);
  showPlayerTagsRef.current = showPlayerTags;

  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const animFrameIdRef = useRef<number | null>(null);

  // Pós-processamento (e3-post) — composer + passes. O nível de qualidade
  // (e3-perf) é lido na montagem da cena; trocá-lo recria a cena inteira (o
  // efeito principal depende de `quality`), como uma troca de `matchKey`.
  const composerRef = useRef<EffectComposer | null>(null);
  const bloomPassRef = useRef<UnrealBloomPass | null>(null);
  const smaaPassRef = useRef<SMAAPass | null>(null);
  const vignettePassRef = useRef<ShaderPass | null>(null);
  // Câmera "TV": antecipação (segue pra onde a bola vai) + trepidação no gol.
  const ballVelRef = useRef<{ x: number; z: number }>({ x: 0, z: 0 });
  const prevBallRef = useRef<{ x: number; z: number }>({ x: 0, z: 0 });
  const camShakeRef = useRef<number>(0);

  const ballMeshRef = useRef<THREE.Mesh | null>(null);
  const ballShadowRef = useRef<THREE.Mesh | null>(null);
  const ballRingRef = useRef<THREE.Mesh | null>(null);
  const possessionRingRef = useRef<THREE.Group | null>(null);
  const playersModelsRef = useRef<Map<string, PlayerMeshModel>>(new Map());
  const rainParticlesRef = useRef<THREE.Points | null>(null);
  const ledCanvasContextRef = useRef<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture } | null>(null);
  // Torcida — uniforms compartilhados; o loop mexe só em uTime e uCheer (custo
  // de CPU ~zero, mesmo com ~14k espectadores, porque a oscilação/pulo mora no
  // vertex shader — ver buildCrowd()).
  const crowdUniformsRef = useRef<{ uTime: { value: number }; uCheer: { value: number } } | null>(null);
  const crowdCheerTargetRef = useRef(0);
  // Estádio: refletores (matéria emissiva das lâmpadas), céu em gradiente,
  // bandeirinhas de escanteio — o handler de clima e o loop mexem nesses.
  const lampMatsRef = useRef<THREE.MeshStandardMaterial[]>([]);
  const skyUniformsRef = useRef<{ uTop: { value: THREE.Color }; uBottom: { value: THREE.Color } } | null>(null);
  const cornerFlagsRef = useRef<THREE.Mesh[]>([]);
  const stadiumCapacityRef = useRef(stadiumCapacity);
  stadiumCapacityRef.current = stadiumCapacity;

  const ballCurrentPos = useRef<{ x: number; y: number; z: number; rollAngle: number }>({ x: 0, y: 0.52, z: 0, rollAngle: 0 });
  const ballFlightTime = useRef<number>(0);
  const netHomeRef = useRef<THREE.Mesh | null>(null);
  const netAwayRef = useRef<THREE.Mesh | null>(null);

  // Pitch Dimensions (padrão FIFA): 105m x 68m.
  // normY (comprimento, 100 = gol do mandante) -> eixo mundial X, invertido
  // pra o mandante ficar sempre no gol da esquerda.
  const toWorldLength = (normY: number): number => (0.5 - normY / 100) * 105;
  // normX (largura) -> eixo mundial Z.
  const toWorldWidth = (normX: number): number => (normX / 100 - 0.5) * 68;

  const createGrassTexture = (): THREE.CanvasTexture => {
    const canvas = document.createElement("canvas");
    canvas.width = 2048;
    canvas.height = 2048;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const bands = 14;
      const bandWidth = canvas.width / bands;
      for (let i = 0; i < bands; i++) {
        ctx.fillStyle = i % 2 === 0 ? "#1f5d2b" : "#276b33";
        ctx.fillRect(i * bandWidth, 0, bandWidth, canvas.height);
      }
      ctx.fillStyle = "rgba(0, 0, 0, 0.05)";
      for (let j = 0; j < 12000; j++) {
        const x = Math.random() * canvas.width;
        const y = Math.random() * canvas.height;
        ctx.fillRect(x, y, 2, 3);
      }
      ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
      for (let k = 0; k < 6000; k++) {
        const x = Math.random() * canvas.width;
        const y = Math.random() * canvas.height;
        ctx.fillRect(x, y, 2, 2);
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  };

  const createLedTexture = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2048;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    ledCanvasContextRef.current = { canvas, ctx, texture };
    return texture;
  };

  const createSoccerBallTexture = (): THREE.CanvasTexture => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 512, 512);
      ctx.fillStyle = "#0f172a";
      const pentagons = [
        [128, 128], [384, 128], [256, 256], [128, 384], [384, 384],
      ];
      pentagons.forEach(([px, py]) => {
        ctx.beginPath();
        ctx.arc(px, py, 42, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.strokeStyle = "#e2e8f0";
      ctx.lineWidth = 4;
      ctx.strokeRect(0, 0, 512, 512);
    }
    return new THREE.CanvasTexture(canvas);
  };

  const createPlayerNameSprite = (name: string, number: number | undefined, isHome: boolean): THREE.Sprite => {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
      ctx.roundRect(8, 8, 240, 48, 12);
      ctx.fill();
      ctx.strokeStyle = isHome ? "#10b981" : "#38bdf8";
      ctx.lineWidth = 2.5;
      ctx.roundRect(8, 8, 240, 48, 12);
      ctx.stroke();
      ctx.font = "bold 22px sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const shortName = name.split(" ").pop() || name;
      ctx.fillText(number != null ? `${number}  ${shortName}` : shortName, 128, 32);
    }
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(3.2, 0.8, 1);
    sprite.position.set(0, 3.4, 0);
    return sprite;
  };

  // --- Inicializa a cena Three.js uma vez por partida ---
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 1200;
    const height = container.clientHeight || 700;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(weather === "noite" ? 0x0a1120 : 0x9fc4de, 0.0032);
    sceneRef.current = scene;

    // Céu em gradiente (cúpula) — o handler de clima troca as cores.
    const skyUniforms = {
      uTop: { value: new THREE.Color(weather === "noite" ? 0x05070d : 0x2e6fb0) },
      uBottom: { value: new THREE.Color(weather === "noite" ? 0x141c2e : 0xbcd7ea) },
    };
    skyUniformsRef.current = skyUniforms;
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(320, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: skyUniforms,
        vertexShader: "varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
        fragmentShader: "uniform vec3 uTop; uniform vec3 uBottom; varying vec3 vP; void main(){ float h = clamp((normalize(vP).y + 0.15) / 0.9, 0.0, 1.0); gl_FragColor = vec4(mix(uBottom, uTop, pow(h, 0.75)), 1.0); }",
      }),
    );
    scene.add(sky);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.5, 500);
    cameraRef.current = camera;

    // --- Nível de qualidade (e3-perf) --------------------------------------
    // Lido aqui na montagem; `quality` está nas deps do efeito, então trocar
    // o nível recria a cena (torcida, sombras, pós) já com o custo certo.
    const q = quality;
    const hi = q === "alta";
    const lo = q === "baixa";
    const qPixelRatio = Math.min(window.devicePixelRatio || 1, hi ? 2 : q === "media" ? 1.5 : 1);
    const qShadows = !lo;
    const qCrowdFill = hi ? 1 : q === "media" ? 0.6 : 0;   // 0 = sem torcida instanciada
    const useComposer = !lo;

    const renderer = new THREE.WebGLRenderer({ antialias: lo, powerPreference: "high-performance" });
    renderer.setSize(width, height);
    renderer.setPixelRatio(qPixelRatio);
    renderer.shadowMap.enabled = qShadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Tom cinematográfico (ACES) — o OutputPass do composer lê estes valores;
    // no modo "baixa" (render direto) o próprio renderer aplica.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    rendererRef.current = renderer;

    container.replaceChildren(renderer.domElement);

    // --- Pós-processamento (e3-post) -----------------------------------------
    // Bloom nos refletores/emissivos + vinheta sutil + AA (SMAA). Ordem:
    // cena → bloom → vinheta → OutputPass (ACES + sRGB) → SMAA (espaço sRGB).
    // Fora do nível "baixa", que renderiza direto (sem composer).
    let composer: EffectComposer | null = null;
    if (useComposer) {
      composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));

      const bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.6, 0.55, 0.82);
      composer.addPass(bloomPass);
      bloomPassRef.current = bloomPass;

      const vignettePass = new ShaderPass({
        uniforms: { tDiffuse: { value: null }, uStrength: { value: 0.9 } },
        vertexShader:
          "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
        fragmentShader: [
          "uniform sampler2D tDiffuse; uniform float uStrength; varying vec2 vUv;",
          "void main(){",
          "  vec4 c = texture2D(tDiffuse, vUv);",
          "  vec2 d = vUv - 0.5;",
          "  float v = smoothstep(0.85, 0.22, dot(d, d) * 2.9);",
          "  c.rgb *= mix(1.0, v, uStrength * 0.55);",
          "  gl_FragColor = c;",
          "}",
        ].join("\n"),
      });
      composer.addPass(vignettePass);
      vignettePassRef.current = vignettePass;

      composer.addPass(new OutputPass());

      if (hi) {
        const smaaPass = new SMAAPass();
        composer.addPass(smaaPass);
        smaaPassRef.current = smaaPass;
      }
      composer.setPixelRatio(qPixelRatio);
      composer.setSize(width, height);
      composerRef.current = composer;
    }

    const ambientLight = new THREE.AmbientLight(0xffffff, weather === "noite" ? 0.78 : 0.9);
    scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xfff5e6, weather === "noite" ? 0.8 : 1.35);
    sunLight.position.set(45, 65, 35);
    sunLight.castShadow = qShadows;
    sunLight.shadow.mapSize.width = hi ? 2048 : 1024;
    sunLight.shadow.mapSize.height = hi ? 2048 : 1024;
    sunLight.shadow.camera.near = 10;
    sunLight.shadow.camera.far = 160;
    sunLight.shadow.camera.left = -65;
    sunLight.shadow.camera.right = 65;
    sunLight.shadow.camera.top = 50;
    sunLight.shadow.camera.bottom = -50;
    sunLight.shadow.bias = -0.0005;
    scene.add(sunLight);

    const nightish = weather !== "sol";
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.7, metalness: 0.5 });
    const addFloodlight = (x: number, z: number) => {
      const spot = new THREE.SpotLight(0xffffff, nightish ? 1.15 : 0.35, 170, Math.PI / 4.2, 0.45, 1.1);
      spot.position.set(x, 40, z);
      spot.target.position.set(x * 0.28, 0, z * 0.28);
      scene.add(spot);
      scene.add(spot.target);

      // Poste + cabeça de lâmpadas (4x3 painéis emissivos).
      const mastH = 38;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 1.1, mastH, 8), mastMat);
      mast.position.set(x, mastH / 2, z);
      mast.castShadow = true;
      scene.add(mast);

      const head = new THREE.Group();
      head.position.set(x, mastH + 1.5, z);
      head.lookAt(0, 0, 0);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(9, 5, 0.6), mastMat);
      head.add(frame);
      const lampMat = new THREE.MeshStandardMaterial({
        color: 0xf5f3e6, emissive: 0xfff8e0, emissiveIntensity: nightish ? 2.4 : 0.15, roughness: 0.4,
      });
      lampMatsRef.current.push(lampMat);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
        const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.85, 12), lampMat);
        lamp.position.set(-3.3 + c * 2.2, -1.6 + r * 1.6, 0.35);
        head.add(lamp);
      }
      scene.add(head);
    };
    addFloodlight(-64, -46);
    addFloodlight(64, -46);
    addFloodlight(-64, 46);
    addFloodlight(64, 46);

    const pitchLength = 105;
    const pitchWidth = 68;

    const grassGeo = new THREE.PlaneGeometry(pitchLength, pitchWidth);
    const grassTex = createGrassTexture();
    const grassMat = new THREE.MeshStandardMaterial({ map: grassTex, roughness: 0.88, metalness: 0.05 });
    const pitch = new THREE.Mesh(grassGeo, grassMat);
    pitch.rotation.x = -Math.PI / 2;
    pitch.receiveShadow = true;
    scene.add(pitch);

    const runoffGeo = new THREE.PlaneGeometry(pitchLength + 20, pitchWidth + 16);
    const runoffMat = new THREE.MeshStandardMaterial({ color: 0x144520, roughness: 0.95 });
    const runoff = new THREE.Mesh(runoffGeo, runoffMat);
    runoff.rotation.x = -Math.PI / 2;
    runoff.position.y = -0.02;
    runoff.receiveShadow = true;
    scene.add(runoff);

    const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false });
    const lineY = 0.02;
    const lw = 0.22;

    const addLine = (w: number, h: number, x: number, z: number) => {
      const lineMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), lineMat);
      lineMesh.rotation.x = -Math.PI / 2;
      lineMesh.position.set(x, lineY, z);
      scene.add(lineMesh);
    };

    addLine(pitchLength, lw, 0, -pitchWidth / 2);
    addLine(pitchLength, lw, 0, pitchWidth / 2);
    addLine(lw, pitchWidth, -pitchLength / 2, 0);
    addLine(lw, pitchWidth, pitchLength / 2, 0);
    addLine(lw, pitchWidth, 0, 0);

    const centerCircleGeo = new THREE.RingGeometry(9.15 - lw / 2, 9.15 + lw / 2, 64);
    const centerCircle = new THREE.Mesh(centerCircleGeo, lineMat);
    centerCircle.rotation.x = -Math.PI / 2;
    centerCircle.position.set(0, lineY, 0);
    scene.add(centerCircle);

    const centerSpot = new THREE.Mesh(new THREE.CircleGeometry(0.35, 16), lineMat);
    centerSpot.rotation.x = -Math.PI / 2;
    centerSpot.position.set(0, lineY, 0);
    scene.add(centerSpot);

    const penW = 16.5;
    const penH = 40.3;
    addLine(penW, lw, -pitchLength / 2 + penW / 2, -penH / 2);
    addLine(penW, lw, -pitchLength / 2 + penW / 2, penH / 2);
    addLine(lw, penH, -pitchLength / 2 + penW, 0);
    addLine(penW, lw, pitchLength / 2 - penW / 2, -penH / 2);
    addLine(penW, lw, pitchLength / 2 - penW / 2, penH / 2);
    addLine(lw, penH, pitchLength / 2 - penW, 0);

    const gAreaW = 5.5;
    const gAreaH = 18.3;
    addLine(gAreaW, lw, -pitchLength / 2 + gAreaW / 2, -gAreaH / 2);
    addLine(gAreaW, lw, -pitchLength / 2 + gAreaW / 2, gAreaH / 2);
    addLine(lw, gAreaH, -pitchLength / 2 + gAreaW, 0);
    addLine(gAreaW, lw, pitchLength / 2 - gAreaW / 2, -gAreaH / 2);
    addLine(gAreaW, lw, pitchLength / 2 - gAreaW / 2, gAreaH / 2);
    addLine(lw, gAreaH, pitchLength / 2 - gAreaW, 0);

    const penSpotL = new THREE.Mesh(new THREE.CircleGeometry(0.28, 16), lineMat);
    penSpotL.rotation.x = -Math.PI / 2;
    penSpotL.position.set(-pitchLength / 2 + 11, lineY, 0);
    scene.add(penSpotL);

    const penSpotR = new THREE.Mesh(new THREE.CircleGeometry(0.28, 16), lineMat);
    penSpotR.rotation.x = -Math.PI / 2;
    penSpotR.position.set(pitchLength / 2 - 11, lineY, 0);
    scene.add(penSpotR);

    const goalW = 7.32;
    const goalH = 2.44;
    const postRadius = 0.08;

    const create3DGoal = (isLeft: boolean) => {
      const goalGroup = new THREE.Group();
      const postMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.4 });

      const bar = new THREE.Mesh(new THREE.CylinderGeometry(postRadius, postRadius, goalW, 16), postMat);
      bar.rotation.x = Math.PI / 2;
      bar.position.set(0, goalH, 0);
      bar.castShadow = true;
      goalGroup.add(bar);

      const postL = new THREE.Mesh(new THREE.CylinderGeometry(postRadius, postRadius, goalH, 16), postMat);
      postL.position.set(0, goalH / 2, -goalW / 2);
      postL.castShadow = true;
      goalGroup.add(postL);

      const postR = new THREE.Mesh(new THREE.CylinderGeometry(postRadius, postRadius, goalH, 16), postMat);
      postR.position.set(0, goalH / 2, goalW / 2);
      postR.castShadow = true;
      goalGroup.add(postR);

      const netDepth = 2.0;
      const netMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, wireframe: true, transparent: true, opacity: 0.45 });
      const net = new THREE.Mesh(new THREE.BoxGeometry(netDepth, goalH, goalW), netMat);
      net.position.set(isLeft ? -netDepth / 2 : netDepth / 2, goalH / 2, 0);
      goalGroup.add(net);

      if (isLeft) netHomeRef.current = net;
      else netAwayRef.current = net;

      goalGroup.position.set(isLeft ? -pitchLength / 2 : pitchLength / 2, 0, 0);
      return goalGroup;
    };

    scene.add(create3DGoal(true));
    scene.add(create3DGoal(false));

    const ledTex = createLedTexture();
    const ledMat = new THREE.MeshBasicMaterial({ map: ledTex });
    const boardHeight = 1.1;

    const sideBoardGeo = new THREE.BoxGeometry(pitchLength + 6, boardHeight, 0.3);
    const topBoard = new THREE.Mesh(sideBoardGeo, ledMat);
    topBoard.position.set(0, boardHeight / 2, -pitchWidth / 2 - 1.4);
    scene.add(topBoard);

    const btmBoard = new THREE.Mesh(sideBoardGeo, ledMat);
    btmBoard.position.set(0, boardHeight / 2, pitchWidth / 2 + 1.4);
    scene.add(btmBoard);

    const endBoardGeo = new THREE.BoxGeometry(0.3, boardHeight, (pitchWidth - 14) / 2);
    const l1 = new THREE.Mesh(endBoardGeo, ledMat);
    l1.position.set(-pitchLength / 2 - 3.2, boardHeight / 2, -pitchWidth / 4);
    scene.add(l1);
    const l2 = new THREE.Mesh(endBoardGeo, ledMat);
    l2.position.set(-pitchLength / 2 - 3.2, boardHeight / 2, pitchWidth / 4);
    scene.add(l2);
    const r1 = new THREE.Mesh(endBoardGeo, ledMat);
    r1.position.set(pitchLength / 2 + 3.2, boardHeight / 2, -pitchWidth / 4);
    scene.add(r1);
    const r2 = new THREE.Mesh(endBoardGeo, ledMat);
    r2.position.set(pitchLength / 2 + 3.2, boardHeight / 2, pitchWidth / 4);
    scene.add(r2);

    // -------------------------------------------------------------------------
    // Arquibancadas em degraus + torcida (InstancedMesh). A oscilação idle e o
    // pulo de comemoração no gol moram no vertex shader (uniforms uTime/uCheer),
    // então o custo de CPU por frame é ~zero mesmo com ~14k espectadores.
    // -------------------------------------------------------------------------
    const standsGroup = new THREE.Group();
    scene.add(standsGroup);

    const concreteMat = new THREE.MeshStandardMaterial({ color: 0x33383f, roughness: 0.96 });
    const backWallMat = new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 1 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x111419, roughness: 0.9, metalness: 0.15, side: THREE.DoubleSide });

    const crowdUniforms = { uTime: { value: 0 }, uCheer: { value: 0 } };
    crowdUniformsRef.current = crowdUniforms;
    const crowdMat = new THREE.MeshLambertMaterial({});
    crowdMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = crowdUniforms.uTime;
      shader.uniforms.uCheer = crowdUniforms.uCheer;
      shader.vertexShader = "uniform float uTime;\nuniform float uCheer;\n" + shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         float _ph = instanceMatrix[3][0] * 0.73 + instanceMatrix[3][2] * 1.31;
         transformed.y += sin(uTime * 1.7 + _ph) * 0.035
           + uCheer * max(0.0, sin(uTime * 8.5 + _ph * 2.7)) * 0.55;`,
      );
    };

    const homeA = new THREE.Color(homePrimaryColor);
    const homeB = new THREE.Color(homeSecondaryColor);
    const awayA = new THREE.Color(awayPrimaryColor);
    const skinTones = [new THREE.Color(0xd9a878), new THREE.Color(0x8d5a3b), new THREE.Color(0xf0c9a0), new THREE.Color(0x6b4326)];
    const neutralTones = [new THREE.Color(0x9aa0a6), new THREE.Color(0x2b2f36), new THREE.Color(0xd7dade), new THREE.Color(0x4a4f57)];
    const pickTone = (awayShare: number): THREE.Color => {
      const r = Math.random();
      let c: THREE.Color;
      if (r < awayShare) c = awayA.clone();
      else if (r < awayShare + (1 - awayShare) * 0.5) c = homeA.clone();
      else if (r < awayShare + (1 - awayShare) * 0.66) c = homeB.clone();
      else if (r < awayShare + (1 - awayShare) * 0.83) c = neutralTones[(Math.random() * neutralTones.length) | 0].clone();
      else c = skinTones[(Math.random() * skinTones.length) | 0].clone();
      return c.multiplyScalar(0.7 + Math.random() * 0.45);
    };

    // Quão cheio o estádio está — capacidade grande enche mais lugares. O
    // nível de qualidade (e3-perf) reduz ou zera a torcida instanciada.
    const fillFactor = Math.max(0.4, Math.min(1, stadiumCapacity / 45000)) * qCrowdFill;

    const specGeo = new THREE.CapsuleGeometry(0.21, 0.42, 2, 6);
    const crowdMeshes: THREE.InstancedMesh[] = [];
    const dummy = new THREE.Object3D();

    // dir = pra fora do campo; a arquibancada sobe nessa direção.
    const buildStand = (
      cx: number, cz: number, rotY: number, length: number, rows: number, awayShare: number,
    ) => {
      const g = new THREE.Group();
      g.position.set(cx, 0, cz);
      g.rotation.y = rotY;
      standsGroup.add(g);

      const rowDepth = 0.95;
      const rowRise = 0.52;
      const frontGap = 5.5; // distância da linha de campo até a 1ª fila
      const deckDepth = rows * rowDepth + 2;
      const rake = Math.atan2(rowRise, rowDepth);

      // Laje inclinada (concreto) — a torcida senta em cima.
      const deck = new THREE.Mesh(new THREE.BoxGeometry(length + 4, 0.7, deckDepth), concreteMat);
      deck.rotation.x = rake;
      deck.position.set(0, (deckDepth / 2) * Math.sin(rake) - 0.35, -(frontGap + (deckDepth / 2) * Math.cos(rake)));
      deck.receiveShadow = true;
      g.add(deck);

      // Parede do fundo + cobertura.
      const backY = rows * rowRise + 1;
      const back = new THREE.Mesh(new THREE.BoxGeometry(length + 4, backY + 4, 0.8), backWallMat);
      back.position.set(0, (backY + 4) / 2, -(frontGap + deckDepth));
      g.add(back);

      const roof = new THREE.Mesh(new THREE.BoxGeometry(length + 6, 0.5, deckDepth * 0.82), roofMat);
      roof.rotation.x = rake * 0.5;
      roof.position.set(0, backY + 4.5, -(frontGap + deckDepth * 0.55));
      roof.castShadow = true;
      g.add(roof);

      // Torcida — pulada inteira no nível "baixa" (fillFactor 0).
      if (fillFactor <= 0) return;
      const colSpacing = 0.62;
      const cols = Math.floor(length / colSpacing);
      const maxSeats = rows * cols;
      const mesh = new THREE.InstancedMesh(specGeo, crowdMat, maxSeats);
      mesh.frustumCulled = false;
      let n = 0;
      for (let row = 0; row < rows; row++) {
        for (let c = 0; c < cols; c++) {
          if (Math.random() > fillFactor * 0.94) continue;
          dummy.position.set(
            -length / 2 + c * colSpacing + (Math.random() - 0.5) * 0.28,
            row * rowRise + 0.95,
            -(frontGap + 0.7 + row * rowDepth) + (Math.random() - 0.5) * 0.18,
          );
          dummy.rotation.set(0, 0, 0);
          dummy.scale.setScalar(0.82 + Math.random() * 0.34);
          dummy.updateMatrix();
          mesh.setMatrixAt(n, dummy.matrix);
          mesh.setColorAt(n, pickTone(awayShare));
          n++;
        }
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      g.add(mesh);
      crowdMeshes.push(mesh);
    };

    const halfL = pitchLength / 2;
    const halfW = pitchWidth / 2;
    // Laterais (correm no eixo X, atrás das linhas de fundo do gramado no eixo Z).
    buildStand(0, -halfW, 0, pitchLength + 26, 26, 0);
    buildStand(0, halfW, Math.PI, pitchLength + 26, 26, 0);
    // Fundos (atrás dos gols). O fundo leste recebe a torcida visitante.
    buildStand(-halfL, 0, Math.PI / 2, pitchWidth + 20, 22, 0);
    buildStand(halfL, 0, -Math.PI / 2, pitchWidth + 20, 22, 0.62);

    const disposeCrowd = () => {
      specGeo.dispose();
      crowdMat.dispose();
      concreteMat.dispose();
      backWallMat.dispose();
      roofMat.dispose();
      crowdMeshes.forEach((m) => m.dispose());
      lampMatsRef.current = [];
      cornerFlagsRef.current = [];
    };

    // -------------------------------------------------------------------------
    // Detalhes do estádio: área técnica (2 bancos de reservas cobertos + placa),
    // bandeirinhas de escanteio, túnel de acesso.
    // -------------------------------------------------------------------------
    const shellMat = new THREE.MeshStandardMaterial({ color: 0x20242b, roughness: 0.9 });
    const benchMat = new THREE.MeshStandardMaterial({ color: 0x394150, roughness: 0.8 });

    const buildDugout = (offsetX: number) => {
      const g = new THREE.Group();
      g.position.set(offsetX, 0, -halfW - 2.4);
      // casca aberta pro campo (frente em +Z)
      const w = 9, h = 2.3, d = 2.6;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(w, 0.25, d + 0.6), shellMat);
      roof.position.set(0, h, -0.1); roof.castShadow = true; g.add(roof);
      const backW = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.3), shellMat);
      backW.position.set(0, h / 2, -d / 2); g.add(backW);
      const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.3, h, d), shellMat);
      sideL.position.set(-w / 2, h / 2, 0); g.add(sideL);
      const sideR = sideL.clone(); sideR.position.x = w / 2; g.add(sideR);
      const bench = new THREE.Mesh(new THREE.BoxGeometry(w - 0.8, 0.5, 0.7), benchMat);
      bench.position.set(0, 0.55, 0.1); g.add(bench);
      // reservas sentados (cápsulas, cor do time correspondente)
      const seatN = 7;
      const subGeo = new THREE.CapsuleGeometry(0.22, 0.36, 2, 6);
      const subMat = new THREE.MeshLambertMaterial({ color: offsetX < 0 ? homeA : awayA });
      const subs = new THREE.InstancedMesh(subGeo, subMat, seatN);
      const od = new THREE.Object3D();
      for (let i = 0; i < seatN; i++) {
        od.position.set(-(w - 2) / 2 + (i * (w - 2)) / (seatN - 1), 1.15, -0.15);
        od.rotation.set(0.32, 0, 0);
        od.updateMatrix();
        subs.setMatrixAt(i, od.matrix);
      }
      g.add(subs);
      scene.add(g);
      return () => { subGeo.dispose(); subMat.dispose(); subs.dispose(); };
    };
    const disposeDugoutHome = buildDugout(-8.5);
    const disposeDugoutAway = buildDugout(8.5);

    // Placa de substituição eletrônica ao lado dos bancos.
    const subBoard = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 1.0, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x0b0f19, emissive: 0xf59e0b, emissiveIntensity: 0.5 }),
    );
    subBoard.position.set(0, 1.4, -halfW - 1.2);
    scene.add(subBoard);

    // Bandeirinhas de escanteio (poste + bandeira que balança no loop).
    const flagPoleMat = new THREE.MeshStandardMaterial({ color: 0xdddddd });
    const flagClothMat = new THREE.MeshBasicMaterial({ color: 0xef4444, side: THREE.DoubleSide });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6), flagPoleMat);
      pole.position.set(sx * (halfL - 0.4), 0.8, sz * (halfW - 0.4));
      scene.add(pole);
      const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), flagClothMat);
      cloth.position.set(sx * (halfL - 0.4) + sx * 0.45, 1.35, sz * (halfW - 0.4));
      cornerFlagsRef.current.push(cloth);
      scene.add(cloth);
    }

    // Túnel de acesso — recorte escuro no meio da arquibancada norte (-Z).
    const tunnel = new THREE.Mesh(
      new THREE.BoxGeometry(5, 3.2, 4),
      new THREE.MeshStandardMaterial({ color: 0x05070b, roughness: 1 }),
    );
    tunnel.position.set(0, 1.6, -halfW - 4);
    scene.add(tunnel);
    const tunnelGlow = new THREE.PointLight(0xffe8b0, 0.5, 14);
    tunnelGlow.position.set(0, 1.6, -halfW - 6);
    scene.add(tunnelGlow);

    const disposeStadiumExtras = () => {
      shellMat.dispose(); benchMat.dispose(); flagPoleMat.dispose(); flagClothMat.dispose();
      mastMat.dispose();
      disposeDugoutHome(); disposeDugoutAway();
    };

    const ballRadius = 0.52;
    const ballGeo = new THREE.SphereGeometry(ballRadius, 32, 32);
    const ballTex = createSoccerBallTexture();
    const ballMat = new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.3, metalness: 0.1 });
    const ballMesh = new THREE.Mesh(ballGeo, ballMat);
    ballMesh.castShadow = true;
    ballMesh.position.set(0, ballRadius, 0);
    scene.add(ballMesh);
    ballMeshRef.current = ballMesh;

    const ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(ballRadius * 1.3, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 }),
    );
    ballShadow.rotation.x = -Math.PI / 2;
    ballShadow.position.set(0, 0.03, 0);
    scene.add(ballShadow);
    ballShadowRef.current = ballShadow;

    const ballRing = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 0.85, 24),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
    );
    ballRing.rotation.x = -Math.PI / 2;
    ballRing.position.set(0, 0.04, 0);
    scene.add(ballRing);
    ballRingRef.current = ballRing;

    const posRingGroup = new THREE.Group();
    const innerRing = new THREE.Mesh(
      new THREE.RingGeometry(1.2, 1.45, 32),
      new THREE.MeshBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
    );
    innerRing.rotation.x = -Math.PI / 2;
    innerRing.position.y = 0.05;
    posRingGroup.add(innerRing);

    const chevronGeo = new THREE.ConeGeometry(0.4, 0.8, 3);
    const chevron = new THREE.Mesh(chevronGeo, new THREE.MeshBasicMaterial({ color: 0x34d399 }));
    chevron.rotation.x = -Math.PI / 2;
    chevron.position.set(0, 0.05, 1.8);
    posRingGroup.add(chevron);

    scene.add(posRingGroup);
    possessionRingRef.current = posRingGroup;

    const rainCount = 2200;
    const rainGeo = new THREE.BufferGeometry();
    const rainPositions = new Float32Array(rainCount * 3);
    for (let r = 0; r < rainCount; r++) {
      rainPositions[r * 3] = (Math.random() - 0.5) * 145;
      rainPositions[r * 3 + 1] = Math.random() * 50;
      rainPositions[r * 3 + 2] = (Math.random() - 0.5) * 95;
    }
    rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPositions, 3));
    const rain = new THREE.Points(
      rainGeo,
      new THREE.PointsMaterial({ color: 0xa5f3fc, size: 0.4, transparent: true, opacity: 0.65 }),
    );
    rain.visible = weather === "chuva";
    scene.add(rain);
    rainParticlesRef.current = rain;

    const handleResize = () => {
      if (!container || !rendererRef.current || !cameraRef.current) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      cameraRef.current.aspect = w / h;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(w, h);
      composerRef.current?.setSize(w, h);
    };
    const resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(container);

    camera.position.set(0, 14, 23);
    camera.lookAt(0, 1.2, 0);

    let lastTime = performance.now();
    let ledOffset = 0;

    const animate = (time: number) => {
      animFrameIdRef.current = requestAnimationFrame(animate);
      const delta = Math.min(0.1, (time - lastTime) / 1000);
      lastTime = time;

      const speedMult = Math.min(4, Math.max(1, matchSpeedRef.current || 2));
      const animSpeed = delta * speedMult;

      // Torcida: relógio contínuo + nível de euforia (1 no gol, um pouco em
      // lance perigoso) suavizado. Todo o movimento acontece no shader.
      if (crowdUniformsRef.current) {
        crowdUniformsRef.current.uTime.value += delta;
        crowdCheerTargetRef.current = isGoalHappeningRef.current ? 1 : (isDangerousMomentRef.current ? 0.25 : 0);
        const cur = crowdUniformsRef.current.uCheer.value;
        const tgt = crowdCheerTargetRef.current;
        // sobe rápido (explosão), desce devagar (a euforia dura)
        crowdUniformsRef.current.uCheer.value += (tgt - cur) * Math.min(1, delta * (tgt > cur ? 9 : 1.6));
      }

      // Bandeirinhas de escanteio balançam de leve.
      for (const f of cornerFlagsRef.current) f.rotation.z = Math.sin(time * 0.003 + f.position.x) * 0.28 - 0.1;

      if (rainParticlesRef.current && rainParticlesRef.current.visible) {
        const posAttr = rainParticlesRef.current.geometry.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < rainCount; i++) {
          let y = posAttr.getY(i) - 52 * delta;
          if (y < 0) y = 45 + Math.random() * 5;
          posAttr.setY(i, y);
        }
        posAttr.needsUpdate = true;
      }

      if (ledCanvasContextRef.current) {
        const { ctx, canvas, texture } = ledCanvasContextRef.current;
        const goalFlash = isGoalHappeningRef.current;
        ledOffset += delta * (goalFlash ? 260 : 75);
        // No gol o painel pisca em ciano/branco; senão fundo escuro fixo.
        ctx.fillStyle = goalFlash
          ? (Math.floor(time * 0.012) % 2 === 0 ? "#0e7490" : "#082f49")
          : "#060913";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = goalFlash ? "#ffffff" : "#10b981";
        ctx.font = "bold 38px monospace";
        const x = -(ledOffset % 900);
        for (let t = 0; t < 5; t++) {
          ctx.fillText(tickerTextRef.current, x + t * 900, 78);
        }
        texture.needsUpdate = true;
      }

      if (ballMeshRef.current && ballShadowRef.current && ballRingRef.current) {
        const currentBallState = ballRef.current;
        const b = ballCurrentPos.current;
        const targetWorldX = toWorldLength(currentBallState.y);
        const targetWorldZ = toWorldWidth(currentBallState.x);

        b.x += (targetWorldX - b.x) * Math.min(1, animSpeed * 10.5);
        b.z += (targetWorldZ - b.z) * Math.min(1, animSpeed * 10.5);

        const dist = Math.hypot(targetWorldX - b.x, targetWorldZ - b.z);
        let targetY = 0.52;
        if (dist > 3.0) {
          ballFlightTime.current += animSpeed * 4.5;
          targetY = 0.52 + Math.sin(Math.min(Math.PI, ballFlightTime.current)) * Math.min(6, dist * 0.35);
        } else {
          ballFlightTime.current = 0;
          targetY = 0.52;
        }

        b.y += (targetY - b.y) * Math.min(1, animSpeed * 16.0);
        b.rollAngle += animSpeed * 22;

        ballMeshRef.current.position.set(b.x, b.y, b.z);
        ballMeshRef.current.rotation.x = b.rollAngle;
        ballMeshRef.current.rotation.z = b.rollAngle * 0.8;

        ballShadowRef.current.position.set(b.x, 0.03, b.z);
        const shadowScale = Math.max(0.35, 1 - (b.y - 0.52) * 0.12);
        ballShadowRef.current.scale.set(shadowScale, shadowScale, 1);

        ballRingRef.current.position.set(b.x, 0.04, b.z);

        if (isGoalHappeningRef.current && (netHomeRef.current || netAwayRef.current)) {
          const activeNet = b.x > 0 ? netAwayRef.current : netHomeRef.current;
          if (activeNet) {
            activeNet.scale.set(1 + Math.sin(time * 0.015) * 0.08, 1, 1);
          }
        }
      }

      const currentDots = dotsRef.current;
      let closestPlayerToBall: PlayerMeshModel | null = null;
      let minDistanceToBall = Infinity;

      playersModelsRef.current.forEach((model, id) => {
        const dot = currentDots.find((d) => d.id === id);
        if (!dot) return;

        const targetX = toWorldLength(dot.y);
        const targetZ = toWorldWidth(dot.x);

        const currentX = model.group.position.x;
        const currentZ = model.group.position.z;

        const vx = targetX - currentX;
        const vz = targetZ - currentZ;
        const distToTarget = Math.hypot(vx, vz);

        model.group.position.x += vx * Math.min(1, animSpeed * 9.0);
        model.group.position.z += vz * Math.min(1, animSpeed * 9.0);

        if (distToTarget > 0.05) {
          const targetAngle = Math.atan2(vx, vz);
          let diff = targetAngle - model.group.rotation.y;
          while (diff < -Math.PI) diff += Math.PI * 2;
          while (diff > Math.PI) diff -= Math.PI * 2;
          model.group.rotation.y += diff * Math.min(1, animSpeed * 11.0);
        } else {
          const toBallX = ballCurrentPos.current.x - model.group.position.x;
          const toBallZ = ballCurrentPos.current.z - model.group.position.z;
          const angleToBall = Math.atan2(toBallX, toBallZ);
          let diff = angleToBall - model.group.rotation.y;
          while (diff < -Math.PI) diff += Math.PI * 2;
          while (diff > Math.PI) diff -= Math.PI * 2;
          model.group.rotation.y += diff * Math.min(1, animSpeed * 6.5);
        }

        if (distToTarget > 0.04) {
          const strideFactor = Math.min(1.0, Math.max(0.35, distToTarget * 1.6));
          const stepRate = 6.0 + Math.min(distToTarget * 8.5, 14.0);
          model.runPhase += animSpeed * stepRate;
          const swing = Math.sin(model.runPhase);

          model.leftHip.rotation.x = swing * 0.70 * strideFactor;
          model.rightHip.rotation.x = -swing * 0.70 * strideFactor;
          model.leftKnee.rotation.x = Math.max(0, -swing * 1.15 * strideFactor);
          model.rightKnee.rotation.x = Math.max(0, swing * 1.15 * strideFactor);
          model.leftShoulder.rotation.x = -swing * 0.52 * strideFactor;
          model.rightShoulder.rotation.x = swing * 0.52 * strideFactor;
          model.leftElbow.rotation.x = 0.55;
          model.rightElbow.rotation.x = 0.55;
          model.pelvis.rotation.x = Math.min(0.12, distToTarget * 0.06);
          model.pelvis.position.y = 0.92 + Math.abs(swing) * 0.02;
        } else {
          model.leftHip.rotation.x += (0 - model.leftHip.rotation.x) * Math.min(1, animSpeed * 6.0);
          model.rightHip.rotation.x += (0 - model.rightHip.rotation.x) * Math.min(1, animSpeed * 6.0);
          model.leftKnee.rotation.x += (0 - model.leftKnee.rotation.x) * Math.min(1, animSpeed * 6.0);
          model.rightKnee.rotation.x += (0 - model.rightKnee.rotation.x) * Math.min(1, animSpeed * 6.0);
          model.pelvis.rotation.x += (0 - model.pelvis.rotation.x) * Math.min(1, animSpeed * 6.0);
          model.pelvis.position.y += (0.92 - model.pelvis.position.y) * Math.min(1, animSpeed * 6.0);

          if (model.isGk) {
            model.leftKnee.rotation.x = 0.22;
            model.rightKnee.rotation.x = 0.22;
            model.leftShoulder.rotation.set(-0.25, 0, -0.35);
            model.rightShoulder.rotation.set(-0.25, 0, 0.35);
            model.leftElbow.rotation.x = 0.7;
            model.rightElbow.rotation.x = 0.7;
          } else {
            model.leftShoulder.rotation.set(0.08, 0, -0.08);
            model.rightShoulder.rotation.set(0.08, 0, 0.08);
            model.leftElbow.rotation.x = 0.22;
            model.rightElbow.rotation.x = 0.22;
            model.leftKnee.rotation.x = 0.08;
            model.rightKnee.rotation.x = 0.08;
          }
        }

        // --- Poses especiais por evento (ver src/game/live-positions.ts) ---
        const anim = dot.anim;
        const relax = (v: number, k = 8) => v + (0 - v) * Math.min(1, animSpeed * k);

        if (anim === "celebrate") {
          model.leftShoulder.rotation.set(-2.4, 0, -0.5);
          model.rightShoulder.rotation.set(-2.4, 0, 0.5);
          model.leftElbow.rotation.x = 0.15;
          model.rightElbow.rotation.x = 0.15;
          model.group.rotation.z = relax(model.group.rotation.z);
          model.group.rotation.x = relax(model.group.rotation.x);
          model.group.position.y = Math.abs(Math.sin(time * 0.012 + model.runPhase)) * 0.28;
        } else if (anim === "dejected") {
          model.leftShoulder.rotation.set(-1.3, 0, -0.15);
          model.rightShoulder.rotation.set(-1.3, 0, 0.15);
          model.leftElbow.rotation.x = 1.7;
          model.rightElbow.rotation.x = 1.7;
          model.group.rotation.x += (0.13 - model.group.rotation.x) * Math.min(1, animSpeed * 4);
          model.group.rotation.z = relax(model.group.rotation.z);
          model.group.position.y = 0;
        } else if (anim === "dive") {
          const dir = ballCurrentPos.current.z > model.group.position.z ? 1 : -1;
          model.group.rotation.z += ((dir * 1.15) - model.group.rotation.z) * Math.min(1, animSpeed * 7);
          model.group.rotation.x = relax(model.group.rotation.x);
          model.leftShoulder.rotation.set(-1.9, 0, -0.2);
          model.rightShoulder.rotation.set(-1.9, 0, 0.2);
          model.leftElbow.rotation.x = 0.1;
          model.rightElbow.rotation.x = 0.1;
          model.leftHip.rotation.x = 0.15; model.rightHip.rotation.x = 0.15;
          model.leftKnee.rotation.x = 0.15; model.rightKnee.rotation.x = 0.15;
          model.group.position.y = 0.55;
        } else if (anim === "down") {
          model.group.rotation.x += ((-1.35) - model.group.rotation.x) * Math.min(1, animSpeed * 5);
          model.group.rotation.z = relax(model.group.rotation.z);
          model.leftHip.rotation.x = 1.1; model.rightHip.rotation.x = 0.6;
          model.leftKnee.rotation.x = 1.3; model.rightKnee.rotation.x = 0.9;
          model.leftShoulder.rotation.set(0.2, 0, -0.1);
          model.rightShoulder.rotation.set(-1.4, 0, 0.3);
          model.rightElbow.rotation.x = 1.6;
          model.leftElbow.rotation.x = 0.3;
          model.group.position.y = 0.12;
        } else if (anim === "shoot") {
          model.runPhase += animSpeed * 26;
          const s = Math.sin(model.runPhase);
          model.rightHip.rotation.x = -1.0 + s * 0.6;
          model.rightKnee.rotation.x = Math.max(0, 0.9 - s);
          model.leftHip.rotation.x = 0.3;
          model.leftKnee.rotation.x = 0.35;
          model.leftShoulder.rotation.set(-0.4, 0, -0.6);
          model.rightShoulder.rotation.set(0.5, 0, 0.5);
          model.group.rotation.z = relax(model.group.rotation.z);
          model.group.rotation.x = relax(model.group.rotation.x);
          model.pelvis.rotation.x = 0.15;
          model.group.position.y = 0;
        } else if (anim === "wall") {
          model.leftHip.rotation.x = 0.05; model.rightHip.rotation.x = 0.05;
          model.leftKnee.rotation.x = 0.28; model.rightKnee.rotation.x = 0.28;
          model.leftShoulder.rotation.set(0.1, 0, 0.55);
          model.rightShoulder.rotation.set(0.1, 0, -0.55);
          model.leftElbow.rotation.x = 1.5;
          model.rightElbow.rotation.x = 1.5;
          model.group.rotation.z = relax(model.group.rotation.z);
          model.group.rotation.x = relax(model.group.rotation.x);
          model.group.position.y = 0;
        } else if (anim === "brace") {
          model.leftKnee.rotation.x = 0.32; model.rightKnee.rotation.x = 0.32;
          model.leftShoulder.rotation.set(0.1, 0, -0.4);
          model.rightShoulder.rotation.set(0.1, 0, 0.4);
          model.leftElbow.rotation.x = 0.7;
          model.rightElbow.rotation.x = 0.7;
          model.group.rotation.z = relax(model.group.rotation.z);
          model.group.rotation.x = relax(model.group.rotation.x);
          model.group.position.y = 0;
        } else if (anim === "setpiece_taker") {
          model.leftShoulder.rotation.set(0.15, 0, -0.45);
          model.rightShoulder.rotation.set(0.15, 0, 0.45);
          model.leftElbow.rotation.x = 1.3;
          model.rightElbow.rotation.x = 1.3;
          model.leftHip.rotation.x = 0.1;
          model.group.rotation.z = relax(model.group.rotation.z);
          model.group.rotation.x = relax(model.group.rotation.x);
          model.group.position.y = 0;
        } else {
          model.group.rotation.z = relax(model.group.rotation.z, 6);
          model.group.rotation.x = relax(model.group.rotation.x, 6);
          model.group.position.y = model.group.position.y > 0.001 ? relax(model.group.position.y, 6) : 0;
        }

        const distToBall = Math.hypot(model.group.position.x - ballCurrentPos.current.x, model.group.position.z - ballCurrentPos.current.z);
        if (distToBall < minDistanceToBall) {
          minDistanceToBall = distToBall;
          closestPlayerToBall = model;
        }
      });

      // Etiqueta de nome só em quem está com a bola — não os 22 o tempo
      // todo (referência real do FM21 Touch: só o jogador na jogada tem
      // nome flutuante, senão vira poluição visual).
      playersModelsRef.current.forEach((model) => {
        if (model.nameSprite) {
          model.nameSprite.visible = showPlayerTagsRef.current && model === closestPlayerToBall;
        }
      });

      if (possessionRingRef.current) {
        if (closestPlayerToBall && minDistanceToBall < 8.0) {
          possessionRingRef.current.visible = true;
          const px = (closestPlayerToBall as PlayerMeshModel).group.position.x;
          const pz = (closestPlayerToBall as PlayerMeshModel).group.position.z;
          possessionRingRef.current.position.set(px, 0.05, pz);
          possessionRingRef.current.rotation.y = (closestPlayerToBall as PlayerMeshModel).group.rotation.y;
        } else {
          possessionRingRef.current.visible = false;
        }
      }

      // Bola "nos pés" do portador — quando um jogador está bem perto e a bola
      // não está no ar, cola a bola logo à frente dele (na direção que ele
      // encara), pra não parecer que ninguém toca nela.
      if (closestPlayerToBall && minDistanceToBall < 2.4 && ballMeshRef.current && ballCurrentPos.current.y < 1.1) {
        const cp = closestPlayerToBall as PlayerMeshModel;
        const fx = Math.sin(cp.group.rotation.y);
        const fz = Math.cos(cp.group.rotation.y);
        const footX = cp.group.position.x + fx * 0.55;
        const footZ = cp.group.position.z + fz * 0.55;
        const b = ballCurrentPos.current;
        b.x += (footX - b.x) * Math.min(1, animSpeed * 6);
        b.z += (footZ - b.z) * Math.min(1, animSpeed * 6);
        ballMeshRef.current.position.x = b.x;
        ballMeshRef.current.position.z = b.z;
        if (ballShadowRef.current) ballShadowRef.current.position.set(b.x, 0.03, b.z);
        if (ballRingRef.current) ballRingRef.current.position.set(b.x, 0.04, b.z);
      }

      if (cameraRef.current) {
        const cam = cameraRef.current;
        const bx = ballCurrentPos.current.x;
        const bz = ballCurrentPos.current.z;
        const currentZoom = zoomLevelRef.current;
        const currentCamMode = activeCameraRef.current;
        const invZoom = 1 / Math.max(0.6, Math.min(2.0, currentZoom));

        // Velocidade da bola (suavizada) → antecipação: a câmera mira um
        // pouco à frente de onde a bola está indo, não onde ela está.
        const rawVx = bx - prevBallRef.current.x;
        const rawVz = bz - prevBallRef.current.z;
        prevBallRef.current.x = bx;
        prevBallRef.current.z = bz;
        ballVelRef.current.x += (rawVx - ballVelRef.current.x) * Math.min(1, delta * 5);
        ballVelRef.current.z += (rawVz - ballVelRef.current.z) * Math.min(1, delta * 5);
        const leadX = Math.max(-24, Math.min(24, ballVelRef.current.x * 10));
        const leadZ = Math.max(-13, Math.min(13, ballVelRef.current.z * 7));

        if (isGoalHappeningRef.current) {
          // Câmera de comemoração — baixa, perto, girando devagar em volta do
          // ponto do gol.
          const orbit = time * 0.0006;
          const focusX = closestPlayerToBall ? (closestPlayerToBall as PlayerMeshModel).group.position.x : bx;
          const focusZ = closestPlayerToBall ? (closestPlayerToBall as PlayerMeshModel).group.position.z : bz;
          cam.position.x += (focusX + Math.sin(orbit) * 13 - cam.position.x) * Math.min(1, animSpeed * 2.6);
          cam.position.y += (5.5 - cam.position.y) * Math.min(1, animSpeed * 2.6);
          cam.position.z += (focusZ + Math.cos(orbit) * 13 - cam.position.z) * Math.min(1, animSpeed * 2.6);
          cam.lookAt(focusX, 1.6, focusZ);
        } else if (currentCamMode === "tv" && isDangerousMomentRef.current) {
          // Finalização iminente — corta pra trás do gol atacado, baixo e
          // perto, como a repetição de gol de transmissão.
          const atkRight = bx >= 0;
          const targetCamX = atkRight ? -49 * invZoom : 49 * invZoom;
          cam.position.x += (targetCamX - cam.position.x) * Math.min(1, animSpeed * 2.6);
          cam.position.y += (8.5 * invZoom - cam.position.y) * Math.min(1, animSpeed * 2.6);
          cam.position.z += (bz * 0.5 - cam.position.z) * Math.min(1, animSpeed * 2.6);
          cam.lookAt(bx, 1.6, bz);
        } else if (currentCamMode === "tv") {
          // Mais baixa e mais perto do gramado que a broadcast genérica —
          // referência real do FM21 Touch enche o quadro com o campo, sobra
          // pouco céu/arquibancada (ver comparação de frames desta sessão).
          // Antecipa a bola: mira o ponto onde ela vai chegar (leadX/leadZ).
          const targetCamX = (bx + leadX) * 0.65;
          const targetCamY = 14 * invZoom;
          const targetCamZ = 23 * invZoom;
          cam.position.x += (targetCamX - cam.position.x) * Math.min(1, animSpeed * 3.2);
          cam.position.y += (targetCamY - cam.position.y) * Math.min(1, animSpeed * 3.5);
          cam.position.z += (targetCamZ - cam.position.z) * Math.min(1, animSpeed * 3.5);
          cam.lookAt((bx + leadX) * 0.75, 1.2, (bz + leadZ) * 0.3);
        } else if (currentCamMode === "sideline") {
          const targetCamX = bx * 0.88;
          cam.position.x += (targetCamX - cam.position.x) * Math.min(1, animSpeed * 4.2);
          cam.position.y += (10 * invZoom - cam.position.y) * Math.min(1, animSpeed * 3.5);
          cam.position.z += (20 * invZoom - cam.position.z) * Math.min(1, animSpeed * 3.5);
          cam.lookAt(bx, 1.5, bz);
        } else if (currentCamMode === "behind_goal") {
          const isAttackingRight = bx >= 0;
          const targetCamX = isAttackingRight ? -58 * invZoom : 58 * invZoom;
          cam.position.x += (targetCamX - cam.position.x) * Math.min(1, animSpeed * 3.2);
          cam.position.y += (14 * invZoom - cam.position.y) * Math.min(1, animSpeed * 3.2);
          cam.position.z += (bz * 0.45 - cam.position.z) * Math.min(1, animSpeed * 3.2);
          cam.lookAt(bx, 1.8, bz);
        } else if (currentCamMode === "tactical") {
          cam.position.x += (0 - cam.position.x) * Math.min(1, animSpeed * 3.5);
          cam.position.y += (56 * invZoom - cam.position.y) * Math.min(1, animSpeed * 3.5);
          cam.position.z += (15 * invZoom - cam.position.z) * Math.min(1, animSpeed * 3.5);
          cam.lookAt(0, 0, 0);
        } else if (currentCamMode === "dugout") {
          cam.position.x += (-18 - cam.position.x) * Math.min(1, animSpeed * 2.8);
          cam.position.y += (4.0 * invZoom - cam.position.y) * Math.min(1, animSpeed * 2.8);
          cam.position.z += (-32 * invZoom - cam.position.z) * Math.min(1, animSpeed * 2.8);
          cam.lookAt(bx, 1.5, bz);
        }

        // Trepidação sutil no gol (sobe rápido, alivia devagar).
        const shakeTgt = isGoalHappeningRef.current ? 1 : 0;
        camShakeRef.current += (shakeTgt - camShakeRef.current) *
          Math.min(1, delta * (shakeTgt > camShakeRef.current ? 12 : 2.5));
        const sh = camShakeRef.current * 0.22;
        if (sh > 0.002) {
          cam.position.x += (Math.random() - 0.5) * sh;
          cam.position.y += (Math.random() - 0.5) * sh;
          cam.position.z += (Math.random() - 0.5) * sh;
        }
      }

      if (composer) composer.render();
      else renderer.render(scene, camera);
    };

    animFrameIdRef.current = requestAnimationFrame(animate);

    return () => {
      if (animFrameIdRef.current) cancelAnimationFrame(animFrameIdRef.current);
      resizeObserver.disconnect();
      disposeCrowd();
      disposeStadiumExtras();
      crowdUniformsRef.current = null;
      skyUniformsRef.current = null;
      composerRef.current?.dispose();
      bloomPassRef.current?.dispose();
      smaaPassRef.current?.dispose?.();
      composerRef.current = null;
      bloomPassRef.current = null;
      smaaPassRef.current = null;
      vignettePassRef.current = null;
      renderer.dispose();
      // A cena inteira (com tudo que tinha dentro, jogadores incluídos) foi
      // descartada — limpa o cadastro de modelos de jogador junto, senão o
      // efeito de sincronização (abaixo) acha que eles "já existem" (porque
      // o Map ainda tem os ids) e nunca recria os meshes na cena nova. Sem
      // isso, todo remount do Three.js (StrictMode em dev duplica o
      // mount/cleanup deste efeito de propósito, e uma troca real de
      // `matchKey` faria o mesmo) deixava o campo sem nenhum jogador.
      playersModelsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey, quality]);

  // Nível de qualidade 3D — só persiste. A troca em si recria a cena (o efeito
  // acima depende de `quality`), com torcida/sombras/pós no custo certo.
  useEffect(() => {
    try { localStorage.setItem(QUALITY_LS_KEY, quality); } catch { /* ignore */ }
  }, [quality]);

  // Sincroniza os modelos 3D com o elenco em campo (substituições, início).
  // Função comum (não `useEffect` direto): chamada tanto por mudança nas
  // props raras abaixo (cor/capitão/qualidade) quanto pelo handle
  // imperativo `update()` quando o ELENCO muda de verdade — nunca a cada
  // frame (ver comentário de `lastRosterKeyRef` acima).
  const syncPlayerModels = (currentDots: Match3DDot[]) => {
    if (!sceneRef.current) return;
    const scene = sceneRef.current;
    // Detalhe do boneco por nível de qualidade (e3-perf).
    const loDetail = quality === "baixa";

    const activeDotIds = new Set(currentDots.map((d) => d.id));
    playersModelsRef.current.forEach((model, id) => {
      if (!activeDotIds.has(id)) {
        scene.remove(model.group);
        playersModelsRef.current.delete(id);
      }
    });

    currentDots.forEach((dot) => {
      if (playersModelsRef.current.has(dot.id)) return;

      const isHome = dot.side === "home";
      const isGk = dot.slot === "GK";
      const isCaptain = dot.id === (isHome ? homeCaptainId : awayCaptainId);
      const jerseyColorHex = isGk
        ? (isHome ? 0xf59e0b : 0x06b6d4)
        : toHex(isHome ? homePrimaryColor : awayPrimaryColor, isHome ? 0x10b981 : 0xef4444);
      const shortsColorHex = isGk
        ? 0x0f172a
        : toHex(isHome ? homeSecondaryColor : awaySecondaryColor, 0x0f172a);
      const trimColorHex = isGk ? 0xffffff : toHex(isHome ? homeSecondaryColor : awaySecondaryColor, 0xffffff);
      // Número claro ou escuro conforme o brilho da camisa.
      const jLum = ((jerseyColorHex >> 16) & 255) * 0.299 + ((jerseyColorHex >> 8) & 255) * 0.587 + (jerseyColorHex & 255) * 0.114;
      const numberDark = jLum > 140;

      const seed = hashStr(dot.id);

      const playerGroup = new THREE.Group();

      const skinMat = new THREE.MeshStandardMaterial({ color: SKIN_TONES[(seed * SKIN_TONES.length) | 0], roughness: 0.75 });
      const hairMat = new THREE.MeshStandardMaterial({ color: HAIR_COLORS[(hashStr(dot.id + "h") * HAIR_COLORS.length) | 0], roughness: 0.9 });
      const jerseyMat = new THREE.MeshStandardMaterial({ color: jerseyColorHex, roughness: 0.5, metalness: 0.08 });
      const trimMat = new THREE.MeshStandardMaterial({ color: trimColorHex, roughness: 0.55, metalness: 0.05 });
      const shortsMat = new THREE.MeshStandardMaterial({ color: shortsColorHex, roughness: 0.6, metalness: 0.05 });
      const socksMat = new THREE.MeshStandardMaterial({
        color: isGk ? (isHome ? 0x0f172a : 0x0284c7) : jerseyColorHex,
        roughness: 0.65,
      });
      const bootMat = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.5, metalness: 0.2 });
      const gloveMat = new THREE.MeshStandardMaterial({ color: 0x22c55e, roughness: 0.4 });

      const pelvis = new THREE.Group();
      pelvis.position.y = 0.92;

      const shortsMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.27, 0.36, 16), shortsMat);
      shortsMesh.castShadow = true;
      pelvis.add(shortsMesh);

      const torsoGroup = new THREE.Group();
      torsoGroup.position.y = 0.18;

      const torsoMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.335, 0.255, 0.64, 16), jerseyMat);
      torsoMesh.position.y = 0.31;
      torsoMesh.castShadow = true;
      torsoGroup.add(torsoMesh);

      // Número nas costas (pulado no nível "baixa").
      if (dot.number != null && !loDetail) {
        const numTex = makeNumberTexture(dot.number, numberDark);
        const numDecal = new THREE.Mesh(
          new THREE.PlaneGeometry(0.32, 0.32),
          new THREE.MeshBasicMaterial({ map: numTex, transparent: true }),
        );
        numDecal.position.set(0, 0.33, -0.30);
        numDecal.rotation.y = Math.PI;
        torsoGroup.add(numDecal);
      }

      const collar = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.028, 8, 16), trimMat);
      collar.rotation.x = Math.PI / 2;
      collar.position.y = 0.62;
      torsoGroup.add(collar);

      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.10, 0.14, 12), skinMat);
      neck.position.y = 0.68;
      neck.castShadow = true;
      torsoGroup.add(neck);

      const headGroup = new THREE.Group();
      headGroup.position.y = 0.86;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.185, 16, 16), skinMat);
      head.scale.y = 1.12;
      head.castShadow = true;
      headGroup.add(head);
      // Cabelo: 0 = quase careca, 1 = cheio (por hash do jogador).
      const hairAmt = hashStr(dot.id + "hs");
      if (hairAmt > 0.12 && !loDetail) {
        const hair = new THREE.Mesh(
          new THREE.SphereGeometry(0.19, 14, 14, 0, Math.PI * 2, 0, Math.PI * (0.36 + hairAmt * 0.34)),
          hairMat,
        );
        hair.position.y = 0.03;
        hair.scale.y = 1.12;
        headGroup.add(hair);
      }
      torsoGroup.add(headGroup);

      const createArm = (isLeft: boolean) => {
        const shoulder = new THREE.Group();
        shoulder.position.set(isLeft ? -0.34 : 0.34, 0.50, 0);

        const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.095, 0.17, 12), jerseyMat);
        sleeve.position.y = -0.08;
        sleeve.castShadow = true;
        shoulder.add(sleeve);
        // Punho da manga na cor da faixa.
        const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.097, 0.093, 0.04, 12), trimMat);
        cuff.position.y = -0.165;
        shoulder.add(cuff);

        const upperArm = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.07, 0.18, 12), skinMat);
        upperArm.position.y = -0.20;
        upperArm.castShadow = true;
        shoulder.add(upperArm);

        // Braçadeira de capitão no braço esquerdo.
        if (isCaptain && isLeft) {
          const band = new THREE.Mesh(
            new THREE.CylinderGeometry(0.082, 0.082, 0.06, 10),
            new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.6 }),
          );
          band.position.y = -0.13;
          shoulder.add(band);
        }

        const elbow = new THREE.Group();
        elbow.position.set(0, -0.28, 0);

        const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.065, 0.22, 12), skinMat);
        forearm.position.y = -0.11;
        forearm.castShadow = true;
        elbow.add(forearm);

        if (isGk) {
          const glove = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 0.06), gloveMat);
          glove.position.y = -0.25;
          glove.castShadow = true;
          elbow.add(glove);
        } else {
          const hand = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.04), skinMat);
          hand.position.y = -0.24;
          elbow.add(hand);
        }

        shoulder.add(elbow);
        return { shoulder, elbow };
      };

      const leftArmData = createArm(true);
      const rightArmData = createArm(false);
      torsoGroup.add(leftArmData.shoulder);
      torsoGroup.add(rightArmData.shoulder);

      pelvis.add(torsoGroup);

      const createLeg = (isLeft: boolean) => {
        const hip = new THREE.Group();
        hip.position.set(isLeft ? -0.16 : 0.16, -0.16, 0);

        const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.09, 0.38, 12), skinMat);
        thigh.position.y = -0.19;
        thigh.castShadow = true;
        hip.add(thigh);

        const knee = new THREE.Group();
        knee.position.set(0, -0.38, 0);

        const kneeCap = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), skinMat);
        knee.add(kneeCap);

        const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.075, 0.38, 12), socksMat);
        shin.position.y = -0.19;
        shin.castShadow = true;
        knee.add(shin);

        const sockCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.098, 0.098, 0.06, 12), shortsMat);
        sockCuff.position.y = -0.04;
        knee.add(sockCuff);

        const bootGroup = new THREE.Group();
        bootGroup.position.set(0, -0.38, 0);

        const bootUpper = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.08, 0.25), bootMat);
        bootUpper.position.set(0, 0.04, 0.04);
        bootUpper.castShadow = true;
        bootGroup.add(bootUpper);

        const bootToe = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.04, 0.09, 8), bootMat);
        bootToe.rotation.x = Math.PI / 2;
        bootToe.position.set(0, 0.035, 0.16);
        bootGroup.add(bootToe);

        const bootSole = new THREE.Mesh(
          new THREE.BoxGeometry(0.14, 0.02, 0.28),
          new THREE.MeshStandardMaterial({ color: 0x09090b, roughness: 0.9 }),
        );
        bootSole.position.set(0, 0.01, 0.04);
        bootGroup.add(bootSole);

        knee.add(bootGroup);
        hip.add(knee);
        return { hip, knee };
      };

      const leftLegData = createLeg(true);
      const rightLegData = createLeg(false);
      pelvis.add(leftLegData.hip);
      pelvis.add(rightLegData.hip);

      playerGroup.add(pelvis);

      const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45 });
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.55, 16), shadowMat);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.02;
      playerGroup.add(shadow);

      const nameSprite = createPlayerNameSprite(dot.playerName, dot.number, isHome);
      nameSprite.position.set(0, 2.35, 0);
      nameSprite.visible = showPlayerTagsRef.current;
      playerGroup.add(nameSprite);

      playerGroup.position.set(toWorldLength(dot.y), 0, toWorldWidth(dot.x));
      scene.add(playerGroup);

      playersModelsRef.current.set(dot.id, {
        id: dot.id,
        group: playerGroup,
        pelvis,
        leftHip: leftLegData.hip,
        rightHip: rightLegData.hip,
        leftKnee: leftLegData.knee,
        rightKnee: rightLegData.knee,
        leftShoulder: leftArmData.shoulder,
        rightShoulder: rightArmData.shoulder,
        leftElbow: leftArmData.elbow,
        rightElbow: rightArmData.elbow,
        nameSprite,
        isGk,
        runPhase: Math.random() * Math.PI * 2,
      });
    });
  };
  // `syncPlayerModels` é recriada a cada render deste componente (que agora
  // é raro, graças ao `React.memo` — ver Match3DLiveUpdate); o handle
  // imperativo abaixo é montado só uma vez (deps `[]`), então lê a versão
  // mais atual via ref em vez de fechar sobre a função de um render antigo.
  const syncPlayerModelsRef = useRef(syncPlayerModels);
  syncPlayerModelsRef.current = syncPlayerModels;

  // Recria os modelos quando cor/capitão/qualidade mudam (raro). A troca de
  // ELENCO (substituição) é tratada no handle imperativo abaixo, não aqui —
  // `dotsRef.current` na montagem geralmente está vazio (o primeiro
  // `update()` do pai ainda não chegou), então essa passada não cria nada
  // ainda; a real sincronização inicial acontece no primeiro `update()`.
  useEffect(() => {
    syncPlayerModelsRef.current(dotsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homePrimaryColor, homeSecondaryColor, awayPrimaryColor, awaySecondaryColor, homeCaptainId, awayCaptainId, quality]);

  // Handle imperativo — é assim que `dots`/`ball` chegam a cada frame (ver
  // comentário de `Match3DLiveUpdate` no topo do arquivo). `update()` só
  // dispara `syncPlayerModels` quando o ELENCO muda de verdade
  // (substituição/início) — nunca a cada frame, mesmo sendo chamado 60x/s.
  useImperativeHandle(ref, () => ({
    update(next: Match3DLiveUpdate) {
      dotsRef.current = next.dots;
      ballRef.current = next.ball;
      const key = next.dots.map((d) => d.id).join(",");
      if (key !== lastRosterKeyRef.current) {
        lastRosterKeyRef.current = key;
        syncPlayerModelsRef.current(next.dots);
      }
    },
  }), []);

  // Efeitos de clima
  useEffect(() => {
    if (!rainParticlesRef.current || !sceneRef.current) return;
    rainParticlesRef.current.visible = weather === "chuva";

    const scene = sceneRef.current;
    const sunLight = scene.children.find((c) => c instanceof THREE.DirectionalLight) as THREE.DirectionalLight;
    const ambientLight = scene.children.find((c) => c instanceof THREE.AmbientLight) as THREE.AmbientLight;
    const spots = scene.children.filter((c) => c instanceof THREE.SpotLight) as THREE.SpotLight[];

    const preset = weather === "noite"
      ? { sun: 0.8, sunCol: 0x9db9e0, amb: 0.78, spot: 1.5, lamp: 2.8, fog: 0x0e1526, skyT: 0x070b16, skyB: 0x1a2438 }
      : weather === "chuva"
        ? { sun: 0.78, sunCol: 0xcfd8dc, amb: 0.62, spot: 1.0, lamp: 1.8, fog: 0x5b6675, skyT: 0x54606e, skyB: 0x8a95a2 }
        : { sun: 1.35, sunCol: 0xfffaed, amb: 0.9, spot: 0.3, lamp: 0.12, fog: 0x9fc4de, skyT: 0x2e6fb0, skyB: 0xbcd7ea };

    if (sunLight) { sunLight.intensity = preset.sun; sunLight.color.setHex(preset.sunCol); }
    if (ambientLight) ambientLight.intensity = preset.amb;
    for (const s of spots) s.intensity = preset.spot;
    for (const m of lampMatsRef.current) m.emissiveIntensity = preset.lamp;
    if (scene.fog) (scene.fog as THREE.FogExp2).color.setHex(preset.fog);
    if (skyUniformsRef.current) {
      skyUniformsRef.current.uTop.value.setHex(preset.skyT);
      skyUniformsRef.current.uBottom.value.setHex(preset.skyB);
    }
  }, [weather]);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative w-full h-full select-none bg-black overflow-hidden">
      <div ref={mountRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

      <div className="absolute top-4 right-4 z-20 flex flex-col gap-2 pointer-events-auto">
        <div className="bg-slate-950/85 backdrop-blur-md p-1.5 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col gap-1">
          {([
            ["tv", "TV", "Câmera de Transmissão TV"],
            ["sideline", "Lateral", "Lateral do Campo"],
            ["behind_goal", "Gol", "Atrás do Gol"],
            ["tactical", "Tática", "Visão Tática Aérea"],
            ["dugout", "Banco", "Área Técnica"],
          ] as [CameraView, string, string][]).map(([id, label, title]) => (
            <button
              key={id}
              onClick={() => onCameraChange(id)}
              className={`px-2.5 py-1.5 rounded-xl text-[10px] font-bold transition-all text-left flex items-center gap-1.5 ${
                activeCamera === id ? "bg-emerald-500 text-slate-950 font-black shadow" : "text-slate-300 hover:text-white"
              }`}
              title={title}
            >
              <Camera className="w-3.5 h-3.5" />
              <span>{label}</span>
            </button>
          ))}
        </div>

        <div className="bg-slate-950/85 backdrop-blur-md p-1.5 rounded-2xl border border-slate-700/80 shadow-2xl flex items-center justify-between gap-1">
          <button
            onClick={() => setZoomLevel((z) => Math.min(1.8, Number((z + 0.15).toFixed(2))))}
            className="p-1.5 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
            title="Aproximar Zoom"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setZoomLevel((z) => Math.max(0.7, Number((z - 0.15).toFixed(2))))}
            className="p-1.5 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
            title="Afastar Zoom"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setShowPlayerTags((v) => !v)}
            className={`p-1.5 rounded-xl transition-colors ${showPlayerTags ? "text-emerald-400" : "text-slate-500"}`}
            title="Exibir Nomes dos Jogadores"
          >
            {showPlayerTags ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={toggleFullscreen}
            className="p-1.5 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
            title="Alternar Tela Cheia"
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>

        <div className="bg-slate-950/85 backdrop-blur-md p-1.5 rounded-2xl border border-slate-700/80 shadow-2xl flex items-center justify-between gap-1">
          <button
            onClick={() => onWeatherChange("noite")}
            className={`p-1.5 rounded-xl transition-colors ${weather === "noite" ? "bg-sky-500/20 text-sky-400 font-bold" : "text-slate-400"}`}
            title="Jogo Noturno (Holofotes)"
          >
            <Moon className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onWeatherChange("sol")}
            className={`p-1.5 rounded-xl transition-colors ${weather === "sol" ? "bg-amber-500/20 text-amber-400 font-bold" : "text-slate-400"}`}
            title="Jogo Diurno (Ensolarado)"
          >
            <Sun className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onWeatherChange("chuva")}
            className={`p-1.5 rounded-xl transition-colors ${weather === "chuva" ? "bg-teal-500/20 text-teal-400 font-bold" : "text-slate-400"}`}
            title="Chuva"
          >
            <CloudRain className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="bg-slate-950/85 backdrop-blur-md p-1.5 rounded-2xl border border-slate-700/80 shadow-2xl flex items-center justify-between gap-1">
          {([
            ["baixa", "B", "Qualidade baixa — sem efeitos, melhor desempenho (recomendado no celular)"],
            ["media", "M", "Qualidade média — bloom + vinheta"],
            ["alta", "A", "Qualidade alta — bloom + vinheta + SMAA + pixelRatio 2"],
          ] as [Quality3D, string, string][]).map(([id, label, title]) => (
            <button
              key={id}
              onClick={() => setQuality(id)}
              className={`px-2 py-1 rounded-xl text-[10px] font-bold transition-colors ${
                quality === id ? "bg-fuchsia-500/20 text-fuchsia-300 font-black" : "text-slate-400 hover:text-white"
              }`}
              title={title}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* O banner de gol (com nome do artilheiro + placar + reprise) mora em
          match-viewer.tsx::GoalBanner, sobreposto a este canvas. */}

      {isDangerousMoment && !isGoalHappening && (
        <div className="absolute top-24 left-1/2 -translate-x-1/2 z-30 bg-amber-500/90 text-slate-950 font-black text-sm uppercase tracking-wider px-5 py-2 rounded-xl shadow-xl animate-pulse flex items-center gap-2">
          <span>🔥</span>
          <span>{specialActionTitle || "LANCE DE PERIGO NO ATAQUE!"}</span>
        </div>
      )}
    </div>
  );
});

Match3DPitchInner.displayName = "Match3DPitch";

// `React.memo`: como `dots`/`ball` não são mais props (ver `Match3DLiveUpdate`
// acima), tudo que sobrou muda raramente — o memo evita que este componente
// (câmeras/zoom/clima/qualidade — bastante JSX) re-renderize só porque o pai
// (`Live3DView`) re-renderiza a cada frame.
export const Match3DPitch = React.memo(Match3DPitchInner);

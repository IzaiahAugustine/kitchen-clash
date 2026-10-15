import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { hasDebugFlag } from '../game/debugFlags';

/** Highest render resolution multiplier we'll use (Retina screens report 2). */
const MAX_PIXEL_RATIO = 1.5;
const MIN_PIXEL_RATIO = 0.75;

/**
 * Renderer, scene, sky and lights. Resolution adapts to keep the frame rate smooth.
 * `?hifx` adds ambient occlusion (soft contact shadows) for fast GPUs.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly sun: THREE.DirectionalLight;
  private composer: EffectComposer | null = null;
  private ao: GTAOPass | null = null;
  private pixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
  private frameTimes: number[] = [];
  private lastAdjust = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = skyTexture();
    this.scene.fog = new THREE.Fog(0xcdeeff, 150, 340);
    // Soft image-based light: gives every surface gentle ambient shading and highlights.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    pmrem.dispose();

    this.scene.add(new THREE.HemisphereLight(0xdcefff, 0x5f8f4a, 0.9));
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
    this.sun.position.set(-30, 70, 30);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -30;
    sc.right = 30;
    sc.top = 40;
    sc.bottom = -40;
    sc.near = 20;
    sc.far = 160;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.025;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target);
  }

  /** Call once the camera exists. */
  setupPost(camera: THREE.Camera): void {
    if (!hasDebugFlag('hifx')) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, camera));
    this.ao = new GTAOPass(this.scene, camera, w, h);
    this.ao.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 16 });
    this.ao.blendIntensity = 0.85;
    this.composer.addPass(this.ao);
    this.composer.addPass(new OutputPass());
  }

  render(camera: THREE.Camera): void {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, camera);
  }

  /**
   * Call once per frame with the real frame time. If frames are running slow, render at a
   * lower resolution; if there's headroom, step back up.
   */
  adaptQuality(dt: number, now: number): void {
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    if (now - this.lastAdjust < 2000 || this.frameTimes.length < 60) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const typical = sorted[Math.floor(sorted.length * 0.5)];
    const max = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    let next = this.pixelRatio;
    if (typical > 1 / 50) next = Math.max(MIN_PIXEL_RATIO, this.pixelRatio - 0.25);
    else if (typical < 1 / 58 && this.pixelRatio < max) next = Math.min(max, this.pixelRatio + 0.25);
    if (next !== this.pixelRatio) {
      this.pixelRatio = next;
      this.renderer.setPixelRatio(next);
      this.resize();
      this.frameTimes = [];
    }
    this.lastAdjust = now;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
  }
}

function skyTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#4fb8ff');
  grad.addColorStop(0.6, '#9edfff');
  grad.addColorStop(1, '#dff6ff');
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

import type * as THREE from 'three';
import type { Object3D } from 'three';
import { Player } from '../players/player';
import { PlayerView } from '../players/playerView';
import type { Palette } from '../players/palette';
import type { GameMode, World } from './mode';

/** "My Player": your character standing on court, slowly turning, while you change your look. */
export class ShowroomMode implements GameMode {
  private player: Player;
  private view: PlayerView | null = null;
  private t = 0;

  constructor(
    private w: World,
    private template: Object3D | null,
    palette: Palette,
  ) {
    // Far-side player so they face the camera.
    this.player = new Player('You', -1, palette);
    this.player.pos.set(0, 0, 10);
    this.setPalette(palette);
    w.ball.hold(this.player.pos.clone().setY(-5));
  }

  setPalette(p: Palette): void {
    this.view?.dispose();
    this.view = this.template ? new PlayerView(this.template, p) : null;
    if (this.view) this.w.scene.add(this.view.root);
  }

  /** Close-up camera on the player, standing to the right of the menu. */
  cameraPose(camera: THREE.PerspectiveCamera): boolean {
    camera.position.set(-2.2, 5.6, 19.5);
    camera.lookAt(-1.1, 3.2, 10);
    return true;
  }

  update(dt: number, time: number): void {
    this.t += dt;
    if (!this.view) return;
    this.view.update(this.player, time, dt, this.player.pos.clone().setY(4.5).setZ(20));
    // A slow turn so you can see the whole outfit.
    this.view.root.rotation.y = Math.PI + Math.sin(this.t * 0.6) * 0.7;
  }

  fixedUpdate(): void {}
  onBallEvent(): void {}

  describe(): string {
    return '';
  }

  cameraTargetX(): number {
    return 0;
  }

  dispose(): void {
    this.view?.dispose();
  }
}

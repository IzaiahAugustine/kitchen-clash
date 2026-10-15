import type { ControlFrame } from '../input/controls';
import type { Contact, Player } from './player';
import type { Aim, ShotButton } from './shots';
import { hasDebugFlag } from '../game/debugFlags';

const AUTO = hasDebugFlag('autoswing');

/** Max speed (ft/s) of the gentle auto-move toward the incoming ball. */
const ASSIST_SPEED = 5;

/** Turns stick/keys into movement, aim and shot presses for a human player. */
export class HumanController {
  aim: Aim = { x: 0, y: 0 };

  constructor(private player: Player) {}

  /**
   * @param preview where the ball can be hit, if it's coming to this player (drives the auto-move)
   * @returns the shot button pressed this frame, if any
   */
  update(input: ControlFrame, preview: Contact | null): ShotButton | null {
    const p = this.player;
    this.aim = { x: input.moveX, y: input.moveY };
    p.intent.set(p.right.x * input.moveX * p.maxSpeed, 0, p.forward.z * input.moveY * p.maxSpeed);
    if (preview) {
      const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
      p.intent.x += clamp((preview.standAt.x - p.pos.x) * 2.5, ASSIST_SPEED);
      p.intent.z += clamp((preview.standAt.z - p.pos.z) * 1.5, ASSIST_SPEED * 0.6);
    }
    // Test hook: `?autoswing` walks to the ball at full speed and swings on time (online tests).
    if (AUTO && preview) {
      p.intent.set(Math.sign(preview.standAt.x - p.pos.x) * Math.min(p.maxSpeed, Math.abs(preview.standAt.x - p.pos.x) * 4), 0,
        Math.sign(preview.standAt.z - p.pos.z) * Math.min(p.maxSpeed, Math.abs(preview.standAt.z - p.pos.z) * 4));
      if (Math.abs(preview.t - 0.2) < 0.012) return 'drive';
    }
    if (input.spin) return 'spin';
    if (input.drive) return 'drive';
    if (input.soft) return 'soft';
    return null;
  }
}

import * as THREE from 'three';

interface Marker {
  mesh: THREE.Mesh;
  age: number;
}

const LIFE = 3;

/** Fading rings where the ball bounced: green = in, red = out. */
export class BounceMarkers {
  private markers: Marker[] = [];
  private geo = new THREE.RingGeometry(0.22, 0.42, 28).rotateX(-Math.PI / 2);

  constructor(private scene: THREE.Scene) {}

  add(x: number, z: number, inside: boolean): void {
    const mesh = new THREE.Mesh(
      this.geo,
      new THREE.MeshBasicMaterial({ color: inside ? 0x3dff7a : 0xff3d5a, transparent: true, depthWrite: false }),
    );
    mesh.position.set(x, 0.05, z);
    mesh.renderOrder = 2;
    this.scene.add(mesh);
    this.markers.push({ mesh, age: 0 });
  }

  dispose(): void {
    for (const m of this.markers) {
      this.scene.remove(m.mesh);
      (m.mesh.material as THREE.Material).dispose();
    }
    this.markers = [];
  }

  update(dt: number): void {
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i];
      m.age += dt;
      const mat = m.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, 1 - m.age / LIFE);
      if (m.age > LIFE) {
        this.scene.remove(m.mesh);
        mat.dispose();
        this.markers.splice(i, 1);
      }
    }
  }
}

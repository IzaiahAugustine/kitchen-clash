import * as THREE from 'three';

/** Procedural textures drawn on canvases (no image files to load). */

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, size: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** Deterministic pseudo-random so textures look the same every load. */
function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

/** Acrylic court surface: fine sand speckle. Grayscale, tinted by the material color. */
export function courtSpeckle(): THREE.CanvasTexture {
  return canvasTexture(256, (g, n) => {
    const r = rng(11);
    g.fillStyle = '#f2f2f2';
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 9000; i++) {
      const v = 200 + Math.floor(r() * 55);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(r() * n, r() * n, 1.4, 1.4);
    }
  });
}

/** Grass: soft mottled patches plus short blade strokes. */
export function grass(): THREE.CanvasTexture {
  return canvasTexture(512, (g, n) => {
    const r = rng(5);
    g.fillStyle = '#e6e6e6';
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 260; i++) {
      const v = 190 + Math.floor(r() * 65);
      g.fillStyle = `rgba(${v},${v},${v},0.35)`;
      g.beginPath();
      g.arc(r() * n, r() * n, 10 + r() * 40, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < 7000; i++) {
      const v = 170 + Math.floor(r() * 85);
      g.strokeStyle = `rgba(${v},${v},${v},0.7)`;
      g.lineWidth = 1;
      const x = r() * n;
      const y = r() * n;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (r() - 0.5) * 3, y - 3 - r() * 5);
      g.stroke();
    }
  });
}

/** Windscreen fabric with the game's name printed on it. One tile = 17 ft x 4 ft. */
export function windscreen(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1f5c3c';
  g.fillRect(0, 0, c.width, c.height);
  // woven mesh
  g.strokeStyle = 'rgba(0,0,0,0.18)';
  for (let x = 0; x < c.width; x += 4) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, c.height);
    g.stroke();
  }
  // Shrink the lettering until it fits the tile with some breathing room.
  let size = 130;
  do {
    g.font = `900 ${size}px "Lilita One", "Arial Black", sans-serif`;
    size -= 4;
  } while (g.measureText('KITCHEN CLASH').width > c.width * 0.78 && size > 20);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(255, 248, 231, 0.85)';
  g.fillText('KITCHEN CLASH', c.width / 2, c.height / 2 + 6);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** Top-down UVs from world x/z, `feetPerTile` feet per texture repeat. */
export function planarUVs(geo: THREE.BufferGeometry, feetPerTile: number): void {
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / feetPerTile;
    uv[i * 2 + 1] = pos.getZ(i) / feetPerTile;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/**
 * UVs for vertical walls that read left-to-right from inside the court. `tileW` x `tileH`
 * feet per texture repeat.
 */
export function wallUVs(geo: THREE.BufferGeometry, tileW: number, tileH: number): void {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = nrm.getX(i);
    const nz = nrm.getZ(i);
    const along = Math.abs(nz) > Math.abs(nx) ? pos.getX(i) * Math.sign(nz || 1) : -pos.getZ(i) * Math.sign(nx || 1);
    uv[i * 2] = along / tileW + 0.5;
    uv[i * 2 + 1] = pos.getY(i) / tileH;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

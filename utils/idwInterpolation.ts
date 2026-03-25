/**
 * idwInterpolation.ts
 *
 * Inverse Distance Weighting (IDW) interpolation utilities.
 * Used by FloorPlanEditor to produce a smooth heatmap from sparse sensor readings.
 */

export interface IDWPoint {
  x: number;  // in the same unit as the grid (e.g. meters or pixels)
  y: number;
  value: number; // 0–1 score
}

/**
 * Interpolate the IDW value at a single point.
 * power = 2 gives classic IDW behaviour (faster decay with distance).
 */
export function idwAt(points: IDWPoint[], px: number, py: number, power = 2): number {
  if (points.length === 0) return 0;

  let weightedSum = 0;
  let weightTotal = 0;

  for (const p of points) {
    const d = Math.sqrt((p.x - px) ** 2 + (p.y - py) ** 2);
    if (d < 1e-9) return p.value; // exact sensor location
    const w = 1 / d ** power;
    weightedSum += w * p.value;
    weightTotal += w;
  }

  return weightTotal > 0 ? weightedSum / weightTotal : 0;
}

/**
 * Render the IDW heatmap directly onto a canvas context.
 *
 * @param ctx       2D canvas context
 * @param points    IDW control points in canvas-pixel coordinates
 * @param width     canvas width in pixels
 * @param height    canvas height in pixels
 * @param cellSize  resolution of the raster grid in pixels (lower = sharper, slower)
 * @param alpha     overall opacity 0–1
 */
export function renderIDWToCanvas(
  ctx: CanvasRenderingContext2D,
  points: IDWPoint[],
  width: number,
  height: number,
  cellSize = 10,
  alpha = 0.55,
): void {
  if (points.length === 0) return;

  const cols = Math.ceil(width  / cellSize);
  const rows = Math.ceil(height / cellSize);
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = (c + 0.5) * cellSize;
      const py = (r + 0.5) * cellSize;
      const score = idwAt(points, px, py);
      const [R, G, B] = scoreToRGB(score);

      // Fill the entire cell rectangle
      for (let dr = 0; dr < cellSize; dr++) {
        for (let dc = 0; dc < cellSize; dc++) {
          const ix = Math.min(c * cellSize + dc, width  - 1);
          const iy = Math.min(r * cellSize + dr, height - 1);
          const i = (iy * width + ix) * 4;
          data[i]     = R;
          data[i + 1] = G;
          data[i + 2] = B;
          data[i + 3] = Math.round(alpha * 255);
        }
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

/** Map a 0–1 score to RGB using: blue → green → yellow → orange → red */
export function scoreToRGB(score: number): [number, number, number] {
  // Colour stops: [score, [R, G, B]]
  const stops: Array<[number, [number, number, number]]> = [
    [0.00, [59,  130, 246]], // blue
    [0.25, [34,  197,  94]], // green
    [0.45, [234, 179,   8]], // yellow
    [0.65, [249, 115,  22]], // orange
    [1.00, [239,  68,  68]], // red
  ];

  for (let i = 0; i < stops.length - 1; i++) {
    const [s0, c0] = stops[i];
    const [s1, c1] = stops[i + 1];
    if (score <= s1) {
      const t = (score - s0) / (s1 - s0);
      return [
        Math.round(c0[0] + t * (c1[0] - c0[0])),
        Math.round(c0[1] + t * (c1[1] - c0[1])),
        Math.round(c0[2] + t * (c1[2] - c0[2])),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

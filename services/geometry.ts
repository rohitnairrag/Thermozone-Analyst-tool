import { WallDef } from '../types';

/** Compute floor area from wall definitions using the Shoelace formula. */
export const computeFloorArea = (walls: WallDef[]): number => {
  if (!walls || walls.length === 0) return 1; // fallback to 1 m²

  let x = 0;
  let y = 0;
  const coords: { x: number; y: number }[] = [{ x, y }];

  walls.forEach(wall => {
    const azRad = wall.azimuth * Math.PI / 180;
    x += wall.lengthM * Math.sin(azRad);
    y += wall.lengthM * Math.cos(azRad);
    coords.push({ x, y });
  });

  let area = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    area += (coords[i].x * coords[i + 1].y) - (coords[i + 1].x * coords[i].y);
  }

  return Math.max(1, Math.abs(area) / 2);
};

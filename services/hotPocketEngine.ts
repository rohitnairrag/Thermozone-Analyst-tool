/**
 * hotPocketEngine.ts
 *
 * Computes per-sensor hot-pocket scores from live sensor readings.
 *
 * Two signals (no hard-coded industry thresholds — all exposed as config):
 *   Signal 1 (55%): desk_temp - setpoint           → absolute discomfort
 *   Signal 2 (45%): desk_temp - zone_mean_desk_temp → spatial unevenness
 *
 * Zone stratification (ceiling_avg - desk_avg) is returned as a diagnostic
 * metric shown separately, not blended into the per-sensor score.
 *
 * Supply-air sensors (role='supply_air') are excluded from averages and
 * returned only as a zone-level informational metric.
 */

export interface SensorWithTemp {
  key: string;
  name: string;
  temp: number;
  classifiedType: 'desk' | 'ceiling';
  role: 'normal' | 'supply_air' | 'excluded';
  zoneId: string;
  setpoint: number | null;
}

export interface HotPocketScore {
  sensorKey: string;
  sensorName: string;
  temp: number;
  deltaSetpoint: number;   // desk_temp - setpoint
  localDeviation: number;  // desk_temp - zone_mean_desk_temp
  score: number;           // 0–1 composite
  color: string;           // hex fill color for heatmap
  label: 'cool' | 'warm' | 'hot' | 'severe';
}

export interface ZoneHotPocketResult {
  zoneId: string;
  setpoint: number;
  deskScores: HotPocketScore[];
  zoneMeanDeskTemp: number;
  zoneMeanCeilingTemp: number;
  stratification: number;      // ceiling_avg - desk_avg (diagnostic, not in score)
  supplyAirTemp?: number;      // only present when a supply_air sensor exists in zone
}

/** Config for customisable threshold ceilings (the max value of each signal's normalisation range). */
export interface HotPocketConfig {
  deltaSetpointMax: number;   // default 4°C
  localDeviationMax: number;  // default 3°C
}

export const DEFAULT_HOT_POCKET_CONFIG: HotPocketConfig = {
  deltaSetpointMax: 4,
  localDeviationMax: 3,
};

// ── helpers ──────────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function norm(value: number, max: number): number {
  return clamp01(value / max);
}

function scoreLabel(score: number): 'cool' | 'warm' | 'hot' | 'severe' {
  if (score < 0.25) return 'cool';
  if (score < 0.45) return 'warm';
  if (score < 0.65) return 'hot';
  return 'severe';
}

export function scoreToColor(score: number): string {
  if (score < 0.25) return '#3b82f6';  // blue
  if (score < 0.45) return '#22c55e';  // green
  if (score < 0.65) return '#f97316';  // orange
  return '#ef4444';                    // red
}

// ── main export ──────────────────────────────────────────────────────────────

/**
 * Compute hot-pocket scores for all zones.
 * Pass only sensors whose role !== 'excluded'.
 */
export function computeZoneHotPockets(
  sensors: SensorWithTemp[],
  config: HotPocketConfig = DEFAULT_HOT_POCKET_CONFIG,
  defaultSetpoint: number = 24,
): ZoneHotPocketResult[] {
  // Group by zone
  const byZone = new Map<string, SensorWithTemp[]>();
  for (const s of sensors) {
    if (!byZone.has(s.zoneId)) byZone.set(s.zoneId, []);
    byZone.get(s.zoneId)!.push(s);
  }

  const results: ZoneHotPocketResult[] = [];

  for (const [zoneId, zoneSensors] of byZone.entries()) {
    const deskSensors    = zoneSensors.filter(s => s.classifiedType === 'desk'    && s.role === 'normal');
    const ceilingSensors = zoneSensors.filter(s => s.classifiedType === 'ceiling' && s.role === 'normal');
    const supplyAir      = zoneSensors.find(s  => s.role === 'supply_air');

    const setpoint = zoneSensors.find(s => s.setpoint !== null)?.setpoint ?? defaultSetpoint;

    const meanDesk = deskSensors.length > 0
      ? deskSensors.reduce((a, s) => a + s.temp, 0) / deskSensors.length
      : setpoint;

    const meanCeiling = ceilingSensors.length > 0
      ? ceilingSensors.reduce((a, s) => a + s.temp, 0) / ceilingSensors.length
      : setpoint;

    const deskScores: HotPocketScore[] = deskSensors.map(s => {
      const deltaSetpoint  = s.temp - setpoint;
      const localDeviation = s.temp - meanDesk;

      const score =
        0.55 * norm(deltaSetpoint,  config.deltaSetpointMax) +
        0.45 * norm(localDeviation, config.localDeviationMax);

      return {
        sensorKey:     s.key,
        sensorName:    s.name,
        temp:          s.temp,
        deltaSetpoint,
        localDeviation,
        score,
        color:         scoreToColor(score),
        label:         scoreLabel(score),
      };
    });

    results.push({
      zoneId,
      setpoint,
      deskScores,
      zoneMeanDeskTemp:    meanDesk,
      zoneMeanCeilingTemp: meanCeiling,
      stratification:      meanCeiling - meanDesk,
      supplyAirTemp:       supplyAir?.temp,
    });
  }

  return results;
}

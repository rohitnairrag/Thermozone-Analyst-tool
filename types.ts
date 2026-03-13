export type Direction = 'N' | 'S' | 'E' | 'W' | 'NE' | 'NW' | 'SE' | 'SW';

export type WallType = 'external' | 'internal';
export type ConstructionType = 'opaque' | 'mixed' | 'full_glass';

export interface EmbeddedWindow {
  id: string;
  areaM2: number;
}

export interface WallDef {
  id: string;
  lengthM: number;
  direction: Direction;
  azimuth: number;
  wallType: WallType;
  constructionType: ConstructionType;
  adjacentZoneId?: string;   // internal walls only
  windows?: EmbeddedWindow[]; // external + mixed only
  glassAreaM2?: number;       // internal + mixed only
}

export interface ZoneParams {
  name: string;
  ceilingHeightM: number;
  isTopFloor: boolean;
  walls: WallDef[];
}

export interface ACUnit {
  id: string;
  name: string;
  ratedCapacityWatts: number;
  iseer: number;
  ageYears: number;
}

export interface HourlyWeather {
  temperature: number[];
  directRadiation: number[];
  diffuseRadiation: number[];
  shortwaveRadiation: number[];
  relativeHumidity: number[];
}

export interface LocationData {
  name: string;
  lat: number;
  lon: number;
}

/**
 * Schedule preset for an internal load item.
 *
 * office_occupancy  – follows people schedule (ramp 8→9, full 10-16, ramp 17→18, off after)
 * office_lighting   – on 8-18 with 0.4 shoulders; off outside
 * office_equipment  – 0.1 standby at night, full 9-17, taper 18-20
 * always_on         – 0.6 duty cycle all 24 h (e.g. fridge compressor cycling)
 * intermittent      – office hours only, 0.3 avg utilisation (e.g. printer)
 */
export type SchedulePreset =
  | 'office_occupancy'
  | 'office_lighting'
  | 'office_equipment'
  | 'always_on'
  | 'intermittent';

/** A single type of heat-generating item inside the zone (used for inventory-based internal loads). */
export interface InternalLoadItem {
  id: string;
  label: string;
  /** Broad category — determines how it maps onto SimulationDataPoint fields */
  category: 'people' | 'lighting' | 'equipment' | 'appliance';
  count: number;
  /** Rated heat output per unit in Watts */
  wattsPerUnit: number;
  schedulePreset: SchedulePreset;
}

export interface ZoneProfile {
  id: string;
  zone: ZoneParams;
  ac: ACUnit[];
  /** Optional per-unit inventory for accurate scheduled internal-load calculation.
   *  When present, replaces the generic W/m² density approach in the physics engine. */
  internalLoads?: InternalLoadItem[];
}

export interface WindowDebugInfo {
  azimuth: number;
  cosTheta: number;
  incidentRadiation: number;
  solarGain: number;
}

export interface SimulationDataPoint {
  time: string;
  hour: number;
  outdoorTemp: number;
  // Categories for Graphing
  solarLoad: number;
  glassLoad: number;
  wallLoad: number;
  roofLoad: number;
  infLoad: number;
  internalLoad: number;
  peopleLoad: number;
  otherLoad: number;

  totalHeatLoad: number;
  windowGains: Record<string, number>;
  coolingCapacityAvailable: number;
  acOutputWatts: number;
  indoorTempRaw: number;
  setPoint: number;

  // Debug Fields
  solarAltitude: number;
  solarAzimuth: number;
  dni: number;
  dhi: number;
  ghi: number;
  windowDebug: Record<string, WindowDebugInfo>;
  _areaM2: number;
}

export interface SimulationResult {
  data: SimulationDataPoint[];
  peakLoadWatts: number;
  peakLoadTime: string;
  isSufficient: boolean;
  averageTemp: number;
  maxTemp: number;
  acOutputAtPeakLoad: number;   // actual AC output (W) at the hour peak load occurs
}

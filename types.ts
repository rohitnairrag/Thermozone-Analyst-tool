export type Direction = 'N' | 'S' | 'E' | 'W' | 'NE' | 'NW' | 'SE' | 'SW';

export type WallType = 'external' | 'internal';
export type ConstructionType = 'opaque' | 'mixed' | 'full_glass';

export type SensorLevel = 'desk' | 'ac_level' | 'exclude';

export interface EmbeddedWindow {
  id: string;
  areaM2: number;
  obstructionHeightM?: number;   // height of obstruction above window centre (m)
  obstructionDistanceM?: number; // horizontal distance from window to obstruction (m)
  obstructionWidthM?: number;    // width of obstruction (m) — optional, for azimuth cone
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

/**
 * Configuration for a single DB sub-zone (site_group_name) within an app zone.
 * coverageType is auto-computed from the AC unit assignments — not stored.
 */
export interface SubZoneConfig {
  name: string;        // DB site_group_name — read-only, sourced from server ZONE_MAP
  areaM2: number;      // floor area entered by user
}

export interface ZoneParams {
  name: string;
  displayName?: string;   // friendly label shown in UI; name is the DB-lookup key
  ceilingHeightM: number;
  isTopFloor: boolean;
  walls: WallDef[];
  subZones?: SubZoneConfig[];  // per-sub-zone floor areas; optional until configured
}

export interface ACUnit {
  id: string;
  name: string;
  ratedCapacityWatts: number;
  iseer: number;
  ageYears: number;
  dbSensorName?: string;         // links to DB sensor name (e.g. "AC1", "AC2")
  primarySubZones?: string[];    // sub-zone names this AC directly cools
  spilloverSubZones?: string[];  // sub-zone names this AC incidentally cools
}

export interface HourlyWeather {
  temperature: number[];
  directRadiation: number[];
  diffuseRadiation: number[];
  shortwaveRadiation: number[];
  relativeHumidity: number[];
  windspeed?: number[];   // 10m wind speed in m/s — used for dynamic outdoor convection coefficient
}

export interface LocationData {
  name: string;
  lat: number;
  lon: number;
}

/** A single type of heat-generating item inside the zone (used for inventory-based internal loads). */
export interface InternalLoadItem {
  id: string;
  label: string;
  /** Broad category — determines how it maps onto SimulationDataPoint fields */
  category: 'people' | 'lighting' | 'equipment' | 'appliance';
  count: number;
  /** Rated heat output per unit in Watts */
  wattsPerUnit: number;
  /** Active time window — "HH:MM" 24-hour strings, both inclusive */
  startTime: string;  // e.g. "10:00"
  endTime:   string;  // e.g. "23:00"
}

export interface ZoneProfile {
  id: string;
  zone: ZoneParams;
  ac: ACUnit[];
  /** Optional per-unit inventory for accurate scheduled internal-load calculation.
   *  When present, replaces the generic W/m² density approach in the physics engine. */
  internalLoads?: InternalLoadItem[];
  /** Optional per-sensor position overrides. Keys are sensor names (from DB).
   *  'desk' = desk-level, 'ac_level' = ceiling/AC-level, 'exclude' = ignore this sensor. */
  sensorPositions?: Record<string, SensorLevel>;
  /** When false, this zone has NO desk-level sensors → always use Track B (capacity/room-temp verdict).
   *  Defaults to true (desk sensors assumed present) if not set. */
  hasDeskSensors?: boolean;
}

export interface WindowDebugInfo {
  azimuth: number;
  cosTheta: number;
  incidentRadiation: number;
  solarGain: number;
}

/** One wall's heat transfer contribution to the adjacent zone at a given simulation slot. */
export interface ZoneTransferEntry {
  wallId: string;
  adjacentZoneId: string;
  watts: number;   // positive = heat flowing INTO this zone from adjacent; negative = flowing out
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

  // Inter-zone heat transfer breakdown (one entry per internal wall with adjacentZoneId)
  zoneTransfers: ZoneTransferEntry[];

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
  totalDailyAcKwh: number;      // total AC cooling energy delivered for the day (kWh)
}

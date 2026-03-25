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

/**
 * Schedule preset for an internal load item.
 *
 * office_occupancy          – people ramp 8→9, full 10-16, ramp 17→18, off after
 * office_lighting           – on 8-18 with 0.4 shoulders; off outside
 * office_equipment          – 0.1 standby at night, full 9-17, taper 18-20
 * always_on                 – 0.6 duty cycle all 24 h (e.g. fridge compressor cycling)
 * intermittent              – office hours only, 0.3 avg utilisation (e.g. printer)
 * extended_office_occupancy – 10am full until 11pm (actual Living Things Bangalore schedule)
 * early_morning_lighting    – on from 6am, full during office hours, off after 11pm
 */
export type SchedulePreset =
  | 'office_occupancy'
  | 'office_lighting'
  | 'office_equipment'
  | 'always_on'
  | 'intermittent'
  | 'extended_office_occupancy'
  | 'early_morning_lighting';

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
  /**
   * Optional key for live-data override of `count`.
   * When live occupancy data is available (e.g. from DB), the engine looks up this key
   * in a `liveOccupancy` map and substitutes the live value instead of the default count.
   * Example: liveCountKey = "occupancy_zone1" → liveOccupancy["occupancy_zone1"] = 6
   */
  liveCountKey?: string;
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

// ── Floor Plan Editor types ──────────────────────────────────────────────────

/**
 * A sensor placed on the interactive floor plan.
 * Ceiling-type sensors also serve as AC unit position anchors.
 */
export interface SensorPlacement {
  sensorKey: string;           // compound "dbZone::sensorName"
  sensorName: string;          // display name (matches temperature grid)
  classifiedType: 'desk' | 'ceiling';
  role: 'normal' | 'supply_air' | 'excluded';
  zoneId: string;              // app zone id this sensor belongs to
  x: number;                   // meters from office-canvas origin
  y: number;
  // Ceiling sensors only — AC anchor
  flowDirection?: number;      // degrees 0–360 (direction AC blows cold air toward)
  wallId?: string;             // which wall the AC is mounted on
  isCustomMode?: boolean;      // true = x/y are raw SVG px / SCALE (no zone offset)
}

export interface ZoneOffset {
  zoneId: string;
  offsetX: number;  // meters from office-canvas origin (SVG left edge)
  offsetY: number;  // meters from office-canvas origin (SVG top edge)
}

/** A room outline on the custom floor plan, editable by the user. */
export interface CustomRoom {
  id: string;
  label: string;
  x: number;   // SVG pixels from canvas origin
  y: number;
  w: number;
  h: number;
}

/** Office-wide floor plan state (all zones + sensor placements). */
export interface OfficeFloorPlan {
  zoneOffsets: ZoneOffset[];
  sensors: SensorPlacement[];
  customRooms?: CustomRoom[];  // editable room outlines drawn from drawio
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

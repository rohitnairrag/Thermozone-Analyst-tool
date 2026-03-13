export type Direction = 'N' | 'S' | 'E' | 'W' | 'NE' | 'NW' | 'SE' | 'SW';
export interface WindowDef {
  id: string;
  wallId: string;
  areaM2: number;
}

export interface WallDef {
  id: string;
  lengthM: number;
  direction: Direction;
  azimuth: number;
}

export interface ZoneParams {
  name: string;
  ceilingHeightM: number;
  isTopFloor: boolean;
  walls: WallDef[];
  windows: WindowDef[];
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

export interface ZoneProfile {
  id: string;
  zone: ZoneParams;
  ac: ACUnit[];
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
  
  totalHeatLoad: number; // Sum of all above
  windowGains: Record<string, number>; // Individual window gains by ID
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
}
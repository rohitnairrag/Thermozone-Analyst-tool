/**
 * liveDataService.ts
 * Fetches real-time and historical averaged room temperatures from the Express backend,
 * which queries the PostgreSQL sensor table (lt_bangalore_org_live_device_data).
 *
 * Zone names passed here are app zone names (e.g. "Zone 1") — the backend
 * resolves them to their constituent DB site_group_names via ZONE_MAP.
 */

/** A sensor reading returned by /api/live-all — includes naturalZone and effectiveZone */
export interface AllSensorReading {
  name: string;
  dbZone: string;          // DB site_group_name (physical home)
  naturalZone: string;     // app zone derived from ZONE_MAP
  effectiveZone: string;   // zone actually used (overridden or same as naturalZone)
  temp: number;
  setpoint: number | null;
  mode: string | null;
  powerStatus: string | null;
  fanSpeed: string | null;
  deviceTimestamp: string;
  status: string | null;
}

export interface SensorMoveEntry {
  zone: string;   // app zone name the sensor moved to
  from: string;   // YYYY-MM-DD — date the physical move happened
}

export interface AllSensorsData {
  sensors: AllSensorReading[];
  overrides: Record<string, SensorMoveEntry[]>;  // assetName → timestamped move history
  zones: string[];                               // all known app zone names
}

export interface SensorReading {
  name: string;
  dbZone: string;        // which DB site_group_name this sensor belongs to
  temp: number;
  setpoint: number | null;
  mode: string | null;
  powerStatus: string | null;
  fanSpeed: string | null;
  deviceTimestamp: string;
  status: string | null;
  rPhasePower: number;   // watts
  yPhasePower: number;   // watts
  bPhasePower: number;   // watts
  power: number;         // total power (watts) — fallback if phase data absent
  liveAcOutput: number;  // = r+y+b phase power when ON, else 0 (watts)
  ageMinutes: number | null;  // minutes since device last reported
  isStale: boolean;           // true if >2 hours since last device_timestamp
}

export interface LiveTempData {
  avgTemp: number;
  sensorCount: number;
  zone: string;
  dbZones: string[];
  lastUpdated: string;
  sensors: SensorReading[];
}

export interface HistoricalAcOutputData {
  zone: string;
  dbZones: string[];
  date: string;
  yesterday: string;
  acOutputs: number[];       // 24-element array, total zone electrical watts, index = hour (0–23)
  hoursFromToday: number;
  hoursFromYesterday: number;
  hasData: boolean;
}

export interface AcBreakdownSensor {
  name: string;
  hours: (number | null)[];  // 24-element; real watts or 0 for elapsed hours, null for future
}

export interface AcBreakdownData {
  zone: string;
  dbZones: string[];
  date: string;
  sensors: AcBreakdownSensor[];
}

export interface HistoricalTempData {
  zone: string;
  dbZones: string[];
  date: string;
  yesterday: string;
  temps: number[];           // 24 real-sensor values, index = hour (0–23)
  hoursFromToday: number;
  hoursFromYesterday: number;
  hasData: boolean;          // true if any DB data found for today or yesterday
}

/** Info about a DB sub-zone returned by /api/subzones */
export interface SubZoneInfo {
  name: string;               // DB site_group_name
  sensorCount: number;
  suggestedAreaM2: number;    // estimated from historical power ratio; 0 if no data
  suggestedMethod: 'power_ratio' | 'sensor_count' | 'none';
}

export interface SubZonesData {
  zone: string;
  dbZones: string[];
  subZones: SubZoneInfo[];
}

/**
 * Fetches sub-zone metadata (sensor counts + area suggestions) for a zone.
 * @param zone - App zone name e.g. "Zone 1"
 */
export async function fetchSubZones(zone = 'Zone 1', totalAreaM2?: number): Promise<SubZonesData | null> {
  try {
    const params = new URLSearchParams({ zone });
    if (totalAreaM2 != null) params.set('totalAreaM2', String(totalAreaM2));
    const response = await fetch(`/api/subzones?${params}`);
    if (!response.ok) {
      console.warn(`[liveDataService] subzones API returned ${response.status}`);
      return null;
    }
    return await response.json() as SubZonesData;
  } catch (err) {
    console.warn('[liveDataService] Failed to fetch sub-zones:', err);
    return null;
  }
}

/**
 * Fetches the latest averaged room temperature for a given app zone.
 * @param zone - App zone name e.g. "Zone 1" (default: "Zone 1")
 */
export async function fetchLiveRoomTemp(zone = 'Zone 1'): Promise<LiveTempData | null> {
  try {
    const response = await fetch(`/api/live-temp?zone=${encodeURIComponent(zone)}`);
    if (!response.ok) {
      console.warn(`[liveDataService] API returned ${response.status}`);
      return null;
    }
    const data: LiveTempData = await response.json();
    return data;
  } catch (err) {
    console.warn('[liveDataService] Failed to fetch live temp:', err);
    return null;
  }
}

/**
 * Fetches hourly average indoor temperatures for a given app zone and date.
 * Returns a 24-element array (index = hour 0–23).
 * Hours with no sensor data carry forward from the previous hour (no nulls).
 *
 * @param zone - App zone name e.g. "Zone 1"
 * @param date - ISO date string YYYY-MM-DD (default: today in IST)
 */
export async function fetchHistoricalTemps(
  zone = 'Zone 1',
  date?: string,
): Promise<HistoricalTempData | null> {
  try {
    // Let the server default to today IST if no date provided
    const params = new URLSearchParams({ zone });
    if (date) params.set('date', date);
    const response = await fetch(`/api/historical-temp?${params}`);
    if (!response.ok) {
      console.warn(`[liveDataService] historical-temp API returned ${response.status}`);
      return null;
    }
    const data: HistoricalTempData = await response.json();
    return data;
  } catch (err) {
    console.warn('[liveDataService] Failed to fetch historical temps:', err);
    return null;
  }
}

/**
 * Fetches per-sensor (per-AC unit) hourly electrical output for a zone and date.
 * Returns an array of { name, hours } — one entry per AC sensor found in the DB.
 * hours is 24-element: real watts for elapsed hours, 0 for elapsed hours with no data, null for future.
 *
 * @param zone - App zone name e.g. "Zone 1"
 * @param date - ISO date string YYYY-MM-DD (default: today in IST)
 */
export async function fetchAcBreakdown(
  zone = 'Zone 1',
  date?: string,
): Promise<AcBreakdownData | null> {
  try {
    const params = new URLSearchParams({ zone });
    if (date) params.set('date', date);
    const response = await fetch(`/api/ac-breakdown?${params}`);
    if (!response.ok) {
      console.warn(`[liveDataService] ac-breakdown API returned ${response.status}`);
      return null;
    }
    const data: AcBreakdownData = await response.json();
    return data;
  } catch (err) {
    console.warn('[liveDataService] Failed to fetch AC breakdown:', err);
    return null;
  }
}

export interface DesignDayData {
  designDayTemp: number;   // 95th-percentile daily max across Apr–Jun for past 5 years
  dataYears: string;       // e.g. "2020–2024"
  dataPoints: number;      // total summer days used in calculation
}

/**
 * Fetches historical daily-max temperatures from OpenMeteo for April–June
 * over the past 5 complete years, then returns the 95th-percentile value
 * as the design-day dry-bulb temperature for this location.
 */
export async function fetchDesignDayTemp(lat: number, lon: number): Promise<DesignDayData | null> {
  try {
    const endYear   = new Date().getFullYear() - 1;   // last complete year
    const startYear = endYear - 4;                     // 5-year window
    const url = `https://archive-api.open-meteo.com/v1/archive`
      + `?latitude=${lat}&longitude=${lon}`
      + `&start_date=${startYear}-04-01&end_date=${endYear}-06-30`
      + `&daily=temperature_2m_max&timezone=Asia%2FKolkata`;

    const res = await fetch(url);
    if (!res.ok) { console.warn('[liveDataService] design-day API returned', res.status); return null; }

    const json = await res.json();
    const dates: string[]   = json.daily?.time              ?? [];
    const maxTemps: number[] = json.daily?.temperature_2m_max ?? [];

    // Keep only April (4), May (5), June (6) and filter out nulls
    const summerTemps = dates
      .map((d, i) => ({ month: new Date(d).getMonth() + 1, temp: maxTemps[i] }))
      .filter(({ month, temp }) => [4, 5, 6].includes(month) && temp != null)
      .map(({ temp }) => temp)
      .sort((a, b) => a - b);

    if (summerTemps.length === 0) return null;

    // 95th percentile — floor at 50% index to avoid extreme single events
    const idx95 = Math.min(Math.floor(summerTemps.length * 0.95), summerTemps.length - 1);
    const designDayTemp = +summerTemps[idx95].toFixed(1);

    return { designDayTemp, dataYears: `${startYear}–${endYear}`, dataPoints: summerTemps.length };
  } catch (err) {
    console.warn('[liveDataService] Failed to fetch design-day temp:', err);
    return null;
  }
}

/**
 * Fetches all sensors across all zones, with their effective zone assignment.
 * Used by the sensor reassignment UI.
 */
export async function fetchAllLiveSensors(): Promise<AllSensorsData | null> {
  try {
    const response = await fetch('/api/live-all');
    if (!response.ok) {
      console.warn(`[liveDataService] live-all API returned ${response.status}`);
      return null;
    }
    return await response.json() as AllSensorsData;
  } catch (err) {
    console.warn('[liveDataService] Failed to fetch all sensors:', err);
    return null;
  }
}

/**
 * Fetches hourly total zone AC electrical output (watts) for a given app zone.
 * Returns a 24-element array (index = hour 0–23).
 * Fallback: today → yesterday same hour → carry-forward.
 *
 * @param zone - App zone name e.g. "Zone 1"
 * @param date - ISO date string YYYY-MM-DD (default: today in IST)
 */
export async function fetchHistoricalAcOutput(
  zone = 'Zone 1',
  date?: string,
): Promise<HistoricalAcOutputData | null> {
  try {
    const params = new URLSearchParams({ zone });
    if (date) params.set('date', date);
    const response = await fetch(`/api/historical-ac-output?${params}`);
    if (!response.ok) {
      console.warn(`[liveDataService] historical-ac-output API returned ${response.status}`);
      return null;
    }
    const data: HistoricalAcOutputData = await response.json();
    return data;
  } catch (err) {
    console.warn('[liveDataService] Failed to fetch historical AC output:', err);
    return null;
  }
}

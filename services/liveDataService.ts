/**
 * liveDataService.ts
 * Fetches real-time and historical averaged room temperatures from the Express backend,
 * which queries the PostgreSQL sensor table (lt_bangalore_org_live_device_data).
 *
 * Zone names passed here are app zone names (e.g. "Zone 1") — the backend
 * resolves them to their constituent DB site_group_names via ZONE_MAP.
 */

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

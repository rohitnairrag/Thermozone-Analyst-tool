/**
 * liveDataService.ts
 * Fetches real-time averaged room temperature from the Express backend,
 * which queries the PostgreSQL sensor table (lt_bangalore_org_live_device_data).
 */

export interface SensorReading {
  name: string;
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
  lastUpdated: string;
  sensors: SensorReading[];
}

/**
 * Fetches the averaged room temperature for a given zone.
 * @param zone - The site_group_name to filter by (default: "Working Area 1")
 */
export async function fetchLiveRoomTemp(zone = 'Working Area 1'): Promise<LiveTempData | null> {
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

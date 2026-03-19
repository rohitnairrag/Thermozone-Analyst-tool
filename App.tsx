import React, { useState, useEffect } from 'react';
import { Activity, Thermometer, Wind, Server, Plus, Trash2, Map, Clock, LayoutGrid, Bug, Pencil, X, Flame, RotateCcw } from 'lucide-react';
import { DEFAULT_ACS, DEFAULT_ZONE } from './constants';
import { calculateHeatLoad } from './services/physicsEngine';
import ResultsDashboard from './components/ResultsDashboard';
import DebugPanel from './components/DebugPanel';
import HeatFlowDiagram from './components/HeatFlowDiagram';
import {
  SimulationResult, ACUnit, ZoneProfile, WallDef, Direction,
  LocationData, HourlyWeather, ConstructionType, EmbeddedWindow, InternalLoadItem, SubZoneConfig, SensorLevel
} from './types';
import { searchLocation, fetchWeather, fetchWeatherForDate } from './services/weatherService';
import { fetchLiveRoomTemp, fetchHistoricalTemps, fetchHistoricalAcOutput, fetchAcBreakdown, fetchSubZones, fetchDesignDayTemp, fetchAllLiveSensors, LiveTempData, HistoricalTempData, HistoricalAcOutputData, AcBreakdownData, SubZoneInfo, DesignDayData, AllSensorsData } from './services/liveDataService';
import { computeFloorArea } from './services/geometry';

const AZIMUTH_MAP: Record<string, number> = {
  'N': 0, 'NE': 45, 'E': 90, 'SE': 135, 'S': 180, 'SW': 225, 'W': 270, 'NW': 315
};

const OPPOSITE_DIR: Record<string, string> = {
  'N': 'S', 'S': 'N', 'E': 'W', 'W': 'E',
  'NE': 'SW', 'SW': 'NE', 'NW': 'SE', 'SE': 'NW',
};

interface InputFieldProps {
  label: string;
  value: string | number;
  onChange: (value: string | number) => void;
  unit?: string;
  type?: 'text' | 'number';
}

const InputField = ({ label, value, onChange, unit, type = 'number' }: InputFieldProps) => (
  <div className="flex flex-col gap-1">
    <label className="text-xs text-slate-400 uppercase font-semibold">{label}</label>
    <div className="relative">
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(type === 'number' ? Number(e.target.value) : e.target.value)}
        className="w-full bg-slate-900 border border-slate-700 rounded-lg py-2 px-3 text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm transition-colors"
      />
      {unit && <span className="absolute right-3 top-2 text-slate-500 text-xs">{unit}</span>}
    </div>
  </div>
);

// Friendly display names for the 4 known zones.
// Used by migrateProfile to back-fill displayName on existing saved data.
const ZONE_DISPLAY_NAMES: Record<string, string> = {
  'Zone 1': 'Main Working Area',
  'Zone 2': 'Pantry',
  'Zone 3': 'Meeting Room',
  'Zone 4': 'Corridor & Reception',
};

// Migrate old localStorage data (separate windows array) to new embedded format.
// Also back-fills displayName so existing saved profiles get proper zone labels.
const migrateProfile = (profile: any): ZoneProfile => {
  const zone = profile.zone;
  const legacyWindows: any[] = zone.windows || [];
  const migratedWalls: WallDef[] = (zone.walls || []).map((wall: any) => {
    if (wall.wallType) return wall as WallDef; // already new format
    const wallWindows = legacyWindows.filter((w: any) => w.wallId === wall.id);
    return {
      ...wall,
      wallType: 'external' as const,
      constructionType: wallWindows.length > 0 ? 'mixed' as const : 'opaque' as const,
      windows: wallWindows.length > 0 ? wallWindows.map((w: any) => ({ id: w.id, areaM2: w.areaM2 })) : undefined,
    };
  });
  // If no displayName saved yet, populate from the known-names table
  const displayName = zone.displayName || ZONE_DISPLAY_NAMES[zone.name];
  // Ensure subZones array exists; back-fill new ACUnit fields for old saved data
  const subZones: SubZoneConfig[] = zone.subZones || [];
  const migratedAc = (profile.ac || []).map((ac: any) => ({
    ...ac,
    dbSensorName: ac.dbSensorName ?? '',
    primarySubZones: ac.primarySubZones ?? [],
    spilloverSubZones: ac.spilloverSubZones ?? [],
  }));
  return {
    ...profile,
    ac: migratedAc,
    zone: { ...zone, walls: migratedWalls, subZones, ...(displayName ? { displayName } : {}) },
  };
};

// ── Default Zone 1 — Working Area (Living Things, Bangalore) ────────────────
// 13 walls: 4 external (mixed with windows), 9 internal
// Source: physical audit + user-entered values saved 2026-03-14
const DEFAULT_ZONE1: ZoneProfile = {
  id: 'zone1-default',
  zone: {
    name: 'Zone 1',
    displayName: 'Main Working Area',
    ceilingHeightM: 3.0,
    isTopFloor: false,
    walls: [
      { id: 'w1',  lengthM: 10.06, direction: 'SE', azimuth: 135, wallType: 'external', constructionType: 'mixed',  windows: [{ id: 'w1-win1',  areaM2: 13.48   }] },
      { id: 'w2',  lengthM: 7.01,  direction: 'SW', azimuth: 225, wallType: 'external', constructionType: 'mixed',  windows: [{ id: 'w2-win1',  areaM2: 9.3934  }] },
      { id: 'w3',  lengthM: 2.62,  direction: 'NW', azimuth: 315, wallType: 'internal', constructionType: 'mixed',  adjacentZoneId: 'zone2-default', glassAreaM2: 6.1  },
      { id: 'w4',  lengthM: 3.04,  direction: 'SW', azimuth: 225, wallType: 'internal', constructionType: 'mixed',  adjacentZoneId: 'zone2-default', glassAreaM2: 7.1  },
      { id: 'w5',  lengthM: 5.42,  direction: 'SW', azimuth: 225, wallType: 'internal', constructionType: 'mixed',  adjacentZoneId: 'zone3-default', glassAreaM2: 12.7 },
      { id: 'w6',  lengthM: 4.85,  direction: 'NW', azimuth: 315, wallType: 'external', constructionType: 'mixed',  windows: [{ id: 'w6-win1',  areaM2: 11.2    }] },
      { id: 'w7',  lengthM: 5.59,  direction: 'NE', azimuth: 45,  wallType: 'internal', constructionType: 'opaque' },
      { id: 'w8',  lengthM: 3.70,  direction: 'NE', azimuth: 45,  wallType: 'internal', constructionType: 'opaque' },
      { id: 'w9',  lengthM: 1.92,  direction: 'NE', azimuth: 45,  wallType: 'internal', constructionType: 'opaque', adjacentZoneId: 'zone4-default' },
      { id: 'w10', lengthM: 4.26,  direction: 'NE', azimuth: 45,  wallType: 'external', constructionType: 'mixed',  windows: [{ id: 'w10-win1', areaM2: 5.7     }] },
      { id: 'w11', lengthM: 1.70,  direction: 'NW', azimuth: 315, wallType: 'internal', constructionType: 'opaque', adjacentZoneId: 'zone4-default' },
      { id: 'w12', lengthM: 2.69,  direction: 'NW', azimuth: 315, wallType: 'internal', constructionType: 'opaque', adjacentZoneId: 'zone4-default' },
      { id: 'w13', lengthM: 1.80,  direction: 'SE', azimuth: 135, wallType: 'internal', constructionType: 'opaque', adjacentZoneId: 'zone4-default' },
    ],
  },
  ac: [
    { id: '1', name: 'Split AC Main', ratedCapacityWatts: 6200, iseer: 3.7, ageYears: 2 },
  ],
  internalLoads: [
    { id: 'il-people',         label: 'People',        category: 'people',    count: 5,  wattsPerUnit: 130, schedulePreset: 'office_occupancy' },
    { id: 'il-monitors',       label: 'Monitors',      category: 'equipment', count: 7,  wattsPerUnit: 30,  schedulePreset: 'office_equipment'  },
    { id: 'il-printer',        label: 'Printer',       category: 'equipment', count: 1,  wattsPerUnit: 500, schedulePreset: 'intermittent'       },
    { id: 'il-tube-lights',    label: 'Tube Lights',   category: 'lighting',  count: 19, wattsPerUnit: 40,  schedulePreset: 'office_lighting'    },
    { id: 'il-fridge',         label: 'Fridge',        category: 'appliance', count: 1,  wattsPerUnit: 200, schedulePreset: 'always_on'          },
    { id: 'il-fans',           label: 'Fans',          category: 'equipment', count: 3,  wattsPerUnit: 75,  schedulePreset: 'office_occupancy'   },
    { id: 'il-ceiling-lights', label: 'Ceiling Lights',category: 'lighting',  count: 9,  wattsPerUnit: 15,  schedulePreset: 'office_lighting'    },
  ] as InternalLoadItem[],
};

// ── Default Zone 2 — Pantry (Living Things, Bangalore) ──────────────────────
// 4 walls: 3 internal mixed partitions + 1 external SW (mixed + 1 window)
const DEFAULT_ZONE2: ZoneProfile = {
  id: 'zone2-default',
  zone: {
    name: 'Zone 2',
    displayName: 'Pantry',
    ceilingHeightM: 3.0,
    isTopFloor: false,
    walls: [
      { id: 'z2w1', lengthM: 2.62, direction: 'SE', azimuth: 135, wallType: 'internal', constructionType: 'mixed',  adjacentZoneId: 'zone1-default', glassAreaM2: 6.2 },
      { id: 'z2w2', lengthM: 3.04, direction: 'NE', azimuth: 45,  wallType: 'internal', constructionType: 'mixed',  adjacentZoneId: 'zone1-default', glassAreaM2: 7.1 },
      { id: 'z2w3', lengthM: 2.62, direction: 'NW', azimuth: 315, wallType: 'internal', constructionType: 'mixed',  adjacentZoneId: 'zone3-default', glassAreaM2: 6.1 },
      { id: 'z2w4', lengthM: 3.04, direction: 'SW', azimuth: 225, wallType: 'external', constructionType: 'mixed',  windows: [{ id: 'z2w4-win1', areaM2: 6.0 }] },
    ],
  },
  ac: [],
  internalLoads: [],
};

// ── Default Zone 3 — Meeting Room 1 (Living Things, Bangalore) ──────────────
// 4 walls: 2 internal (adj Zone 2 & Zone 1) + 2 external NW/SW (mixed + windows)
const DEFAULT_ZONE3: ZoneProfile = {
  id: 'zone3-default',
  zone: {
    name: 'Zone 3',
    displayName: 'Meeting Room',
    ceilingHeightM: 3.0,
    isTopFloor: false,
    walls: [
      { id: 'z3w1', lengthM: 2.62, direction: 'SE', azimuth: 135, wallType: 'internal', constructionType: 'mixed',  adjacentZoneId: 'zone2-default', glassAreaM2: 6.2  },
      { id: 'z3w2', lengthM: 5.42, direction: 'NE', azimuth: 45,  wallType: 'internal', constructionType: 'mixed',  adjacentZoneId: 'zone1-default', glassAreaM2: 12.7  },
      { id: 'z3w3', lengthM: 2.62, direction: 'NW', azimuth: 315, wallType: 'external', constructionType: 'mixed',  windows: [{ id: 'z3w3-win1', areaM2: 6.0 }] },
      { id: 'z3w4', lengthM: 5.42, direction: 'SW', azimuth: 225, wallType: 'external', constructionType: 'mixed',  windows: [{ id: 'z3w4-win1', areaM2: 6.0 }] },
    ],
  },
  ac: [],
  internalLoads: [],
};

// ── Default Zone 4 — Unconditioned Corridor (elevator, reception, staircase, washroom) ──
// 8 walls: 2 external (NE with window, NW opaque) + 6 internal (all adj Zone 1)
const DEFAULT_ZONE4: ZoneProfile = {
  id: 'zone4-default',
  zone: {
    name: 'Zone 4',
    displayName: 'Corridor & Reception',
    ceilingHeightM: 3.0,
    isTopFloor: false,
    walls: [
      { id: 'z4w1', lengthM: 12.08, direction: 'NE', azimuth: 45,  wallType: 'external', constructionType: 'mixed',  windows: [{ id: 'z4w1-win1', areaM2: 4.26 }] },
      { id: 'z4w2', lengthM: 1.70,  direction: 'NW', azimuth: 315, wallType: 'external', constructionType: 'opaque' },
      { id: 'z4w3', lengthM: 5.50,  direction: 'SW', azimuth: 225, wallType: 'internal', constructionType: 'opaque', adjacentZoneId: 'zone1-default' },
      { id: 'z4w4', lengthM: 1.80,  direction: 'NW', azimuth: 315, wallType: 'internal', constructionType: 'opaque', adjacentZoneId: 'zone1-default' },
      { id: 'z4w5', lengthM: 3.70,  direction: 'SW', azimuth: 225, wallType: 'internal', constructionType: 'opaque', adjacentZoneId: 'zone1-default' },
      { id: 'z4w6', lengthM: 1.80,  direction: 'SE', azimuth: 135, wallType: 'internal', constructionType: 'opaque', adjacentZoneId: 'zone1-default' },
      { id: 'z4w7', lengthM: 1.70,  direction: 'SE', azimuth: 135, wallType: 'internal', constructionType: 'opaque', adjacentZoneId: 'zone1-default' },
      { id: 'z4w8', lengthM: 1.92,  direction: 'SW', azimuth: 225, wallType: 'internal', constructionType: 'opaque', adjacentZoneId: 'zone1-default' },
    ],
  },
  ac: [],
  internalLoads: [],
};

interface WallModal {
  isOpen: boolean;
  editingId: string | null;
  lengthM: number;
  direction: Direction;
  wallType: 'external' | 'internal';
  constructionType: ConstructionType;
  adjacentZoneId: string;
  windows: EmbeddedWindow[];
  glassAreaM2: number;
}

const DEFAULT_WALL_MODAL: WallModal = {
  isOpen: false,
  editingId: null,
  lengthM: 5,
  direction: 'N',
  wallType: 'external',
  constructionType: 'opaque',
  adjacentZoneId: '',
  windows: [],
  glassAreaM2: 0,
};

function App() {
  const [activeTab, setActiveTab] = useState<'monitor' | 'configure'>('monitor');
  const [configSection, setConfigSection] = useState<'zone' | 'ac' | 'internal' | 'sensors'>('zone');

  // Ordered factory defaults — one entry per zone.
  // Used both as the initial state fallback AND when "+" creates a new zone.
  const FACTORY_DEFAULTS: ZoneProfile[] = [DEFAULT_ZONE1, DEFAULT_ZONE2, DEFAULT_ZONE3, DEFAULT_ZONE4];

  const [zones, setZones] = useState<ZoneProfile[]>(() => {
    const saved = localStorage.getItem('thermozone_v2');
    if (saved) {
      try {
        const parsed = JSON.parse(saved).map(migrateProfile);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch (e) {
        console.error("Failed to parse saved data", e);
      }
    }
    // Fall back to all known factory defaults so every zone starts with the right config
    return FACTORY_DEFAULTS;
  });

  const [activeZoneId, setActiveZoneId] = useState<string>(() => {
    // Restore the saved active zone id so edits/deletes always target the right zone
    const saved = localStorage.getItem('thermozone_v2');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed[0].id;
      } catch {}
    }
    return DEFAULT_ZONE1.id;
  });
  const [selectedHour, setSelectedHour] = useState<number>(14);
  const [showDebug, setShowDebug] = useState<boolean>(false);
  const [showHeatFlow, setShowHeatFlow] = useState<boolean>(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [wallModal, setWallModal] = useState<WallModal>(DEFAULT_WALL_MODAL);

  const [location, setLocation] = useState<LocationData>(() => {
    const saved = localStorage.getItem('thermozone_location');
    if (saved) {
      try { return JSON.parse(saved); } catch { /* fall through */ }
    }
    return { name: 'Bangalore, India', lat: 12.9716, lon: 77.5946 };
  });
  const [weather, setWeather] = useState<HourlyWeather | null>(null);
  const [isFetchingWeather, setIsFetchingWeather] = useState(false);
  const [locationInput, setLocationInput] = useState(location.name);

  const activeProfile = zones.find(z => z.id === activeZoneId) ?? zones[0] ?? null;
  const zone = activeProfile?.zone ?? null;
  const acList = activeProfile?.ac ?? [];

  const [results, setResults] = useState<SimulationResult | null>(null);
  const [liveData, setLiveData] = useState<LiveTempData | null>(null);
  const [historicalTemps, setHistoricalTemps] = useState<HistoricalTempData | null>(null);
  const [historicalAcOutput, setHistoricalAcOutput] = useState<HistoricalAcOutputData | null>(null);
  const [acBreakdown, setAcBreakdown] = useState<AcBreakdownData | null>(null);
  // Sub-zone metadata fetched from server (names, sensor counts, suggested areas)
  const [availableSubZones, setAvailableSubZones] = useState<SubZoneInfo[]>([]);
  const [designDayData, setDesignDayData] = useState<DesignDayData | null>(null);
  // zoneId → 24-hr temperature array for ALL zones (used for adjacent-zone partition heat transfer)
  const [allZoneTemps, setAllZoneTemps] = useState<Record<string, number[]>>({});
  // zoneId → 24-hr AC electrical output array for ALL zones (used for heat flow diagram AC verdict)
  const [allZoneAcOutputs, setAllZoneAcOutputs] = useState<Record<string, number[]>>({});
  // zoneId → full simulation result for ALL zones (used for zone-independent heat flow diagram)
  const [allZoneResults, setAllZoneResults] = useState<Record<string, SimulationResult>>({});

  // Sensor zone overrides: assetName → array of { zone, from } entries (timestamped moves).
  // e.g. { "Table_3": [{ zone: "Zone 2", from: "2026-03-14" }] }
  // Persisted to zones_config.json via the server.
  const [sensorZoneOverrides, setSensorZoneOverrides] = useState<Record<string, Array<{ zone: string; from: string }>>>({});
  // All sensors across all zones — fetched when the Sensors config section is opened
  const [allLiveSensors, setAllLiveSensors] = useState<AllSensorsData | null>(null);

  // Selected analysis date — defaults to today IST (YYYY-MM-DD)
  const [selectedDate, setSelectedDate] = useState<string>(
    () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  );
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const isToday = selectedDate === todayIST;

  // ── Desk-level average temp (mirrors isDeskSensor logic in ResultsDashboard) ──
  // Uses only occupant-zone sensors for the live Zone Temp card — excludes AC/ceiling
  // sensors that read cold supply air and would pull the average down artificially.
  const deskAvgTemp: number | null = (() => {
    if (!liveData) return null;
    const hasDeskSensors = activeProfile?.hasDeskSensors ?? true;
    if (!hasDeskSensors) return null;
    const sensorPositions = activeProfile?.sensorPositions;
    const deskSensors = liveData.sensors.filter(s => {
      if (sensorPositions) {
        const pos = sensorPositions[s.name];
        if (pos === 'desk') return true;
        if (pos === 'ac_level' || pos === 'exclude') return false;
      }
      // Auto-exclude: reading < 20°C while others avg > 24°C (sensor inside AC duct)
      const otherTemps = liveData.sensors.filter(os => os.name !== s.name).map(os => os.temp);
      const otherAvg = otherTemps.length > 0 ? otherTemps.reduce((a, b) => a + b, 0) / otherTemps.length : 25;
      if (s.temp < 20 && otherAvg > 24) return false;
      // Default: include unless sensor name contains 'ac'
      return !s.name.toLowerCase().includes('ac');
    });
    if (deskSensors.length === 0) return null;
    return deskSensors.reduce((sum, s) => sum + s.temp, 0) / deskSensors.length;
  })();

  useEffect(() => {
    localStorage.setItem('thermozone_v2', JSON.stringify(zones));
    // Debounce file-save to avoid hammering the server on every keystroke
    const timer = setTimeout(() => {
      fetch('http://localhost:3001/api/zones/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zones, sensorZoneOverrides }),
      }).catch(() => { /* server may not be running — silent fail */ });
    }, 800);
    return () => clearTimeout(timer);
  }, [zones, sensorZoneOverrides]);

  // On mount: load zone config from file, then auto-detect AC units from live sensors.
  useEffect(() => {
    (async () => {
      // ── Step 1: load saved zone config (overrides localStorage if present) ──
      let currentZones: ZoneProfile[] = zones; // fallback = localStorage / factory defaults
      try {
        const r = await fetch('http://localhost:3001/api/zones/config');
        if (r.ok) {
          const data = await r.json();
          if (data?.zones && Array.isArray(data.zones) && data.zones.length > 0) {
            currentZones = data.zones.map(migrateProfile);
            setZones(currentZones);
            setActiveZoneId(currentZones[0].id);
          }
          if (data?.sensorZoneOverrides && typeof data.sensorZoneOverrides === 'object') {
            setSensorZoneOverrides(data.sensorZoneOverrides);
          }
        }
      } catch { /* server not running — stay with localStorage */ }

      // ── Step 2: auto-detect AC units from live sensor data ──────────────────
      // Runs for ALL zones. For zones that already have AC entries, new sensors
      // are merged by name (no duplicates). Each detected sensor → one ACUnit
      // with default ratedCapacityWatts: 6200 W, iseer: 3.70 (BEE 3-star). User can adjust
      // these in Configure at any time.
      const liveResults = await Promise.allSettled(
        currentZones.map(z => fetchLiveRoomTemp(z.zone.name))
      );

      let anyDetected = false;
      const zonesWithAc = currentZones.map((zp, idx) => {
        const result = liveResults[idx];
        if (result?.status !== 'fulfilled' || !result.value?.sensors?.length) return zp;

        // Deduplicate by name — don't re-add units already present
        const existingNames = new Set(zp.ac.map(ac => ac.name));
        const newAcs: ACUnit[] = result.value.sensors
          // Only treat as an AC unit if the asset name contains "ac"
          // (case-insensitive). Plain temperature sensors (e.g. "sensor 1",
          // "Table_1") won't match; AC units (e.g. "AC-1", "Split AC Main") will.
          .filter(s => s.name.toLowerCase().includes('ac'))
          .filter(s => !existingNames.has(s.name))
          .map(s => ({
            id:                 `ac-auto-${s.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`,
            name:               s.name,
            ratedCapacityWatts: 6200,  // default — user can override in Configure
            iseer:              3.70,  // BEE 3-star minimum (3.70–3.99) — user can override
            ageYears:           0,
            dbSensorName:       s.name,  // auto-link to the DB sensor by name
            primarySubZones:    [],
            spilloverSubZones:  [],
          }));

        if (newAcs.length === 0) return zp;
        anyDetected = true;
        return { ...zp, ac: [...zp.ac, ...newAcs] };
      });

      if (anyDetected) {
        setZones(zonesWithAc);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem('thermozone_location', JSON.stringify(location));
    const loadWeather = async () => {
      setIsFetchingWeather(true);
      setWeatherError(null);
      const data = await fetchWeatherForDate(location.lat, location.lon, selectedDate);
      if (data) {
        setWeather(data);
      } else {
        setWeatherError("Failed to fetch weather data. Please check the location or try again.");
      }
      setIsFetchingWeather(false);
    };
    loadWeather();
  }, [location, selectedDate]);

  useEffect(() => {
    if (!weather || !zone) return;
    try {
      // Guard: only use DB data when it matches the currently-selected date.
      // Without this check a race condition causes the sim to fire with stale
      // data from the previous date while the new fetch is still in-flight.
      const realTemps = (historicalTemps?.hasData && historicalTemps.date === selectedDate)
        ? historicalTemps.temps
        : null;
      const realAcOutputs = (historicalAcOutput?.hasData && historicalAcOutput.date === selectedDate)
        ? historicalAcOutput.acOutputs
        : null;
      const inventoryItems = activeProfile?.internalLoads;
      // Build adjacent-zone temp map — exclude the active zone itself
      const adjZoneTemps = Object.keys(allZoneTemps).length > 0
        ? Object.fromEntries(Object.entries(allZoneTemps).filter(([id]) => id !== (activeZoneId || zones[0]?.id))) as Record<string, number[]>
        : null;
      const res = calculateHeatLoad(zone, acList, weather, location.lat, location.lon, realTemps, realAcOutputs, inventoryItems, adjZoneTemps);
      setResults(res);
      setWeatherError(null);
    } catch (error) {
      console.error(error);
      setWeatherError("Calculation failed. Please check your zone configuration.");
    }
  // allZoneTemps is intentionally included: when adjacent zone temperatures arrive
  // (async, after first render) the simulation must re-run so zoneTransfers are populated.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone, acList, weather, location, historicalTemps, historicalAcOutput, activeProfile?.internalLoads, allZoneTemps]);

  // Compute simulation for ALL zones using shared weather — makes heat flow diagram zone-independent
  useEffect(() => {
    if (!weather) return;
    const computed: Record<string, SimulationResult> = {};
    for (const zp of zones) {
      try {
        const adjTemps = Object.keys(allZoneTemps).length > 0
          ? Object.fromEntries(Object.entries(allZoneTemps).filter(([id]) => id !== zp.id)) as Record<string, number[]>
          : null;
        // Use actual sensor temps for this zone (same data the chart uses via realTemps)
        // so that wall conduction = U × area × (T_solair − T_indoor) uses the real indoor temp.
        const zoneSensorTemps = (allZoneTemps[zp.id] && allZoneTemps[zp.id].length > 0)
          ? allZoneTemps[zp.id]
          : null;
        // Use real AC output for this zone so heat flow diagram shows accurate acOutputWatts
        const zoneAcOutputs = (allZoneAcOutputs[zp.id] && allZoneAcOutputs[zp.id].length > 0)
          ? allZoneAcOutputs[zp.id]
          : null;
        computed[zp.id] = calculateHeatLoad(
          zp.zone, zp.ac, weather, location.lat, location.lon,
          zoneSensorTemps, zoneAcOutputs,
          zp.internalLoads, adjTemps
        );
      } catch (e) {
        console.warn(`[allZoneResults] sim failed for zone ${zp.id}:`, e);
      }
    }
    setAllZoneResults(computed);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weather, zones, location, allZoneTemps, allZoneAcOutputs]);

  // Fetch hourly real temps and real AC output from DB whenever zone or selected date changes
  useEffect(() => {
    if (!zone?.name) return;
    const loadHistoricalData = async () => {
      const [tempsData, acData, breakdownData] = await Promise.all([
        fetchHistoricalTemps(zone.name, selectedDate),
        fetchHistoricalAcOutput(zone.name, selectedDate),
        fetchAcBreakdown(zone.name, selectedDate),
      ]);
      setHistoricalTemps(tempsData);
      setHistoricalAcOutput(acData);
      setAcBreakdown(breakdownData);
    };
    loadHistoricalData();
  }, [zone?.name, selectedDate]);

  // Fetch sub-zone metadata whenever active zone changes (names, sensor counts, area suggestions)
  useEffect(() => {
    if (!zone?.name) return;
    const totalAreaM2 = zone.walls ? computeFloorArea(zone.walls) : undefined;
    fetchSubZones(zone.name, totalAreaM2).then(data => {
      setAvailableSubZones(data?.subZones ?? []);
    });
  }, [zone?.name]);

  // Fetch design-day temperature once when location changes
  useEffect(() => {
    fetchDesignDayTemp(location.lat, location.lon).then(setDesignDayData);
  }, [location.lat, location.lon]);

  // Fetch temperatures AND AC outputs for ALL zones.
  // Temps → adjacent-zone partition heat transfer + heat flow diagram indoor temps.
  // AC outputs → allZoneResults so heat flow diagram shows real AC output per zone.
  useEffect(() => {
    if (!weather) return;
    const loadAllZoneData = async () => {
      const [tempResults, acResults] = await Promise.all([
        Promise.all(zones.map(z => fetchHistoricalTemps(z.zone.name, selectedDate))),
        Promise.all(zones.map(z => fetchHistoricalAcOutput(z.zone.name, selectedDate))),
      ]);
      const tempMap: Record<string, number[]> = {};
      const acMap: Record<string, number[]> = {};
      zones.forEach((z, i) => {
        const tempData = tempResults[i];
        if (tempData?.hasData && tempData.date === selectedDate) {
          tempMap[z.id] = tempData.temps;
        } else if (z.ac.length === 0) {
          // Unconditioned interior zone: outdoor temp + 4 °C buffer accounts for heat
          // buildup in an enclosed space with no cooling or active ventilation.
          // At night the buffer is reduced to ~1 °C since outdoor temps drop sharply
          // and the space cools along with the ambient.
          tempMap[z.id] = weather.temperature.map((t, h) => {
            const isDay = h >= 8 && h <= 19;
            return t + (isDay ? 4.0 : 1.0);
          });
        }
        // Conditioned zones with no DB data: omit — no partition heat transfer assumed

        const acData = acResults[i];
        if (acData?.hasData && acData.date === selectedDate) {
          acMap[z.id] = acData.acOutputs;
        }
      });
      setAllZoneTemps(tempMap);
      setAllZoneAcOutputs(acMap);
    };
    loadAllZoneData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones.length, selectedDate, weather]);

  const handleLocationSearch = async () => {
    if (!locationInput.trim()) return;
    const data = await searchLocation(locationInput);
    if (data) {
      setLocation(data);
      setLocationInput(data.name);
    }
  };

  useEffect(() => {
    if (!zone?.name) return;
    const loadLiveTemp = async () => {
      const data = await fetchLiveRoomTemp(zone.name);
      setLiveData(data);
    };
    loadLiveTemp();
    const interval = setInterval(loadLiveTemp, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [zone?.name]);

  const updateActiveProfile = (updates: Partial<ZoneProfile>) => {
    const targetId = activeZoneId || zones[0]?.id;
    setZones(prev => prev.map(z => z.id === targetId ? { ...z, ...updates } : z));
  };

  const addNewZone = () => {
    const newId = Date.now().toString();
    const newZoneName = `Zone ${zones.length + 1}`;
    // Use the factory default for this zone number if one exists; otherwise use a blank zone
    const factoryDefault = FACTORY_DEFAULTS.find(d => d.zone.name === newZoneName);
    const knownDisplayName = ZONE_DISPLAY_NAMES[newZoneName];
    const newProfile: ZoneProfile = factoryDefault
      ? { ...factoryDefault, id: newId }                                    // deep-copy factory default, new id
      : { id: newId, zone: { ...DEFAULT_ZONE, name: newZoneName, ...(knownDisplayName ? { displayName: knownDisplayName } : {}) }, ac: [] };
    setZones(prev => [...prev, newProfile]);
    setActiveZoneId(newId);
    setActiveTab('configure'); // go straight to config so user can set up the zone
  };

  // Remove the currently active zone. Requires at least 2 zones to be present.
  const deleteActiveZone = () => {
    if (zones.length <= 1) return;
    const label = activeProfile?.zone.displayName || activeProfile?.zone.name || 'this zone';
    if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return;
    const remaining = zones.filter(z => z.id !== activeZoneId);
    setZones(remaining);
    setActiveZoneId(remaining[0].id);
  };

  // Reset the active zone back to its hardcoded factory default.
  // Picks the correct default based on zone name; preserves the zone's id.
  const ZONE_DEFAULTS: Record<string, ZoneProfile> = {
    'Zone 1': DEFAULT_ZONE1,
    'Zone 2': DEFAULT_ZONE2,
    'Zone 3': DEFAULT_ZONE3,
    'Zone 4': DEFAULT_ZONE4,
  };
  const resetZoneToDefault = () => {
    const zoneName = activeProfile?.zone.name ?? 'this zone';
    const defaultConfig = ZONE_DEFAULTS[zoneName] ?? DEFAULT_ZONE1;
    if (!window.confirm(
      `Reset "${zoneName}" to factory defaults?\n\n` +
      `All wall, AC and internal-load edits for this zone will be replaced with the ` +
      `original ${zoneName} configuration. This cannot be undone.`
    )) return;
    const targetId = activeZoneId || zones[0]?.id;
    setZones(prev => prev.map(z =>
      z.id === targetId
        ? { ...defaultConfig, id: z.id }   // keep the same id, restore everything else
        : z
    ));
  };

  // --- Wall Modal Handlers ---
  const openAddWallModal = () => setWallModal({ ...DEFAULT_WALL_MODAL, isOpen: true });

  const openEditWallModal = (wall: WallDef) => {
    setWallModal({
      isOpen: true,
      editingId: wall.id,
      lengthM: wall.lengthM,
      direction: wall.direction,
      wallType: wall.wallType,
      constructionType: wall.constructionType,
      adjacentZoneId: wall.adjacentZoneId || '',
      windows: (wall.windows || []).map(w => ({
        id: w.id,
        areaM2: w.areaM2,
        obstructionHeightM: w.obstructionHeightM,
        obstructionDistanceM: w.obstructionDistanceM,
        obstructionWidthM: w.obstructionWidthM,
      })),
      glassAreaM2: wall.glassAreaM2 || 0,
    });
  };

  const closeWallModal = () => setWallModal(DEFAULT_WALL_MODAL);

  const saveWall = () => {
    const { editingId, lengthM, direction, wallType, constructionType, adjacentZoneId, windows, glassAreaM2 } = wallModal;
    const wallData: WallDef = {
      id: editingId || Date.now().toString(),
      lengthM,
      direction,
      azimuth: AZIMUTH_MAP[direction],
      wallType,
      constructionType,
      adjacentZoneId: wallType === 'internal' && adjacentZoneId ? adjacentZoneId : undefined,
      windows: constructionType === 'mixed' && wallType === 'external' ? windows.map(w => ({
      id: w.id,
      areaM2: w.areaM2,
      ...(w.obstructionHeightM != null ? { obstructionHeightM: w.obstructionHeightM } : {}),
      ...(w.obstructionDistanceM != null ? { obstructionDistanceM: w.obstructionDistanceM } : {}),
      ...(w.obstructionWidthM != null ? { obstructionWidthM: w.obstructionWidthM } : {}),
    })) : undefined,
      glassAreaM2: constructionType === 'mixed' && wallType === 'internal' ? glassAreaM2 : undefined,
    };
    const currentWalls = zone.walls || [];
    const newWalls = editingId
      ? currentWalls.map(w => w.id === editingId ? wallData : w)
      : [...currentWalls, wallData];
    updateActiveProfile({ zone: { ...zone, walls: newWalls } });
    closeWallModal();
  };

  const removeWall = (id: string) => {
    updateActiveProfile({ zone: { ...zone, walls: (zone.walls || []).filter(w => w.id !== id) } });
  };

  const addModalWindow = () => {
    setWallModal(prev => ({ ...prev, windows: [...prev.windows, { id: Date.now().toString(), areaM2: 1 }] }));
  };

  const updateModalWindow = (id: string, updates: Partial<EmbeddedWindow>) => {
    setWallModal(prev => ({ ...prev, windows: prev.windows.map(w => w.id === id ? { ...w, ...updates } : w) }));
  };

  const removeModalWindow = (id: string) => {
    setWallModal(prev => ({ ...prev, windows: prev.windows.filter(w => w.id !== id) }));
  };

  // --- AC Handlers ---
  const addAC = () => {
    const newAC: ACUnit = {
      id: Date.now().toString(), name: 'New AC', ratedCapacityWatts: 3500, iseer: 3.70, ageYears: 0,
      dbSensorName: '', primarySubZones: [], spilloverSubZones: [],
    };
    updateActiveProfile({ ac: [...acList, newAC] });
  };

  const updateAC = (id: string, field: keyof ACUnit, value: string | number) => {
    updateActiveProfile({ ac: acList.map(ac => ac.id === id ? { ...ac, [field]: value } : ac) });
  };

  const removeAC = (id: string) => {
    updateActiveProfile({ ac: acList.filter(ac => ac.id !== id) });
  };

  // Update a sub-zone's area (or add it if not yet in the list)
  const updateSubZone = (subZoneName: string, areaM2: number) => {
    const current = zone?.subZones || [];
    const exists = current.some(sz => sz.name === subZoneName);
    const updated: SubZoneConfig[] = exists
      ? current.map(sz => sz.name === subZoneName ? { ...sz, areaM2 } : sz)
      : [...current, { name: subZoneName, areaM2 }];
    updateActiveProfile({ zone: { ...zone!, subZones: updated } });
  };

  // Toggle a sub-zone in an AC's primarySubZones list
  const togglePrimarySubZone = (acId: string, subZoneName: string) => {
    updateActiveProfile({
      ac: acList.map(ac => {
        if (ac.id !== acId) return ac;
        const current = ac.primarySubZones || [];
        const updated = current.includes(subZoneName)
          ? current.filter(s => s !== subZoneName)
          : [...current, subZoneName];
        return { ...ac, primarySubZones: updated };
      }),
    });
  };

  // Toggle a sub-zone in an AC's spilloverSubZones list
  const toggleSpilloverSubZone = (acId: string, subZoneName: string) => {
    updateActiveProfile({
      ac: acList.map(ac => {
        if (ac.id !== acId) return ac;
        const current = ac.spilloverSubZones || [];
        const updated = current.includes(subZoneName)
          ? current.filter(s => s !== subZoneName)
          : [...current, subZoneName];
        return { ...ac, spilloverSubZones: updated };
      }),
    });
  };

  // Compute coverage type for a sub-zone based on current AC assignments
  const getSubZoneCoverageType = (subZoneName: string): 'direct' | 'spillover' | 'none' => {
    if (acList.some(ac => (ac.primarySubZones || []).includes(subZoneName))) return 'direct';
    if (acList.some(ac => (ac.spilloverSubZones || []).includes(subZoneName))) return 'spillover';
    return 'none';
  };

  const totalAcCapacityWatts = acList.reduce((s, a) => s + a.ratedCapacityWatts, 0);

  // --- Internal Load Handlers ---
  const internalLoadItems: InternalLoadItem[] = activeProfile?.internalLoads ?? [];

  const addInternalLoadItem = () => {
    const newItem: InternalLoadItem = {
      id: Date.now().toString(),
      label: 'New Item',
      category: 'equipment',
      count: 1,
      wattsPerUnit: 100,
      schedulePreset: 'office_equipment',
    };
    updateActiveProfile({ internalLoads: [...internalLoadItems, newItem] });
  };

  const updateInternalLoadItem = (id: string, field: keyof InternalLoadItem, value: string | number) => {
    updateActiveProfile({
      internalLoads: internalLoadItems.map(item =>
        item.id === id ? { ...item, [field]: value } : item
      ),
    });
  };

  const removeInternalLoadItem = (id: string) => {
    updateActiveProfile({ internalLoads: internalLoadItems.filter(item => item.id !== id) });
  };

  // --- Sensor Position Handlers ---
  const saveSensorPosition = (sensorName: string, level: SensorLevel) => {
    setZones(prev => prev.map(zp =>
      zp.id === activeZoneId
        ? { ...zp, sensorPositions: { ...(zp.sensorPositions ?? {}), [sensorName]: level } }
        : zp
    ));
  };

  // --- Sensor Zone Override Handlers ---
  const moveSensor = (assetName: string, toZone: string | null) => {
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    setSensorZoneOverrides(prev => {
      const next = { ...prev };
      if (toZone === null) {
        delete next[assetName]; // reset — removes all move history for this sensor
      } else {
        const existing = next[assetName] || [];
        // Replace any existing entry for today (idempotent if user changes dropdown multiple times today)
        const filtered = existing.filter(e => e.from !== todayIST);
        next[assetName] = [...filtered, { zone: toZone, from: todayIST }];
      }
      return next;
    });
  };

  // Helper: get the currently effective zone for a sensor (most recent entry ≤ today)
  const effectiveZoneForSensor = (assetName: string, naturalZone: string): string => {
    const entries = sensorZoneOverrides[assetName];
    if (!entries || entries.length === 0) return naturalZone;
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const applicable = entries
      .filter(e => e.from <= todayIST)
      .sort((a, b) => b.from.localeCompare(a.from))[0];
    return applicable ? applicable.zone : naturalZone;
  };

  // --- Wall display helpers ---
  const getWallSummary = (wall: WallDef) => {
    const faceArea = wall.lengthM * (zone?.ceilingHeightM ?? 2.7);
    if (wall.constructionType === 'full_glass') return { faceArea, glassArea: faceArea, solidArea: 0 };
    if (wall.constructionType === 'mixed') {
      if (wall.wallType === 'external') {
        const winArea = (wall.windows || []).reduce((s, w) => s + w.areaM2, 0);
        return { faceArea, glassArea: winArea, solidArea: Math.max(0, faceArea - winArea) };
      } else {
        const glass = wall.glassAreaM2 || 0;
        return { faceArea, glassArea: glass, solidArea: Math.max(0, faceArea - glass) };
      }
    }
    return { faceArea, glassArea: 0, solidArea: faceArea };
  };

  const getConstructionLabel = (wall: WallDef) => {
    if (wall.wallType === 'external') {
      if (wall.constructionType === 'opaque') return 'Solid Concrete';
      if (wall.constructionType === 'mixed') return `Concrete + ${(wall.windows || []).length} Window(s)`;
      if (wall.constructionType === 'full_glass') return 'Full Glass Facade';
    } else {
      if (wall.constructionType === 'opaque') return 'Concrete Partition';
      if (wall.constructionType === 'mixed') return 'Mixed Partition';
      if (wall.constructionType === 'full_glass') return 'Glass Partition';
    }
    return '';
  };

  // --- Modal derived values ---
  const modalFaceArea = wallModal.lengthM * (zone?.ceilingHeightM ?? 2.7);
  const modalGlassArea = (() => {
    if (wallModal.constructionType === 'full_glass') return modalFaceArea;
    if (wallModal.constructionType === 'mixed') {
      if (wallModal.wallType === 'external') return wallModal.windows.reduce((s, w) => s + w.areaM2, 0);
      return wallModal.glassAreaM2;
    }
    return 0;
  })();
  const modalSolidArea = Math.max(0, modalFaceArea - modalGlassArea);

  const otherZones = zones.filter(z => z.id !== activeZoneId);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 pb-20 font-inter">

      {/* ── Wall Modal ── */}
      {wallModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl">

            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-slate-800 sticky top-0 bg-slate-900 z-10">
              <h2 className="text-lg font-bold text-white">
                {wallModal.editingId ? 'Edit Wall' : 'Add Wall'}
              </h2>
              <button onClick={closeWallModal} className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors">
                <X size={20} />
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Length */}
              <InputField
                label="Wall Length"
                value={wallModal.lengthM}
                unit="m"
                onChange={(v) => setWallModal(prev => ({ ...prev, lengthM: v as number }))}
              />

              {/* Direction */}
              <div className="flex flex-col gap-2">
                <label className="text-xs text-slate-400 uppercase font-semibold">Direction</label>
                <div className="grid grid-cols-4 gap-2">
                  {Object.keys(AZIMUTH_MAP).map(dir => (
                    <button
                      key={dir}
                      onClick={() => setWallModal(prev => ({ ...prev, direction: dir as Direction }))}
                      className={`py-2 text-sm font-bold rounded-lg border transition-all ${wallModal.direction === dir ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'}`}
                    >
                      {dir}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-500">Azimuth: {AZIMUTH_MAP[wallModal.direction]}°</p>
                {wallModal.wallType === 'internal' && wallModal.adjacentZoneId && (() => {
                  const adjZone = zones.find(z => z.id === wallModal.adjacentZoneId);
                  const oppDir = OPPOSITE_DIR[wallModal.direction];
                  return adjZone && oppDir ? (
                    <p className="text-xs text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2 mt-1">
                      ↔ In <span className="font-semibold">{adjZone.zone.name}</span>, this shared wall faces <span className="font-semibold">{oppDir}</span> — enter it as {oppDir} when configuring that zone.
                    </p>
                  ) : null;
                })()}
              </div>

              {/* Wall Type */}
              <div className="flex flex-col gap-2">
                <label className="text-xs text-slate-400 uppercase font-semibold">Wall Type</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['external', 'internal'] as const).map(type => (
                    <button
                      key={type}
                      onClick={() => setWallModal(prev => ({ ...prev, wallType: type, constructionType: 'opaque' }))}
                      className={`py-2.5 text-sm font-semibold rounded-lg border capitalize transition-all ${wallModal.wallType === type ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'}`}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </div>

              {/* Adjacent Zone (internal only) */}
              {wallModal.wallType === 'internal' && (
                <div className="flex flex-col gap-2">
                  <label className="text-xs text-slate-400 uppercase font-semibold">Adjacent Zone</label>
                  {otherZones.length === 0 ? (
                    <p className="text-xs text-yellow-500 bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3">
                      No other zones yet. Add more zones from the header to link internal walls.
                    </p>
                  ) : (
                    <select
                      value={wallModal.adjacentZoneId}
                      onChange={(e) => setWallModal(prev => ({ ...prev, adjacentZoneId: e.target.value }))}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-3 text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                    >
                      <option value="">— Select adjacent zone —</option>
                      {otherZones.map(z => (
                        <option key={z.id} value={z.id}>{z.zone.name}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {/* Construction Type */}
              <div className="flex flex-col gap-2">
                <label className="text-xs text-slate-400 uppercase font-semibold">Construction Type</label>
                <div className="space-y-2">
                  {(wallModal.wallType === 'external'
                    ? [
                        { value: 'opaque',     label: 'Solid Concrete',       desc: 'No glazing' },
                        { value: 'mixed',      label: 'Concrete + Windows',   desc: 'Partial glazing' },
                        { value: 'full_glass', label: 'Full Glass Facade',    desc: 'Entire wall is glass' },
                      ]
                    : [
                        { value: 'opaque',     label: 'Full Concrete Partition', desc: 'Solid wall' },
                        { value: 'mixed',      label: 'Mixed (Glass + Concrete)', desc: 'Partial glass panel' },
                        { value: 'full_glass', label: 'Full Glass Partition',     desc: 'Entire wall is glass' },
                      ]
                  ).map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setWallModal(prev => ({ ...prev, constructionType: opt.value as ConstructionType }))}
                      className={`w-full text-left px-4 py-3 rounded-lg border transition-all ${wallModal.constructionType === opt.value ? 'bg-blue-600/20 border-blue-500 text-white' : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'}`}
                    >
                      <span className="font-semibold text-sm">{opt.label}</span>
                      <span className="ml-2 text-xs text-slate-500">{opt.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Windows list (external + mixed) */}
              {wallModal.wallType === 'external' && wallModal.constructionType === 'mixed' && (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-slate-400 uppercase font-semibold">Windows</label>
                    <button
                      onClick={addModalWindow}
                      className="flex items-center gap-1 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors"
                    >
                      <Plus size={12} /> Add Window
                    </button>
                  </div>
                  {wallModal.windows.length === 0 && (
                    <p className="text-xs text-slate-500 text-center py-3 border border-dashed border-slate-800 rounded-lg">
                      No windows added. Click "Add Window" to define glazing.
                    </p>
                  )}
                  {wallModal.windows.map((win, idx) => {
                    const obstrH = win.obstructionHeightM;
                    const obstrD = win.obstructionDistanceM;
                    const obstrW = win.obstructionWidthM;
                    const hasObstruction = obstrH != null && obstrD != null && obstrD > 0;
                    const obstrAngleDeg = hasObstruction ? Math.atan2(obstrH!, obstrD!) * 180 / Math.PI : null;
                    const svf = obstrAngleDeg != null ? (1 + Math.cos(obstrAngleDeg * Math.PI / 180)) / 2 : null;
                    return (
                      <div key={win.id} className="bg-slate-950/50 border border-slate-800 rounded-lg p-3 space-y-3">
                        {/* Row 1: area + delete */}
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-slate-500 w-16 shrink-0">Window {idx + 1}</span>
                          <div className="flex-1 relative">
                            <input
                              type="number"
                              value={win.areaM2}
                              onChange={(e) => updateModalWindow(win.id, { areaM2: Number(e.target.value) })}
                              className="w-full bg-slate-900 border border-slate-700 rounded-lg py-1.5 px-3 pr-10 text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                            />
                            <span className="absolute right-3 top-1.5 text-slate-500 text-xs">m²</span>
                          </div>
                          <button onClick={() => removeModalWindow(win.id)} className="text-slate-600 hover:text-red-500 transition-colors">
                            <Trash2 size={14} />
                          </button>
                        </div>
                        {/* Row 2: obstruction fields */}
                        <div className="pl-16 space-y-2">
                          <p className="text-[10px] text-slate-500 uppercase font-semibold tracking-wider">External Obstruction (optional)</p>
                          <div className="grid grid-cols-3 gap-2">
                            <div className="relative">
                              <input
                                type="number"
                                min={0}
                                step={0.1}
                                value={win.obstructionHeightM ?? ''}
                                placeholder="e.g. 4.0"
                                onChange={(e) => updateModalWindow(win.id, { obstructionHeightM: e.target.value === '' ? undefined : Number(e.target.value) })}
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg py-1.5 px-2 pr-6 text-white placeholder-slate-600 focus:ring-2 focus:ring-blue-500 outline-none text-xs"
                              />
                              <span className="absolute right-1.5 top-1.5 text-slate-500 text-[10px]">H</span>
                            </div>
                            <div className="relative">
                              <input
                                type="number"
                                min={0.1}
                                step={0.1}
                                value={win.obstructionDistanceM ?? ''}
                                placeholder="e.g. 8.0"
                                onChange={(e) => updateModalWindow(win.id, { obstructionDistanceM: e.target.value === '' ? undefined : Number(e.target.value) })}
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg py-1.5 px-2 pr-6 text-white placeholder-slate-600 focus:ring-2 focus:ring-blue-500 outline-none text-xs"
                              />
                              <span className="absolute right-1.5 top-1.5 text-slate-500 text-[10px]">D</span>
                            </div>
                            <div className="relative">
                              <input
                                type="number"
                                min={0}
                                step={0.1}
                                value={win.obstructionWidthM ?? ''}
                                placeholder="optional"
                                onChange={(e) => updateModalWindow(win.id, { obstructionWidthM: e.target.value === '' ? undefined : Number(e.target.value) })}
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg py-1.5 px-2 pr-6 text-white placeholder-slate-600 focus:ring-2 focus:ring-blue-500 outline-none text-xs"
                              />
                              <span className="absolute right-1.5 top-1.5 text-slate-500 text-[10px]">W</span>
                            </div>
                          </div>
                          <p className="text-[10px] text-slate-600">H = obstruction height (m) · D = distance (m) · W = width (m, optional)</p>
                          {hasObstruction && obstrAngleDeg != null && svf != null && (
                            <p className="text-[10px] text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded px-2 py-1">
                              Obstruction angle: {obstrAngleDeg.toFixed(1)}° · SVF: {svf.toFixed(2)} · Diffuse reduced by {((1 - svf) * 100).toFixed(0)}%
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Glass area (internal + mixed) */}
              {wallModal.wallType === 'internal' && wallModal.constructionType === 'mixed' && (
                <InputField
                  label="Glass Panel Area"
                  value={wallModal.glassAreaM2}
                  unit="m²"
                  onChange={(v) => setWallModal(prev => ({ ...prev, glassAreaM2: v as number }))}
                />
              )}

              {/* Area Summary */}
              <div className="bg-slate-950/50 border border-slate-800 rounded-xl p-4">
                <p className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-3">Wall Area Summary</p>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-xs text-slate-500">Face Area</p>
                    <p className="text-base font-mono font-bold text-white">{modalFaceArea.toFixed(2)}<span className="text-xs text-slate-500"> m²</span></p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Glass Area</p>
                    <p className="text-base font-mono font-bold text-blue-400">{modalGlassArea.toFixed(2)}<span className="text-xs text-slate-500"> m²</span></p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Solid Area</p>
                    <p className="text-base font-mono font-bold text-slate-300">{modalSolidArea.toFixed(2)}<span className="text-xs text-slate-500"> m²</span></p>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 p-6 border-t border-slate-800 sticky bottom-0 bg-slate-900">
              <button onClick={closeWallModal} className="px-5 py-2.5 text-sm font-medium text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors">
                Cancel
              </button>
              <button onClick={saveWall} className="px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors shadow-lg shadow-blue-900/30">
                {wallModal.editingId ? 'Save Changes' : 'Add Wall'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <header className="bg-slate-900 border-b border-slate-800 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="text-blue-500" />
            <h1 className="text-xl font-bold tracking-tight text-white hidden sm:block">Living Things - ThermoZone <span className="text-blue-500">Analyst</span></h1>
          </div>

          <div className="flex items-center gap-4">
            {/* Location Input */}
            <div className="hidden md:flex items-center gap-2 bg-slate-800 rounded-lg p-1 px-2 border border-slate-700">
              <Map size={14} className="text-slate-400" />
              <input
                type="text"
                value={locationInput}
                onChange={(e) => setLocationInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLocationSearch()}
                placeholder="Enter city..."
                className="bg-transparent text-white text-xs outline-none w-48"
              />
              {isFetchingWeather ? (
                <div className="animate-spin h-3 w-3 border-2 border-blue-500 border-t-transparent rounded-full"></div>
              ) : (
                <button onClick={handleLocationSearch} className="text-slate-400 hover:text-white">
                  <Plus size={14} />
                </button>
              )}
            </div>

            {/* Zone Selector */}
            <div className="flex items-center gap-2 bg-slate-800 rounded-lg p-1">
              <select
                value={activeZoneId}
                onChange={(e) => setActiveZoneId(e.target.value)}
                className="bg-transparent text-white text-sm outline-none px-2 py-1 cursor-pointer"
              >
                {zones.map(z => (
                  <option key={z.id} value={z.id}>{z.zone.displayName || z.zone.name}</option>
                ))}
              </select>
              <button onClick={addNewZone} className="text-blue-400 hover:text-white px-2" title="Add New Zone"><Plus size={16} /></button>
              {zones.length > 1 && (
                <button onClick={deleteActiveZone} className="text-red-400 hover:text-red-300 px-1" title="Remove this zone"><Trash2 size={14} /></button>
              )}
            </div>

            <div className="h-6 w-px bg-slate-700 hidden sm:block"></div>

            <div className="flex gap-2">
              {(['monitor', 'configure'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition-all capitalize ${activeTab === tab ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/50' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 mt-8">

        {/* ── Empty state — no zones yet ── */}
        {zones.length === 0 && (
          <div className="flex flex-col items-center justify-center py-32 text-center gap-6">
            <div className="p-5 bg-slate-800 rounded-full">
              <LayoutGrid className="text-blue-400" size={40} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white mb-2">No zones configured</h2>
              <p className="text-slate-400 text-sm">Click the <span className="text-blue-400 font-semibold">+</span> button in the header to add your first zone.</p>
            </div>
          </div>
        )}

        {zones.length > 0 && (<>

        {weatherError && (
          <div className="mb-6 p-4 bg-red-900/30 border border-red-700 rounded-xl text-red-300 text-sm">
            {weatherError}
          </div>
        )}

        {/* ── Sensor Strip ── */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-2xl p-4 mb-8 flex flex-col md:flex-row items-center justify-between backdrop-blur-sm gap-4">
          <div className="flex items-center gap-6 w-full md:w-auto justify-center md:justify-start flex-wrap">

            <div className="flex items-center gap-3">
              <div className="p-2 bg-slate-800 rounded-full">
                <Thermometer className="text-orange-500" size={24} />
              </div>
              <div>
                <p className="text-xs text-slate-400 uppercase tracking-wider">
                  Zone Temp
                  {liveData && (() => {
                    const maxAge = Math.max(...liveData.sensors.map(s => s.ageMinutes ?? 0));
                    const anyStale = liveData.sensors.some(s => s.isStale);
                    if (anyStale) return (
                      <span className="ml-2 text-amber-400 normal-case font-normal"
                        title={`Sensor data is ${Math.round(maxAge / 60)}h old — device may have stopped reporting`}>
                        ⚠ Stale ({Math.round(maxAge / 60)}h old)
                      </span>
                    );
                    return <span className="ml-2 text-green-400 normal-case font-normal">● Live</span>;
                  })()}
                  {!liveData && <span className="ml-2 text-slate-500 normal-case font-normal">No sensor data</span>}
                  {deskAvgTemp != null && <span className="ml-2 text-cyan-400 normal-case font-normal">· desk sensors</span>}
                  {historicalTemps?.hasData && <span className="ml-2 text-blue-400 normal-case font-normal">· DB temps active</span>}
                  {historicalAcOutput?.hasData && <span className="ml-2 text-purple-400 normal-case font-normal">· DB AC active</span>}
                </p>
                <p className="text-2xl font-mono font-bold text-white">
                  {deskAvgTemp != null ? `${deskAvgTemp.toFixed(1)}°C` : liveData ? `${liveData.avgTemp.toFixed(1)}°C` : '—'}
                </p>
                {(() => {
                  const setpoint = liveData?.sensors.find(s => s.setpoint != null)?.setpoint ?? null;
                  if (setpoint == null || !liveData) return null;
                  const displayTemp = deskAvgTemp ?? liveData.avgTemp;
                  const delta = displayTemp - setpoint;
                  const deltaColor = delta <= 1 ? 'text-green-400' : delta <= 3 ? 'text-yellow-400' : 'text-red-400';
                  return (
                    <p className="text-xs mt-0.5">
                      <span className="text-slate-400">Setpoint </span>
                      <span className="text-white font-mono font-semibold">{setpoint}°C</span>
                      <span className={`ml-2 font-mono font-semibold ${deltaColor}`}>
                        {delta > 0 ? `+${delta.toFixed(1)}° above` : delta < -0.5 ? `${delta.toFixed(1)}° below` : '≈ at setpoint'}
                      </span>
                    </p>
                  );
                })()}
              </div>
            </div>


          </div>

          {liveData && (
            <div className="text-[10px] text-slate-600 text-right shrink-0">
              Last updated<br />
              {new Date(liveData.lastUpdated).toLocaleTimeString()}
            </div>
          )}
        </div>

        {/* ── CONFIGURE TAB ── */}
        {activeTab === 'configure' && (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-8 animate-fade-in">
            <div className="lg:col-span-1 space-y-2">
              {[
                { id: 'zone',     label: 'Zone Metadata',    icon: Server     },
                { id: 'ac',       label: 'AC Specification', icon: Wind       },
                { id: 'internal', label: 'Internal Loads',   icon: Flame      },
                { id: 'sensors',  label: 'Sensor Zones',     icon: Map        },
              ].map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    setConfigSection(item.id as 'zone' | 'ac' | 'internal' | 'sensors');
                    if (item.id === 'sensors') {
                      fetchAllLiveSensors().then(d => { if (d) setAllLiveSensors(d); });
                    }
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${configSection === item.id ? 'bg-slate-800 border border-slate-700 text-white' : 'text-slate-400 hover:bg-slate-900'}`}
                >
                  <item.icon size={18} className={configSection === item.id ? 'text-blue-500' : 'text-slate-500'} />
                  <span className="font-medium">{item.label}</span>
                </button>
              ))}
            </div>

            <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-2xl p-6 min-h-[500px]">

              {/* ── ZONE SECTION ── */}
              {configSection === 'zone' && (
                <div className="space-y-8">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-4">
                      <InputField label="Zone Label" value={zone.displayName || zone.name} onChange={(v) => updateActiveProfile({ zone: { ...zone, displayName: v as string } })} type="text" />
                      <InputField label="Ceiling Height" value={zone.ceilingHeightM} unit="m" onChange={(v) => updateActiveProfile({ zone: { ...zone, ceilingHeightM: v as number } })} />

                      <div className="flex items-center justify-between p-4 bg-slate-950/50 rounded-xl border border-slate-800">
                        <div className="flex items-center gap-3">
                          <div className="p-2 bg-slate-800 rounded-lg">
                            <Server className="text-blue-400" size={18} />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-white">Top Floor Room</p>
                            <p className="text-xs text-slate-500">Enable roof heat gain calculation</p>
                          </div>
                        </div>
                        <button
                          onClick={() => updateActiveProfile({ zone: { ...zone, isTopFloor: !zone.isTopFloor } })}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${zone.isTopFloor ? 'bg-blue-600' : 'bg-slate-700'}`}
                        >
                          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${zone.isTopFloor ? 'translate-x-6' : 'translate-x-1'}`} />
                        </button>
                      </div>
                    </div>

                    <div className="bg-slate-950/30 rounded-2xl border border-slate-800 p-6 flex flex-col justify-center gap-6">
                      <div className="text-center">
                        <p className="text-xs text-slate-500 uppercase font-bold tracking-widest mb-1">Computed Floor Area</p>
                        <p className="text-4xl font-mono font-bold text-white">{(results?.data[0]?._areaM2 || 0).toFixed(2)} <span className="text-lg font-normal text-slate-500">m²</span></p>
                        <p className="text-[10px] text-slate-500 mt-1 uppercase tracking-tighter italic">Calculated via Shoelace Method</p>
                      </div>
                      <div className="h-px bg-slate-800 w-1/2 mx-auto"></div>
                      <div className="text-center">
                        <p className="text-xs text-slate-500 uppercase font-bold tracking-widest mb-1">Computed Room Volume</p>
                        <p className="text-4xl font-mono font-bold text-white">{(results?.data[0]?._areaM2 ? results.data[0]._areaM2 * zone.ceilingHeightM : 0).toFixed(2)} <span className="text-lg font-normal text-slate-500">m³</span></p>
                      </div>
                    </div>
                  </div>

                  {/* ── Danger zone — delete this zone ── */}
                  {zones.length > 1 && (
                    <div className="border border-red-900/40 bg-red-950/20 rounded-xl p-4 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-red-400">Delete Zone</p>
                        <p className="text-xs text-slate-500 mt-0.5">Permanently removes <span className="text-white font-medium">{zone.displayName || zone.name}</span> and all its configuration.</p>
                      </div>
                      <button
                        onClick={deleteActiveZone}
                        className="flex items-center gap-2 text-xs bg-red-900/30 hover:bg-red-800/50 text-red-400 hover:text-red-300 border border-red-800/50 px-4 py-2 rounded-lg transition-colors"
                      >
                        <Trash2 size={14} /> Delete Zone
                      </button>
                    </div>
                  )}

                  {/* ── Sub-Zones ── */}
                  {availableSubZones.length > 1 && (
                    <div className="border-t border-slate-800 pt-8">
                      <div className="mb-4">
                        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                          <LayoutGrid size={20} className="text-purple-400" />
                          Sub-Zones
                        </h3>
                        <p className="text-xs text-slate-500 mt-1">
                          Enter the floor area for each sub-zone. Used to compute per-AC heat load.
                        </p>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {availableSubZones.map(sz => {
                          const saved = (zone.subZones || []).find(s => s.name === sz.name);
                          const coverageType = getSubZoneCoverageType(sz.name);
                          const coverageBadge =
                            coverageType === 'direct'   ? { label: 'Direct',   cls: 'bg-green-500/10 text-green-400 border-green-500/20' } :
                            coverageType === 'spillover' ? { label: 'Spillover', cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' } :
                            { label: 'No AC', cls: 'bg-red-500/10 text-red-400 border-red-500/20' };
                          return (
                            <div key={sz.name} className="bg-slate-950/50 border border-slate-800 p-4 rounded-xl space-y-3">
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-medium text-white">{sz.name}</span>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-slate-500">{sz.sensorCount} sensor{sz.sensorCount !== 1 ? 's' : ''}</span>
                                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${coverageBadge.cls}`}>{coverageBadge.label}</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="flex-1">
                                  <label className="text-xs text-slate-400 uppercase font-semibold">Floor Area</label>
                                  <div className="relative mt-1">
                                    <input
                                      type="number"
                                      value={saved?.areaM2 != null && saved.areaM2 > 0 ? saved.areaM2 : ''}
                                      placeholder={sz.suggestedAreaM2 > 0 ? String(sz.suggestedAreaM2) : '0'}
                                      onChange={e => updateSubZone(sz.name, Number(e.target.value))}
                                      className="w-full bg-slate-900 border border-slate-700 rounded-lg py-2 px-3 text-white placeholder-slate-600 focus:ring-2 focus:ring-purple-500 outline-none text-sm"
                                    />
                                    <span className="absolute right-3 top-2 text-slate-500 text-xs">m²</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* ── Walls ── */}
                  <div className="border-t border-slate-800 pt-8">
                    <div className="flex justify-between items-center mb-6">
                      <div>
                        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                          <LayoutGrid size={20} className="text-blue-400" />
                          Room Geometry (Walls)
                        </h3>
                        <p className="text-xs text-slate-500 mt-1">Define walls sequentially to build the room perimeter.</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={resetZoneToDefault}
                          title="Reset this zone to factory default configuration"
                          className="flex items-center gap-2 text-xs text-slate-400 hover:text-orange-300 border border-slate-700 hover:border-orange-700 px-3 py-2 rounded-lg transition-colors"
                        >
                          <RotateCcw size={14} /> Reset to Default
                        </button>
                        <button
                          onClick={openAddWallModal}
                          className="flex items-center gap-2 text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg transition-colors shadow-lg shadow-blue-900/20"
                        >
                          <Plus size={16} /> Add Wall
                        </button>
                      </div>
                    </div>

                    {(zone.walls || []).length === 0 ? (
                      <div className="py-12 border-2 border-dashed border-slate-800 rounded-2xl flex flex-col items-center justify-center text-slate-500">
                        <LayoutGrid size={40} className="mb-3 opacity-20" />
                        <p>No walls defined for this zone.</p>
                        <button onClick={openAddWallModal} className="mt-4 text-blue-400 hover:text-blue-300 text-sm font-medium">Click to add your first wall</button>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {(zone.walls || []).map((wall, idx) => {
                          const summary = getWallSummary(wall);
                          const adjZone = wall.adjacentZoneId ? zones.find(z => z.id === wall.adjacentZoneId) : null;
                          return (
                            <div key={wall.id} className="bg-slate-950/50 border border-slate-800 p-4 rounded-xl hover:border-slate-700 transition-colors">
                              <div className="flex items-start justify-between mb-3">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-[10px] font-bold bg-slate-800 text-slate-400 px-2 py-0.5 rounded border border-slate-700">Wall {idx + 1}</span>
                                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${wall.wallType === 'external' ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20' : 'bg-purple-500/10 text-purple-400 border border-purple-500/20'}`}>
                                    {wall.wallType === 'external' ? 'External' : 'Internal'}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <button onClick={() => openEditWallModal(wall)} className="text-slate-500 hover:text-blue-400 p-1.5 rounded-lg hover:bg-slate-800 transition-all" title="Edit wall">
                                    <Pencil size={14} />
                                  </button>
                                  <button onClick={() => removeWall(wall.id)} className="text-slate-500 hover:text-red-500 p-1.5 rounded-lg hover:bg-slate-800 transition-all" title="Remove wall">
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </div>

                              <div className="space-y-1.5 text-sm">
                                <div className="flex justify-between">
                                  <span className="text-slate-400">Length</span>
                                  <span className="font-mono text-white font-semibold">{wall.lengthM} m</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-slate-400">Direction</span>
                                  <span className="font-mono text-blue-400 font-semibold">{wall.direction} ({wall.azimuth}°)</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-slate-400">Construction</span>
                                  <span className="text-white text-xs font-medium">{getConstructionLabel(wall)}</span>
                                </div>
                                {adjZone && (
                                  <div className="flex justify-between">
                                    <span className="text-slate-400">Adjacent</span>
                                    <span className="text-purple-400 text-xs font-medium">{adjZone.zone.name}</span>
                                  </div>
                                )}
                                <div className="mt-2 pt-2 border-t border-slate-800/50 grid grid-cols-3 gap-2 text-center">
                                  <div>
                                    <p className="text-[10px] text-slate-600">Face</p>
                                    <p className="text-xs font-mono text-slate-300">{summary.faceArea.toFixed(1)} m²</p>
                                  </div>
                                  <div>
                                    <p className="text-[10px] text-slate-600">Glass</p>
                                    <p className="text-xs font-mono text-blue-400">{summary.glassArea.toFixed(1)} m²</p>
                                  </div>
                                  <div>
                                    <p className="text-[10px] text-slate-600">Solid</p>
                                    <p className="text-xs font-mono text-slate-300">{summary.solidArea.toFixed(1)} m²</p>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── AC SECTION ── */}
              {configSection === 'ac' && (() => {
                // DB sensor names available for linking (from live data or breakdown)
                const dbSensorNames = [
                  ...new Set([
                    ...(liveData?.sensors.filter(s => s.name.toLowerCase().includes('ac')).map(s => s.name) ?? []),
                    ...(acBreakdown?.sensors.map(s => s.name) ?? []),
                  ])
                ];
                const selectCls = "bg-slate-900 border border-slate-700 rounded-lg py-1.5 px-2 text-white text-xs focus:ring-2 focus:ring-blue-500 outline-none w-full";
                return (
                  <div className="space-y-6">
                    <div className="flex justify-between items-center">
                      <h3 className="font-semibold text-white">Installed AC Units</h3>
                      <button onClick={addAC} className="flex items-center gap-1 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded"><Plus size={14} /> Add Unit</button>
                    </div>
                    <div className="grid grid-cols-1 gap-4">
                      {acList.map((ac) => (
                        <div key={ac.id} className="bg-slate-950/50 border border-slate-800 p-4 rounded-xl space-y-4">
                          {/* Row 1: specs */}
                          <div className="flex flex-col md:flex-row gap-4 items-end">
                            <div className="flex-1 w-full">
                              <InputField label="Unit Name" type="text" value={ac.name} onChange={(v) => updateAC(ac.id, 'name', v)} />
                            </div>
                            <div className="w-full md:w-32">
                              <InputField label="Capacity" unit="Watts" value={ac.ratedCapacityWatts} onChange={(v) => updateAC(ac.id, 'ratedCapacityWatts', v as number)} />
                            </div>
                            <div className="w-full md:w-24">
                              <InputField label="ISEER" value={ac.iseer} onChange={(v) => updateAC(ac.id, 'iseer', v as number)} />
                            </div>
                            <div className="w-full md:w-24">
                              <InputField label="Age (Yrs)" value={ac.ageYears} onChange={(v) => updateAC(ac.id, 'ageYears', v as number)} />
                            </div>
                            <button onClick={() => removeAC(ac.id)} className="text-slate-600 hover:text-red-500 p-2 mb-1"><Trash2 size={18} /></button>
                          </div>
                          {/* Row 2: DB sensor link */}
                          <div className="flex flex-col gap-1">
                            <label className="text-xs text-slate-400 uppercase font-semibold">DB Sensor Link</label>
                            <select
                              value={ac.dbSensorName || ''}
                              onChange={e => updateAC(ac.id, 'dbSensorName', e.target.value)}
                              className={selectCls}
                            >
                              <option value="">— Not linked —</option>
                              {dbSensorNames.map(n => <option key={n} value={n}>{n}</option>)}
                            </select>
                            <p className="text-xs text-slate-500">Links this AC spec to its live sensor reading from the DB.</p>
                          </div>
                          {/* Row 3: Coverage assignment (only shown if sub-zones are available) */}
                          {availableSubZones.length > 0 && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-800">
                              {/* Primary coverage */}
                              <div>
                                <p className="text-xs text-slate-400 uppercase font-semibold mb-2">Primary Coverage</p>
                                <p className="text-xs text-slate-500 mb-2">Sub-zones this AC directly cools.</p>
                                <div className="space-y-1.5">
                                  {availableSubZones.map(sz => (
                                    <label key={sz.name} className="flex items-center gap-2 cursor-pointer group">
                                      <input
                                        type="checkbox"
                                        checked={(ac.primarySubZones || []).includes(sz.name)}
                                        onChange={() => togglePrimarySubZone(ac.id, sz.name)}
                                        className="accent-blue-500 w-3.5 h-3.5"
                                      />
                                      <span className="text-xs text-slate-300 group-hover:text-white">{sz.name}</span>
                                      <span className="text-xs text-slate-600">({sz.sensorCount} sensor{sz.sensorCount !== 1 ? 's' : ''})</span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                              {/* Spillover coverage */}
                              <div>
                                <p className="text-xs text-slate-400 uppercase font-semibold mb-2">Spillover Coverage</p>
                                <p className="text-xs text-slate-500 mb-2">Sub-zones that get incidental cooling from this AC.</p>
                                <div className="space-y-1.5">
                                  {availableSubZones.map(sz => (
                                    <label key={sz.name} className="flex items-center gap-2 cursor-pointer group">
                                      <input
                                        type="checkbox"
                                        checked={(ac.spilloverSubZones || []).includes(sz.name)}
                                        onChange={() => toggleSpilloverSubZone(ac.id, sz.name)}
                                        className="accent-yellow-500 w-3.5 h-3.5"
                                      />
                                      <span className="text-xs text-slate-300 group-hover:text-white">{sz.name}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="p-4 bg-slate-800 rounded-lg flex justify-between items-center">
                      <span className="text-slate-400">Total System Capacity</span>
                      <span className="text-xl font-bold text-white">{(totalAcCapacityWatts / 3517).toFixed(2)} TR</span>
                    </div>

                    {/* ── Sensor Positions ── */}
                    {liveData && liveData.sensors.length > 0 && (
                      <div className="border-t border-slate-800 pt-6">
                        <div className="mb-4">
                          <h3 className="font-semibold text-white flex items-center gap-2">
                            <Thermometer size={16} className="text-orange-400" /> Sensor Positions
                          </h3>
                          <p className="text-xs text-slate-500 mt-1">
                            Override auto-detection when a sensor has been physically moved
                          </p>
                        </div>

                        {/* Zone-level desk sensor toggle */}
                        <div className="mb-4 flex items-center justify-between bg-slate-950/50 border border-slate-800 rounded-xl px-4 py-3">
                          <div>
                            <p className="text-sm font-medium text-white">Zone has desk-level sensors</p>
                            <p className="text-xs text-slate-500 mt-0.5">
                              Disable if all sensors are at AC / ceiling height — switches verdict to Track B
                            </p>
                          </div>
                          <button
                            onClick={() => setZones(prev => prev.map(zp =>
                              zp.id === activeZoneId
                                ? { ...zp, hasDeskSensors: !(zp.hasDeskSensors ?? true) }
                                : zp
                            ))}
                            className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${
                              (activeProfile?.hasDeskSensors ?? true)
                                ? 'bg-green-600'
                                : 'bg-slate-700'
                            }`}
                          >
                            <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                              (activeProfile?.hasDeskSensors ?? true) ? 'translate-x-6' : 'translate-x-0.5'
                            }`} />
                          </button>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {liveData.sensors.map(s => {
                            const currentPos = activeProfile?.sensorPositions?.[s.name];
                            const otherTemps = liveData.sensors.filter(os => os.name !== s.name).map(os => os.temp);
                            const otherAvg = otherTemps.length > 0 ? otherTemps.reduce((a, b) => a + b, 0) / otherTemps.length : 25;
                            const likelyInAcDuct = s.temp < 20 && otherAvg > 24;
                            return (
                              <div key={s.name} className="bg-slate-950/50 border border-slate-800 rounded-xl p-3 space-y-2">
                                <div className="flex items-center justify-between">
                                  <div>
                                    <p className="text-sm font-medium text-white">{s.name}</p>
                                    <p className="text-xs font-mono text-slate-400">{s.temp.toFixed(1)}°C</p>
                                  </div>
                                  {likelyInAcDuct && (
                                    <span className="text-[10px] font-bold text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded px-2 py-0.5">
                                      ⚠ Likely inside AC duct
                                    </span>
                                  )}
                                </div>
                                <div className="flex gap-1">
                                  {([
                                    { value: 'desk' as SensorLevel,     label: 'Desk Level' },
                                    { value: 'ac_level' as SensorLevel, label: 'AC & Ceiling' },
                                    { value: 'exclude' as SensorLevel,  label: 'Exclude' },
                                  ] as const).map(opt => (
                                    <button
                                      key={opt.value}
                                      onClick={() => saveSensorPosition(s.name, opt.value)}
                                      className={`flex-1 text-xs py-1.5 px-1 rounded-lg border transition-all font-medium ${
                                        currentPos === opt.value
                                          ? opt.value === 'desk'     ? 'bg-green-600/30 border-green-500 text-green-300'
                                          : opt.value === 'ac_level' ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                                          :                            'bg-red-600/30 border-red-500 text-red-300'
                                          : 'bg-slate-900 border-slate-700 text-slate-500 hover:border-slate-600 hover:text-slate-300'
                                      }`}
                                    >
                                      {opt.label}
                                    </button>
                                  ))}
                                </div>
                                {!currentPos && (
                                  <p className="text-[10px] text-slate-600 italic">Auto-detect (name-based)</p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ── INTERNAL LOADS SECTION ── */}
              {configSection === 'internal' && (() => {
                const SCHEDULE_LABELS: Record<string, string> = {
                  office_occupancy:          'Occupancy (8–18)',
                  office_lighting:           'Lighting (8–18)',
                  office_equipment:          'Equipment (9–17)',
                  always_on:                 'Always On (24/7 · 60%)',
                  intermittent:              'Intermittent (30%)',
                  extended_office_occupancy: 'Extended (10am–11pm)',
                  early_morning_lighting:    'Lighting (6am–11pm)',
                };
                const CATEGORY_COLORS: Record<string, string> = {
                  people:    'bg-orange-500/10 text-orange-400 border-orange-500/20',
                  lighting:  'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
                  equipment: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
                  appliance: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
                };
                const peakRatedW = internalLoadItems.reduce((s, i) => s + i.count * i.wattsPerUnit, 0);
                const selectCls = "bg-slate-900 border border-slate-700 rounded-lg py-1.5 px-2 text-white text-xs focus:ring-2 focus:ring-blue-500 outline-none w-full";
                return (
                  <div className="space-y-6">
                    {/* Header */}
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="font-semibold text-white flex items-center gap-2">
                          <Flame size={16} className="text-orange-400" /> Internal Heat Sources
                        </h3>
                        <p className="text-xs text-slate-500 mt-1">
                          Each item is multiplied by its schedule factor every hour.
                          Heat is split into <span className="text-green-400">people</span>,{' '}
                          <span className="text-yellow-400">lighting</span>,{' '}
                          <span className="text-blue-400">equipment</span> &amp;{' '}
                          <span className="text-purple-400">appliance</span> categories.
                        </p>
                      </div>
                      <button
                        onClick={addInternalLoadItem}
                        className="flex items-center gap-1 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg shrink-0 transition-colors"
                      >
                        <Plus size={13} /> Add Item
                      </button>
                    </div>

                    {/* Method badge */}
                    <div className="flex items-center gap-2 px-3 py-2 bg-green-900/20 border border-green-800/40 rounded-lg text-xs text-green-400">
                      <Activity size={13} />
                      {internalLoadItems.length > 0
                        ? 'Using inventory-based scheduled method — overrides generic W/m² density estimate'
                        : 'No inventory — falling back to generic W/m² density estimate'}
                    </div>

                    {/* Item list */}
                    {internalLoadItems.length === 0 ? (
                      <div className="py-12 border-2 border-dashed border-slate-800 rounded-2xl flex flex-col items-center justify-center text-slate-500 gap-3">
                        <Flame size={36} className="opacity-20" />
                        <p className="text-sm">No internal load items defined.</p>
                        <button onClick={addInternalLoadItem} className="text-blue-400 hover:text-blue-300 text-sm font-medium">Click to add your first item</button>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {/* Column headers */}
                        <div className="hidden md:grid grid-cols-[1fr_110px_80px_80px_1fr_60px_28px] gap-3 px-4 text-[10px] text-slate-500 uppercase font-bold tracking-widest">
                          <span>Label</span><span>Category</span><span>Count</span><span>W/unit</span><span>Schedule</span><span className="text-right">Peak W</span><span />
                        </div>

                        {internalLoadItems.map((item) => (
                          <div key={item.id} className="bg-slate-950/50 border border-slate-800 rounded-xl p-3 grid grid-cols-1 md:grid-cols-[1fr_110px_80px_80px_1fr_60px_28px] gap-3 items-center hover:border-slate-700 transition-colors">

                            {/* Label */}
                            <input
                              type="text"
                              value={item.label}
                              onChange={e => updateInternalLoadItem(item.id, 'label', e.target.value)}
                              className="bg-slate-900 border border-slate-700 rounded-lg py-1.5 px-3 text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none w-full"
                              placeholder="Label"
                            />

                            {/* Category */}
                            <select
                              value={item.category}
                              onChange={e => updateInternalLoadItem(item.id, 'category', e.target.value)}
                              className={selectCls}
                            >
                              <option value="people">People</option>
                              <option value="lighting">Lighting</option>
                              <option value="equipment">Equipment</option>
                              <option value="appliance">Appliance</option>
                            </select>

                            {/* Count */}
                            <input
                              type="number"
                              min={0}
                              value={item.count}
                              onChange={e => updateInternalLoadItem(item.id, 'count', Number(e.target.value))}
                              className="bg-slate-900 border border-slate-700 rounded-lg py-1.5 px-2 text-white text-sm font-mono text-center focus:ring-2 focus:ring-blue-500 outline-none w-full"
                            />

                            {/* Watts per unit */}
                            <div className="relative">
                              <input
                                type="number"
                                min={0}
                                value={item.wattsPerUnit}
                                onChange={e => updateInternalLoadItem(item.id, 'wattsPerUnit', Number(e.target.value))}
                                className="bg-slate-900 border border-slate-700 rounded-lg py-1.5 pl-2 pr-7 text-white text-sm font-mono text-center focus:ring-2 focus:ring-blue-500 outline-none w-full"
                              />
                              <span className="absolute right-2 top-1.5 text-slate-500 text-xs pointer-events-none">W</span>
                            </div>

                            {/* Schedule preset */}
                            <select
                              value={item.schedulePreset}
                              onChange={e => updateInternalLoadItem(item.id, 'schedulePreset', e.target.value)}
                              className={selectCls}
                            >
                              {Object.entries(SCHEDULE_LABELS).map(([val, lbl]) => (
                                <option key={val} value={val}>{lbl}</option>
                              ))}
                            </select>

                            {/* Peak watts (count × W/unit) */}
                            <div className="text-right">
                              <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded border ${CATEGORY_COLORS[item.category]}`}>
                                {(item.count * item.wattsPerUnit).toLocaleString()} W
                              </span>
                            </div>

                            {/* Remove */}
                            <button
                              onClick={() => removeInternalLoadItem(item.id)}
                              className="text-slate-600 hover:text-red-500 transition-colors flex justify-center"
                              title="Remove item"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Summary footer */}
                    {internalLoadItems.length > 0 && (
                      <div className="border-t border-slate-800 pt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
                        {(['people', 'lighting', 'equipment', 'appliance'] as const).map(cat => {
                          const catW = internalLoadItems
                            .filter(i => i.category === cat)
                            .reduce((s, i) => s + i.count * i.wattsPerUnit, 0);
                          if (catW === 0) return null;
                          return (
                            <div key={cat} className={`p-3 rounded-xl border ${CATEGORY_COLORS[cat]} bg-opacity-10`}>
                              <p className="text-[10px] uppercase font-bold tracking-widest capitalize mb-1">{cat}</p>
                              <p className="text-lg font-mono font-bold">{catW.toLocaleString()} W</p>
                            </div>
                          );
                        })}
                        <div className="col-span-2 md:col-span-4 p-4 bg-slate-800 rounded-xl flex justify-between items-center">
                          <div>
                            <p className="text-xs text-slate-400 uppercase font-bold tracking-widest">Rated Peak Total</p>
                            <p className="text-[10px] text-slate-500 mt-0.5">at schedule factor = 1.0 · actual output varies by hour</p>
                          </div>
                          <p className="text-2xl font-mono font-bold text-white">{peakRatedW.toLocaleString()} <span className="text-sm font-normal text-slate-400">W</span></p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ── SENSOR ZONES SECTION ── */}
              {configSection === 'sensors' && (() => {
                const allZoneNames = zones.map(z => z.zone.name);
                const sensors = allLiveSensors?.sensors ?? [];

                return (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-base font-semibold text-white mb-1">Sensor Zone Assignment</h3>
                      <p className="text-xs text-slate-400">
                        When a sensor is physically moved to a different room, reassign it here.
                        This overrides the DB <code className="text-slate-300">site_group_name</code> without changing the database.
                      </p>
                    </div>

                    {sensors.length === 0 && (
                      <div className="p-6 bg-slate-800/50 rounded-xl border border-slate-700 text-center">
                        <p className="text-slate-400 text-sm">
                          {allLiveSensors === null ? 'Loading sensors…' : 'No sensors found in any zone.'}
                        </p>
                      </div>
                    )}

                    {sensors.length > 0 && (
                      <div className="space-y-2">
                        {/* Header */}
                        <div className="grid grid-cols-12 gap-2 px-3 mb-1">
                          <span className="col-span-4 text-[10px] text-slate-500 uppercase font-bold tracking-widest">Sensor</span>
                          <span className="col-span-3 text-[10px] text-slate-500 uppercase font-bold tracking-widest">DB Zone</span>
                          <span className="col-span-4 text-[10px] text-slate-500 uppercase font-bold tracking-widest">Assigned Zone</span>
                          <span className="col-span-1"></span>
                        </div>

                        {sensors.map(s => {
                          const entries = sensorZoneOverrides[s.name] || [];
                          const isOverridden = entries.length > 0;
                          const currentZone = effectiveZoneForSensor(s.name, s.naturalZone);
                          const latestEntry = entries.sort((a, b) => b.from.localeCompare(a.from))[0];

                          return (
                            <div
                              key={s.name}
                              className={`grid grid-cols-12 gap-2 items-center px-3 py-2.5 rounded-xl border ${
                                isOverridden ? 'bg-amber-950/20 border-amber-700/40' : 'bg-slate-800/50 border-slate-700/50'
                              }`}
                            >
                              {/* Sensor name + temp */}
                              <div className="col-span-4">
                                <p className="text-sm font-medium text-white leading-tight">{s.name}</p>
                                <p className="text-[10px] text-slate-400 font-mono">{s.temp.toFixed(1)}°C</p>
                                {isOverridden && latestEntry && (
                                  <p className="text-[10px] text-amber-500">moved {latestEntry.from}</p>
                                )}
                              </div>

                              {/* DB zone */}
                              <div className="col-span-3">
                                <p className="text-xs text-slate-400 leading-tight">{s.dbZone}</p>
                                <p className="text-[10px] text-slate-500">({s.naturalZone})</p>
                              </div>

                              {/* Zone selector */}
                              <div className="col-span-4">
                                <select
                                  value={currentZone}
                                  onChange={e => {
                                    const chosen = e.target.value;
                                    moveSensor(s.name, chosen === s.naturalZone && entries.length === 0 ? null : chosen);
                                  }}
                                  className="w-full bg-slate-900 border border-slate-600 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-500"
                                >
                                  {allZoneNames.map(zn => (
                                    <option key={zn} value={zn}>{zn}</option>
                                  ))}
                                </select>
                              </div>

                              {/* Reset button (only when overridden) */}
                              <div className="col-span-1 flex justify-center">
                                {isOverridden && (
                                  <button
                                    onClick={() => moveSensor(s.name, null)}
                                    title="Reset to DB zone (clear all move history)"
                                    className="text-slate-500 hover:text-red-400 transition-colors"
                                  >
                                    <X size={14} />
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}

                        {Object.keys(sensorZoneOverrides).length > 0 && (
                          <div className="mt-4 p-3 bg-amber-950/30 border border-amber-700/40 rounded-xl">
                            <p className="text-xs text-amber-300 font-medium">
                              {Object.keys(sensorZoneOverrides).length} sensor{Object.keys(sensorZoneOverrides).length > 1 ? 's' : ''} reassigned.
                              Historical queries use the zone each sensor was in <span className="italic">on that date</span>.
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* ── MONITOR TAB ── */}
        {activeTab === 'monitor' && (
          <div className="space-y-8 animate-fade-in">
            {/* Date picker */}
            <div className="flex items-center gap-3 px-1">
              <label className="text-xs font-medium uppercase tracking-wider text-slate-400">Analysis Date</label>
              <input
                type="date"
                value={selectedDate}
                max={todayIST}
                onChange={e => setSelectedDate(e.target.value)}
                className="bg-slate-800 border border-slate-600 text-white text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-500 cursor-pointer"
              />
              {!isToday && (
                <button
                  onClick={() => setSelectedDate(todayIST)}
                  className="text-xs text-blue-400 hover:text-blue-300 border border-blue-800 hover:border-blue-600 px-2 py-1 rounded-lg transition-colors"
                >
                  Back to Today
                </button>
              )}
              {!isToday && (
                <span className="text-xs text-orange-400 font-medium">
                  📅 Viewing historical: {selectedDate}
                </span>
              )}
            </div>

            {results && (
              <>
                <ResultsDashboard
                  results={results}
                  ratedCapacityWatts={totalAcCapacityWatts}
                  locationName={location.name}
                  walls={zone.walls}
                  isToday={isToday}
                  acOutputSource={historicalAcOutput ? {
                    hasData: historicalAcOutput.hasData,
                    hoursWithAcOn: historicalAcOutput.acOutputs.filter((v): v is number => v != null && v > 0).length,
                    hoursFromYesterday: historicalAcOutput.hoursFromYesterday,
                    totalElecKwh: historicalAcOutput.acOutputs
                      .filter((v): v is number => v !== null)
                      .reduce((sum, v) => sum + v, 0) / 1000,
                  } : undefined}
                  acBreakdown={acBreakdown ?? undefined}
                  liveData={liveData ?? undefined}
                  subZoneConfigs={zone.subZones}
                  availableSubZones={availableSubZones}
                  acList={acList}
                  designDayData={designDayData ?? undefined}
                  sensorPositions={activeProfile?.sensorPositions}
                  hasDeskSensors={activeProfile?.hasDeskSensors ?? true}
                />

                {/* ── Tool buttons ── */}
                <div className="flex flex-wrap justify-center gap-3">
                  <button
                    onClick={() => setShowDebug(!showDebug)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest transition-all ${showDebug ? 'bg-pink-600 text-white shadow-lg shadow-pink-900/50' : 'bg-slate-800 text-slate-400 hover:text-white border border-slate-700'}`}
                  >
                    <Bug size={14} />
                    {showDebug ? 'Hide Engineering Debug' : 'Show Engineering Debug'}
                  </button>

                  <button
                    onClick={() => setShowHeatFlow(!showHeatFlow)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest transition-all ${showHeatFlow ? 'bg-orange-600 text-white shadow-lg shadow-orange-900/50' : 'bg-slate-800 text-slate-400 hover:text-white border border-slate-700'}`}
                  >
                    <Flame size={14} />
                    {showHeatFlow ? 'Hide Heat Flow' : 'Show Heat Flow'}
                  </button>
                </div>

                {showDebug && (
                  <div className="space-y-6 animate-fade-in">
                    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
                      <div className="flex items-center justify-between mb-6">
                        <div className="flex items-center gap-2">
                          <Clock className="text-blue-400" size={18} />
                          <h3 className="text-sm font-bold text-white uppercase tracking-widest">Select Hour for Verification</h3>
                        </div>
                        <span className="text-2xl font-mono font-bold text-blue-400">{selectedHour}:00</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="23"
                        value={selectedHour}
                        onChange={(e) => setSelectedHour(Number(e.target.value))}
                        className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                      />
                      <div className="flex justify-between mt-2 text-[10px] text-slate-500 font-mono">
                        <span>00:00</span>
                        <span>06:00</span>
                        <span>12:00</span>
                        <span>18:00</span>
                        <span>23:00</span>
                      </div>
                    </div>

                    <DebugPanel
                      dataPoint={results.data[selectedHour]}
                      walls={zone.walls}
                    />
                  </div>
                )}

                {showHeatFlow && (
                  <div className="animate-fade-in">
                    <HeatFlowDiagram
                      allZoneResults={allZoneResults}
                      zones={zones}
                      activeZoneId={activeZoneId || zones[0]?.id}
                      allZoneTemps={allZoneTemps}
                      isToday={isToday}
                      selectedHour={selectedHour}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        )}

        </>)}
      </main>
    </div>
  );
}

export default App;

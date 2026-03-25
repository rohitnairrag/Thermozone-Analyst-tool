/**
 * HeatPocketMap.tsx — Enhanced
 *
 * 2D floor-plan showing zone-level and per-sensor thermal analysis.
 *
 * Existing features (unchanged):
 *   • Zone solid-fill coloured by desk-sensor vs AC setpoint
 *   • Minute-level live sensor replay timeline
 *   • Click zone → detail panel with heat source breakdown
 *
 * New in this version:
 *   • Sensor placement sidebar — drag desk/ceiling sensors onto the floor plan
 *   • IDW gradient heatmap overlay from placed desk sensor readings
 *   • Proper hot pocket scoring: 55% δ-setpoint + 45% local-deviation
 *   • AC airflow direction arrows for ceiling sensors
 *   • Configurable thresholds (not hard standards — clients calibrate these)
 *   • Supply-air sensor (cold AC duct sensor) handled separately
 *   • Role management: mark sensor as excluded or supply_air from sidebar
 */

import React, {
  useState, useMemo, useEffect, useRef, useCallback,
} from 'react';
import {
  Thermometer, Info, X, AlertTriangle, Play, Pause, SkipBack,
  Layers, ChevronDown, ChevronRight, Settings, Eye, EyeOff,
  Wind, MapPin,
} from 'lucide-react';
import { SimulationResult, ZoneProfile } from '../types';
import { AllSensorsData } from '../services/liveDataService';
import {
  computeZoneHotPockets, SensorWithTemp, HotPocketConfig,
  DEFAULT_HOT_POCKET_CONFIG, ZoneHotPocketResult, HotPocketScore,
} from '../services/hotPocketEngine';
import { renderIDWToCanvas, IDWPoint } from '../utils/idwInterpolation';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  allZoneResults: Record<string, SimulationResult>;
  actualTemps: Record<string, number[]>;
  liveDeskTemps?: Record<string, number>;
  liveAcStatus?: Record<string, { setpoint: number | null; acIsOn: boolean }>;
  zones: ZoneProfile[];
  selectedHour: number;
  allLiveSensors?: AllSensorsData | null;
}

// ─── Local placement type (SVG pixel coords) ─────────────────────────────────

interface HeatMapPlacement {
  sensorKey: string;
  sensorName: string;
  classifiedType: 'desk' | 'ceiling';
  role: 'normal' | 'supply_air' | 'excluded';
  zoneProfileId: string;   // ZoneProfile.id (e.g. "zone1-default")
  svgX: number;
  svgY: number;
  flowDirection?: number;  // degrees 0–360, ceiling only
}

const PLACEMENTS_KEY = 'thermozone_heatmap_placements';
const CONFIG_KEY     = 'thermozone_heatmap_config';

// ─── SVG viewbox ──────────────────────────────────────────────────────────────

const SVG_VB = { x: 60, y: 5, w: 665, h: 650 };

// ─── Floor-plan zone shapes ───────────────────────────────────────────────────

interface ZoneShape {
  id: string;
  label: string;
  displayLines: string[];
  polygon: string;
  labelX: number;
  labelY: number;
  parentZoneId?: string;
  dbSubZoneName?: string;
}

const ZONE_SHAPES: ZoneShape[] = [
  {
    id: 'zone4-default',
    label: 'Corridor & Reception',
    displayLines: ['Corridor', '& Recep.'],
    polygon: '600,30 680,30 680,498 600,498 600,440 503,440 503,213 600,213',
    labelX: 591, labelY: 318,
  },
  {
    id: 'zone3-default',
    label: 'Meeting Room',
    displayLines: ['Meeting', 'Room'],
    polygon: '120,30 250,30 250,310 120,310',
    labelX: 185, labelY: 160,
  },
  {
    id: 'zone2-default',
    label: 'Pantry',
    displayLines: ['Pantry'],
    polygon: '120,310 250,310 250,440 120,440',
    labelX: 185, labelY: 378,
  },
  {
    id: 'zone1-wa2',
    label: 'Working Area 2',
    displayLines: ['Working', 'Area 2'],
    polygon: '250,30 600,30 600,213 503,213 503,440 250,440',
    labelX: 390, labelY: 120,
    parentZoneId: 'zone1-default',
    dbSubZoneName: 'Working Area 2',
  },
  {
    id: 'zone1-wa1',
    label: 'Working Area 1',
    displayLines: ['Working Area 1'],
    polygon: '120,440 600,440 600,498 680,498 680,600 120,600',
    labelX: 370, labelY: 555,
    parentZoneId: 'zone1-default',
    dbSubZoneName: 'Working Area 1',
  },
  {
    id: 'zone1-et',
    label: 'Embedded Team',
    displayLines: ['Embedded', 'Team'],
    polygon: '120,440 250,440 250,510 120,510',
    labelX: 185, labelY: 468,
    parentZoneId: 'zone1-default',
    dbSubZoneName: 'Embedded Team',
  },
];

// ─── Glass-window edge segments ───────────────────────────────────────────────

interface GlassSegment { id: string; x1: number; y1: number; x2: number; y2: number; }

const GLASS_SEGMENTS: GlassSegment[] = [
  { id: 'nw',       x1: 120, y1: 35,  x2: 600, y2: 35  },
  { id: 'sw-mr',    x1: 120, y1: 110, x2: 120, y2: 200 },
  { id: 'sw-pantry',x1: 120, y1: 321, x2: 120, y2: 410 },
  { id: 'sw-lower', x1: 120, y1: 438, x2: 120, y2: 546 },
  { id: 'se',       x1: 230, y1: 600, x2: 680, y2: 600 },
  { id: 'ne',       x1: 680, y1: 497, x2: 680, y2: 595 },
];

const DIR_LABELS = [
  { text: '← NW →', x: 355, y: 20  },
  { text: '← SE →', x: 355, y: 626 },
  { text: 'SW',      x: 88,  y: 325 },
  { text: 'NE',      x: 702, y: 325 },
];

// ─── 8-direction labels ───────────────────────────────────────────────────────

const DIRECTIONS_8 = [
  { label: 'N',  deg:   0 },
  { label: 'NE', deg:  45 },
  { label: 'E',  deg:  90 },
  { label: 'SE', deg: 135 },
  { label: 'S',  deg: 180 },
  { label: 'SW', deg: 225 },
  { label: 'W',  deg: 270 },
  { label: 'NW', deg: 315 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEVIATION_MAX_C = 8;

function deviationColor(deviation: number | null, alpha = 0.82): string {
  if (deviation === null) return `rgba(100,116,139,${alpha})`;
  const t = Math.min(1, Math.max(0, deviation / DEVIATION_MAX_C));
  let r: number, g: number, b: number;
  if (t < 0.5) {
    const u = t * 2;
    r = Math.round(59  + (234 - 59)  * u);
    g = Math.round(130 + (179 - 130) * u);
    b = Math.round(246 + (8   - 246) * u);
  } else {
    const u = (t - 0.5) * 2;
    r = Math.round(234 + (239 - 234) * u);
    g = Math.round(179 + (68  - 179) * u);
    b = Math.round(8   + (68  - 8)   * u);
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

function hotStatus(deviation: number | null, acIsOn?: boolean | null) {
  if (acIsOn === false)
    return { label: 'AC Off',        textColor: '#94a3b8', borderColor: '#475569', bgColor: 'rgba(51,65,85,0.30)' };
  if (deviation === null)
    return { label: 'No Data',       textColor: '#94a3b8', borderColor: '#475569', bgColor: 'rgba(71,85,105,0.25)' };
  if (deviation <= 0)
    return { label: 'Comfortable',   textColor: '#34d399', borderColor: '#059669', bgColor: 'rgba(5,150,105,0.15)' };
  if (deviation <= 1.5)
    return { label: 'Slightly Warm', textColor: '#fbbf24', borderColor: '#d97706', bgColor: 'rgba(217,119,6,0.15)' };
  if (deviation <= 3)
    return { label: 'Warm',          textColor: '#fb923c', borderColor: '#ea580c', bgColor: 'rgba(234,88,12,0.15)' };
  return   { label: 'Hot Pocket',    textColor: '#f87171', borderColor: '#dc2626', bgColor: 'rgba(220,38,38,0.18)' };
}

function fmtMinute(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Classify a sensor as desk, ceiling, or supply_air based on
 * sensorPositions override map and heuristics.
 */
function classifySensorType(
  name: string,
  temp: number,
  sensorPositions: Record<string, string> | undefined,
  allZoneTemps: number[],
): 'desk' | 'ceiling' | 'supply_air' | 'excluded' {
  if (sensorPositions) {
    const pos = sensorPositions[name];
    if (pos === 'desk')     return 'desk';
    if (pos === 'ac_level') return 'ceiling';
    if (pos === 'exclude')  return 'excluded';
  }
  // Heuristic: very cold while others are warm → supply_air sensor inside AC duct
  const otherAvg = allZoneTemps.length > 0
    ? allZoneTemps.reduce((a, b) => a + b, 0) / allZoneTemps.length
    : 25;
  if (temp < 20 && otherAvg > 24) return 'supply_air';
  return name.toLowerCase().includes('ac') ? 'ceiling' : 'desk';
}

/** Convert SVG viewbox coords → canvas pixel coords. */
function svgToCanvas(svgX: number, svgY: number, cw: number, ch: number): [number, number] {
  return [
    (svgX - SVG_VB.x) / SVG_VB.w * cw,
    (svgY - SVG_VB.y) / SVG_VB.h * ch,
  ];
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function FlowDirectionModal({ onSelect, onSkip }: { onSelect: (deg: number) => void; onSkip: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-slate-800 border border-slate-600 rounded-2xl p-6 w-72 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-semibold flex items-center gap-2">
            <Wind size={16} className="text-blue-400" /> AC Airflow Direction
          </h3>
          <button onClick={onSkip} className="text-slate-500 hover:text-white"><X size={14} /></button>
        </div>
        <p className="text-xs text-slate-400 mb-4">
          Which direction does cold air blow from this AC unit?
        </p>
        <div className="grid grid-cols-3 gap-2">
          {DIRECTIONS_8.map(d => (
            <button
              key={d.deg}
              onClick={() => onSelect(d.deg)}
              className="py-2 rounded-lg bg-slate-700 hover:bg-blue-600 text-white text-sm font-medium transition-colors"
            >
              {d.label}
            </button>
          ))}
          <button
            onClick={onSkip}
            className="col-span-3 py-2 rounded-lg bg-slate-900 text-slate-400 hover:text-white text-xs transition-colors border border-slate-700"
          >
            Skip (set later)
          </button>
        </div>
      </div>
    </div>
  );
}

function ThresholdConfigPanel({
  config,
  onChange,
  onClose,
}: {
  config: HotPocketConfig;
  onChange: (c: HotPocketConfig) => void;
  onClose: () => void;
}) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
          <Settings size={11} /> Hot Pocket Thresholds
        </span>
        <button onClick={onClose} className="text-slate-500 hover:text-white"><X size={13} /></button>
      </div>
      <p className="text-xs text-slate-500 leading-relaxed">
        These are reference ranges — not official standards.
        Calibrate based on your occupant comfort surveys.
      </p>
      <div className="space-y-3">
        <div>
          <div className="flex justify-between text-xs text-slate-400 mb-1">
            <span>Max δ-setpoint (Signal 1)</span>
            <span className="font-mono text-orange-400">{config.deltaSetpointMax}°C</span>
          </div>
          <input type="range" min={1} max={8} step={0.5}
            value={config.deltaSetpointMax}
            onChange={e => onChange({ ...config, deltaSetpointMax: Number(e.target.value) })}
            className="w-full accent-orange-500"
          />
          <div className="flex justify-between text-[10px] text-slate-600 mt-0.5">
            <span>1°C</span><span>8°C</span>
          </div>
        </div>
        <div>
          <div className="flex justify-between text-xs text-slate-400 mb-1">
            <span>Max local deviation (Signal 2)</span>
            <span className="font-mono text-orange-400">{config.localDeviationMax}°C</span>
          </div>
          <input type="range" min={1} max={6} step={0.5}
            value={config.localDeviationMax}
            onChange={e => onChange({ ...config, localDeviationMax: Number(e.target.value) })}
            className="w-full accent-orange-500"
          />
          <div className="flex justify-between text-[10px] text-slate-600 mt-0.5">
            <span>1°C</span><span>6°C</span>
          </div>
        </div>
      </div>
      <div className="text-[10px] text-slate-500 bg-slate-900 rounded-lg p-2 space-y-0.5">
        <div>Score = 0.55 × (δ-setpoint / max) + 0.45 × (local-dev / max)</div>
        <div className="flex gap-3 flex-wrap mt-1">
          <span className="text-blue-400">● &lt;0.25 cool</span>
          <span className="text-green-400">● 0.25 warm</span>
          <span className="text-orange-400">● 0.45 hot</span>
          <span className="text-red-400">● &gt;0.65 severe</span>
        </div>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

const HeatPocketMap: React.FC<Props> = ({
  allZoneResults, actualTemps, liveDeskTemps, liveAcStatus,
  zones, selectedHour, allLiveSensors,
}) => {
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);

  // ── Minute-level timeline ──────────────────────────────────────────────────
  const currentMinute = useMemo(() => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }, []);

  const [localMinute, setLocalMinute] = useState<number>(currentMinute);
  const [isPlaying,   setIsPlaying]   = useState<boolean>(false);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const PLAY_STEP_MIN   = 15;
  const PLAY_INTERVAL_MS = 250;

  const stopPlay = useCallback(() => {
    if (playRef.current) { clearInterval(playRef.current); playRef.current = null; }
    setIsPlaying(false);
  }, []);

  const startPlay = useCallback(() => {
    setLocalMinute(0);
    setIsPlaying(true);
    playRef.current = setInterval(() => {
      setLocalMinute(prev => {
        const next = prev + PLAY_STEP_MIN;
        if (next >= currentMinute) { stopPlay(); return currentMinute; }
        return next;
      });
    }, PLAY_INTERVAL_MS);
  }, [currentMinute, stopPlay]);

  const togglePlay = useCallback(() => {
    isPlaying ? stopPlay() : startPlay();
  }, [isPlaying, stopPlay, startPlay]);

  useEffect(() => () => { if (playRef.current) clearInterval(playRef.current); }, []);

  const localHour = Math.floor(localMinute / 60);

  // ── New state: sensor placements ──────────────────────────────────────────
  const [placements, setPlacements] = useState<HeatMapPlacement[]>(() => {
    try { return JSON.parse(localStorage.getItem(PLACEMENTS_KEY) ?? '[]'); } catch { return []; }
  });

  const [hotPocketConfig, setHotPocketConfig] = useState<HotPocketConfig>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? '{}');
      return { ...DEFAULT_HOT_POCKET_CONFIG, ...saved };
    } catch { return DEFAULT_HOT_POCKET_CONFIG; }
  });

  const [showHeatmap,       setShowHeatmap]       = useState(false);
  const [showSidebar,       setShowSidebar]        = useState(false);
  const [showThresholds,    setShowThresholds]     = useState(false);
  const [draggingSensorKey, setDraggingSensorKey]  = useState<string | null>(null);
  const [dragOverSvg,       setDragOverSvg]        = useState(false);
  const [selectedPlacKey,   setSelectedPlacKey]    = useState<string | null>(null);
  const [pendingFlowKey,    setPendingFlowKey]      = useState<string | null>(null);
  const [sidebarExpand,     setSidebarExpand]       = useState<Record<string, boolean>>({ desk: true, ceiling: true });

  // Persist placements
  useEffect(() => {
    localStorage.setItem(PLACEMENTS_KEY, JSON.stringify(placements));
  }, [placements]);

  // Persist threshold config
  useEffect(() => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(hotPocketConfig));
  }, [hotPocketConfig]);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const svgRef    = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ── Zone-level data (existing logic) ─────────────────────────────────────
  const shapeData = useMemo(() => {
    const out: Record<string, {
      actualTemp: number | null;
      setpoint: number;
      deviation: number | null;
      acIsOn: boolean | null;
    }> = {};

    for (const shape of ZONE_SHAPES) {
      const simZoneId = shape.parentZoneId ?? shape.id;
      const result    = allZoneResults[simZoneId];
      const slot      = result ? Math.min(localMinute, result.data.length - 1) : -1;
      const slotDp    = result && slot >= 0 ? result.data[slot] : null;
      const simSetpoint = slotDp?.setPoint ?? 24;

      const isCurrentHour = localHour === Math.floor(currentMinute / 60);

      const lookup = <T,>(map: Record<string, T> | undefined): T | undefined => {
        if (!map) return undefined;
        return (shape.dbSubZoneName != null ? map[shape.dbSubZoneName] : undefined)
          ?? map[shape.id]
          ?? (shape.parentZoneId ? map[shape.parentZoneId] : undefined);
      };

      let setpoint: number    = simSetpoint;
      let acIsOn: boolean | null = null;

      if (isCurrentHour && liveAcStatus) {
        const acEntry = lookup<{ setpoint: number | null; acIsOn: boolean }>(liveAcStatus);
        if (acEntry != null) {
          acIsOn   = acEntry.acIsOn;
          setpoint = acEntry.setpoint ?? simSetpoint;
        }
      }

      let actualTemp: number | null = null;

      if (isCurrentHour && liveDeskTemps) {
        const liveTemp = lookup<number>(liveDeskTemps);
        if (liveTemp != null) actualTemp = liveTemp;
      }

      if (actualTemp === null) {
        const temps =
          (shape.dbSubZoneName && actualTemps[shape.dbSubZoneName]) ||
          actualTemps[shape.id] ||
          (shape.parentZoneId ? actualTemps[shape.parentZoneId] : undefined);
        actualTemp = (temps && temps[localHour] != null) ? temps[localHour] : null;
      }

      const deviation = (actualTemp !== null && acIsOn !== false) ? actualTemp - setpoint : null;
      out[shape.id] = { actualTemp, setpoint, deviation, acIsOn };
    }
    return out;
  }, [allZoneResults, actualTemps, localMinute, localHour, liveDeskTemps, liveAcStatus, currentMinute]);

  const slotData = useMemo(() => {
    if (!selectedShapeId) return null;
    const shape  = ZONE_SHAPES.find(s => s.id === selectedShapeId);
    const zoneId = shape?.parentZoneId ?? selectedShapeId;
    const result = allZoneResults[zoneId];
    if (!result) return null;
    const slot = Math.min(localMinute, result.data.length - 1);
    return result.data[slot] ?? null;
  }, [selectedShapeId, allZoneResults, localMinute]);

  const selectedShape  = ZONE_SHAPES.find(s => s.id === selectedShapeId);
  const selectedData   = selectedShapeId ? shapeData[selectedShapeId] : null;
  const selectedStatus = hotStatus(selectedData?.deviation ?? null);

  const breakdownItems = useMemo(() => {
    if (!slotData) return [];
    const rawItems = [
      { label: 'Solar',        value: slotData.solarLoad,    color: '#f59e0b' },
      { label: 'Glass Cond.', value: slotData.glassLoad,    color: '#60a5fa' },
      { label: 'Wall Cond.',  value: slotData.wallLoad,     color: '#a78bfa' },
      { label: 'Roof',         value: slotData.roofLoad,     color: '#f97316' },
      { label: 'Infiltration', value: slotData.infLoad,      color: '#34d399' },
      { label: 'People',       value: slotData.peopleLoad,   color: '#fb7185' },
      { label: 'Equipment',    value: slotData.internalLoad, color: '#e879f9' },
      { label: 'Inter-zone',   value: slotData.otherLoad,    color: '#94a3b8' },
    ].filter(i => Math.abs(i.value) > 50);
    const absSum = rawItems.reduce((s, i) => s + Math.abs(i.value), 0) || 1;
    return rawItems
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .map(i => ({ ...i, pct: (Math.abs(i.value) / absSum) * 100 }));
  }, [slotData]);

  // ── Hot pocket scoring using hotPocketEngine ──────────────────────────────
  /**
   * Build SensorWithTemp[] from allLiveSensors, classifying each sensor
   * using the sensorPositions from the matching ZoneProfile.
   */
  const sensorWithTemps = useMemo<SensorWithTemp[]>(() => {
    if (!allLiveSensors) return [];
    return allLiveSensors.sensors.map(s => {
      // Find matching zone profile for classification lookup
      const zp = zones.find(z => z.zone.name === s.effectiveZone);
      const pos = zp?.sensorPositions;
      const zoneTemps = allLiveSensors.sensors
        .filter(o => o.effectiveZone === s.effectiveZone && o.key !== s.key)
        .map(o => o.temp);

      const classified = classifySensorType(s.name, s.temp, pos, zoneTemps);

      return {
        key:            s.key,
        name:           s.name,
        temp:           s.temp,
        classifiedType: classified === 'supply_air' ? 'ceiling' : classified === 'excluded' ? 'desk' : classified,
        role:           classified === 'supply_air' ? 'supply_air' : classified === 'excluded' ? 'excluded' : 'normal',
        zoneId:         zp?.id ?? s.effectiveZone,
        setpoint:       s.setpoint,
      } as SensorWithTemp;
    });
  }, [allLiveSensors, zones]);

  const hotPocketResults = useMemo<ZoneHotPocketResult[]>(() => {
    if (sensorWithTemps.length === 0) return [];
    return computeZoneHotPockets(sensorWithTemps, hotPocketConfig);
  }, [sensorWithTemps, hotPocketConfig]);

  /** Map sensorKey → HotPocketScore for quick lookup */
  const scoreByKey = useMemo<Map<string, HotPocketScore>>(() => {
    const m = new Map<string, HotPocketScore>();
    for (const zr of hotPocketResults) {
      for (const ds of zr.deskScores) {
        m.set(ds.sensorKey, ds);
      }
    }
    return m;
  }, [hotPocketResults]);

  // ── Sensor lists for sidebar ──────────────────────────────────────────────
  const { deskSensors, ceilingSensors } = useMemo(() => {
    if (!allLiveSensors) return { deskSensors: [], ceilingSensors: [] };
    const desk: typeof allLiveSensors.sensors = [];
    const ceiling: typeof allLiveSensors.sensors = [];
    for (const s of allLiveSensors.sensors) {
      const zp  = zones.find(z => z.zone.name === s.effectiveZone);
      const pos = zp?.sensorPositions;
      const zoneTemps = allLiveSensors.sensors
        .filter(o => o.effectiveZone === s.effectiveZone && o.key !== s.key)
        .map(o => o.temp);
      const cls = classifySensorType(s.name, s.temp, pos, zoneTemps);
      if (cls === 'excluded') continue;
      if (cls === 'ceiling' || cls === 'supply_air') ceiling.push(s);
      else desk.push(s);
    }
    return { deskSensors: desk, ceilingSensors: ceiling };
  }, [allLiveSensors, zones]);

  const isPlaced = useCallback((key: string) => placements.some(p => p.sensorKey === key), [placements]);

  // ── Drag handlers ─────────────────────────────────────────────────────────

  const handleDragStart = useCallback((key: string) => {
    setDraggingSensorKey(key);
  }, []);

  const handleSvgDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOverSvg(true);
  }, []);

  const handleSvgDragLeave = useCallback(() => {
    setDragOverSvg(false);
  }, []);

  const handleSvgDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOverSvg(false);
    if (!draggingSensorKey || !svgRef.current) return;

    const rect  = svgRef.current.getBoundingClientRect();
    const svgX  = (e.clientX - rect.left) / rect.width  * SVG_VB.w + SVG_VB.x;
    const svgY  = (e.clientY - rect.top)  / rect.height * SVG_VB.h + SVG_VB.y;

    // Find the sensor in allLiveSensors
    const sensor = allLiveSensors?.sensors.find(s => s.key === draggingSensorKey);
    if (!sensor) return;

    const zp = zones.find(z => z.zone.name === sensor.effectiveZone);
    const pos = zp?.sensorPositions;
    const zoneTemps = allLiveSensors?.sensors
      .filter(o => o.effectiveZone === sensor.effectiveZone && o.key !== sensor.key)
      .map(o => o.temp) ?? [];
    const cls = classifySensorType(sensor.name, sensor.temp, pos, zoneTemps);

    const placement: HeatMapPlacement = {
      sensorKey:      sensor.key,
      sensorName:     sensor.name,
      classifiedType: cls === 'ceiling' || cls === 'supply_air' ? 'ceiling' : 'desk',
      role:           cls === 'supply_air' ? 'supply_air' : 'normal',
      zoneProfileId:  zp?.id ?? sensor.effectiveZone,
      svgX,
      svgY,
    };

    setPlacements(prev => {
      const filtered = prev.filter(p => p.sensorKey !== draggingSensorKey);
      return [...filtered, placement];
    });

    // Ask for flow direction if ceiling sensor
    if (placement.classifiedType === 'ceiling') {
      setPendingFlowKey(sensor.key);
    }

    setDraggingSensorKey(null);
  }, [draggingSensorKey, allLiveSensors, zones]);

  const handleRemovePlacement = useCallback((key: string) => {
    setPlacements(prev => prev.filter(p => p.sensorKey !== key));
    if (selectedPlacKey === key) setSelectedPlacKey(null);
  }, [selectedPlacKey]);

  const handleFlowSelect = useCallback((deg: number) => {
    if (!pendingFlowKey) return;
    setPlacements(prev =>
      prev.map(p => p.sensorKey === pendingFlowKey ? { ...p, flowDirection: deg } : p)
    );
    setPendingFlowKey(null);
  }, [pendingFlowKey]);

  const handleRoleToggle = useCallback((key: string) => {
    setPlacements(prev =>
      prev.map(p => {
        if (p.sensorKey !== key) return p;
        const nextRole = p.role === 'excluded' ? 'normal' : 'excluded';
        return { ...p, role: nextRole };
      })
    );
  }, []);

  const handleSetSupplyAir = useCallback((key: string) => {
    setPlacements(prev =>
      prev.map(p => {
        if (p.sensorKey !== key) return p;
        const nextRole = p.role === 'supply_air' ? 'normal' : 'supply_air';
        return { ...p, role: nextRole };
      })
    );
  }, []);

  // ── IDW canvas effect ─────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const svgEl  = svgRef.current;
    if (!canvas || !svgEl || !showHeatmap) return;

    const rect = svgEl.getBoundingClientRect();
    canvas.width  = rect.width;
    canvas.height = rect.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Placed desk sensors with hot pocket scores
    const idwPoints: IDWPoint[] = [];
    for (const p of placements) {
      if (p.classifiedType !== 'desk' || p.role === 'excluded') continue;
      const score = scoreByKey.get(p.sensorKey);
      if (!score) continue;
      const [cx, cy] = svgToCanvas(p.svgX, p.svgY, canvas.width, canvas.height);
      idwPoints.push({ x: cx, y: cy, value: score.score });
    }

    if (idwPoints.length >= 2) {
      renderIDWToCanvas(ctx, idwPoints, canvas.width, canvas.height, 8, 0.5);
    } else if (idwPoints.length === 1) {
      // Single sensor: radial gradient from its position
      const [cx, cy] = [idwPoints[0].x, idwPoints[0].y];
      const score = idwPoints[0].value;
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(canvas.width, canvas.height) * 0.4);
      const [r, g, b] = score > 0.65 ? [239, 68, 68] : score > 0.45 ? [249, 115, 22] : score > 0.25 ? [234, 179, 8] : [34, 197, 94];
      gradient.addColorStop(0,   `rgba(${r},${g},${b},0.65)`);
      gradient.addColorStop(0.6, `rgba(${r},${g},${b},0.15)`);
      gradient.addColorStop(1,   `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }, [placements, scoreByKey, showHeatmap]);

  // Re-render canvas when window resizes
  useEffect(() => {
    if (!showHeatmap) return;
    const observer = new ResizeObserver(() => {
      const canvas = canvasRef.current;
      const svgEl  = svgRef.current;
      if (!canvas || !svgEl) return;
      // Trigger re-render by updating canvas size
      const rect = svgEl.getBoundingClientRect();
      canvas.width  = rect.width;
      canvas.height = rect.height;
    });
    if (svgRef.current) observer.observe(svgRef.current);
    return () => observer.disconnect();
  }, [showHeatmap]);

  // ── AC cone path helper ───────────────────────────────────────────────────
  function flowConePath(svgX: number, svgY: number, deg: number): string {
    const rad   = deg * Math.PI / 180;
    const len   = 60;
    const spread = 25;
    const tipX  = svgX + Math.sin(rad) * len;
    const tipY  = svgY - Math.cos(rad) * len;
    const perpX = Math.cos(rad) * spread;
    const perpY = Math.sin(rad) * spread;
    return `M ${svgX} ${svgY} L ${tipX + perpX} ${tipY + perpY} L ${tipX - perpX} ${tipY - perpY} Z`;
  }

  // ── Selected placement info ───────────────────────────────────────────────
  const selectedPlac = placements.find(p => p.sensorKey === selectedPlacKey);
  const selectedPlacScore = selectedPlacKey ? scoreByKey.get(selectedPlacKey) : undefined;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 animate-fade-in">

      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <Thermometer size={20} className="text-red-400" />
        <h3 className="text-lg font-semibold text-white">Heat Pocket Map</h3>
        <span className="text-xs text-slate-400 ml-1">
          Desk sensor vs AC setpoint — click a zone to inspect
        </span>
        {/* Toolbar buttons */}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setShowSidebar(!showSidebar)}
            title="Toggle sensor sidebar"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${showSidebar ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white border border-slate-700'}`}
          >
            <MapPin size={12} /> Sensors
            {placements.length > 0 && (
              <span className="bg-orange-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] font-bold">
                {placements.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setShowHeatmap(!showHeatmap)}
            title={showHeatmap ? 'Hide IDW heatmap' : 'Show IDW gradient heatmap'}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${showHeatmap ? 'bg-orange-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white border border-slate-700'}`}
            disabled={placements.filter(p => p.classifiedType === 'desk' && p.role !== 'excluded').length === 0}
          >
            {showHeatmap ? <Eye size={12} /> : <EyeOff size={12} />}
            Heatmap
          </button>
          <button
            onClick={() => setShowThresholds(!showThresholds)}
            title="Configure hot pocket thresholds"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${showThresholds ? 'bg-slate-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white border border-slate-700'}`}
          >
            <Settings size={12} /> Thresholds
          </button>
        </div>
      </div>

      {/* Threshold config panel */}
      {showThresholds && (
        <ThresholdConfigPanel
          config={hotPocketConfig}
          onChange={setHotPocketConfig}
          onClose={() => setShowThresholds(false)}
        />
      )}

      {/* Timeline */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Live Sensor Replay
          </span>
          <span className="text-xs text-slate-500">
            00:00 → <span className="text-emerald-400 font-mono font-semibold">{fmtMinute(currentMinute)}</span>
            <span className="text-slate-600 ml-1">(now)</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={togglePlay}
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-slate-700 hover:bg-slate-600 transition-colors text-white flex-shrink-0"
            aria-label={isPlaying ? 'Pause' : 'Play timeline'}
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            onClick={() => { stopPlay(); setLocalMinute(currentMinute); }}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-700 hover:bg-emerald-700 transition-colors text-slate-400 hover:text-white text-xs flex-shrink-0"
          >
            <SkipBack size={11} style={{ transform: 'scaleX(-1)' }} /> Now
          </button>
          <input
            type="range" min={0} max={currentMinute} step={1} value={localMinute}
            onChange={e => { stopPlay(); setLocalMinute(Number(e.target.value)); }}
            className="flex-1 accent-orange-500 cursor-pointer"
          />
          <span className="flex items-center gap-1.5 flex-shrink-0 w-20 justify-end">
            {localHour === Math.floor(currentMinute / 60) && liveDeskTemps && Object.keys(liveDeskTemps).length > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
            )}
            <span className="text-sm font-mono font-bold text-orange-400">{fmtMinute(localMinute)}</span>
          </span>
        </div>
        <div className="relative" style={{ paddingLeft: '5.75rem', paddingRight: '3.75rem' }}>
          <div className="relative h-4">
            {Array.from({ length: Math.floor(currentMinute / 60) + 1 }, (_, h) => {
              const pct = currentMinute > 0 ? (h * 60) / currentMinute * 100 : 0;
              const isActive = h === localHour;
              return (
                <button key={h}
                  onClick={() => { stopPlay(); setLocalMinute(h * 60); }}
                  style={{ position: 'absolute', left: `${pct}%`, transform: 'translateX(-50%)' }}
                  className={`text-xs font-mono transition-colors leading-none ${isActive ? 'text-orange-400 font-bold' : 'text-slate-600 hover:text-slate-300'}`}
                >
                  {String(h).padStart(2, '0')}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex gap-3 items-start">

        {/* ── Sensor Sidebar ──────────────────────────────────────────────── */}
        {showSidebar && (
          <div className="w-52 flex-shrink-0 bg-slate-900 border border-slate-700 rounded-xl overflow-hidden flex flex-col" style={{ maxHeight: 520 }}>
            <div className="px-3 py-2 bg-slate-800 border-b border-slate-700 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Sensors
              </span>
              <span className="text-[10px] text-slate-500">drag to floor plan</span>
            </div>

            <div className="overflow-y-auto flex-1 p-2 space-y-2">
              {!allLiveSensors && (
                <p className="text-xs text-slate-500 p-2 text-center">No live sensor data</p>
              )}

              {/* Desk sensors */}
              {deskSensors.length > 0 && (
                <div>
                  <button
                    onClick={() => setSidebarExpand(prev => ({ ...prev, desk: !prev.desk }))}
                    className="flex items-center gap-1.5 w-full text-left px-2 py-1 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
                  >
                    {sidebarExpand.desk ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    Desk Sensors ({deskSensors.length})
                  </button>
                  {sidebarExpand.desk && (
                    <div className="space-y-1 mt-1">
                      {deskSensors.map(s => {
                        const placed = isPlaced(s.key);
                        const score  = scoreByKey.get(s.key);
                        return (
                          <div
                            key={s.key}
                            draggable
                            onDragStart={() => handleDragStart(s.key)}
                            className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-grab active:cursor-grabbing border transition-colors
                              ${placed
                                ? 'bg-blue-950/30 border-blue-700/40 opacity-75'
                                : 'bg-slate-800 border-slate-700 hover:border-slate-500'
                              }`}
                          >
                            <span
                              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              style={{ backgroundColor: score ? score.color : '#64748b' }}
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-white truncate leading-tight">{s.name}</p>
                              <p className="text-[10px] text-slate-400 leading-tight">{s.temp.toFixed(1)}°C · {s.effectiveZone}</p>
                            </div>
                            {placed && (
                              <span className="text-[9px] text-blue-400 font-medium flex-shrink-0">placed</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Ceiling / AC sensors */}
              {ceilingSensors.length > 0 && (
                <div>
                  <button
                    onClick={() => setSidebarExpand(prev => ({ ...prev, ceiling: !prev.ceiling }))}
                    className="flex items-center gap-1.5 w-full text-left px-2 py-1 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
                  >
                    {sidebarExpand.ceiling ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    Ceiling / AC ({ceilingSensors.length})
                  </button>
                  {sidebarExpand.ceiling && (
                    <div className="space-y-1 mt-1">
                      {ceilingSensors.map(s => {
                        const placed = isPlaced(s.key);
                        return (
                          <div
                            key={s.key}
                            draggable
                            onDragStart={() => handleDragStart(s.key)}
                            className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-grab active:cursor-grabbing border transition-colors
                              ${placed
                                ? 'bg-blue-950/30 border-blue-700/40 opacity-75'
                                : 'bg-slate-800 border-slate-700 hover:border-slate-500'
                              }`}
                          >
                            <Wind size={10} className="text-sky-400 flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-white truncate leading-tight">{s.name}</p>
                              <p className="text-[10px] text-slate-400 leading-tight">{s.temp.toFixed(1)}°C · {s.effectiveZone}</p>
                            </div>
                            {placed && (
                              <span className="text-[9px] text-blue-400 font-medium flex-shrink-0">placed</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Placed sensors list */}
              {placements.length > 0 && (
                <div className="mt-3 pt-2 border-t border-slate-700/50">
                  <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider px-2 mb-1">Placed</p>
                  {placements.map(p => (
                    <div
                      key={p.sensorKey}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-lg mb-1 cursor-pointer text-xs transition-colors
                        ${selectedPlacKey === p.sensorKey ? 'bg-blue-700/30 border border-blue-600/50' : 'hover:bg-slate-800'}`}
                      onClick={() => setSelectedPlacKey(selectedPlacKey === p.sensorKey ? null : p.sensorKey)}
                    >
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: p.classifiedType === 'ceiling' ? '#38bdf8' : (scoreByKey.get(p.sensorKey)?.color ?? '#64748b') }}
                      />
                      <span className="flex-1 truncate text-slate-300">{p.sensorName}</span>
                      {p.role === 'supply_air' && <span className="text-[9px] text-sky-400">SAT</span>}
                      {p.role === 'excluded'   && <span className="text-[9px] text-slate-500">off</span>}
                      <button
                        onClick={e => { e.stopPropagation(); handleRemovePlacement(p.sensorKey); }}
                        className="text-slate-600 hover:text-red-400 transition-colors"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Floor plan + canvas wrapper ───────────────────────────────── */}
        <div className="flex-1 min-w-0">
          <div
            className={`bg-slate-900 rounded-xl border transition-colors p-3 ${dragOverSvg ? 'border-blue-500 shadow-lg shadow-blue-900/30' : 'border-slate-700'}`}
            onDragOver={handleSvgDragOver}
            onDrop={handleSvgDrop}
            onDragLeave={handleSvgDragLeave}
          >
            {dragOverSvg && (
              <div className="text-xs text-blue-400 text-center mb-2 font-medium animate-pulse">
                Drop sensor here to place it on the floor plan
              </div>
            )}
            <div style={{ position: 'relative' }}>
              <svg
                ref={svgRef}
                viewBox="60 5 665 650"
                width="100%"
                style={{ maxHeight: '480px', display: 'block' }}
                aria-label="Office floor plan"
              >
                {/* Background */}
                <rect x="60" y="5" width="665" height="650" fill="#0f172a" />

                {/* Zone polygons */}
                {ZONE_SHAPES.map(shape => {
                  const d          = shapeData[shape.id];
                  const color      = deviationColor(d?.deviation ?? null);
                  const isSelected = shape.id === selectedShapeId;
                  const status     = hotStatus(d?.deviation ?? null);

                  return (
                    <g
                      key={shape.id}
                      onClick={() => { setSelectedShapeId(isSelected ? null : shape.id); setSelectedPlacKey(null); }}
                      style={{ cursor: 'pointer' }}
                    >
                      <polygon
                        points={shape.polygon}
                        fill={color}
                        stroke={isSelected ? '#f97316' : '#334155'}
                        strokeWidth={isSelected ? 2.5 : 1}
                      />
                      {shape.displayLines.map((line, li) => (
                        <text key={li}
                          x={shape.labelX}
                          y={shape.labelY + li * 13}
                          textAnchor="middle"
                          fill="#f1f5f9"
                          fontSize="10"
                          fontFamily="Inter, Helvetica, sans-serif"
                          fontWeight={isSelected ? '700' : '400'}
                          style={{ pointerEvents: 'none', userSelect: 'none' }}
                        >
                          {line}
                        </text>
                      ))}
                      <text
                        x={shape.labelX}
                        y={shape.labelY + shape.displayLines.length * 13 + 5}
                        textAnchor="middle"
                        fill={status.textColor}
                        fontSize="9"
                        fontFamily="Inter, Helvetica, sans-serif"
                        fontWeight="700"
                        style={{ pointerEvents: 'none', userSelect: 'none' }}
                      >
                        {d?.actualTemp != null ? `${d.actualTemp.toFixed(1)}°C` : '—'}
                      </text>
                    </g>
                  );
                })}

                {/* Glass windows */}
                {GLASS_SEGMENTS.map(seg => (
                  <line key={seg.id}
                    x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2}
                    stroke="#38bdf8" strokeWidth="5" strokeLinecap="round" opacity="0.85"
                    style={{ pointerEvents: 'none' }}
                  />
                ))}

                {/* Direction labels */}
                {DIR_LABELS.map(d => (
                  <text key={d.text} x={d.x} y={d.y}
                    textAnchor="middle" fill="#64748b" fontSize="10"
                    fontFamily="Inter, Helvetica, sans-serif" fontWeight="600"
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {d.text}
                  </text>
                ))}

                {/* AC flow cones (ceiling sensors with flowDirection) */}
                {placements
                  .filter(p => p.classifiedType === 'ceiling' && p.flowDirection != null)
                  .map(p => (
                    <path
                      key={`cone-${p.sensorKey}`}
                      d={flowConePath(p.svgX, p.svgY, p.flowDirection!)}
                      fill="rgba(56,189,248,0.18)"
                      stroke="#38bdf8"
                      strokeWidth="0.5"
                      style={{ pointerEvents: 'none' }}
                    />
                  ))
                }

                {/* Placed sensor markers */}
                {placements.map(p => {
                  const score    = scoreByKey.get(p.sensorKey);
                  const isSelP   = selectedPlacKey === p.sensorKey;
                  const fillColor = p.classifiedType === 'ceiling'
                    ? '#38bdf8'
                    : (score?.color ?? '#64748b');
                  const isExcluded = p.role === 'excluded';

                  return (
                    <g
                      key={p.sensorKey}
                      onClick={e => { e.stopPropagation(); setSelectedPlacKey(isSelP ? null : p.sensorKey); setSelectedShapeId(null); }}
                      style={{ cursor: 'pointer' }}
                    >
                      {/* Outer ring for selected/hot */}
                      {(isSelP || (score && score.score > 0.65)) && !isExcluded && (
                        <circle
                          cx={p.svgX} cy={p.svgY} r={10}
                          fill="none"
                          stroke={isSelP ? '#f97316' : '#ef4444'}
                          strokeWidth="1.5"
                          opacity="0.7"
                        />
                      )}
                      <circle
                        cx={p.svgX} cy={p.svgY} r={5.5}
                        fill={isExcluded ? '#334155' : fillColor}
                        stroke={isSelP ? '#f97316' : '#1e293b'}
                        strokeWidth="1.5"
                        opacity={isExcluded ? 0.4 : 1}
                      />
                      {/* Sensor name label */}
                      <text
                        x={p.svgX} y={p.svgY - 9}
                        textAnchor="middle"
                        fill={isExcluded ? '#475569' : '#cbd5e1'}
                        fontSize="7.5"
                        fontFamily="Inter, sans-serif"
                        fontWeight="500"
                        style={{ pointerEvents: 'none', userSelect: 'none' }}
                      >
                        {p.sensorName.length > 10 ? p.sensorName.slice(0, 9) + '…' : p.sensorName}
                      </text>
                      {/* Supply air badge */}
                      {p.role === 'supply_air' && (
                        <text
                          x={p.svgX + 7} y={p.svgY + 3}
                          fill="#7dd3fc"
                          fontSize="6"
                          fontFamily="Inter, sans-serif"
                          fontWeight="700"
                          style={{ pointerEvents: 'none', userSelect: 'none' }}
                        >
                          SAT
                        </text>
                      )}
                    </g>
                  );
                })}

                {/* Legend */}
                <defs>
                  <linearGradient id="hpLegendGrad" x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0%"   stopColor="rgb(59,130,246)" />
                    <stop offset="50%"  stopColor="rgb(234,179,8)" />
                    <stop offset="100%" stopColor="rgb(239,68,68)" />
                  </linearGradient>
                </defs>
                <text x="200" y="618" textAnchor="middle" fill="#64748b" fontSize="8" fontFamily="sans-serif">
                  Temperature vs Setpoint
                </text>
                <rect x="130" y="621" width="140" height="8" fill="url(#hpLegendGrad)" rx="2" />
                <text x="130" y="638" fill="#64748b" fontSize="8" fontFamily="sans-serif">At setpoint</text>
                <text x="270" y="638" fill="#64748b" fontSize="8" fontFamily="sans-serif" textAnchor="end">+8°C above</text>
                <line x1="300" y1="627" x2="318" y2="627" stroke="#38bdf8" strokeWidth="4" strokeLinecap="round" />
                <text x="322" y="631" fill="#64748b" fontSize="8" fontFamily="sans-serif">Glass window</text>
              </svg>

              {/* IDW canvas overlay */}
              {showHeatmap && (
                <canvas
                  ref={canvasRef}
                  style={{
                    position: 'absolute',
                    top: 0, left: 0,
                    width: '100%', height: '100%',
                    pointerEvents: 'none',
                    borderRadius: '0.5rem',
                  }}
                />
              )}
            </div>

            {/* Hint when sidebar open */}
            {showSidebar && placements.length === 0 && (
              <p className="text-xs text-slate-500 text-center mt-2">
                Drag a sensor from the panel onto the floor plan to place it
              </p>
            )}
          </div>
        </div>

        {/* ── Detail Panel ─────────────────────────────────────────────── */}
        <div className="w-72 flex-shrink-0 space-y-3">

          {/* Selected placed sensor detail */}
          {selectedPlac && (
            <div className="bg-slate-800 rounded-xl border border-blue-700/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-white">{selectedPlac.sensorName}</p>
                  <p className="text-xs text-slate-400">{selectedPlac.classifiedType === 'ceiling' ? 'Ceiling / AC sensor' : 'Desk sensor'}</p>
                </div>
                <button onClick={() => setSelectedPlacKey(null)} className="text-slate-500 hover:text-white"><X size={15} /></button>
              </div>

              {selectedPlacScore && selectedPlac.classifiedType === 'desk' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: selectedPlacScore.color }}
                    />
                    <span className="text-sm font-bold text-white font-mono">{selectedPlacScore.temp.toFixed(1)}°C</span>
                    <span
                      className="text-xs font-semibold px-2 py-0.5 rounded-full"
                      style={{ backgroundColor: selectedPlacScore.color + '33', color: selectedPlacScore.color }}
                    >
                      {selectedPlacScore.label}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <span className="text-slate-400">Score</span>
                    <span className="font-mono text-white">{(selectedPlacScore.score * 100).toFixed(0)} / 100</span>
                    <span className="text-slate-400">δ-setpoint</span>
                    <span className="font-mono text-orange-300">{selectedPlacScore.deltaSetpoint >= 0 ? '+' : ''}{selectedPlacScore.deltaSetpoint.toFixed(1)}°C</span>
                    <span className="text-slate-400">Local dev.</span>
                    <span className="font-mono text-orange-300">{selectedPlacScore.localDeviation >= 0 ? '+' : ''}{selectedPlacScore.localDeviation.toFixed(1)}°C</span>
                  </div>
                  {/* Score bar */}
                  <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${selectedPlacScore.score * 100}%`, backgroundColor: selectedPlacScore.color }}
                    />
                  </div>
                </div>
              )}

              {selectedPlac.classifiedType === 'ceiling' && (
                <div className="space-y-2 text-xs">
                  {selectedPlac.role === 'supply_air' ? (
                    <p className="text-sky-400">Supply Air Temp sensor — excluded from zone averages (shows refrigeration diagnostic only)</p>
                  ) : (
                    <p className="text-slate-400">Ceiling-level sensor — measures upper room ambient air temp</p>
                  )}
                  {selectedPlac.flowDirection != null && (
                    <div className="flex items-center gap-2 text-slate-300">
                      <Wind size={11} className="text-sky-400" />
                      Airflow: {DIRECTIONS_8.find(d => d.deg === selectedPlac.flowDirection)?.label ?? `${selectedPlac.flowDirection}°`}
                      <button
                        onClick={() => setPendingFlowKey(selectedPlac.sensorKey)}
                        className="text-slate-500 hover:text-sky-400 transition-colors text-xs"
                      >
                        change
                      </button>
                    </div>
                  )}
                  {selectedPlac.flowDirection == null && (
                    <button
                      onClick={() => setPendingFlowKey(selectedPlac.sensorKey)}
                      className="flex items-center gap-1.5 text-sky-400 hover:text-sky-300 transition-colors"
                    >
                      <Wind size={11} /> Set airflow direction
                    </button>
                  )}
                </div>
              )}

              {/* Role controls */}
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => handleRoleToggle(selectedPlac.sensorKey)}
                  className={`text-xs px-2 py-1 rounded-lg border transition-colors ${selectedPlac.role === 'excluded' ? 'border-red-500 text-red-400 bg-red-900/20' : 'border-slate-600 text-slate-400 hover:border-red-500 hover:text-red-400'}`}
                >
                  {selectedPlac.role === 'excluded' ? 'Excluded' : 'Exclude'}
                </button>
                {selectedPlac.classifiedType === 'ceiling' && (
                  <button
                    onClick={() => handleSetSupplyAir(selectedPlac.sensorKey)}
                    className={`text-xs px-2 py-1 rounded-lg border transition-colors ${selectedPlac.role === 'supply_air' ? 'border-sky-500 text-sky-400 bg-sky-900/20' : 'border-slate-600 text-slate-400 hover:border-sky-500 hover:text-sky-400'}`}
                  >
                    {selectedPlac.role === 'supply_air' ? 'Supply Air ✓' : 'Mark Supply Air'}
                  </button>
                )}
                <button
                  onClick={() => handleRemovePlacement(selectedPlac.sensorKey)}
                  className="text-xs px-2 py-1 rounded-lg border border-slate-600 text-slate-500 hover:text-red-400 hover:border-red-500 transition-colors"
                >
                  Remove
                </button>
              </div>
            </div>
          )}

          {/* Hot pocket zone summary */}
          {hotPocketResults.length > 0 && !selectedPlac && (
            <div className="bg-slate-800 rounded-xl border border-slate-700 p-4 space-y-3">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                <Layers size={11} className="text-orange-400" /> Hot Pocket Scores
              </p>
              <p className="text-[10px] text-slate-500">
                Score = 55% δ-setpoint + 45% local deviation.
                Thresholds are configurable — not industry standards.
              </p>
              {hotPocketResults.map(zr => (
                <div key={zr.zoneId}>
                  <p className="text-[10px] text-slate-500 mb-1">{zr.zoneId}</p>
                  {zr.deskScores.length === 0 && (
                    <p className="text-[10px] text-slate-600 italic">No desk sensors</p>
                  )}
                  {zr.deskScores.map(ds => (
                    <div key={ds.sensorKey} className="flex items-center gap-2 mb-1">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: ds.color }} />
                      <span className="flex-1 text-xs text-slate-300 truncate">{ds.sensorName}</span>
                      <span className="text-xs font-mono text-slate-400">{ds.temp.toFixed(1)}°</span>
                      <span className="text-[10px] font-bold" style={{ color: ds.color }}>{ds.label}</span>
                    </div>
                  ))}
                  {zr.supplyAirTemp != null && (
                    <p className="text-[10px] text-sky-500 mt-1 flex items-center gap-1">
                      <Wind size={9} /> Supply air: {zr.supplyAirTemp.toFixed(1)}°C
                    </p>
                  )}
                  <p className="text-[10px] text-slate-600 mt-1">
                    Stratification: {zr.stratification >= 0 ? '+' : ''}{zr.stratification.toFixed(1)}°C (ceiling vs desk)
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Zone detail panel (existing) */}
          {selectedShape && selectedData && !selectedPlac ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between bg-slate-800 rounded-xl border border-slate-700 px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-white">{selectedShape.label}</p>
                  <p className="text-xs text-slate-400 mt-0.5">at {fmtMinute(localMinute)}</p>
                </div>
                <button onClick={() => setSelectedShapeId(null)} className="text-slate-500 hover:text-white">
                  <X size={16} />
                </button>
              </div>

              <div
                className="rounded-xl border p-4"
                style={{ borderColor: selectedStatus.borderColor, backgroundColor: selectedStatus.bgColor }}
              >
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Thermal Status</p>
                  {selectedData.deviation !== null && selectedData.deviation > 3 && (
                    <AlertTriangle size={14} className="text-red-400" />
                  )}
                </div>
                <div className="flex items-end gap-3 mb-3">
                  <span className="text-4xl font-bold font-mono leading-none" style={{ color: selectedStatus.textColor }}>
                    {selectedData.actualTemp != null ? `${selectedData.actualTemp.toFixed(1)}°C` : '—'}
                  </span>
                  <span className="text-xs text-slate-400 pb-1 leading-snug">desk sensor<br />reading</span>
                </div>
                <div className="flex items-center justify-between text-xs mb-2">
                  <span className="text-slate-400">AC Setpoint</span>
                  <span className="font-mono text-slate-300">{selectedData.setpoint.toFixed(1)}°C</span>
                </div>
                <div className="flex items-center justify-between text-xs mb-3">
                  <span className="text-slate-400">Deviation</span>
                  <span className="font-mono font-semibold" style={{ color: selectedStatus.textColor }}>
                    {selectedData.deviation != null
                      ? `${selectedData.deviation >= 0 ? '+' : ''}${selectedData.deviation.toFixed(1)}°C`
                      : '—'}
                  </span>
                </div>
                <div
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border"
                  style={{ color: selectedStatus.textColor, borderColor: selectedStatus.borderColor, backgroundColor: selectedStatus.bgColor }}
                >
                  <Thermometer size={11} />
                  {selectedStatus.label}
                </div>
                {selectedData.deviation !== null && selectedData.deviation > 3 && (
                  <p className="text-xs text-red-400 mt-3 leading-relaxed">
                    This zone is not receiving adequate cooling — the desk-level temperature
                    is significantly above the AC setpoint.
                  </p>
                )}
              </div>

              {slotData && (
                <div className="bg-slate-800 rounded-xl border border-slate-700 p-4 space-y-2">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Info size={12} className="text-blue-400" /> Heat Source Breakdown
                  </p>
                  {breakdownItems.length === 0 && (
                    <p className="text-xs text-slate-500">No significant heat load at this hour.</p>
                  )}
                  {breakdownItems.map(item => (
                    <div key={item.label}>
                      <div className="flex justify-between text-xs text-slate-400 mb-1">
                        <span>{item.label}</span>
                        <span className="font-mono">{item.pct.toFixed(0)}%  {(item.value / 1000).toFixed(2)} kW</span>
                      </div>
                      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-300"
                          style={{ width: `${Math.min(100, item.pct)}%`, backgroundColor: item.color }}
                        />
                      </div>
                    </div>
                  ))}
                  <p className="text-xs text-slate-500 pt-1">
                    Simulated total:{' '}
                    <span className="font-mono text-slate-400">{(slotData.totalHeatLoad / 1000).toFixed(2)} kW</span>
                  </p>
                </div>
              )}
            </div>
          ) : !selectedShape && !selectedPlac && (
            <div className="bg-slate-900 rounded-xl border border-dashed border-slate-700 flex items-center justify-center p-6 text-center">
              <div>
                <Thermometer size={28} className="text-slate-700 mx-auto mb-2" />
                <p className="text-xs text-slate-500">
                  Click any zone to inspect desk sensor vs AC setpoint.
                </p>
                {showSidebar && (
                  <p className="text-xs text-slate-600 mt-1">
                    Or drag a sensor from the sidebar to place it on the map.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Flow direction modal */}
      {pendingFlowKey && (
        <FlowDirectionModal
          onSelect={handleFlowSelect}
          onSkip={() => setPendingFlowKey(null)}
        />
      )}
    </div>
  );
};

export default HeatPocketMap;

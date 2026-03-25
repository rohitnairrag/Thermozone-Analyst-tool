/**
 * FloorPlanEditor.tsx
 *
 * Full-office interactive 2-D floor plan editor.
 *
 * Features
 * ─────────
 * • Renders all zone polygons from wall-vector definitions (SVG)
 * • Click any wall → edit its length in metres; add or delete walls via toolbar
 * • Drag zones to reposition them on the canvas
 * • Left sidebar lists all sensors (desk / ceiling) for the selected zone;
 *   drag them onto the canvas to set their position
 * • Ceiling sensors also act as AC anchors: after dropping one, pick airflow direction
 * • Click a placed sensor → right detail panel shows hot-pocket metrics
 * • "Show Heatmap" toggle renders an IDW gradient canvas overlay
 */

import React, {
  useState, useRef, useEffect, useCallback, useMemo,
} from 'react';
import {
  Eye, EyeOff, Plus, Trash2, X, Move, Thermometer,
  Wind, ArrowRight, Settings,
} from 'lucide-react';
import {
  ZoneProfile, WallDef, Direction, ConstructionType,
  SensorPlacement, ZoneOffset, OfficeFloorPlan,
} from '../types';
import { AllSensorsData } from '../services/liveDataService';
import {
  computeZoneHotPockets, SensorWithTemp, HotPocketScore,
  scoreToColor, DEFAULT_HOT_POCKET_CONFIG, HotPocketConfig,
} from '../services/hotPocketEngine';
import { renderIDWToCanvas, IDWPoint } from '../utils/idwInterpolation';

// ── constants ──────────────────────────────────────────────────────────────

const SCALE = 50;     // SVG pixels per metre
const MARGIN = 2;     // metres of padding around the layout
const ZONE_GAP = 3;   // metres between auto-placed zones

// ── geometry helpers ────────────────────────────────────────────────────────

interface Point { x: number; y: number }

/** Compute polygon vertices (in metres, relative to zone origin) from wall list. */
function wallsToPolyMetres(walls: WallDef[]): Point[] {
  const pts: Point[] = [{ x: 0, y: 0 }];
  let x = 0, y = 0;
  for (const w of walls) {
    const az = w.azimuth * Math.PI / 180;
    x += w.lengthM * Math.sin(az);
    y -= w.lengthM * Math.cos(az); // SVG y-down
    pts.push({ x, y });
  }
  return pts;
}

/** Compute the wall midpoint in metres (relative to zone origin). */
function wallMidpoint(walls: WallDef[], wallIndex: number): Point {
  const pts = wallsToPolyMetres(walls);
  const a = pts[wallIndex];
  const b = pts[wallIndex + 1] ?? pts[0];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Compute axis-aligned bounding box in metres (relative to zone origin). */
function zoneBBox(walls: WallDef[]): { minX: number; maxX: number; minY: number; maxY: number } {
  const pts = wallsToPolyMetres(walls);
  return {
    minX: Math.min(...pts.map(p => p.x)),
    maxX: Math.max(...pts.map(p => p.x)),
    minY: Math.min(...pts.map(p => p.y)),
    maxY: Math.max(...pts.map(p => p.y)),
  };
}

/** Compute centroid of polygon vertices. */
function zoneCentroid(walls: WallDef[]): Point {
  const pts = wallsToPolyMetres(walls);
  const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return { x, y };
}

/** Auto-compute initial zone offsets: row layout with ZONE_GAP spacing. */
function computeDefaultOffsets(zones: ZoneProfile[]): ZoneOffset[] {
  const offsets: ZoneOffset[] = [];
  let cursorX = MARGIN;
  for (const z of zones) {
    const bb = zoneBBox(z.zone.walls);
    offsets.push({
      zoneId:  z.id,
      offsetX: cursorX - bb.minX,
      offsetY: MARGIN  - bb.minY,
    });
    cursorX += (bb.maxX - bb.minX) + ZONE_GAP;
  }
  return offsets;
}

/** Merge saved offsets with any newly-added zones. */
function mergeOffsets(zones: ZoneProfile[], saved: ZoneOffset[]): ZoneOffset[] {
  const defaults = computeDefaultOffsets(zones);
  return zones.map(z => {
    const saved_ = saved.find(o => o.zoneId === z.id);
    return saved_ ?? defaults.find(o => o.zoneId === z.id)!;
  });
}

// ── sensor classification helper (mirrors ResultsDashboard logic) ────────────

function classifySensor(
  name: string,
  temp: number,
  sensorPositions: Record<string, string> | undefined,
  hasDeskSensors: boolean | undefined,
  otherTemps: number[],
): 'desk' | 'ceiling' | 'excluded' {
  if (hasDeskSensors === false) return 'excluded';
  if (sensorPositions) {
    const pos = sensorPositions[name];
    if (pos === 'desk')     return 'desk';
    if (pos === 'ac_level') return 'ceiling';
    if (pos === 'exclude')  return 'excluded';
  }
  const otherAvg = otherTemps.length > 0
    ? otherTemps.reduce((a, b) => a + b, 0) / otherTemps.length
    : 25;
  if (temp < 20 && otherAvg > 24) return 'excluded';
  return name.toLowerCase().includes('ac') ? 'ceiling' : 'desk';
}

// ── flow-direction helpers ──────────────────────────────────────────────────

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

// ── sub-components ──────────────────────────────────────────────────────────

/** Small popover for editing wall length inline. */
function WallEditPopover({
  wallLength,
  onSave,
  onDelete,
  onClose,
  svgX,
  svgY,
}: {
  wallLength: number;
  onSave: (len: number) => void;
  onDelete: () => void;
  onClose: () => void;
  svgX: number;
  svgY: number;
}) {
  const [val, setVal] = useState(wallLength.toFixed(2));
  return (
    <div
      style={{ position: 'absolute', left: svgX + 8, top: svgY - 24, zIndex: 50 }}
      className="bg-slate-800 border border-slate-600 rounded-xl shadow-xl p-3 flex flex-col gap-2 w-48"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-400 font-semibold uppercase">Wall Length</span>
        <button onClick={onClose} className="text-slate-500 hover:text-white"><X size={12} /></button>
      </div>
      <div className="flex items-center gap-1">
        <input
          type="number"
          value={val}
          step="0.1"
          min="0.5"
          onChange={e => setVal(e.target.value)}
          className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-white text-sm outline-none focus:border-blue-500"
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter') onSave(parseFloat(val) || wallLength); }}
        />
        <span className="text-slate-400 text-xs">m</span>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onSave(parseFloat(val) || wallLength)}
          className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg py-1 font-medium"
        >
          Save
        </button>
        <button
          onClick={onDelete}
          className="px-2 py-1 text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded-lg"
          title="Delete wall"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

/** Modal for selecting AC airflow direction after placing a ceiling sensor. */
function FlowDirectionModal({
  onSelect,
  onSkip,
}: {
  onSelect: (deg: number) => void;
  onSkip: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-slate-800 border border-slate-600 rounded-2xl p-6 w-72 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-semibold">AC Airflow Direction</h3>
          <button onClick={onSkip} className="text-slate-500 hover:text-white"><X size={16} /></button>
        </div>
        <p className="text-slate-400 text-xs mb-4">
          Which direction does this AC unit blow cold air toward?
        </p>
        <div className="grid grid-cols-3 gap-2">
          {DIRECTIONS_8.map(d => (
            <button
              key={d.deg}
              onClick={() => onSelect(d.deg)}
              className="bg-slate-700 hover:bg-blue-600 text-white text-sm rounded-lg py-2 font-medium transition-colors"
            >
              {d.label}
            </button>
          ))}
        </div>
        <button onClick={onSkip} className="mt-4 w-full text-slate-400 hover:text-white text-xs py-1">
          Skip (set later)
        </button>
      </div>
    </div>
  );
}

/** Add-wall dialog. */
function AddWallDialog({
  onAdd,
  onClose,
}: {
  onAdd: (wall: Omit<WallDef, 'id'>) => void;
  onClose: () => void;
}) {
  const [len, setLen]  = useState(3);
  const [dir, setDir]  = useState<Direction>('N');
  const [type, setType] = useState<'external' | 'internal'>('external');
  const [ctor, setCtor] = useState<ConstructionType>('opaque');
  const AZIMUTH_MAP: Record<string, number> = {
    N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315,
  };
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-slate-800 border border-slate-600 rounded-2xl p-6 w-80 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-semibold">Add Wall</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-white"><X size={16} /></button>
        </div>
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-slate-400 uppercase font-semibold">Length (m)</span>
            <input type="number" value={len} min={0.5} step={0.1}
              onChange={e => setLen(parseFloat(e.target.value) || 1)}
              className="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm outline-none focus:border-blue-500"
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-400 uppercase font-semibold">Direction</span>
            <select value={dir} onChange={e => setDir(e.target.value as Direction)}
              className="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm outline-none">
              {(['N','NE','E','SE','S','SW','W','NW'] as Direction[]).map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-slate-400 uppercase font-semibold">Wall Type</span>
            <select value={type} onChange={e => setType(e.target.value as 'external'|'internal')}
              className="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm outline-none">
              <option value="external">External</option>
              <option value="internal">Internal (partition)</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-slate-400 uppercase font-semibold">Construction</span>
            <select value={ctor} onChange={e => setCtor(e.target.value as ConstructionType)}
              className="mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm outline-none">
              <option value="opaque">Opaque</option>
              <option value="mixed">Mixed (with windows)</option>
              <option value="full_glass">Full Glass</option>
            </select>
          </label>
        </div>
        <div className="flex gap-2 mt-5">
          <button onClick={onClose}
            className="flex-1 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg py-2">
            Cancel
          </button>
          <button
            onClick={() => onAdd({ lengthM: len, direction: dir, azimuth: AZIMUTH_MAP[dir],
              wallType: type, constructionType: ctor })}
            className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg py-2 font-medium">
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

// ── main component ──────────────────────────────────────────────────────────

export interface FloorPlanEditorProps {
  zones:         ZoneProfile[];
  setZones:      (zones: ZoneProfile[]) => void;
  allLiveSensors: AllSensorsData | null;
  floorPlan:     OfficeFloorPlan;
  setFloorPlan:  (fp: OfficeFloorPlan) => void;
}

const FloorPlanEditor: React.FC<FloorPlanEditorProps> = ({
  zones, setZones, allLiveSensors, floorPlan, setFloorPlan,
}) => {

  // ── local UI state ────────────────────────────────────────────────────────
  const [showHeatmap,  setShowHeatmap]  = useState(false);
  const [hoveredWall,  setHoveredWall]  = useState<{ zoneId: string; wallIdx: number } | null>(null);
  const [selectedWall, setSelectedWall] = useState<{
    zoneId: string; wallIdx: number; svgX: number; svgY: number;
  } | null>(null);
  const [showAddWall,    setShowAddWall]    = useState(false);
  const [addWallZoneId,  setAddWallZoneId]  = useState<string | null>(null);
  const [selectedSensorKey,     setSelectedSensorKey]     = useState<string | null>(null);
  const [pendingFlowSensorKey,  setPendingFlowSensorKey]  = useState<string | null>(null);
  const [sidebarZoneId,  setSidebarZoneId]  = useState<string>(zones[0]?.id ?? '');
  const [config, setConfig] = useState<HotPocketConfig>(DEFAULT_HOT_POCKET_CONFIG);
  const [showConfig, setShowConfig] = useState(false);

  // Zone drag state
  const zoneDragRef = useRef<{
    zoneId: string; startSvgX: number; startSvgY: number;
    startOffX: number; startOffY: number;
  } | null>(null);

  // Sensor drag from sidebar
  const dragSensorRef = useRef<{ key: string; name: string; classifiedType: 'desk'|'ceiling'; zoneId: string } | null>(null);

  const svgRef       = useRef<SVGSVGElement>(null);
  const heatmapRef   = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── derived data ──────────────────────────────────────────────────────────

  /** Effective zone offsets: merge saved with defaults for any new zones. */
  const zoneOffsets = useMemo(
    () => mergeOffsets(zones, floorPlan.zoneOffsets),
    [zones, floorPlan.zoneOffsets],
  );

  const getOffset = useCallback(
    (zoneId: string): ZoneOffset =>
      zoneOffsets.find(o => o.zoneId === zoneId) ?? { zoneId, offsetX: MARGIN, offsetY: MARGIN },
    [zoneOffsets],
  );

  /** Convert metres → SVG pixels. */
  const mToSvg = (m: number) => m * SCALE;

  /** Convert a zone-local point (metres) to SVG pixels. */
  const toSVG = (zoneId: string, local: Point): Point => {
    const off = getOffset(zoneId);
    return {
      x: (off.offsetX + local.x) * SCALE,
      y: (off.offsetY + local.y) * SCALE,
    };
  };

  /** SVG viewport size (based on all zone polygons). */
  const svgSize = useMemo(() => {
    let maxX = 0, maxY = 0;
    for (const z of zones) {
      const bb  = zoneBBox(z.zone.walls);
      const off = getOffset(z.id);
      maxX = Math.max(maxX, off.offsetX + bb.maxX + MARGIN);
      maxY = Math.max(maxY, off.offsetY + bb.maxY + MARGIN);
    }
    return { width: maxX * SCALE, height: maxY * SCALE };
  }, [zones, zoneOffsets]);

  /** Build sensor list from allLiveSensors for the currently selected sidebar zone. */
  const sidebarZone = useMemo(() => zones.find(z => z.id === sidebarZoneId), [zones, sidebarZoneId]);

  const sidebarSensors = useMemo(() => {
    if (!allLiveSensors || !sidebarZone) return { desk: [], ceiling: [] };
    const zoneName = sidebarZone.zone.name;
    const zoneSensors = allLiveSensors.sensors.filter(s => s.effectiveZone === zoneName);
    const others = zoneSensors.map(s => s.temp);
    const desk: typeof zoneSensors = [];
    const ceiling: typeof zoneSensors = [];
    for (const s of zoneSensors) {
      const cl = classifySensor(
        s.name, s.temp,
        sidebarZone.sensorPositions,
        sidebarZone.hasDeskSensors,
        others.filter(t => t !== s.temp),
      );
      if (cl === 'desk')    desk.push(s);
      if (cl === 'ceiling') ceiling.push(s);
    }
    return { desk, ceiling };
  }, [allLiveSensors, sidebarZone]);

  /** All placed sensors as a lookup map. */
  const placedMap = useMemo(
    () => new Map(floorPlan.sensors.map(s => [s.sensorKey, s])),
    [floorPlan.sensors],
  );

  /** Build SensorWithTemp[] for hot-pocket engine from all zones. */
  const sensorsForEngine = useMemo((): SensorWithTemp[] => {
    if (!allLiveSensors) return [];
    const result: SensorWithTemp[] = [];
    for (const z of zones) {
      const zoneSensors = allLiveSensors.sensors.filter(s => s.effectiveZone === z.zone.name);
      const others = zoneSensors.map(s => s.temp);
      for (const s of zoneSensors) {
        const cl = classifySensor(
          s.name, s.temp, z.sensorPositions, z.hasDeskSensors,
          others.filter(t => t !== s.temp),
        );
        const placed  = placedMap.get(s.key);
        const role    = placed?.role ?? (cl === 'excluded' ? 'excluded' : 'normal');
        result.push({
          key: s.key, name: s.name, temp: s.temp,
          classifiedType: cl === 'excluded' ? 'desk' : cl,
          role,
          zoneId:  z.id,
          setpoint: s.setpoint,
        });
      }
    }
    return result;
  }, [allLiveSensors, zones, placedMap]);

  const hotPocketResults = useMemo(
    () => computeZoneHotPockets(sensorsForEngine.filter(s => s.role !== 'excluded'), config),
    [sensorsForEngine, config],
  );

  const hotPocketMap = useMemo(() => {
    const m = new Map<string, HotPocketScore>();
    for (const r of hotPocketResults) {
      for (const s of r.deskScores) m.set(s.sensorKey, s);
    }
    return m;
  }, [hotPocketResults]);

  // ── heatmap rendering ─────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = heatmapRef.current;
    if (!canvas || !showHeatmap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Build IDW control points from placed desk sensors that have scores
    const points: IDWPoint[] = [];
    for (const sp of floorPlan.sensors) {
      if (sp.classifiedType !== 'desk' || sp.role !== 'normal') continue;
      const score = hotPocketMap.get(sp.sensorKey);
      if (!score) continue;
      const off = getOffset(sp.zoneId);
      points.push({
        x: (off.offsetX + sp.x) * SCALE,
        y: (off.offsetY + sp.y) * SCALE,
        value: score.score,
      });
    }

    if (points.length > 0) {
      renderIDWToCanvas(ctx, points, canvas.width, canvas.height, 8, 0.55);
    }
  }, [showHeatmap, floorPlan.sensors, hotPocketMap, zoneOffsets, svgSize]);

  // ── floorPlan mutators ────────────────────────────────────────────────────

  const updateOffset = useCallback((zoneId: string, offsetX: number, offsetY: number) => {
    setFloorPlan({
      ...floorPlan,
      zoneOffsets: zoneOffsets.map(o => o.zoneId === zoneId ? { zoneId, offsetX, offsetY } : o),
    });
  }, [floorPlan, zoneOffsets, setFloorPlan]);

  const placeSensor = useCallback((sp: SensorPlacement) => {
    setFloorPlan({
      ...floorPlan,
      sensors: [...floorPlan.sensors.filter(s => s.sensorKey !== sp.sensorKey), sp],
    });
  }, [floorPlan, setFloorPlan]);

  const removePlacedSensor = useCallback((key: string) => {
    setFloorPlan({ ...floorPlan, sensors: floorPlan.sensors.filter(s => s.sensorKey !== key) });
    if (selectedSensorKey === key) setSelectedSensorKey(null);
  }, [floorPlan, setFloorPlan, selectedSensorKey]);

  const updateSensorRole = useCallback((key: string, role: SensorPlacement['role']) => {
    setFloorPlan({
      ...floorPlan,
      sensors: floorPlan.sensors.map(s => s.sensorKey === key ? { ...s, role } : s),
    });
  }, [floorPlan, setFloorPlan]);

  const updateSensorPosition = useCallback((key: string, x: number, y: number) => {
    setFloorPlan({
      ...floorPlan,
      sensors: floorPlan.sensors.map(s => s.sensorKey === key ? { ...s, x, y } : s),
    });
  }, [floorPlan, setFloorPlan]);

  const updateSensorFlow = useCallback((key: string, deg: number) => {
    setFloorPlan({
      ...floorPlan,
      sensors: floorPlan.sensors.map(s => s.sensorKey === key ? { ...s, flowDirection: deg } : s),
    });
    setPendingFlowSensorKey(null);
  }, [floorPlan, setFloorPlan]);

  // ── wall mutators ─────────────────────────────────────────────────────────

  const updateWallLength = (zoneId: string, wallIdx: number, len: number) => {
    setZones(zones.map(z => z.id !== zoneId ? z : {
      ...z,
      zone: {
        ...z.zone,
        walls: z.zone.walls.map((w, i) => i === wallIdx ? { ...w, lengthM: len } : w),
      },
    }));
    setSelectedWall(null);
  };

  const deleteWall = (zoneId: string, wallIdx: number) => {
    setZones(zones.map(z => z.id !== zoneId ? z : {
      ...z,
      zone: {
        ...z.zone,
        walls: z.zone.walls.filter((_, i) => i !== wallIdx),
      },
    }));
    setSelectedWall(null);
  };

  const addWall = (wall: Omit<WallDef, 'id'>) => {
    const zid = addWallZoneId ?? zones[0]?.id;
    if (!zid) return;
    const newId = `w-${Date.now()}`;
    setZones(zones.map(z => z.id !== zid ? z : {
      ...z,
      zone: { ...z.zone, walls: [...z.zone.walls, { id: newId, ...wall }] },
    }));
    setShowAddWall(false);
    setAddWallZoneId(null);
  };

  // ── SVG interaction (zone drag + wall click) ──────────────────────────────

  const svgCoordsFromEvent = (e: React.MouseEvent<SVGSVGElement>): Point => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left),
      y: (e.clientY - rect.top),
    };
  };

  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!zoneDragRef.current) return;
    const { zoneId, startSvgX, startSvgY, startOffX, startOffY } = zoneDragRef.current;
    const cur = svgCoordsFromEvent(e);
    const dxM = (cur.x - startSvgX) / SCALE;
    const dyM = (cur.y - startSvgY) / SCALE;
    updateOffset(zoneId, startOffX + dxM, startOffY + dyM);
  };

  const handleSvgMouseUp = () => {
    zoneDragRef.current = null;
  };

  const startZoneDrag = (e: React.MouseEvent, zoneId: string) => {
    e.stopPropagation();
    const cur = svgCoordsFromEvent(e as any);
    const off = getOffset(zoneId);
    zoneDragRef.current = {
      zoneId,
      startSvgX: cur.x, startSvgY: cur.y,
      startOffX: off.offsetX, startOffY: off.offsetY,
    };
  };

  const handleWallClick = (e: React.MouseEvent, zoneId: string, wallIdx: number, svgX: number, svgY: number) => {
    e.stopPropagation();
    setSelectedWall({ zoneId, wallIdx, svgX, svgY });
  };

  // ── canvas drop (place sensor) ────────────────────────────────────────────

  const handleCanvasDragOver = (e: React.DragEvent) => { e.preventDefault(); };

  const handleCanvasDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const drag = dragSensorRef.current;
    if (!drag) return;

    const rect = svgRef.current!.getBoundingClientRect();
    const svgX = e.clientX - rect.left;
    const svgY = e.clientY - rect.top;

    // Find which zone this point falls in (closest zone offset anchor)
    // Simple: the zone whose centroid SVG position is nearest to the drop
    const zoneId = drag.zoneId;
    const off    = getOffset(zoneId);
    const xM     = svgX / SCALE - off.offsetX;
    const yM     = svgY / SCALE - off.offsetY;

    const newPlacement: SensorPlacement = {
      sensorKey:      drag.key,
      sensorName:     drag.name,
      classifiedType: drag.classifiedType,
      role:           'normal',
      zoneId,
      x: parseFloat(xM.toFixed(2)),
      y: parseFloat(yM.toFixed(2)),
    };

    placeSensor(newPlacement);
    dragSensorRef.current = null;

    if (drag.classifiedType === 'ceiling') {
      setPendingFlowSensorKey(drag.key);
    }
  };

  // ── placed sensor drag (reposition) ──────────────────────────────────────

  const placedSensorDragRef = useRef<{ key: string; zoneId: string } | null>(null);

  const handlePlacedSensorMouseDown = (e: React.MouseEvent, key: string, zoneId: string) => {
    e.stopPropagation();
    placedSensorDragRef.current = { key, zoneId };
  };

  const handleSvgMouseMoveForSensor = (e: React.MouseEvent<SVGSVGElement>) => {
    if (placedSensorDragRef.current) {
      const { key, zoneId } = placedSensorDragRef.current;
      const cur = svgCoordsFromEvent(e);
      const off = getOffset(zoneId);
      const xM  = parseFloat((cur.x / SCALE - off.offsetX).toFixed(2));
      const yM  = parseFloat((cur.y / SCALE - off.offsetY).toFixed(2));
      updateSensorPosition(key, xM, yM);
    }
    handleSvgMouseMove(e);
  };

  const handleSvgMouseUpAll = () => {
    placedSensorDragRef.current = null;
    handleSvgMouseUp();
  };

  // ── selected sensor detail ────────────────────────────────────────────────

  const selectedSensor = selectedSensorKey ? placedMap.get(selectedSensorKey) : null;
  const selectedScore  = selectedSensorKey ? hotPocketMap.get(selectedSensorKey) : null;
  const selectedLiveData = allLiveSensors?.sensors.find(s => s.key === selectedSensorKey);

  // Nearest AC (ceiling sensor) distance
  const nearestAcDistance = useMemo(() => {
    if (!selectedSensor) return null;
    const acs = floorPlan.sensors.filter(
      s => s.classifiedType === 'ceiling' && s.zoneId === selectedSensor.zoneId && s.role !== 'excluded',
    );
    if (acs.length === 0) return null;
    const dists = acs.map(a => Math.sqrt((a.x - selectedSensor.x) ** 2 + (a.y - selectedSensor.y) ** 2));
    return Math.min(...dists).toFixed(1);
  }, [selectedSensor, floorPlan.sensors]);

  // ── render ────────────────────────────────────────────────────────────────

  const totalWidth  = svgSize.width  + 300; // sidebar

  return (
    <div className="flex flex-col h-full select-none" ref={containerRef}>

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-3 px-4 py-3 bg-slate-900/60 border-b border-slate-800 flex-wrap">
        <span className="text-white font-semibold text-sm">Floor Plan Editor</span>
        <div className="h-4 w-px bg-slate-700" />

        {/* Zone selector for "Add Wall" */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Zone:</span>
          <select
            value={addWallZoneId ?? zones[0]?.id ?? ''}
            onChange={e => setAddWallZoneId(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-white text-xs rounded-lg px-2 py-1 outline-none"
          >
            {zones.map(z => <option key={z.id} value={z.id}>{z.zone.displayName || z.zone.name}</option>)}
          </select>
          <button
            onClick={() => setShowAddWall(true)}
            className="flex items-center gap-1 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded-lg px-2 py-1"
          >
            <Plus size={12} /> Add Wall
          </button>
        </div>

        <div className="h-4 w-px bg-slate-700" />

        <button
          onClick={() => setShowHeatmap(h => !h)}
          className={`flex items-center gap-1 text-xs rounded-lg px-3 py-1.5 font-medium transition-all ${
            showHeatmap ? 'bg-orange-600 text-white' : 'bg-slate-700 text-slate-300 hover:text-white'
          }`}
        >
          {showHeatmap ? <Eye size={12} /> : <EyeOff size={12} />}
          {showHeatmap ? 'Hide Heatmap' : 'Show Heatmap'}
        </button>

        <button
          onClick={() => setShowConfig(c => !c)}
          className="flex items-center gap-1 text-xs rounded-lg px-2 py-1.5 text-slate-400 hover:text-white hover:bg-slate-700"
          title="Threshold settings"
        >
          <Settings size={12} />
        </button>

        {showConfig && (
          <div className="flex items-center gap-4 bg-slate-800 rounded-lg px-3 py-2 border border-slate-700">
            <label className="text-xs text-slate-400">
              Δ Setpoint max
              <input type="number" value={config.deltaSetpointMax} step={0.5} min={1}
                onChange={e => setConfig(c => ({ ...c, deltaSetpointMax: parseFloat(e.target.value) || 4 }))}
                className="ml-2 w-12 bg-slate-900 border border-slate-600 rounded px-1 py-0.5 text-white text-xs outline-none"
              />
              °C
            </label>
            <label className="text-xs text-slate-400">
              Zone deviation max
              <input type="number" value={config.localDeviationMax} step={0.5} min={0.5}
                onChange={e => setConfig(c => ({ ...c, localDeviationMax: parseFloat(e.target.value) || 3 }))}
                className="ml-2 w-12 bg-slate-900 border border-slate-600 rounded px-1 py-0.5 text-white text-xs outline-none"
              />
              °C
            </label>
          </div>
        )}

        {!allLiveSensors && (
          <span className="text-xs text-yellow-400 ml-auto">Live sensor data not loaded — open Sensors tab first</span>
        )}
      </div>

      {/* ── Main content ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left sidebar (sensor palette) ── */}
        <div className="w-60 min-w-[15rem] bg-slate-900/40 border-r border-slate-800 flex flex-col overflow-y-auto">
          <div className="p-3 border-b border-slate-800">
            <span className="text-xs text-slate-400 uppercase font-semibold">Sensor Palette</span>
            <select
              value={sidebarZoneId}
              onChange={e => setSidebarZoneId(e.target.value)}
              className="mt-2 w-full bg-slate-800 border border-slate-700 text-white text-xs rounded-lg px-2 py-1.5 outline-none"
            >
              {zones.map(z => <option key={z.id} value={z.id}>{z.zone.displayName || z.zone.name}</option>)}
            </select>
            <p className="text-xs text-slate-500 mt-2">Drag sensors onto the floor plan to place them.</p>
          </div>

          {/* Desk sensors */}
          <SensorGroup
            label="Desk Sensors"
            color="#f97316"
            sensors={sidebarSensors.desk}
            classifiedType="desk"
            zoneId={sidebarZoneId}
            placedMap={placedMap}
            dragSensorRef={dragSensorRef}
            hotPocketMap={hotPocketMap}
          />

          {/* Ceiling / AC sensors */}
          <SensorGroup
            label="Ceiling / AC Sensors"
            color="#22d3ee"
            sensors={sidebarSensors.ceiling}
            classifiedType="ceiling"
            zoneId={sidebarZoneId}
            placedMap={placedMap}
            dragSensorRef={dragSensorRef}
            hotPocketMap={hotPocketMap}
          />
        </div>

        {/* ── SVG Canvas ── */}
        <div className="flex-1 overflow-auto relative bg-slate-950">
          <div style={{ position: 'relative', width: svgSize.width, height: svgSize.height }}>

            {/* Heatmap canvas overlay */}
            <canvas
              ref={heatmapRef}
              width={svgSize.width}
              height={svgSize.height}
              style={{
                position: 'absolute', top: 0, left: 0,
                pointerEvents: 'none',
                display: showHeatmap ? 'block' : 'none',
              }}
            />

            <svg
              ref={svgRef}
              width={svgSize.width}
              height={svgSize.height}
              style={{ display: 'block' }}
              onMouseMove={handleSvgMouseMoveForSensor}
              onMouseUp={handleSvgMouseUpAll}
              onMouseLeave={handleSvgMouseUpAll}
              onDragOver={handleCanvasDragOver}
              onDrop={handleCanvasDrop}
              onClick={() => { setSelectedWall(null); setSelectedSensorKey(null); }}
            >
              {/* Grid */}
              <defs>
                <pattern id="grid1m" width={SCALE} height={SCALE} patternUnits="userSpaceOnUse">
                  <path d={`M ${SCALE} 0 L 0 0 0 ${SCALE}`} fill="none" stroke="#1e293b" strokeWidth="0.5" />
                </pattern>
              </defs>
              <rect width={svgSize.width} height={svgSize.height} fill="url(#grid1m)" />

              {/* Zone polygons + walls */}
              {zones.map(z => {
                const off   = getOffset(z.id);
                const pts   = wallsToPolyMetres(z.zone.walls);
                const svgPts = pts.map(p => ({
                  x: (off.offsetX + p.x) * SCALE,
                  y: (off.offsetY + p.y) * SCALE,
                }));
                const polyStr = svgPts.map(p => `${p.x},${p.y}`).join(' ');
                const cen    = zoneCentroid(z.zone.walls);
                const cenSVG = toSVG(z.id, cen);

                return (
                  <g key={z.id}>
                    {/* Zone fill */}
                    <polygon
                      points={polyStr}
                      fill="#1e293b"
                      stroke="#334155"
                      strokeWidth="1.5"
                    />

                    {/* Wall segments (clickable) */}
                    {z.zone.walls.map((wall, idx) => {
                      const a   = svgPts[idx];
                      const b   = svgPts[idx + 1] ?? svgPts[0];
                      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                      const isHovered  = hoveredWall?.zoneId === z.id && hoveredWall?.wallIdx === idx;
                      const isSelected = selectedWall?.zoneId === z.id && selectedWall?.wallIdx === idx;
                      const strokeColor = isSelected ? '#3b82f6'
                                        : isHovered  ? '#60a5fa'
                                        : wall.wallType === 'external' ? '#475569' : '#334155';
                      return (
                        <g key={wall.id}>
                          {/* Invisible hit target */}
                          <line
                            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                            stroke="transparent" strokeWidth={14}
                            style={{ cursor: 'pointer' }}
                            onMouseEnter={() => setHoveredWall({ zoneId: z.id, wallIdx: idx })}
                            onMouseLeave={() => setHoveredWall(null)}
                            onClick={e => handleWallClick(e, z.id, idx, mid.x, mid.y)}
                          />
                          {/* Visible wall line */}
                          <line
                            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                            stroke={strokeColor}
                            strokeWidth={isHovered || isSelected ? 3 : 2}
                            strokeDasharray={wall.wallType === 'internal' ? '6,4' : undefined}
                            style={{ pointerEvents: 'none' }}
                          />
                          {/* Length label */}
                          {(isHovered || isSelected) && (
                            <text
                              x={mid.x} y={mid.y - 6}
                              textAnchor="middle"
                              fill="#94a3b8"
                              fontSize={10}
                              style={{ pointerEvents: 'none' }}
                            >
                              {wall.lengthM.toFixed(1)} m
                            </text>
                          )}
                        </g>
                      );
                    })}

                    {/* Zone drag handle (centroid label) */}
                    <g
                      style={{ cursor: 'move' }}
                      onMouseDown={e => startZoneDrag(e, z.id)}
                    >
                      <circle cx={cenSVG.x} cy={cenSVG.y} r={14} fill="#0f172a" stroke="#334155" />
                      <text x={cenSVG.x} y={cenSVG.y - 2} textAnchor="middle"
                        fill="#94a3b8" fontSize={8} style={{ pointerEvents: 'none' }}>
                        ⠿
                      </text>
                      <text x={cenSVG.x} y={cenSVG.y + 9} textAnchor="middle"
                        fill="#64748b" fontSize={8} style={{ pointerEvents: 'none' }}>
                        {z.zone.displayName || z.zone.name}
                      </text>
                    </g>
                  </g>
                );
              })}

              {/* Placed sensors */}
              {floorPlan.sensors.map(sp => {
                const off    = getOffset(sp.zoneId);
                const svgX   = (off.offsetX + sp.x) * SCALE;
                const svgY   = (off.offsetY + sp.y) * SCALE;
                const score  = hotPocketMap.get(sp.sensorKey);
                const color  = sp.role === 'excluded'  ? '#475569'
                             : sp.role === 'supply_air' ? '#7c3aed'
                             : sp.classifiedType === 'ceiling' ? '#22d3ee'
                             : score?.color ?? '#f97316';
                const isSelected = selectedSensorKey === sp.sensorKey;

                return (
                  <g
                    key={sp.sensorKey}
                    style={{ cursor: 'pointer' }}
                    onMouseDown={e => handlePlacedSensorMouseDown(e, sp.sensorKey, sp.zoneId)}
                    onClick={e => { e.stopPropagation(); setSelectedSensorKey(sp.sensorKey); }}
                  >
                    {/* Pulsing ring for hot pockets */}
                    {score && score.score > 0.65 && (
                      <circle cx={svgX} cy={svgY} r={14} fill="none"
                        stroke="#ef4444" strokeWidth={1.5} opacity={0.6}
                        strokeDasharray="4,2">
                        <animate attributeName="r" values="12;18;12" dur="2s" repeatCount="indefinite" />
                        <animate attributeName="opacity" values="0.6;0.2;0.6" dur="2s" repeatCount="indefinite" />
                      </circle>
                    )}
                    {sp.classifiedType === 'desk' ? (
                      <circle cx={svgX} cy={svgY} r={7}
                        fill={color} stroke={isSelected ? '#fff' : '#0f172a'} strokeWidth={isSelected ? 2 : 1} />
                    ) : (
                      <polygon
                        points={`${svgX},${svgY - 8} ${svgX + 7},${svgY + 5} ${svgX - 7},${svgY + 5}`}
                        fill={color} stroke={isSelected ? '#fff' : '#0f172a'} strokeWidth={isSelected ? 2 : 1}
                      />
                    )}
                    {/* Airflow direction arrow for ceiling sensors */}
                    {sp.classifiedType === 'ceiling' && sp.flowDirection !== undefined && (
                      <line
                        x1={svgX} y1={svgY}
                        x2={svgX + Math.sin(sp.flowDirection * Math.PI / 180) * 18}
                        y2={svgY - Math.cos(sp.flowDirection * Math.PI / 180) * 18}
                        stroke={color} strokeWidth={2} markerEnd="url(#arrowhead)"
                        style={{ pointerEvents: 'none' }}
                      />
                    )}
                    <text x={svgX} y={svgY + 18} textAnchor="middle"
                      fill="#cbd5e1" fontSize={8} style={{ pointerEvents: 'none' }}>
                      {sp.sensorName}
                    </text>
                  </g>
                );
              })}

              {/* Arrowhead marker */}
              <defs>
                <marker id="arrowhead" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
                  <polygon points="0 0, 6 2, 0 4" fill="#22d3ee" />
                </marker>
              </defs>
            </svg>
          </div>
        </div>

        {/* ── Right panel (selected sensor detail) ── */}
        {selectedSensor && (
          <div className="w-64 min-w-[16rem] bg-slate-900/60 border-l border-slate-800 overflow-y-auto p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="text-white font-semibold text-sm">{selectedSensor.sensorName}</span>
              <button onClick={() => setSelectedSensorKey(null)} className="text-slate-500 hover:text-white">
                <X size={14} />
              </button>
            </div>

            {/* Live temp */}
            {selectedLiveData && (
              <div className="bg-slate-800 rounded-xl p-3 text-center">
                <span className="text-2xl font-bold text-white">{selectedLiveData.temp.toFixed(1)}°C</span>
                <p className="text-xs text-slate-400 mt-1">Live temperature</p>
              </div>
            )}

            {/* Hot pocket score (desk sensors only) */}
            {selectedScore && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">Hot pocket score</span>
                  <span
                    className="text-xs font-bold px-2 py-0.5 rounded-full"
                    style={{ backgroundColor: selectedScore.color + '33', color: selectedScore.color }}
                  >
                    {(selectedScore.score * 100).toFixed(0)}% · {selectedScore.label}
                  </span>
                </div>
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${selectedScore.score * 100}%`, backgroundColor: selectedScore.color }}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <Metric label="Δ Setpoint" value={`+${selectedScore.deltaSetpoint.toFixed(1)}°C`}
                    note="vs AC target" />
                  <Metric label="Zone outlier" value={`+${selectedScore.localDeviation.toFixed(1)}°C`}
                    note="vs zone mean" />
                </div>
              </div>
            )}

            {/* Position */}
            <div className="space-y-2">
              <span className="text-xs text-slate-400 uppercase font-semibold">Position (m)</span>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-500">X (east)</span>
                  <input type="number" step="0.1"
                    value={selectedSensor.x}
                    onChange={e => updateSensorPosition(selectedSensor.sensorKey, parseFloat(e.target.value) || 0, selectedSensor.y)}
                    className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-white text-xs outline-none focus:border-blue-500"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-500">Y (south)</span>
                  <input type="number" step="0.1"
                    value={selectedSensor.y}
                    onChange={e => updateSensorPosition(selectedSensor.sensorKey, selectedSensor.x, parseFloat(e.target.value) || 0)}
                    className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-white text-xs outline-none focus:border-blue-500"
                  />
                </label>
              </div>
              {nearestAcDistance && (
                <p className="text-xs text-slate-500">
                  Nearest AC: <span className="text-slate-300">{nearestAcDistance} m</span>
                </p>
              )}
            </div>

            {/* Role */}
            <div className="space-y-1">
              <span className="text-xs text-slate-400 uppercase font-semibold">Sensor Role</span>
              <div className="flex flex-col gap-1">
                {(['normal', 'supply_air', 'excluded'] as const).map(role => (
                  <button
                    key={role}
                    onClick={() => updateSensorRole(selectedSensor.sensorKey, role)}
                    className={`text-xs text-left px-3 py-1.5 rounded-lg transition-colors ${
                      selectedSensor.role === role
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    {role === 'normal'     && 'Normal (included in analysis)'}
                    {role === 'supply_air' && 'Supply Air (inside AC duct)'}
                    {role === 'excluded'   && 'Excluded (ignore this sensor)'}
                  </button>
                ))}
              </div>
            </div>

            {/* Flow direction (ceiling sensors) */}
            {selectedSensor.classifiedType === 'ceiling' && (
              <div className="space-y-2">
                <span className="text-xs text-slate-400 uppercase font-semibold">AC Airflow Direction</span>
                <div className="grid grid-cols-4 gap-1">
                  {DIRECTIONS_8.map(d => (
                    <button
                      key={d.deg}
                      onClick={() => updateSensorFlow(selectedSensor.sensorKey, d.deg)}
                      className={`text-xs py-1 rounded-lg transition-colors ${
                        selectedSensor.flowDirection === d.deg
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Remove button */}
            <button
              onClick={() => removePlacedSensor(selectedSensor.sensorKey)}
              className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded-lg px-2 py-1.5 transition-colors"
            >
              <Trash2 size={12} /> Remove from floor plan
            </button>
          </div>
        )}
      </div>

      {/* ── Legend ── */}
      <div className="flex items-center gap-4 px-4 py-2 bg-slate-900/60 border-t border-slate-800 text-xs text-slate-400 flex-wrap">
        <span className="font-semibold text-slate-300">Legend:</span>
        {[
          { color: '#3b82f6', label: 'Cool (score <25%)' },
          { color: '#22c55e', label: 'OK (25–45%)' },
          { color: '#f97316', label: 'Warm (45–65%)' },
          { color: '#ef4444', label: 'Hot Pocket (>65%)' },
        ].map(l => (
          <div key={l.label} className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: l.color }} />
            <span>{l.label}</span>
          </div>
        ))}
        <span className="ml-2">● Desk sensor</span>
        <span>▲ Ceiling / AC sensor</span>
        <span className="text-purple-400">▲ Supply air sensor</span>
      </div>

      {/* ── Modals ── */}
      {pendingFlowSensorKey && (
        <FlowDirectionModal
          onSelect={deg => updateSensorFlow(pendingFlowSensorKey, deg)}
          onSkip={() => setPendingFlowSensorKey(null)}
        />
      )}

      {showAddWall && (
        <AddWallDialog onAdd={addWall} onClose={() => setShowAddWall(false)} />
      )}

      {selectedWall && (
        <WallEditPopover
          wallLength={
            zones.find(z => z.id === selectedWall.zoneId)
              ?.zone.walls[selectedWall.wallIdx]?.lengthM ?? 0
          }
          svgX={selectedWall.svgX}
          svgY={selectedWall.svgY}
          onSave={len => updateWallLength(selectedWall.zoneId, selectedWall.wallIdx, len)}
          onDelete={() => deleteWall(selectedWall.zoneId, selectedWall.wallIdx)}
          onClose={() => setSelectedWall(null)}
        />
      )}
    </div>
  );
};

// ── helper sub-components ──────────────────────────────────────────────────

function SensorGroup({
  label, color, sensors, classifiedType, zoneId, placedMap, dragSensorRef, hotPocketMap,
}: {
  label: string;
  color: string;
  sensors: Array<{ key: string; name: string; temp: number; setpoint: number | null }>;
  classifiedType: 'desk' | 'ceiling';
  zoneId: string;
  placedMap: Map<string, SensorPlacement>;
  dragSensorRef: React.MutableRefObject<any>;
  hotPocketMap: Map<string, HotPocketScore>;
}) {
  if (sensors.length === 0) return null;
  return (
    <div className="border-b border-slate-800">
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-900/40">
        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-xs font-semibold text-slate-300">{label}</span>
        <span className="text-xs text-slate-500 ml-auto">{sensors.length}</span>
      </div>
      {sensors.map(s => {
        const isPlaced = placedMap.has(s.key);
        const score    = hotPocketMap.get(s.key);
        return (
          <div
            key={s.key}
            draggable
            onDragStart={() => {
              dragSensorRef.current = { key: s.key, name: s.name, classifiedType, zoneId };
            }}
            onDragEnd={() => { /* ref cleared in drop handler */ }}
            className={`flex items-center justify-between px-3 py-2 cursor-grab hover:bg-slate-800/60 transition-colors ${
              isPlaced ? 'opacity-50' : ''
            }`}
            title={isPlaced ? 'Already placed — drag again to move' : 'Drag to place on floor plan'}
          >
            <div className="flex items-center gap-2 min-w-0">
              {classifiedType === 'desk' ? (
                <div className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: score ? score.color : color }} />
              ) : (
                <div className="w-0 h-0 flex-shrink-0 border-l-[5px] border-r-[5px] border-b-[9px] border-transparent"
                  style={{ borderBottomColor: color }} />
              )}
              <span className="text-xs text-slate-200 truncate">{s.name}</span>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {score && (
                <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: score.color }} />
              )}
              <span className="text-xs text-slate-400">{s.temp.toFixed(1)}°</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="bg-slate-800 rounded-lg p-2 text-center">
      <div className="text-sm font-bold text-white">{value}</div>
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-xs text-slate-500">{note}</div>
    </div>
  );
}

export default FloorPlanEditor;

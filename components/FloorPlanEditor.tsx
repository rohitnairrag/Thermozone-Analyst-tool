/**
 * FloorPlanEditor.tsx
 *
 * Interactive floor plan editor.
 *
 * Features
 * ─────────
 * • Upload any draw.io / SVG floor plan — displayed as-is (unchanged visual)
 * • Wall segments auto-extracted from the SVG mxGraph XML; each wall is a
 *   clickable hit-target overlaid on the image (hover = highlight + dimension,
 *   click = edit length in metres)
 * • Drag live DB sensors from the left sidebar onto the floor plan to place them
 * • Multiple sensors persist (functional-updater pattern, no stale closure)
 * • Click a placed sensor → right panel shows live temp, hot-pocket score,
 *   X/Y distance to nearest AC, role selector, remove button
 * • "Show Heatmap" toggle renders an IDW gradient canvas overlay
 */

import React, {
  useState, useRef, useEffect, useCallback, useMemo,
} from 'react';
import {
  Eye, EyeOff, Trash2, X, Settings, Upload,
} from 'lucide-react';
import {
  ZoneProfile,
  SensorPlacement, OfficeFloorPlan,
} from '../types';
import { AllSensorsData } from '../services/liveDataService';
import {
  computeZoneHotPockets, SensorWithTemp, HotPocketScore,
  DEFAULT_HOT_POCKET_CONFIG, HotPocketConfig,
} from '../services/hotPocketEngine';
import { renderIDWToCanvas, IDWPoint } from '../utils/idwInterpolation';

// ── constants ───────────────────────────────────────────────────────────────

const SCALE = 50;   // SVG pixels per metre (used for dimension display)
const SVG_W = 900;  // canvas width  (px)
const SVG_H = 700;  // canvas height (px)

// ── wall segment type (extracted from mxGraph XML) ──────────────────────────

interface WallSegment {
  id: string;
  x1: number; y1: number;
  x2: number; y2: number;
  lengthPx: number;  // original pixel length; divide by SCALE to get metres
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse the mxGraph XML embedded in a draw.io SVG's `content` attribute
 * and return one WallSegment per edge of every rectangle shape found.
 */
function extractWallsFromSvg(svgText: string): WallSegment[] {
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const content = doc.querySelector('svg')?.getAttribute('content') ?? '';
    const decoded = content
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&#10;/g, '\n');

    const walls: WallSegment[] = [];
    // Match mxCell nodes that have a child mxGeometry with x/y/width/height
    const re = /<mxCell\b[^>]*>[\s\S]*?<mxGeometry\b[^>]*x="([^"]+)"[^>]*y="([^"]+)"[^>]*width="([^"]+)"[^>]*height="([^"]+)"/g;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(decoded)) !== null) {
      const x = +m[1], y = +m[2], w = +m[3], h = +m[4];
      if (!w || !h) continue;
      const base = `w${i++}`;
      walls.push(
        { id: `${base}-top`,    x1: x,   y1: y,   x2: x+w, y2: y,   lengthPx: w },
        { id: `${base}-right`,  x1: x+w, y1: y,   x2: x+w, y2: y+h, lengthPx: h },
        { id: `${base}-bottom`, x1: x,   y1: y+h, x2: x+w, y2: y+h, lengthPx: w },
        { id: `${base}-left`,   x1: x,   y1: y,   x2: x,   y2: y+h, lengthPx: h },
      );
    }
    return walls;
  } catch {
    return [];
  }
}

/** Decode a data URL produced by handleSvgUpload back to raw SVG text. */
function dataUrlToSvgText(dataUrl: string): string {
  return decodeURIComponent(
    dataUrl.replace(/^data:image\/svg\+xml;charset=utf-8,/, '')
  );
}

// ── sensor classification helper ─────────────────────────────────────────────

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

// ── flow-direction helpers ────────────────────────────────────────────────────

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

// ── sub-components ────────────────────────────────────────────────────────────

/** Inline popover to edit a wall length. */
function WallEditPopover({
  wallLength, onSave, onClose, svgX, svgY,
}: {
  wallLength: number;
  onSave: (len: number) => void;
  onClose: () => void;
  svgX: number; svgY: number;
}) {
  const [val, setVal] = useState(wallLength.toFixed(2));
  return (
    <div
      style={{ position: 'absolute', left: svgX + 8, top: Math.max(0, svgY - 48), zIndex: 50 }}
      className="bg-slate-800 border border-slate-600 rounded-xl shadow-xl p-3 flex flex-col gap-2 w-48"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-400 font-semibold uppercase">Wall Length</span>
        <button onClick={onClose} className="text-slate-500 hover:text-white"><X size={12} /></button>
      </div>
      <div className="flex items-center gap-1">
        <input
          type="number" value={val} step="0.1" min="0.1"
          onChange={e => setVal(e.target.value)}
          className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-white text-sm outline-none focus:border-blue-500"
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter') onSave(parseFloat(val) || wallLength); }}
        />
        <span className="text-slate-400 text-xs">m</span>
      </div>
      <button
        onClick={() => onSave(parseFloat(val) || wallLength)}
        className="bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg py-1 font-medium"
      >
        Save
      </button>
    </div>
  );
}

/** Modal for selecting AC airflow direction. */
function FlowDirectionModal({ onSelect, onSkip }: {
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
            <button key={d.deg} onClick={() => onSelect(d.deg)}
              className="bg-slate-700 hover:bg-blue-600 text-white text-sm rounded-lg py-2 font-medium transition-colors">
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

// ── main component ────────────────────────────────────────────────────────────

export interface FloorPlanEditorProps {
  zones:         ZoneProfile[];
  setZones:      (zones: ZoneProfile[]) => void;
  allLiveSensors: AllSensorsData | null;
  floorPlan:     OfficeFloorPlan;
  setFloorPlan:  (fp: OfficeFloorPlan | ((prev: OfficeFloorPlan) => OfficeFloorPlan)) => void;
  floorPlanSvg:     string | null;
  setFloorPlanSvg:  (url: string | null) => void;
}

const FloorPlanEditor: React.FC<FloorPlanEditorProps> = ({
  zones, allLiveSensors, floorPlan, setFloorPlan, floorPlanSvg, setFloorPlanSvg,
}) => {

  // ── UI state ────────────────────────────────────────────────────────────────
  const [showHeatmap,  setShowHeatmap]  = useState(false);
  const [showConfig,   setShowConfig]   = useState(false);
  const [config, setConfig] = useState<HotPocketConfig>(DEFAULT_HOT_POCKET_CONFIG);

  const [selectedSensorKey,    setSelectedSensorKey]    = useState<string | null>(null);
  const [pendingFlowSensorKey, setPendingFlowSensorKey] = useState<string | null>(null);
  const [sidebarZoneId, setSidebarZoneId] = useState<string>(zones[0]?.id ?? '');

  // Wall editing
  const [svgWalls,     setSvgWalls]     = useState<WallSegment[]>([]);
  const [wallOverrides, setWallOverrides] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('thermozone_wall_overrides') ?? '{}'); }
    catch { return {}; }
  });
  const [hoveredWallId,  setHoveredWallId]  = useState<string | null>(null);
  const [selectedWall,   setSelectedWall]   = useState<{
    wall: WallSegment; svgX: number; svgY: number;
  } | null>(null);

  // Refs
  const svgRef       = useRef<SVGSVGElement>(null);
  const heatmapRef   = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragSensorRef = useRef<{
    key: string; name: string; classifiedType: 'desk' | 'ceiling'; zoneId: string;
  } | null>(null);
  const placedSensorDragRef = useRef<{ key: string } | null>(null);

  // ── Re-extract walls on mount / when SVG URL changes ────────────────────────
  useEffect(() => {
    if (!floorPlanSvg) { setSvgWalls([]); return; }
    try {
      const text = dataUrlToSvgText(floorPlanSvg);
      setSvgWalls(extractWallsFromSvg(text));
    } catch { setSvgWalls([]); }
  }, [floorPlanSvg]);

  // ── SVG upload ───────────────────────────────────────────────────────────────
  const handleSvgUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
      setFloorPlanSvg(dataUrl);
      setSvgWalls(extractWallsFromSvg(text));
      // Clear sensor placements and wall overrides when a new plan is loaded
      setFloorPlan(prev => ({ ...prev, sensors: [] }));
      const cleared: Record<string, number> = {};
      setWallOverrides(cleared);
      localStorage.removeItem('thermozone_wall_overrides');
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const saveWallOverride = (id: string, px: number) => {
    const next = { ...wallOverrides, [id]: px };
    setWallOverrides(next);
    localStorage.setItem('thermozone_wall_overrides', JSON.stringify(next));
  };

  // ── Derived data ─────────────────────────────────────────────────────────────

  const sidebarZone = useMemo(() => zones.find(z => z.id === sidebarZoneId), [zones, sidebarZoneId]);

  const sidebarSensors = useMemo(() => {
    if (!allLiveSensors || !sidebarZone) return { desk: [], ceiling: [] };
    const zoneSensors = allLiveSensors.sensors.filter(s => s.effectiveZone === sidebarZone.zone.name);
    const others = zoneSensors.map(s => s.temp);
    const desk: typeof zoneSensors = [];
    const ceiling: typeof zoneSensors = [];
    for (const s of zoneSensors) {
      const cl = classifySensor(s.name, s.temp, sidebarZone.sensorPositions, sidebarZone.hasDeskSensors, others.filter(t => t !== s.temp));
      if (cl === 'desk')    desk.push(s);
      if (cl === 'ceiling') ceiling.push(s);
    }
    return { desk, ceiling };
  }, [allLiveSensors, sidebarZone]);

  const placedMap = useMemo(
    () => new Map(floorPlan.sensors.map(s => [s.sensorKey, s])),
    [floorPlan.sensors],
  );

  const sensorsForEngine = useMemo((): SensorWithTemp[] => {
    if (!allLiveSensors) return [];
    const result: SensorWithTemp[] = [];
    for (const z of zones) {
      const zoneSensors = allLiveSensors.sensors.filter(s => s.effectiveZone === z.zone.name);
      const others = zoneSensors.map(s => s.temp);
      for (const s of zoneSensors) {
        const cl = classifySensor(s.name, s.temp, z.sensorPositions, z.hasDeskSensors, others.filter(t => t !== s.temp));
        const placed = placedMap.get(s.key);
        const role   = placed?.role ?? (cl === 'excluded' ? 'excluded' : 'normal');
        result.push({ key: s.key, name: s.name, temp: s.temp,
          classifiedType: cl === 'excluded' ? 'desk' : cl, role, zoneId: z.id, setpoint: s.setpoint });
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
    for (const r of hotPocketResults)
      for (const s of r.deskScores) m.set(s.sensorKey, s);
    return m;
  }, [hotPocketResults]);

  // ── Heatmap ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = heatmapRef.current;
    if (!canvas || !showHeatmap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const points: IDWPoint[] = [];
    for (const sp of floorPlan.sensors) {
      if (sp.classifiedType !== 'desk' || sp.role !== 'normal') continue;
      const score = hotPocketMap.get(sp.sensorKey);
      if (!score) continue;
      points.push({ x: sp.x * SCALE, y: sp.y * SCALE, value: score.score });
    }
    if (points.length > 0) renderIDWToCanvas(ctx, points, canvas.width, canvas.height, 8, 0.55);
  }, [showHeatmap, floorPlan.sensors, hotPocketMap]);

  // ── Sensor mutators ──────────────────────────────────────────────────────────

  const placeSensor = useCallback((sp: SensorPlacement) => {
    setFloorPlan(prev => ({
      ...prev,
      sensors: [...prev.sensors.filter(s => s.sensorKey !== sp.sensorKey), sp],
    }));
  }, [setFloorPlan]);

  const removePlacedSensor = useCallback((key: string) => {
    setFloorPlan({ ...floorPlan, sensors: floorPlan.sensors.filter(s => s.sensorKey !== key) });
    if (selectedSensorKey === key) setSelectedSensorKey(null);
  }, [floorPlan, setFloorPlan, selectedSensorKey]);

  const updateSensorRole = useCallback((key: string, role: SensorPlacement['role']) => {
    setFloorPlan({ ...floorPlan, sensors: floorPlan.sensors.map(s => s.sensorKey === key ? { ...s, role } : s) });
  }, [floorPlan, setFloorPlan]);

  const updateSensorPosition = useCallback((key: string, x: number, y: number) => {
    setFloorPlan({ ...floorPlan, sensors: floorPlan.sensors.map(s => s.sensorKey === key ? { ...s, x, y } : s) });
  }, [floorPlan, setFloorPlan]);

  const updateSensorFlow = useCallback((key: string, deg: number) => {
    setFloorPlan({ ...floorPlan, sensors: floorPlan.sensors.map(s => s.sensorKey === key ? { ...s, flowDirection: deg } : s) });
    setPendingFlowSensorKey(null);
  }, [floorPlan, setFloorPlan]);

  // ── SVG interaction ──────────────────────────────────────────────────────────

  const svgCoordsFromEvent = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handleCanvasDragOver = (e: React.DragEvent) => { e.preventDefault(); };

  const handleCanvasDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const drag = dragSensorRef.current;
    if (!drag) return;
    const rect = svgRef.current!.getBoundingClientRect();
    const xM = parseFloat(((e.clientX - rect.left) / SCALE).toFixed(2));
    const yM = parseFloat(((e.clientY - rect.top)  / SCALE).toFixed(2));
    placeSensor({
      sensorKey: drag.key, sensorName: drag.name,
      classifiedType: drag.classifiedType, role: 'normal',
      zoneId: drag.zoneId, x: xM, y: yM, isCustomMode: true,
    });
    dragSensorRef.current = null;
    if (drag.classifiedType === 'ceiling') setPendingFlowSensorKey(drag.key);
  };

  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!placedSensorDragRef.current) return;
    const { key } = placedSensorDragRef.current;
    const cur = svgCoordsFromEvent(e);
    updateSensorPosition(key,
      parseFloat((cur.x / SCALE).toFixed(2)),
      parseFloat((cur.y / SCALE).toFixed(2)),
    );
  };

  const handleSvgMouseUp = () => { placedSensorDragRef.current = null; };

  // ── Selected sensor detail ───────────────────────────────────────────────────

  const selectedSensor   = selectedSensorKey ? placedMap.get(selectedSensorKey) : null;
  const selectedScore    = selectedSensorKey ? hotPocketMap.get(selectedSensorKey) : null;
  const selectedLiveData = allLiveSensors?.sensors.find(s => s.key === selectedSensorKey);

  const acDistances = useMemo(() => {
    if (!selectedSensor) return null;
    const acs = floorPlan.sensors.filter(s => s.classifiedType === 'ceiling' && s.role !== 'excluded');
    if (acs.length === 0) return null;
    let best: { dx: number; dy: number; dist: number; acName: string } | null = null;
    for (const ac of acs) {
      const dx = Math.abs(selectedSensor.x - ac.x);
      const dy = Math.abs(selectedSensor.y - ac.y);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (!best || dist < best.dist) best = { dx, dy, dist, acName: ac.sensorName };
    }
    return best;
  }, [selectedSensor, floorPlan.sensors]);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full select-none">

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-3 px-4 py-3 bg-slate-900/60 border-b border-slate-800 flex-wrap">
        <span className="text-white font-semibold text-sm">Floor Plan Editor</span>
        <div className="h-4 w-px bg-slate-700" />

        {/* SVG upload */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".svg,.drawio"
          className="hidden"
          onChange={handleSvgUpload}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1 bg-blue-700 hover:bg-blue-600 text-white text-xs rounded-lg px-3 py-1.5 font-medium"
          title="Upload a draw.io or SVG file as the floor plan"
        >
          <Upload size={12} />
          {floorPlanSvg ? 'Replace Floor Plan' : 'Upload Floor Plan'}
        </button>

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
              />°C
            </label>
            <label className="text-xs text-slate-400">
              Zone deviation max
              <input type="number" value={config.localDeviationMax} step={0.5} min={0.5}
                onChange={e => setConfig(c => ({ ...c, localDeviationMax: parseFloat(e.target.value) || 3 }))}
                className="ml-2 w-12 bg-slate-900 border border-slate-600 rounded px-1 py-0.5 text-white text-xs outline-none"
              />°C
            </label>
          </div>
        )}

        {!allLiveSensors && (
          <span className="text-xs text-yellow-400 ml-auto">Live sensor data not loaded</span>
        )}
      </div>

      {/* ── Main content ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left sidebar ── */}
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

          <SensorGroup label="Desk Sensors" color="#f97316" sensors={sidebarSensors.desk}
            classifiedType="desk" zoneId={sidebarZoneId} placedMap={placedMap}
            dragSensorRef={dragSensorRef} hotPocketMap={hotPocketMap} />

          <SensorGroup label="Ceiling / AC Sensors" color="#22d3ee" sensors={sidebarSensors.ceiling}
            classifiedType="ceiling" zoneId={sidebarZoneId} placedMap={placedMap}
            dragSensorRef={dragSensorRef} hotPocketMap={hotPocketMap} />
        </div>

        {/* ── SVG Canvas ── */}
        <div className="flex-1 overflow-auto relative bg-slate-950">
          <div style={{ position: 'relative', width: SVG_W, height: SVG_H }}>

            {/* Heatmap canvas overlay */}
            <canvas ref={heatmapRef} width={SVG_W} height={SVG_H}
              style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none',
                display: showHeatmap ? 'block' : 'none' }} />

            <svg ref={svgRef} width={SVG_W} height={SVG_H} style={{ display: 'block' }}
              onMouseMove={handleSvgMouseMove}
              onMouseUp={handleSvgMouseUp}
              onMouseLeave={handleSvgMouseUp}
              onDragOver={handleCanvasDragOver}
              onDrop={handleCanvasDrop}
              onClick={() => { setSelectedWall(null); setSelectedSensorKey(null); }}
            >
              {/* Canvas background */}
              <rect width={SVG_W} height={SVG_H} fill="#0f172a" />

              {/* ── Layer 1: Uploaded floor plan SVG (as-is) ── */}
              {floorPlanSvg ? (
                <image
                  href={floorPlanSvg}
                  x={0} y={0}
                  width={SVG_W} height={SVG_H}
                  preserveAspectRatio="xMidYMid meet"
                  style={{ pointerEvents: 'none' }}
                />
              ) : (
                <text x={SVG_W / 2} y={SVG_H / 2}
                  textAnchor="middle" dominantBaseline="middle"
                  fill="#475569" fontSize={16}
                  style={{ pointerEvents: 'none', userSelect: 'none' }}>
                  Upload a floor plan to get started
                </text>
              )}

              {/* ── Layer 2: Transparent wall hit-targets + hover highlights ── */}
              {floorPlanSvg && svgWalls.map(wall => {
                const isHov  = hoveredWallId === wall.id;
                const midX   = (wall.x1 + wall.x2) / 2;
                const midY   = (wall.y1 + wall.y2) / 2;
                const lenPx  = wallOverrides[wall.id] ?? wall.lengthPx;
                const isHoriz = Math.abs(wall.y2 - wall.y1) < Math.abs(wall.x2 - wall.x1);
                return (
                  <g key={wall.id}>
                    {/* Wide invisible hit target */}
                    <line
                      x1={wall.x1} y1={wall.y1} x2={wall.x2} y2={wall.y2}
                      stroke="transparent" strokeWidth={14}
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={() => setHoveredWallId(wall.id)}
                      onMouseLeave={() => setHoveredWallId(null)}
                      onClick={e => { e.stopPropagation(); setSelectedWall({ wall, svgX: midX, svgY: midY }); }}
                    />
                    {/* Visible blue highlight on hover */}
                    {isHov && (
                      <line x1={wall.x1} y1={wall.y1} x2={wall.x2} y2={wall.y2}
                        stroke="#3b82f6" strokeWidth={3} opacity={0.75}
                        style={{ pointerEvents: 'none' }} />
                    )}
                    {/* Dimension label on hover */}
                    {isHov && (
                      <text
                        x={isHoriz ? midX : midX - 10}
                        y={isHoriz ? midY - 10 : midY}
                        textAnchor="middle" dominantBaseline="middle"
                        fill="#93c5fd" fontSize={9} fontWeight="600"
                        style={{ pointerEvents: 'none', userSelect: 'none' }}>
                        {(lenPx / SCALE).toFixed(2)} m
                      </text>
                    )}
                  </g>
                );
              })}

              {/* ── Layer 3: Placed sensors ── */}
              {floorPlan.sensors.map(sp => {
                const svgX  = sp.x * SCALE;
                const svgY  = sp.y * SCALE;
                const score = hotPocketMap.get(sp.sensorKey);
                const color = sp.role === 'excluded'  ? '#475569'
                            : sp.role === 'supply_air' ? '#7c3aed'
                            : sp.classifiedType === 'ceiling' ? '#22d3ee'
                            : score?.color ?? '#f97316';
                const isSelected = selectedSensorKey === sp.sensorKey;
                return (
                  <g key={sp.sensorKey} style={{ cursor: 'pointer' }}
                    onMouseDown={e => { e.stopPropagation(); placedSensorDragRef.current = { key: sp.sensorKey }; }}
                    onClick={e => { e.stopPropagation(); setSelectedSensorKey(sp.sensorKey); }}
                  >
                    {score && score.score > 0.65 && (
                      <circle cx={svgX} cy={svgY} r={14} fill="none"
                        stroke="#ef4444" strokeWidth={1.5} opacity={0.6} strokeDasharray="4,2">
                        <animate attributeName="r" values="12;18;12" dur="2s" repeatCount="indefinite" />
                        <animate attributeName="opacity" values="0.6;0.2;0.6" dur="2s" repeatCount="indefinite" />
                      </circle>
                    )}
                    {sp.classifiedType === 'desk' ? (
                      <circle cx={svgX} cy={svgY} r={7}
                        fill={color} stroke={isSelected ? '#fff' : '#0f172a'} strokeWidth={isSelected ? 2 : 1} />
                    ) : (
                      <polygon
                        points={`${svgX},${svgY-8} ${svgX+7},${svgY+5} ${svgX-7},${svgY+5}`}
                        fill={color} stroke={isSelected ? '#fff' : '#0f172a'} strokeWidth={isSelected ? 2 : 1} />
                    )}
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

            {/* Wall edit popover (positioned absolutely over SVG) */}
            {selectedWall && (
              <WallEditPopover
                wallLength={(wallOverrides[selectedWall.wall.id] ?? selectedWall.wall.lengthPx) / SCALE}
                svgX={selectedWall.svgX}
                svgY={selectedWall.svgY}
                onSave={len => { saveWallOverride(selectedWall.wall.id, len * SCALE); setSelectedWall(null); }}
                onClose={() => setSelectedWall(null)}
              />
            )}
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

            {selectedLiveData && (
              <div className="bg-slate-800 rounded-xl p-3 text-center">
                <span className="text-2xl font-bold text-white">{selectedLiveData.temp.toFixed(1)}°C</span>
                <p className="text-xs text-slate-400 mt-1">Live temperature</p>
              </div>
            )}

            {selectedScore && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">Hot pocket score</span>
                  <span className="text-xs font-bold px-2 py-0.5 rounded-full"
                    style={{ backgroundColor: selectedScore.color + '33', color: selectedScore.color }}>
                    {(selectedScore.score * 100).toFixed(0)}% · {selectedScore.label}
                  </span>
                </div>
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all"
                    style={{ width: `${selectedScore.score * 100}%`, backgroundColor: selectedScore.color }} />
                </div>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <Metric label="Δ Setpoint" value={`+${selectedScore.deltaSetpoint.toFixed(1)}°C`} note="vs AC target" />
                  <Metric label="Zone outlier" value={`+${selectedScore.localDeviation.toFixed(1)}°C`} note="vs zone mean" />
                </div>
              </div>
            )}

            <div className="space-y-2">
              <span className="text-xs text-slate-400 uppercase font-semibold">Position (m)</span>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-500">X</span>
                  <input type="number" step="0.1" value={selectedSensor.x}
                    onChange={e => updateSensorPosition(selectedSensor.sensorKey, parseFloat(e.target.value) || 0, selectedSensor.y)}
                    className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-white text-xs outline-none focus:border-blue-500" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-500">Y</span>
                  <input type="number" step="0.1" value={selectedSensor.y}
                    onChange={e => updateSensorPosition(selectedSensor.sensorKey, selectedSensor.x, parseFloat(e.target.value) || 0)}
                    className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-white text-xs outline-none focus:border-blue-500" />
                </label>
              </div>
              {acDistances && (
                <div className="text-xs text-slate-500 space-y-0.5">
                  <p className="text-slate-400 font-medium">Distance from {acDistances.acName}:</p>
                  <p>X: <span className="text-cyan-300">{acDistances.dx.toFixed(1)} m</span>
                  {'  '}Y: <span className="text-cyan-300">{acDistances.dy.toFixed(1)} m</span></p>
                  <p>Total: <span className="text-slate-300">{acDistances.dist.toFixed(1)} m</span></p>
                </div>
              )}
            </div>

            <div className="space-y-1">
              <span className="text-xs text-slate-400 uppercase font-semibold">Sensor Role</span>
              <div className="flex flex-col gap-1">
                {(['normal', 'supply_air', 'excluded'] as const).map(role => (
                  <button key={role}
                    onClick={() => updateSensorRole(selectedSensor.sensorKey, role)}
                    className={`text-xs text-left px-3 py-1.5 rounded-lg transition-colors ${
                      selectedSensor.role === role ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
                    }`}>
                    {role === 'normal'     && 'Normal (included in analysis)'}
                    {role === 'supply_air' && 'Supply Air (inside AC duct)'}
                    {role === 'excluded'   && 'Excluded (ignore this sensor)'}
                  </button>
                ))}
              </div>
            </div>

            {selectedSensor.classifiedType === 'ceiling' && (
              <div className="space-y-2">
                <span className="text-xs text-slate-400 uppercase font-semibold">AC Airflow Direction</span>
                <div className="grid grid-cols-4 gap-1">
                  {DIRECTIONS_8.map(d => (
                    <button key={d.deg} onClick={() => updateSensorFlow(selectedSensor.sensorKey, d.deg)}
                      className={`text-xs py-1 rounded-lg transition-colors ${
                        selectedSensor.flowDirection === d.deg ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
                      }`}>
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button onClick={() => removePlacedSensor(selectedSensor.sensorKey)}
              className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded-lg px-2 py-1.5 transition-colors">
              <Trash2 size={12} /> Remove from floor plan
            </button>
          </div>
        )}
      </div>

      {/* ── Legend ── */}
      <div className="flex items-center gap-4 px-4 py-2 bg-slate-900/60 border-t border-slate-800 text-xs text-slate-400 flex-wrap">
        <span className="font-semibold text-slate-300">Legend:</span>
        {[
          { color: '#3b82f6', label: 'Cool (<25%)' },
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
        <span className="text-slate-500">Hover a wall to see / click to edit its dimension</span>
      </div>

      {/* ── Modals ── */}
      {pendingFlowSensorKey && (
        <FlowDirectionModal
          onSelect={deg => updateSensorFlow(pendingFlowSensorKey, deg)}
          onSkip={() => setPendingFlowSensorKey(null)}
        />
      )}
    </div>
  );
};

// ── helper sub-components ─────────────────────────────────────────────────────

function SensorGroup({
  label, color, sensors, classifiedType, zoneId, placedMap, dragSensorRef, hotPocketMap,
}: {
  label: string; color: string;
  sensors: Array<{ key: string; name: string; temp: number; setpoint: number | null }>;
  classifiedType: 'desk' | 'ceiling'; zoneId: string;
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
          <div key={s.key} draggable
            onDragStart={() => { dragSensorRef.current = { key: s.key, name: s.name, classifiedType, zoneId }; }}
            onDragEnd={() => { dragSensorRef.current = null; }}
            className={`flex items-center justify-between px-3 py-2 cursor-grab hover:bg-slate-800/60 transition-colors ${isPlaced ? 'opacity-50' : ''}`}
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
              {score && <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: score.color }} />}
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

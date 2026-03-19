/**
 * HeatFlowDiagram.tsx — Unified building-wide heat flow map.
 *
 * ONE map for the entire building at a single point in time.
 * All zones are nodes; all partition heat transfers are arrows.
 * Direction and magnitude are computed directly from allZoneTemps +
 * wall geometry — completely independent of which zone is "active".
 *
 * Arrow direction: always hot → cold (thermodynamic truth).
 * Arrow thickness: proportional to watts transferred.
 * Node border:     orange = net heat gainer · blue = net heat loser.
 */

import React, { useMemo, useState, useEffect } from 'react';
import { SimulationResult, ZoneProfile } from '../types';
import { U_GLASS, U_WALL } from '../services/physicsEngine';

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  allZoneResults?: Record<string, SimulationResult>;  // simulation for every zone — zone-independent
  zones:           ZoneProfile[];
  activeZoneId:    string;
  allZoneTemps:    Record<string, number[]>;
  isToday:         boolean;
  selectedHour:    number;
}

// U-values imported directly from physicsEngine.ts — single source of truth
const U_GLASS_K = U_GLASS;
const U_WALL_K  = U_WALL;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCurrentISTSlot(): number {
  const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const h = nowIST.getHours();
  const m = nowIST.getMinutes();
  return Math.min(h * 60 + m, 1439);
}

/** Intersection of ray from (cx,cy) in direction (dx,dy) with a rect boundary. */
function rectEdge(cx: number, cy: number, hw: number, hh: number, dx: number, dy: number) {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return { x: cx, y: cy };
  const nx = dx / len, ny = dy / len;
  const t = Math.min(nx !== 0 ? hw / Math.abs(nx) : Infinity, ny !== 0 ? hh / Math.abs(ny) : Infinity);
  return { x: cx + nx * t, y: cy + ny * t };
}

function wallUeff(type: string, glassM2: number | undefined, totalArea: number): number {
  if (type === 'full_glass') return U_GLASS_K;
  if (type === 'mixed' && glassM2 != null && glassM2 > 0) {
    const ga = Math.min(glassM2, totalArea);
    return (U_GLASS_K * ga + U_WALL_K * Math.max(0, totalArea - ga)) / totalArea;
  }
  if (type === 'mixed') return (U_GLASS_K + U_WALL_K) / 2;
  return U_WALL_K;
}

// ─── SVG layout constants ─────────────────────────────────────────────────────

const SVG_W  = 1040;
const SVG_H  = 620;
const CX     = SVG_W / 2;
const CY     = SVG_H / 2;
const ORBIT  = 245;   // radius of zone circle — wide enough for arrow labels to breathe
const NHW    = 86;    // node half-width
const NHH    = 46;    // node half-height
const THRESHOLD = 25; // W — below this: grey dashed, no animation

// Virtual node ID for the outside environment
const OUTSIDE_ID = '__outside__';
const OUTSIDE_R  = 64;   // radius of the circular Outside node

/** Intersection of ray from circle center (cx,cy) with its boundary. */
function circleEdge(cx: number, cy: number, r: number, dx: number, dy: number) {
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return { x: cx + (dx / len) * r, y: cy + (dy / len) * r };
}

// ─── Internal types ──────────────────────────────────────────────────────────

interface ZonePos { id: string; name: string; x: number; y: number; }

interface HeatFlow {
  fromId:     string;
  toId:       string;
  watts:      number;
  pairKey:    string;
  hasTempData: boolean;
  isExternal?: boolean;
  flowType?:  'solar' | 'conduction' | 'internal';
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function HeatFlowDiagram({
  allZoneResults, zones, activeZoneId, allZoneTemps, isToday, selectedHour,
}: Props) {

  // ── Slot tracking ───────────────────────────────────────────────────────
  const [liveSlot, setLiveSlot] = useState<number>(() =>
    isToday ? getCurrentISTSlot() : selectedHour * 60
  );
  useEffect(() => {
    if (isToday) {
      const update = () => setLiveSlot(getCurrentISTSlot());
      update();
      const id = setInterval(update, 30_000);
      return () => clearInterval(id);
    } else {
      setLiveSlot(Math.min(selectedHour * 60, 1439));
    }
  }, [isToday, selectedHour]);

  const slot     = Math.min(liveSlot, 1439);
  const h0       = Math.floor(slot / 60);
  const slotMin  = slot % 60;
  const slotTime = `${h0.toString().padStart(2, '0')}:${slotMin.toString().padStart(2, '0')}`;

  // ── Zone positions (evenly spaced circle) ──────────────────────────────
  const zonePos = useMemo<ZonePos[]>(() =>
    zones.map((z, i) => {
      const angle = (2 * Math.PI * i / Math.max(zones.length, 1)) - Math.PI / 2;
      return { id: z.id, name: z.zone.displayName || z.zone.name, x: CX + ORBIT * Math.cos(angle), y: CY + ORBIT * Math.sin(angle) };
    }), [zones]);

  const posById = useMemo(() => {
    const m: Record<string, ZonePos> = {};
    for (const p of zonePos) m[p.id] = p;
    return m;
  }, [zonePos]);

  // ── Build unique zone-pair conductances (UA, W/K) ──────────────────────
  // Each physical partition is counted ONCE from the zone whose ID sorts first.
  // Both zones in a pair define the same wall (from opposite sides), so iterating
  // all zones would double-count every partition. Skipping the "zbId" zone's entry
  // prevents this while still summing genuinely separate wall segments between a pair.
  const pairUA = useMemo(() => {
    const map = new Map<string, { zaId: string; zbId: string; ua: number }>();
    for (const zp of zones) {
      for (const wall of zp.zone.walls) {
        if (wall.wallType !== 'internal' || !wall.adjacentZoneId) continue;
        const ids = [zp.id, wall.adjacentZoneId].sort();
        // Only count this wall from the zone whose ID sorts first — skips the mirror
        // entry from the adjacent zone (same physical partition, opposite direction).
        if (zp.id !== ids[0]) continue;
        const key  = ids.join('|');
        const area = wall.lengthM * zp.zone.ceilingHeightM;
        const ua   = wallUeff(wall.constructionType, wall.glassAreaM2, area) * area;
        const existing = map.get(key);
        if (existing) {
          existing.ua += ua;  // multiple distinct wall segments between the same pair
        } else {
          map.set(key, { zaId: ids[0], zbId: ids[1], ua });
        }
      }
    }
    return map;
  }, [zones]);

  // ── Outdoor air temperature at current hour (shared across all zones) ──
  const outdoorTemp: number | null = useMemo(() => {
    for (const zp of zones) {
      const d = allZoneResults?.[zp.id]?.data[slot];
      if (d?.outdoorTemp != null) return d.outdoorTemp;
    }
    return null;
  }, [allZoneResults, zones, slot]);

  // ── Peak sol-air temperature — the REAL driving temperature for wall conduction ──
  // Back-calculated from wallLoad simulation output:
  //   wallLoad = U_WALL × A_opaque × (T_solair − T_indoor)
  //   → T_solair = T_indoor + wallLoad / (U_WALL × A_opaque)
  // Shows why heat flows IN even when outdoor AIR temp < room temp.
  const peakSolAirTemp: number | null = useMemo(() => {
    if (outdoorTemp === null) return null;
    let peak = outdoorTemp;
    for (const zp of zones) {
      const simSlot = allZoneResults?.[zp.id]?.data[slot];
      if (!simSlot || (simSlot.wallLoad ?? 0) <= 0) continue;
      const cH = zp.zone.ceilingHeightM;
      let opaqueArea = 0;
      for (const w of zp.zone.walls) {
        if (w.wallType !== 'external') continue;
        const totalArea = w.lengthM * cH;
        const glassArea = (w.windows ?? []).reduce((s, win) => s + win.areaM2, 0)
                        + (w.glassAreaM2 ?? 0);
        opaqueArea += Math.max(0, totalArea - glassArea);
      }
      if (opaqueArea <= 0) continue;
      const tIndoor  = allZoneTemps[zp.id]?.[h0] ?? 27;
      const tSolAir  = tIndoor + (simSlot.wallLoad ?? 0) / (U_WALL_K * opaqueArea);
      if (tSolAir > peak) peak = tSolAir;
    }
    // Only show if meaningfully higher than air temp (i.e. solar is actually heating walls)
    return peak > outdoorTemp + 2 ? peak : null;
  }, [allZoneResults, zones, slot, outdoorTemp, allZoneTemps, h0]);

  // ── Compute heat flows for current slot ────────────────────────────────
  const heatFlows = useMemo<HeatFlow[]>(() => {
    const flows: HeatFlow[] = [];

    // 1. Internal zone-to-zone flows (partition walls)
    // Use simulation's indoorTempRaw at the exact slot (matches physics engine) with
    // hourly DB temp as fallback when simulation data isn't available for a zone.
    for (const [key, pair] of pairUA) {
      const tA = allZoneResults?.[pair.zaId]?.data[slot]?.indoorTempRaw
              ?? allZoneTemps[pair.zaId]?.[h0]
              ?? null;
      const tB = allZoneResults?.[pair.zbId]?.data[slot]?.indoorTempRaw
              ?? allZoneTemps[pair.zbId]?.[h0]
              ?? null;
      const hasTempData = tA !== null && tB !== null;

      if (!hasTempData) {
        flows.push({ fromId: pair.zaId, toId: pair.zbId, watts: 0, pairKey: key, hasTempData: false, flowType: 'internal' });
        continue;
      }
      const q = pair.ua * (tA - tB);
      flows.push({
        fromId: q >= 0 ? pair.zaId : pair.zbId,
        toId:   q >= 0 ? pair.zbId : pair.zaId,
        watts:  Math.abs(q),
        pairKey: key,
        hasTempData: true,
        flowType: 'internal',
      });
    }

    // 2. External flows: zone ↔ Outside (from simulation data per zone)
    for (const zp of zones) {
      const simSlot = allZoneResults?.[zp.id]?.data[slot];
      if (!simSlot) continue;

      // Solar gain — always Outside → Zone when positive (sun only shines inward)
      const solar = simSlot.solarLoad ?? 0;
      if (solar > THRESHOLD) {
        flows.push({
          fromId: OUTSIDE_ID, toId: zp.id,
          watts: solar,
          pairKey: `${zp.id}|solar`,
          hasTempData: true,
          isExternal: true,
          flowType: 'solar',
        });
      }

      // Wall conduction only — matches "Wall" component in Stacked Heat Load chart.
      // roofLoad and infLoad are shown as breakdown lines in the per-zone card, not as separate arrows.
      const wallCond = simSlot.wallLoad ?? 0;
      if (wallCond > THRESHOLD) {
        flows.push({
          fromId: OUTSIDE_ID,
          toId:   zp.id,
          watts:  wallCond,
          pairKey: `${zp.id}|conduction`,
          hasTempData: true,
          isExternal: true,
          flowType: 'conduction',
        });
      }
    }

    return flows;
  }, [pairUA, allZoneTemps, allZoneResults, zones, h0, slot]);

  // ── Net heat balance per zone (includes both internal and external flows) ──
  const netBalance = useMemo<Record<string, number>>(() => {
    const bal: Record<string, number> = {};
    for (const f of heatFlows) {
      if (!f.hasTempData) continue;
      // Skip OUTSIDE_ID contributions to bal — we only track zone nodes
      if (f.fromId !== OUTSIDE_ID) bal[f.fromId] = (bal[f.fromId] ?? 0) - f.watts;
      if (f.toId   !== OUTSIDE_ID) bal[f.toId]   = (bal[f.toId]   ?? 0) + f.watts;
    }
    return bal;
  }, [heatFlows]);

  const maxFlow = Math.max(...heatFlows.map(f => f.watts), 1);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h3 className="text-sm font-bold text-white uppercase tracking-widest">
            Building Heat Flow Map
          </h3>
          <p className="text-xs text-slate-400 mt-1">
            All inter-zone partition transfers · unified view · hot → cold
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap justify-end">
          {/* Top flows summary */}
          {heatFlows.filter(f => f.hasTempData && f.watts > THRESHOLD).sort((a, b) => b.watts - a.watts).slice(0, 2).map(f => (
            <div key={f.pairKey} className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-950/50 border border-orange-900 rounded-lg">
              <span className="text-orange-400 text-[10px] font-bold">
                {f.fromId === OUTSIDE_ID ? (f.flowType === 'solar' ? '☀ Solar' : 'Outside') : (posById[f.fromId]?.name ?? '?')} → {f.toId === OUTSIDE_ID ? 'Outside' : (posById[f.toId]?.name ?? '?')}
              </span>
              <span className="text-orange-300 text-xs font-mono font-bold">
                {Math.round(f.watts).toLocaleString()} W
              </span>
            </div>
          ))}
          <div className="text-right">
            <p className="text-xl font-mono font-bold text-blue-400">{slotTime}</p>
            <p className="text-[10px] text-slate-500 uppercase tracking-wider">
              {isToday ? 'Live · IST' : 'Historical'}
            </p>
          </div>
        </div>
      </div>

      {/* ── SVG ── */}
      <div className="w-full overflow-x-auto">
        <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="w-full" style={{ maxHeight: 540 }}>
          <defs>
            <marker id="hf2-arr-hot"  markerWidth="9" markerHeight="6" refX="9" refY="3" orient="auto">
              <polygon points="0 0, 9 3, 0 6" fill="#f97316" />
            </marker>
            <marker id="hf2-arr-sol"  markerWidth="9" markerHeight="6" refX="9" refY="3" orient="auto">
              <polygon points="0 0, 9 3, 0 6" fill="#f59e0b" />
            </marker>
            <marker id="hf2-arr-cold" markerWidth="9" markerHeight="6" refX="9" refY="3" orient="auto">
              <polygon points="0 0, 9 3, 0 6" fill="#38bdf8" />
            </marker>
            <marker id="hf2-arr-dim"  markerWidth="9" markerHeight="6" refX="9" refY="3" orient="auto">
              <polygon points="0 0, 9 3, 0 6" fill="#475569" />
            </marker>
            <filter id="hf2-glow-active" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="9" result="b"/>
              <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <filter id="hf2-glow-node" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="5" result="b"/>
              <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <style>{`
              .hf2-flow { animation: hf2Anim 1.1s linear infinite; }
              @keyframes hf2Anim { to { stroke-dashoffset: -24; } }
            `}</style>
          </defs>

          {/* ── Heat-flow arrows (rendered behind nodes) ── */}
          {heatFlows.map(flow => {
            const isExternal = flow.isExternal ?? false;
            const hasFlow    = flow.hasTempData && flow.watts > THRESHOLD;

            // Colour by flow type
            const color =
              !hasFlow            ? '#334155'
              : flow.flowType === 'solar'       ? '#f59e0b'   // amber — solar
              : flow.flowType === 'conduction' && flow.toId === OUTSIDE_ID ? '#38bdf8'  // blue — night loss
              : '#f97316';                                     // orange — heat gain / internal

            // Cap external (solar/conduction) arrows at 5 px so they don't overpower the diagram;
            // internal zone-to-zone arrows scale up to 8 px.
            const maxStroke = flow.isExternal ? 5 : 8;
            const strokeW = hasFlow ? Math.max(1.5, Math.min(maxStroke, (flow.watts / maxFlow) * maxStroke)) : 1.5;
            const markerId = flow.flowType === 'solar' ? 'url(#hf2-arr-sol)'
              : flow.flowType === 'conduction' && flow.toId === OUTSIDE_ID ? 'url(#hf2-arr-cold)'
              : hasFlow ? 'url(#hf2-arr-hot)' : 'url(#hf2-arr-dim)';

            let src: { x: number; y: number };
            let dst: { x: number; y: number };
            let lx: number;
            let ly: number;
            let pathD: string;

            if (isExternal) {
              // External flows: straight lines between Outside circle and zone rect
              const zoneId   = flow.fromId === OUTSIDE_ID ? flow.toId : flow.fromId;
              const zonePos  = posById[zoneId];
              if (!zonePos) return null;
              const dx = zonePos.x - CX;
              const dy = zonePos.y - CY;
              src = flow.fromId === OUTSIDE_ID
                ? circleEdge(CX, CY, OUTSIDE_R + 4, dx, dy)
                : rectEdge(zonePos.x, zonePos.y, NHW + 7, NHH + 7, -dx, -dy);
              dst = flow.fromId === OUTSIDE_ID
                ? rectEdge(zonePos.x, zonePos.y, NHW + 7, NHH + 7, -dx, -dy)
                : circleEdge(CX, CY, OUTSIDE_R + 4, -dx, -dy);
              // Offset solar vs conduction so they run parallel but separated
              // Wider perp gap (±26) + staggered radial position so labels never overlap:
              //   Solar label sits at 38% (closer to Outside node)
              //   Conduction label sits at 72% (closer to zone node)
              const isSolar = flow.flowType === 'solar';
              const perp = isSolar ? 26 : -26;
              const len  = Math.sqrt(dx * dx + dy * dy) || 1;
              const ox = (-dy / len) * perp;
              const oy = ( dx / len) * perp;
              const LT = isSolar ? 0.38 : 0.72;
              lx = src.x * (1 - LT) + dst.x * LT + ox;
              ly = src.y * (1 - LT) + dst.y * LT + oy;
              pathD = `M ${src.x + ox} ${src.y + oy} L ${dst.x + ox} ${dst.y + oy}`;
            } else {
              // Internal flows: curved bezier between zone nodes
              const from = posById[flow.fromId];
              const to   = posById[flow.toId];
              if (!from || !to) return null;
              const dx  = to.x - from.x;
              const dy  = to.y - from.y;
              const len = Math.sqrt(dx * dx + dy * dy) || 1;
              src = rectEdge(from.x, from.y, NHW + 7, NHH + 7,  dx,  dy);
              dst = rectEdge(to.x,   to.y,   NHW + 7, NHH + 7, -dx, -dy);
              const mx  = (src.x + dst.x) / 2;
              const my  = (src.y + dst.y) / 2;
              const cpX = mx + (-dy / len) * 42;
              const cpY = my + ( dx / len) * 42;
              lx = 0.25 * src.x + 0.5 * cpX + 0.25 * dst.x;
              ly = 0.25 * src.y + 0.5 * cpY + 0.25 * dst.y;
              pathD = `M ${src.x} ${src.y} Q ${cpX} ${cpY} ${dst.x} ${dst.y}`;
            }

            return (
              <g key={flow.pairKey}>
                <path
                  d={pathD}
                  fill="none"
                  stroke={color}
                  strokeWidth={strokeW}
                  strokeDasharray={hasFlow ? '12 6' : '4 6'}
                  className={hasFlow ? 'hf2-flow' : ''}
                  markerEnd={hasFlow ? markerId : 'url(#hf2-arr-dim)'}
                  opacity={hasFlow ? 0.9 : 0.2}
                />
                {hasFlow && (
                  <>
                    <rect x={lx - 50} y={ly - 13} width={100} height={24} rx={7}
                      fill="#0f172a" stroke={color} strokeWidth={1.2} opacity={0.97} />
                    <text x={lx} y={ly + 4} textAnchor="middle"
                      fill={color} fontSize="11" fontWeight="700"
                      fontFamily="'Courier New', monospace">
                      {flow.flowType === 'solar' ? '☀ ' : ''}{Math.round(flow.watts).toLocaleString()} W
                    </text>
                  </>
                )}
                {!flow.hasTempData && !isExternal && (
                  <text x={lx} y={ly + 4} textAnchor="middle"
                    fill="#475569" fontSize="9" fontFamily="system-ui, sans-serif">
                    no data
                  </text>
                )}
              </g>
            );
          })}

          {/* ── Outside node (center) ── */}
          <g>
            <circle cx={CX} cy={CY} r={OUTSIDE_R} fill="#0c1526"
              stroke="#475569" strokeWidth={1.5} strokeDasharray="6 3" />

            {/* Label */}
            <text x={CX} y={CY - (peakSolAirTemp !== null ? 38 : 26)} textAnchor="middle"
              fill="#64748b" fontSize="9" fontWeight="700" letterSpacing="1.5"
              fontFamily="system-ui, sans-serif">
              OUTSIDE
            </text>

            {/* Air temperature */}
            {outdoorTemp !== null ? (<>
              <text x={CX} y={CY - (peakSolAirTemp !== null ? 26 : 14)} textAnchor="middle"
                fill="#94a3b8" fontSize="9" fontFamily="system-ui, sans-serif">
                Air
              </text>
              <text x={CX} y={CY - (peakSolAirTemp !== null ? 10 : 2)} textAnchor="middle"
                fill="#cbd5e1" fontSize={peakSolAirTemp !== null ? 14 : 17} fontWeight="800"
                fontFamily="'Courier New', monospace">
                {outdoorTemp.toFixed(1)}°C
              </text>
            </>) : (
              <text x={CX} y={CY - 4} textAnchor="middle"
                fill="#475569" fontSize="10" fontFamily="system-ui, sans-serif">
                no data
              </text>
            )}

            {/* Sol-air temperature — only shown when sun is heating walls */}
            {peakSolAirTemp !== null && (<>
              <line x1={CX - 28} y1={CY + 6} x2={CX + 28} y2={CY + 6}
                stroke="#475569" strokeWidth={0.5} />
              <text x={CX} y={CY + 17} textAnchor="middle"
                fill="#f97316" fontSize="8" fontFamily="system-ui, sans-serif">
                Wall sol-air
              </text>
              <text x={CX} y={CY + 31} textAnchor="middle"
                fill="#fb923c" fontSize="13" fontWeight="800"
                fontFamily="'Courier New', monospace">
                ~{peakSolAirTemp.toFixed(0)}°C
              </text>
            </>)}

            {/* "ambient" shown only when no sol-air data */}
            {peakSolAirTemp === null && (
              <text x={CX} y={CY + 16} textAnchor="middle"
                fill="#475569" fontSize="9" fontFamily="system-ui, sans-serif">
                ambient
              </text>
            )}
          </g>

          {/* ── Zone nodes ── */}
          {zonePos.map(pos => {
            const isActive = pos.id === activeZoneId;
            const zone     = zones.find(z => z.id === pos.id);
            const temp     = allZoneTemps[pos.id]?.[h0] ?? null;
            const net      = netBalance[pos.id] ?? 0;
            const cond     = (zone?.ac.length ?? 0) > 0;

            const isGainer = net >  THRESHOLD;
            const isLoser  = net < -THRESHOLD;

            const fill    = isActive ? '#1e3a5f' : '#1e293b';
            const stroke  = isActive   ? '#3b82f6'
                          : isGainer   ? '#f97316'
                          : isLoser    ? '#38bdf8'
                          : '#475569';
            const strokeW = isActive ? 2.5 : 1.8;
            const glow    = isActive ? 'url(#hf2-glow-active)' : (isGainer || isLoser) ? 'url(#hf2-glow-node)' : undefined;

            // Net badge text under temperature
            const netLabel = isGainer
              ? `▲ +${Math.round(net).toLocaleString()} W`
              : isLoser
              ? `▼ ${Math.round(net).toLocaleString()} W`
              : '≈ balanced';
            const netColor = isGainer ? '#f97316' : isLoser ? '#38bdf8' : '#64748b';

            return (
              <g key={pos.id}>
                <rect
                  x={pos.x - NHW} y={pos.y - NHH}
                  width={NHW * 2} height={NHH * 2}
                  rx={13} ry={13}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={strokeW}
                  filter={glow}
                />
                {/* Zone name */}
                <text x={pos.x} y={pos.y - 16} textAnchor="middle"
                  fill="#e2e8f0" fontSize="11" fontWeight="700"
                  fontFamily="system-ui, sans-serif">
                  {pos.name}
                </text>
                {/* Temperature */}
                {temp !== null ? (
                  <text x={pos.x} y={pos.y + 2} textAnchor="middle"
                    fill="#ffffff" fontSize="16" fontWeight="800"
                    fontFamily="'Courier New', monospace">
                    {temp.toFixed(1)}°C
                  </text>
                ) : (
                  <text x={pos.x} y={pos.y + 2} textAnchor="middle"
                    fill="#475569" fontSize="10"
                    fontFamily="system-ui, sans-serif">
                    no sensor
                  </text>
                )}
                {/* Net heat + AC badge */}
                <text x={pos.x} y={pos.y + 18} textAnchor="middle"
                  fill={netColor} fontSize="9" fontWeight="700"
                  fontFamily="'Courier New', monospace">
                  {netLabel}
                </text>
                <text x={pos.x} y={pos.y + 30} textAnchor="middle"
                  fill={isActive ? '#3b82f6' : cond ? '#22d3ee' : '#94a3b8'}
                  fontSize="8" fontWeight="600"
                  fontFamily="system-ui, sans-serif">
                  {isActive ? 'ACTIVE · ' : ''}{cond ? '● AC' : '○ Uncond.'}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* ── Legend ── */}
      <div className="flex flex-wrap gap-4 justify-center mt-2 mb-5 text-xs text-slate-400">
        <div className="flex items-center gap-2">
          <svg width="36" height="8"><path d="M 0 4 L 36 4" fill="none" stroke="#f59e0b" strokeWidth="3" strokeDasharray="9 5"/></svg>
          <span><span className="text-amber-400 font-semibold">Amber</span> = Solar gain</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="36" height="8"><path d="M 0 4 L 36 4" fill="none" stroke="#f97316" strokeWidth="3" strokeDasharray="9 5"/></svg>
          <span><span className="text-orange-400 font-semibold">Orange</span> = Heat entering zone</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="36" height="8"><path d="M 0 4 L 36 4" fill="none" stroke="#38bdf8" strokeWidth="3" strokeDasharray="9 5"/></svg>
          <span><span className="text-sky-400 font-semibold">Blue</span> = Heat escaping to outside</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-5 h-4 rounded border-2 border-orange-500 bg-slate-900" />
          <span><span className="text-orange-400 font-semibold">Orange border</span> = net heat gainer</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-5 h-4 rounded border-2 border-sky-400 bg-slate-900" />
          <span><span className="text-sky-400 font-semibold">Blue border</span> = net heat loser</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="36" height="8"><path d="M 0 4 Q 18 1 36 4" fill="none" stroke="#334155" strokeWidth="1.5" strokeDasharray="4 5"/></svg>
          <span>No data / &lt; {THRESHOLD} W</span>
        </div>
      </div>

      {/* ── Per-zone heat balance cards ── */}
      <div className={`grid gap-3 ${
        zones.length <= 2 ? 'grid-cols-2' :
        zones.length === 3 ? 'grid-cols-3' :
        'grid-cols-2 md:grid-cols-4'
      }`}>
        {zones.map(z => {
          const net      = netBalance[z.id] ?? 0;
          const temp     = allZoneTemps[z.id]?.[h0];
          const isGainer = net >  THRESHOLD;
          const isLoser  = net < -THRESHOLD;

          // Simulation components at current slot — used for card breakdown matching chart values
          const simSlot  = allZoneResults?.[z.id]?.data[slot];
          const s_solar  = simSlot?.solarLoad  ?? 0;
          const s_wall   = simSlot?.wallLoad   ?? 0;
          const s_roof   = simSlot?.roofLoad   ?? 0;
          const s_inf    = simSlot?.infLoad    ?? 0;
          const s_glass  = simSlot?.glassLoad  ?? 0;

          // Zone-to-zone flows from/to this zone (diagram arrows)
          const zoneLosses = heatFlows.filter(f => f.hasTempData && !f.isExternal && f.fromId === z.id && f.watts > THRESHOLD);
          const zoneGains  = heatFlows.filter(f => f.hasTempData && !f.isExternal && f.toId   === z.id && f.watts > THRESHOLD);

          return (
            <div key={z.id} className={`p-4 rounded-xl border ${
              isGainer ? 'border-orange-800 bg-orange-950/20' :
              isLoser  ? 'border-sky-800   bg-sky-950/20'    :
                         'border-slate-800 bg-slate-900/60'
            }`}>
              {/* Header row */}
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider flex items-center gap-1">
                  {z.id === activeZoneId && <span className="text-blue-400 text-[8px]">●</span>}
                  {z.zone.displayName || z.zone.name}
                </p>
                {temp != null && (
                  <p className="text-[10px] font-mono text-slate-400">{temp.toFixed(1)}°C</p>
                )}
              </div>

              {/* Net watts */}
              <p className={`text-2xl font-mono font-bold ${
                isGainer ? 'text-orange-400' : isLoser ? 'text-sky-400' : 'text-slate-500'
              }`}>
                {net > 0 ? '+' : ''}{Math.round(net).toLocaleString()} W
              </p>
              <p className="text-[10px] text-slate-500 mt-0.5">
                {isGainer ? '▲ net heat gain' : isLoser ? '▼ net heat loss' : '≈ balanced'}
              </p>

              {/* External heat gain breakdown — matches Stacked Heat Load chart exactly */}
              {simSlot && (
                <div className="mt-2 border-t border-slate-800 pt-2 space-y-0.5">
                  <p className="text-[8px] text-slate-600 uppercase tracking-wider mb-1">From outside</p>
                  {s_solar  > THRESHOLD && <p className="text-[9px] font-mono text-amber-500">☀ Solar: +{Math.round(s_solar).toLocaleString()} W</p>}
                  {s_wall   > THRESHOLD && <p className="text-[9px] font-mono text-orange-500">⬛ Wall cond.: +{Math.round(s_wall).toLocaleString()} W</p>}
                  {s_glass  > THRESHOLD && <p className="text-[9px] font-mono text-orange-400">⬜ Glass cond.: +{Math.round(s_glass).toLocaleString()} W</p>}
                  {s_roof   > THRESHOLD && <p className="text-[9px] font-mono text-purple-400">▲ Roof: +{Math.round(s_roof).toLocaleString()} W</p>}
                  {s_inf    > THRESHOLD && <p className="text-[9px] font-mono text-slate-400">↪ Infiltration: +{Math.round(s_inf).toLocaleString()} W</p>}
                  {s_solar <= THRESHOLD && s_wall <= THRESHOLD && s_glass <= THRESHOLD && s_roof <= THRESHOLD && s_inf <= THRESHOLD && (
                    <p className="text-[9px] text-slate-600">no significant external gain</p>
                  )}
                </div>
              )}

              {/* Zone-to-zone flows */}
              {(zoneGains.length > 0 || zoneLosses.length > 0) && (
                <div className="mt-2 border-t border-slate-800 pt-2 space-y-0.5">
                  <p className="text-[8px] text-slate-600 uppercase tracking-wider mb-1">Zone transfers</p>
                  {zoneGains.map(f => (
                    <p key={f.pairKey} className="text-[9px] font-mono text-orange-500">
                      ← {posById[f.fromId]?.name ?? '?'}: +{Math.round(f.watts).toLocaleString()} W
                    </p>
                  ))}
                  {zoneLosses.map(f => (
                    <p key={f.pairKey} className="text-[9px] font-mono text-sky-500">
                      → {posById[f.toId]?.name ?? '?'}: −{Math.round(f.watts).toLocaleString()} W
                    </p>
                  ))}
                </div>
              )}

              {/* AC badge */}
              <p className="text-[9px] mt-1.5 font-semibold" style={{ color: (z.ac.length > 0) ? '#22d3ee' : '#94a3b8' }}>
                {z.ac.length > 0 ? `● AC · ${z.ac[0].ratedCapacityWatts.toLocaleString()} W` : '○ Unconditioned'}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

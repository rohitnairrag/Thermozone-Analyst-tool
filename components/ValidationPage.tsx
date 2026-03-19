/**
 * ValidationPage.tsx
 *
 * Runs the physics engine in pure-prediction mode (Path B — no real indoor temps fed in)
 * and compares the output against real sensor readings from the DB.
 *
 * Accessible at /validate (served by the Vite dev server).
 */

import React, { useState } from 'react';
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { calculateHeatLoad } from '../services/physicsEngine';
import { fetchWeatherForDate } from '../services/weatherService';
import { fetchHistoricalTemps, fetchHistoricalAcOutput } from '../services/liveDataService';
import { ZoneProfile } from '../types';

const LAT = 12.9716;
const LON = 77.5946;

interface Metrics {
  rmse: number | null;
  mae: number | null;
  bias: number | null;
  maxErr: number | null;
  r2: number | null;
  dataHours: number;
}

interface HourRow {
  hour: string;
  predicted: number;
  actual: number | null;
  outdoor: number;
  error: number | null;
  solarGlass: number;
  wall: number;
  roof: number;
  inf: number;
  internal: number;
  acCooling: number;
  totalHeat: number;
}

// ── Tiny metric card ─────────────────────────────────────────────────────────
function MetricCard({ label, value, unit, good, bad }: {
  label: string; value: string; unit?: string; good?: boolean; bad?: boolean;
}) {
  const colour = good ? 'text-green-400' : bad ? 'text-red-400' : 'text-amber-400';
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 text-center">
      <p className="text-[10px] text-slate-400 uppercase tracking-widest font-bold mb-1">{label}</p>
      <p className={`text-2xl font-mono font-bold ${colour}`}>{value}</p>
      {unit && <p className="text-[10px] text-slate-500 mt-0.5">{unit}</p>}
    </div>
  );
}

// ── Custom tooltip ────────────────────────────────────────────────────────────
const TempTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-slate-400 font-bold mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: <span className="font-mono font-bold">{p.value?.toFixed ? p.value.toFixed(1) : p.value}°C</span>
        </p>
      ))}
    </div>
  );
};

const LoadTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-slate-400 font-bold mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: <span className="font-mono font-bold">{(p.value / 1000).toFixed(2)} kW</span>
        </p>
      ))}
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────
export default function ValidationPage() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const yesterday = (() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  })();

  const [zoneName, setZoneName] = useState('Zone 1');
  const [date, setDate] = useState(yesterday);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [rows, setRows] = useState<HourRow[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [acNote, setAcNote] = useState('');
  const [sensorNote, setSensorNote] = useState('');
  const [startTempNote, setStartTempNote] = useState('');

  const run = async () => {
    setRunning(true);
    setError('');
    setRows([]);
    setMetrics(null);

    try {
      // ── 1. Zone config ──────────────────────────────────────────────────────
      setStatus('Loading zone configuration…');
      const cfgRes = await fetch('http://localhost:3001/api/zones/config');
      if (!cfgRes.ok) throw new Error('Cannot reach API server on port 3001 — is it running?');
      const cfgData = await cfgRes.json();
      const zoneProfile: ZoneProfile = cfgData.zones?.find((z: any) => z.zone.name === zoneName);
      if (!zoneProfile) throw new Error(`Zone "${zoneName}" not found in saved config.`);

      // ── 2. Weather ──────────────────────────────────────────────────────────
      setStatus('Fetching weather from Open-Meteo…');
      const weather = await fetchWeatherForDate(LAT, LON, date);
      if (!weather) throw new Error('Weather data unavailable for this date.');

      // ── 3. Real sensor temps (comparison only — NOT fed into simulation) ───
      setStatus('Fetching real sensor temperatures from DB…');
      const realTempsData = await fetchHistoricalTemps(zoneName, date);
      const actualTemps = realTempsData?.hasData ? realTempsData.temps : null;
      setSensorNote(
        actualTemps
          ? `${realTempsData!.hoursFromToday} hours of sensor data from DB`
          : 'No sensor data found for this date'
      );

      // ── 4. Real AC electrical output ────────────────────────────────────────
      setStatus('Fetching AC output from DB…');
      const acData = await fetchHistoricalAcOutput(zoneName, date);
      const acOutputsW = acData?.hasData ? acData.acOutputs : null;
      setAcNote(
        acData?.hasData
          ? `${acData.hoursFromToday} hours of AC power data from DB`
          : 'No AC power data — cooling set to 0'
      );

      // ── 5. Starting temperature — yesterday's last sensor reading ────────────
      // The building stores heat from previous days; if we start at 24°C (hardcoded)
      // the model runs too cold all day. Using the real end-of-yesterday temp fixes this.
      setStatus('Fetching yesterday\'s sensor data for starting temperature…');
      const prevDate = (() => {
        const d = new Date(date); d.setDate(d.getDate() - 1);
        return d.toISOString().slice(0, 10);
      })();
      const prevTempsData = await fetchHistoricalTemps(zoneName, prevDate);
      const initialTempC = prevTempsData?.hasData
        ? prevTempsData.temps[23]   // room temp at 11pm yesterday = starting temp today
        : null;
      setStartTempNote(
        initialTempC != null
          ? `Starting at ${initialTempC.toFixed(1)}°C (real sensor, ${prevDate} 11pm)`
          : `Starting at 24.0°C (fallback — no yesterday sensor data found)`
      );

      // ── 6. Run physics simulation — PATH B (realIndoorTemps = null) ─────────
      // We do NOT pass real sensor temps, so the engine predicts from physics alone.
      // We compare the output to real data to measure accuracy.
      setStatus('Running physics simulation (Path B — pure prediction)…');
      const result = calculateHeatLoad(
        zoneProfile.zone,
        zoneProfile.ac,
        weather,
        LAT, LON,
        null,          // ← null forces Path B (pure physics prediction)
        acOutputsW,    // real AC electrical watts → converted to cooling inside engine
        zoneProfile.internalLoads || [],
        {},            // no adjacent zone temps
        initialTempC,  // ← real starting temp from DB (yesterday 11pm); null → 24°C fallback
      );

      // ── 7. Aggregate 1-min slots → hourly rows ───────────────────────────────
      const SLOTS = result.data.length; // 1440 for 1-min resolution
      const slotsPerHour = SLOTS / 24;  // = 60

      const avg = (arr: number[]) =>
        arr.reduce((a, b) => a + b, 0) / arr.length;

      const hourlyRows: HourRow[] = Array.from({ length: 24 }, (_, h) => {
        const s0 = Math.floor(h * slotsPerHour);
        const s1 = Math.min(SLOTS, Math.ceil((h + 1) * slotsPerHour));
        const sl = result.data.slice(s0, s1);
        const act = actualTemps?.[h] ?? null;
        const pred = +avg(sl.map(s => s.indoorTempRaw)).toFixed(2);
        return {
          hour: String(h).padStart(2, '0') + ':00',
          predicted: pred,
          actual: act != null ? +act.toFixed(2) : null,
          outdoor: +avg(sl.map(s => s.outdoorTemp)).toFixed(2),
          error: act != null ? +(pred - act).toFixed(2) : null,
          solarGlass: +avg(sl.map(s => s.solarLoad + s.glassLoad)).toFixed(0),
          wall: +avg(sl.map(s => s.wallLoad)).toFixed(0),
          roof: +avg(sl.map(s => s.roofLoad)).toFixed(0),
          inf: +avg(sl.map(s => s.infLoad)).toFixed(0),
          internal: +avg(sl.map(s => s.internalLoad + s.peopleLoad + s.otherLoad)).toFixed(0),
          acCooling: -Math.abs(+avg(sl.map(s => s.acOutputWatts)).toFixed(0)),
          totalHeat: +avg(sl.map(s => s.totalHeatLoad)).toFixed(0),
        };
      });

      // ── 7. Accuracy metrics ─────────────────────────────────────────────────
      const pairs = hourlyRows.filter(r => r.actual != null);
      let rmse = null, mae = null, bias = null, maxErr = null, r2 = null;
      if (pairs.length > 0) {
        const errs = pairs.map(r => r.error as number);
        rmse   = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
        mae    = errs.reduce((s, e) => s + Math.abs(e), 0) / errs.length;
        bias   = errs.reduce((s, e) => s + e, 0) / errs.length;
        maxErr = Math.max(...errs.map(Math.abs));
        const actMu = pairs.reduce((s, r) => s + (r.actual as number), 0) / pairs.length;
        const ss_tot = pairs.reduce((s, r) => s + ((r.actual as number) - actMu) ** 2, 0);
        const ss_res = errs.reduce((s, e) => s + e * e, 0);
        r2 = ss_tot > 0.001 ? 1 - ss_res / ss_tot : null;
      }

      setRows(hourlyRows);
      setMetrics({ rmse, mae, bias, maxErr, r2, dataHours: pairs.length });
      setStatus('Done');
    } catch (err: any) {
      setError(err.message);
      setStatus('');
    } finally {
      setRunning(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 font-sans max-w-5xl mx-auto">

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Heat Load Validation</h1>
        <p className="text-slate-400 text-sm mt-1">
          Runs the <span className="text-blue-400 font-mono">physicsEngine</span> in pure-prediction mode (no sensor temps fed in)
          and compares against real sensor readings from the DB.
        </p>
      </div>

      {/* Equation */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6">
        <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-2">How the prediction works</p>
        <p className="text-blue-300 font-mono text-sm bg-slate-950 rounded-lg px-4 py-2 border-l-2 border-blue-500 mb-2">
          T(slot+1) = T(slot) + [ Q_heat(slot) − Q_AC(slot) ] × 1800s / C_thermal
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] font-mono">
          {[
            ['Q_heat',   'solar + wall + glass + roof + infiltration + internal'],
            ['Q_AC',     'real DB electrical watts × avg ISEER'],
            ['C_thermal','ρ_air × Cp × Volume  (30-min timestep = stable)'],
            ['Path B',   'real indoor temps NOT used → genuine prediction'],
          ].map(([k, v]) => (
            <div key={k} className="bg-slate-950 rounded-lg px-3 py-1.5">
              <span className="text-slate-400">{k} = </span>
              <span className="text-slate-300">{v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-4 bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-400 uppercase tracking-widest font-bold">Zone</label>
          <select
            value={zoneName}
            onChange={e => setZoneName(e.target.value)}
            className="bg-slate-950 border border-slate-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500"
          >
            {['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4'].map(z => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-400 uppercase tracking-widest font-bold">Date</label>
          <input
            type="date"
            value={date}
            max={today}
            onChange={e => setDate(e.target.value)}
            className="bg-slate-950 border border-slate-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500"
          />
        </div>
        <button
          onClick={run}
          disabled={running}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-sm px-5 py-2 rounded-lg transition-colors"
        >
          {running ? 'Running…' : '▶  Run Validation'}
        </button>
      </div>

      {/* Status / error */}
      {status && !error && (
        <div className="mb-4 px-4 py-2.5 bg-blue-950/50 border border-blue-800 rounded-xl text-blue-300 text-sm">
          {status}
        </div>
      )}
      {error && (
        <div className="mb-4 px-4 py-2.5 bg-red-950/50 border border-red-800 rounded-xl text-red-300 text-sm">
          Error: {error}
        </div>
      )}

      {/* Results */}
      {rows.length > 0 && metrics && (
        <>
          {/* Data source notes */}
          <div className="flex flex-wrap gap-3 mb-6 text-xs">
            <span className="px-3 py-1 bg-green-950/40 border border-green-800/50 text-green-400 rounded-full">
              ● Sensors: {sensorNote}
            </span>
            <span className="px-3 py-1 bg-blue-950/40 border border-blue-800/50 text-blue-400 rounded-full">
              ● AC Power: {acNote}
            </span>
            <span className="px-3 py-1 bg-purple-950/40 border border-purple-800/50 text-purple-400 rounded-full">
              ● Physics: 1-min timestep · Path B (no sensor temps fed in)
            </span>
            <span className={`px-3 py-1 border rounded-full ${startTempNote.includes('real sensor') ? 'bg-teal-950/40 border-teal-800/50 text-teal-400' : 'bg-amber-950/40 border-amber-800/50 text-amber-400'}`}>
              ● T₀: {startTempNote}
            </span>
          </div>

          {/* Metrics */}
          {metrics.dataHours === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-center text-slate-400 mb-6">
              No real sensor data found for this date — only predicted temperature shown below.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
                <MetricCard
                  label="RMSE"
                  value={metrics.rmse != null ? metrics.rmse.toFixed(2) : '—'}
                  unit="°C"
                  good={metrics.rmse != null && metrics.rmse <= 1.5}
                  bad={metrics.rmse != null && metrics.rmse > 3}
                />
                <MetricCard
                  label="MAE"
                  value={metrics.mae != null ? metrics.mae.toFixed(2) : '—'}
                  unit="°C"
                  good={metrics.mae != null && metrics.mae <= 1}
                  bad={metrics.mae != null && metrics.mae > 2}
                />
                <MetricCard
                  label="Max Error"
                  value={metrics.maxErr != null ? metrics.maxErr.toFixed(2) : '—'}
                  unit="°C"
                  good={metrics.maxErr != null && metrics.maxErr <= 2}
                  bad={metrics.maxErr != null && metrics.maxErr > 4}
                />
                <MetricCard
                  label="Bias"
                  value={metrics.bias != null ? (metrics.bias > 0 ? '+' : '') + metrics.bias.toFixed(2) : '—'}
                  unit={metrics.bias != null && metrics.bias > 0.3 ? 'over-predicts' : metrics.bias != null && metrics.bias < -0.3 ? 'under-predicts' : 'balanced'}
                  good={metrics.bias != null && Math.abs(metrics.bias) <= 0.5}
                  bad={metrics.bias != null && Math.abs(metrics.bias) > 2}
                />
                <MetricCard
                  label="R²"
                  value={metrics.r2 != null ? metrics.r2.toFixed(3) : '—'}
                  unit="1.0 = perfect"
                  good={metrics.r2 != null && metrics.r2 >= 0.85}
                  bad={metrics.r2 != null && metrics.r2 < 0.5}
                />
                <MetricCard
                  label="Data Hours"
                  value={String(metrics.dataHours)}
                  unit="out of 24"
                  good={metrics.dataHours >= 20}
                  bad={metrics.dataHours < 8}
                />
              </div>

              {/* Interpretation */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6 text-sm text-slate-300 leading-relaxed">
                {metrics.rmse != null && metrics.rmse <= 1.5 && (
                  <p>✅ <strong className="text-white">Good match.</strong> The physics model predicts temperature within ±{metrics.rmse.toFixed(1)}°C RMS. The heat load calculation is well calibrated.</p>
                )}
                {metrics.rmse != null && metrics.rmse > 1.5 && metrics.rmse <= 3 && (
                  <p>⚠️ <strong className="text-white">Acceptable match.</strong> RMSE of {metrics.rmse.toFixed(1)}°C is reasonable for a simplified physics model. See the error chart below to identify which hours are off.</p>
                )}
                {metrics.rmse != null && metrics.rmse > 3 && (
                  <p>❌ <strong className="text-white">Large error.</strong> RMSE of {metrics.rmse.toFixed(1)}°C suggests the model is missing something — likely thermal mass stored from previous days, or the starting temperature is wrong.</p>
                )}
                {metrics.bias != null && Math.abs(metrics.bias) > 0.5 && (
                  <span className="ml-2">
                    Bias of {metrics.bias > 0 ? '+' : ''}{metrics.bias.toFixed(1)}°C means the model consistently {metrics.bias > 0 ? 'over-estimates heat or under-estimates AC cooling' : 'under-estimates heat or over-estimates AC cooling'}.
                  </span>
                )}
                {metrics.r2 != null && metrics.r2 < 0 && (
                  <p className="mt-1 text-amber-400">⚠️ Negative R² means the model predicts worse than just using the daily average. This usually means the starting temperature is far off (thermal mass of building not modelled).</p>
                )}
              </div>
            </>
          )}

          {/* Temperature chart */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-5">
            <h2 className="text-xs text-slate-400 uppercase tracking-widest font-bold mb-4">
              Temperature: Predicted vs Actual (°C)
            </h2>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={rows} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="hour" tick={{ fill: '#64748b', fontSize: 11 }} />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} unit="°C" domain={['auto', 'auto']} />
                <Tooltip content={<TempTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} />
                <Line dataKey="outdoor"   name="Outdoor"            stroke="#475569" strokeWidth={1.5} dot={false} strokeDasharray="4 4" />
                <Line dataKey="predicted" name="Predicted (Path B)" stroke="#3b82f6" strokeWidth={2.5} dot={false} strokeDasharray="6 3" />
                {rows.some(r => r.actual != null) && (
                  <Line dataKey="actual" name="Actual (sensors)" stroke="#22c55e" strokeWidth={2.5} dot={{ r: 3, fill: '#22c55e' }} connectNulls={false} />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Heat load breakdown */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-5">
            <h2 className="text-xs text-slate-400 uppercase tracking-widest font-bold mb-4">
              Heat Load Breakdown per Hour (W) — what drives temperature up/down
            </h2>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={rows} margin={{ top: 4, right: 16, bottom: 0, left: 0 }} stackOffset="sign">
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="hour" tick={{ fill: '#64748b', fontSize: 11 }} />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} tickFormatter={v => (v / 1000).toFixed(1) + 'kW'} />
                <Tooltip content={<LoadTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
                <ReferenceLine y={0} stroke="#334155" />
                <Bar dataKey="solarGlass" name="Solar + Glass"  stackId="a" fill="#fbbf24" />
                <Bar dataKey="wall"       name="Walls"          stackId="a" fill="#f97316" />
                <Bar dataKey="roof"       name="Roof"           stackId="a" fill="#f43f5e" />
                <Bar dataKey="inf"        name="Infiltration"   stackId="a" fill="#a78bfa" />
                <Bar dataKey="internal"   name="Internal Loads" stackId="a" fill="#facc15" />
                <Bar dataKey="acCooling"  name="AC Cooling (−)" stackId="a" fill="#22d3ee" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Error per hour */}
          {rows.some(r => r.error != null) && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-5">
              <h2 className="text-xs text-slate-400 uppercase tracking-widest font-bold mb-1">
                Prediction Error per Hour: Predicted − Actual (°C)
              </h2>
              <p className="text-[11px] text-slate-500 mb-4">
                Orange = model over-predicted (room warmer than sensors said).
                Green = model under-predicted (room cooler than sensors said).
              </p>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={rows} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="hour" tick={{ fill: '#64748b', fontSize: 11 }} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 11 }} unit="°C" />
                  <Tooltip formatter={(v: any) => [typeof v === 'number' ? v.toFixed(2) + '°C' : '—', 'Error']} />
                  <ReferenceLine y={0} stroke="#475569" />
                  <Bar
                    dataKey="error"
                    name="Error"
                    fill="#f97316"
                    label={false}
                    // colour each bar individually
                    isAnimationActive={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Raw data table */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h2 className="text-xs text-slate-400 uppercase tracking-widest font-bold mb-4">Hourly Data Table</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="text-slate-500 border-b border-slate-800">
                    {['Hour','Outdoor','Predicted','Actual','Error','Total Heat','AC Cooling'].map(h => (
                      <th key={h} className="text-left py-2 px-2 font-semibold tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const errCls = r.error == null ? 'text-slate-600'
                      : Math.abs(r.error) <= 1 ? 'text-green-400'
                      : Math.abs(r.error) <= 2 ? 'text-amber-400'
                      : 'text-red-400';
                    return (
                      <tr key={r.hour} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                        <td className="py-1.5 px-2 text-slate-400">{r.hour}</td>
                        <td className="py-1.5 px-2 text-slate-300">{r.outdoor.toFixed(1)}°C</td>
                        <td className="py-1.5 px-2 text-blue-400 font-semibold">{r.predicted.toFixed(1)}°C</td>
                        <td className="py-1.5 px-2 text-green-400">{r.actual != null ? r.actual.toFixed(1) + '°C' : '—'}</td>
                        <td className={`py-1.5 px-2 font-semibold ${errCls}`}>
                          {r.error != null ? (r.error > 0 ? '+' : '') + r.error.toFixed(2) + '°C' : '—'}
                        </td>
                        <td className="py-1.5 px-2 text-slate-300">{(r.totalHeat / 1000).toFixed(2)} kW</td>
                        <td className="py-1.5 px-2 text-cyan-400">{(-r.acCooling / 1000).toFixed(2)} kW</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

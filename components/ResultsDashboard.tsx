import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  AreaChart, Area, ReferenceLine
} from 'recharts';
import { SimulationResult, SimulationDataPoint, WallDef } from '../types';
import { AlertTriangle, CheckCircle, Zap, CloudSun } from 'lucide-react';

interface TooltipEntry {
  value: number;
  dataKey: string;
  name: string;
  color: string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
  ratedCapacity?: number;
}

const CustomTooltip = ({ active, payload, label, ratedCapacity }: CustomTooltipProps) => {
  if (!active || !payload?.length) return null;

  return (
    <div className="bg-slate-900 border border-slate-700 p-3 rounded-lg shadow-xl text-slate-100 text-xs z-50">
      <p className="font-semibold mb-2 text-slate-400 border-b border-slate-800 pb-1">{label}</p>
      {payload.map((entry, index) => {
        const value = Number(entry.value);
        if (value === 0 && entry.dataKey !== 'indoorTempRaw') return null;

        const isTempKey = ['indoorTempRaw', 'setPoint', 'outdoorTemp'].includes(entry.dataKey);
        const unit = isTempKey ? '°C' : 'W';
        const isAcOutput = entry.dataKey === 'acOutputWatts';

        return (
          <div key={index} className="flex items-center justify-between gap-4 mb-1">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
              <span className="text-slate-300">{entry.name}</span>
            </div>
            <div className="font-mono font-medium">
              {value.toFixed(1)} {unit}
              {isAcOutput && ratedCapacity ? (
                <span className="text-slate-500 ml-1">
                  ({((value / ratedCapacity) * 100).toFixed(0)}%)
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
};

type ProcessedDataPoint = SimulationDataPoint & { internalCombined: number };

interface Props {
  results: SimulationResult;
  ratedCapacityWatts: number;
  locationName?: string;
  walls?: WallDef[];
  isToday?: boolean;
}

const ResultsDashboard: React.FC<Props> = ({ results, ratedCapacityWatts, locationName, walls = [], isToday = true }) => {
  const peakLoadTR = (results.peakLoadWatts / 3517).toFixed(2);
  const acOutputTR = (results.acOutputAtPeakLoad / 3517).toFixed(2);

  // Current IST hour — chart only shows hours 0 … currentISTHour (no future data) when isToday
  const currentISTHour = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
  ).getHours();

  // Slice simulation data: today → up to current IST hour; historical → full 24h
  const chartData = isToday ? results.data.slice(0, currentISTHour + 1) : results.data;
  const timeRangeLabel = isToday ? `0:00 → ${currentISTHour}:00 IST` : `Full Day (0:00 – 23:00)`;

  const processedData: ProcessedDataPoint[] = chartData.map(d => ({
    ...d,
    internalCombined: (d.internalLoad || 0) + (d.peopleLoad || 0) + (d.otherLoad || 0) + (d.glassLoad || 0)
  }));

  const areaConfig = [
    { key: 'internalCombined' as keyof ProcessedDataPoint, name: 'Internal', color: '#10b981' },
    { key: 'infLoad' as keyof ProcessedDataPoint, name: 'Infiltration', color: '#94a3b8' },
    { key: 'roofLoad' as keyof ProcessedDataPoint, name: 'Roof', color: '#8b5cf6' },
    { key: 'wallLoad' as keyof ProcessedDataPoint, name: 'Wall', color: '#6366f1' },
    { key: 'solarLoad' as keyof ProcessedDataPoint, name: 'Solar', color: '#f59e0b' },
  ];

  const activeAreas = areaConfig.filter(cat =>
    processedData.some(point => {
      const val = point[cat.key];
      return typeof val === 'number' && val > 0;
    })
  );

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Location Header */}
      {locationName && (
        <div className="flex items-center gap-2 text-slate-400 px-1">
          <CloudSun size={16} className="text-blue-400" />
          <span className="text-xs font-medium uppercase tracking-wider">Weather Data Source:</span>
          <span className="text-xs text-white font-semibold">{locationName}</span>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className={`p-4 rounded-xl border ${results.isSufficient ? 'bg-green-900/20 border-green-700' : 'bg-red-900/20 border-red-700'}`}>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-gray-300">Verdict</h3>
            {results.isSufficient ? <CheckCircle className="text-green-500" size={20} /> : <AlertTriangle className="text-red-500" size={20} />}
          </div>
          <p className={`text-2xl font-bold ${results.isSufficient ? 'text-green-400' : 'text-red-400'}`}>
            {results.isSufficient ? 'SUFFICIENT' : 'UNDERSIZED'}
          </p>
          <p className="text-xs text-gray-400 mt-1">Actual AC Output vs Peak Load</p>
        </div>

        <div className="p-4 bg-slate-800 rounded-xl border border-slate-700">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-gray-300">Peak Load</h3>
            <Zap className="text-yellow-500" size={20} />
          </div>
          <p className="text-2xl font-bold text-white">{peakLoadTR} <span className="text-sm font-normal text-gray-400">TR</span></p>
          <p className="text-xs text-gray-400 mt-1">At {results.peakLoadTime} ({Math.round(results.peakLoadWatts)} W)</p>
        </div>

        <div className="p-4 bg-slate-800 rounded-xl border border-slate-700">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-gray-300">AC Output at Peak</h3>
            <Zap className="text-blue-400" size={20} />
          </div>
          <p className="text-2xl font-bold text-white">{acOutputTR} <span className="text-sm font-normal text-gray-400">TR</span></p>
          <p className="text-xs text-gray-400 mt-1">At peak hour · {Math.round(results.acOutputAtPeakLoad)} W</p>
        </div>

      </div>

      {/* Main Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Load Profile Chart */}
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-semibold text-white">Total Heat Load vs Time</h3>
            <span className="text-xs text-slate-400 font-mono bg-slate-700 px-2 py-1 rounded">
              {timeRangeLabel}
            </span>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorLoad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="time" stroke="#94a3b8" fontSize={12} interval={Math.max(1, Math.floor(chartData.length / 6))} />
                <YAxis
                  stroke="#94a3b8"
                  fontSize={12}
                  label={{ value: 'Watts', angle: -90, position: 'insideLeft', fill: '#94a3b8' }}
                  domain={[0, 'auto']}
                />
                <Tooltip content={<CustomTooltip ratedCapacity={ratedCapacityWatts} />} />
                <Legend />
                <ReferenceLine
                  y={ratedCapacityWatts}
                  stroke="#3b82f6"
                  strokeDasharray="3 3"
                  label={{ position: 'insideTopRight', value: 'Max Capacity', fill: '#3b82f6', fontSize: 10 }}
                />
                <Area type="monotone" dataKey="totalHeatLoad" name="Total Heat Load" stroke="#ef4444" fillOpacity={1} fill="url(#colorLoad)" />
                <Line type="monotone" dataKey="acOutputWatts" name="AC Output" stroke="#3b82f6" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Load Breakdown Chart */}
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-semibold text-white">Stacked Heat Load Components</h3>
            <span className="text-xs text-slate-400 font-mono bg-slate-700 px-2 py-1 rounded">
              {timeRangeLabel}
            </span>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={processedData} margin={{ top: 20, right: 20, left: 10, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="time" stroke="#94a3b8" fontSize={12} interval={Math.max(1, Math.floor(processedData.length / 6))} />
                <YAxis stroke="#94a3b8" fontSize={12} width={45} label={{ value: 'Watts', angle: -90, position: 'insideLeft', fill: '#94a3b8', offset: 0 }} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ paddingTop: '10px' }} />

                {activeAreas.map((cat) => (
                  <Area
                    key={cat.key as string}
                    type="monotone"
                    dataKey={cat.key as string}
                    name={cat.name}
                    stackId="1"
                    stroke={cat.color}
                    fill={cat.color}
                    fillOpacity={0.6}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Hourly Verdict Table */}
      <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">Hourly AC Verdict</h3>
          <span className="text-xs text-slate-400 font-mono bg-slate-700 px-2 py-1 rounded">
            {timeRangeLabel}
          </span>
        </div>

        {/* Legend */}
        <div className="flex gap-4 mb-3">
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-500/80" />
            Sufficient — AC output ≥ heat load
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-500/80" />
            Undersized — AC output &lt; heat load
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-slate-600" />
            AC off / no load
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400 border-b border-slate-700">
                <th className="text-left py-2 pr-4 font-medium">Hour</th>
                <th className="text-right py-2 pr-4 font-medium">Outdoor °C</th>
                <th className="text-right py-2 pr-4 font-medium">Heat Load</th>
                <th className="text-right py-2 pr-4 font-medium">AC Output</th>
                <th className="text-right py-2 pr-4 font-medium">Gap</th>
                <th className="text-center py-2 font-medium">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {chartData.map((d, i) => {
                const load = Math.round(d.totalHeatLoad);
                const output = Math.round(d.acOutputWatts);
                const gap = output - load;
                const acOff = output === 0 && load === 0;
                const sufficient = output >= load;

                let rowBg = '';
                let verdictBg = '';
                let verdictText = '';
                let verdictLabel = '';

                if (acOff) {
                  rowBg = '';
                  verdictBg = 'bg-slate-700 text-slate-400';
                  verdictLabel = 'AC OFF';
                } else if (sufficient) {
                  rowBg = 'bg-green-900/10';
                  verdictBg = 'bg-green-500/20 text-green-400';
                  verdictLabel = '✓ SUFFICIENT';
                } else {
                  rowBg = 'bg-red-900/10';
                  verdictBg = 'bg-red-500/20 text-red-400';
                  verdictLabel = '✗ UNDERSIZED';
                }

                return (
                  <tr
                    key={i}
                    className={`border-b border-slate-700/50 hover:bg-slate-700/30 transition-colors ${rowBg}`}
                  >
                    <td className="py-1.5 pr-4 font-mono text-slate-300">{d.time}</td>
                    <td className="py-1.5 pr-4 text-right font-mono text-slate-300">{d.outdoorTemp.toFixed(1)}</td>
                    <td className="py-1.5 pr-4 text-right font-mono text-white">{load.toLocaleString()} W</td>
                    <td className="py-1.5 pr-4 text-right font-mono text-blue-300">{output.toLocaleString()} W</td>
                    <td className={`py-1.5 pr-4 text-right font-mono ${gap >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {gap >= 0 ? '+' : ''}{gap.toLocaleString()} W
                    </td>
                    <td className="py-1.5 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${verdictBg}`}>
                        {verdictLabel}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Summary footer */}
        {(() => {
          const activeHours = chartData.filter(d => !(d.totalHeatLoad === 0 && d.acOutputWatts === 0));
          const sufficientCount = activeHours.filter(d => d.acOutputWatts >= d.totalHeatLoad).length;
          const undersizedCount = activeHours.length - sufficientCount;
          return activeHours.length > 0 ? (
            <div className="mt-3 pt-3 border-t border-slate-700 flex gap-6 text-xs text-slate-400">
              <span>Active hours: <span className="text-white font-semibold">{activeHours.length}</span></span>
              <span className="text-green-400">✓ Sufficient: <span className="font-semibold">{sufficientCount}h</span></span>
              <span className="text-red-400">✗ Undersized: <span className="font-semibold">{undersizedCount}h</span></span>
              <span>
                Efficiency score:{' '}
                <span className="font-semibold text-white">
                  {((sufficientCount / activeHours.length) * 100).toFixed(0)}%
                </span>
              </span>
            </div>
          ) : null;
        })()}
      </div>

      {/* Window Gains Chart */}
      <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
        <h3 className="text-lg font-semibold text-white mb-6">Individual Window Heat Gain vs Time</h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="time" stroke="#94a3b8" fontSize={12} interval={3} />
              <YAxis stroke="#94a3b8" fontSize={12} label={{ value: 'Watts', angle: -90, position: 'insideLeft', fill: '#94a3b8' }} />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              {Object.keys(chartData[0]?.windowGains || {}).map((winId, index) => {
                // Resolve label from new embedded wall structure
                let label = `Window ${index + 1}`;
                if (winId.startsWith('full_glass_')) {
                  const wallId = winId.replace('full_glass_', '');
                  const wallDef = walls.find(w => w.id === wallId);
                  if (wallDef) label = `Full Glass (${wallDef.direction})`;
                } else if (winId.startsWith('win_')) {
                  const embeddedWinId = winId.replace('win_', '');
                  const wallDef = walls.find(w => w.windows?.some(win => win.id === embeddedWinId));
                  if (wallDef) label = `Win ${index + 1} (${wallDef.direction})`;
                }

                return (
                  <Line
                    key={winId}
                    type="monotone"
                    dataKey={`windowGains.${winId}`}
                    name={label}
                    stroke={`hsl(${(index * 137) % 360}, 70%, 60%)`}
                    strokeWidth={2}
                    dot={false}
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

    </div>
  );
};

export default ResultsDashboard;

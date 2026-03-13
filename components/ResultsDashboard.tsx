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

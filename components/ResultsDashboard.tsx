import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  AreaChart, Area, ReferenceLine
} from 'recharts';
import { SimulationResult, SimulationDataPoint, WallDef, ACUnit, SubZoneConfig, SensorLevel } from '../types';
import { AcBreakdownData, LiveTempData, SubZoneInfo, DesignDayData } from '../services/liveDataService';
import { AlertTriangle, CheckCircle, Zap, CloudSun, Thermometer, Wind } from 'lucide-react';

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

type ProcessedDataPoint = SimulationDataPoint & {
  internalCombined: number;   // internalLoad + peopleLoad (matches Configure tab inventory)
  glassCondLoad: number;      // glass conduction (U×A×ΔT) — envelope, not internal
  zoneTransferLoad: number;   // net positive inter-zone heat transfer
};

interface Props {
  results: SimulationResult;
  ratedCapacityWatts: number;
  locationName?: string;
  walls?: WallDef[];
  isToday?: boolean;
  acOutputSource?: { hasData: boolean; hoursWithAcOn: number; hoursFromYesterday: number; totalElecKwh?: number };
  acBreakdown?: AcBreakdownData;
  liveData?: LiveTempData;
  subZoneConfigs?: SubZoneConfig[];
  availableSubZones?: SubZoneInfo[];
  acList?: ACUnit[];
  designDayData?: DesignDayData;
  sensorPositions?: Record<string, SensorLevel>;
  hasDeskSensors?: boolean;
}

const ResultsDashboard: React.FC<Props> = ({
  results, ratedCapacityWatts, locationName, walls = [], isToday = true,
  acOutputSource, acBreakdown, liveData, subZoneConfigs, availableSubZones, acList = [],
  designDayData, sensorPositions, hasDeskSensors = true,
}) => {
  // Current IST time — chart shows slots 0 … currentSlot (no future data) when isToday
  // Simulation runs at 1-min resolution: slot = hour*60 + min
  const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const currentISTHour   = nowIST.getHours();
  const currentISTMinute = nowIST.getMinutes();
  const currentSlot = currentISTHour * 60 + currentISTMinute;

  // Slice simulation data: today → up to current IST 1-min slot; historical → full 1440 slots
  const chartData = isToday ? results.data.slice(0, currentSlot + 1) : results.data;

  // ── Summary metrics: always computed from elapsed slots only for today.
  // For a past date, use the full-day results from the physics engine.
  // This ensures peak load / AC output never reflect future/forecasted slots.
  const summaryData = isToday ? chartData : results.data;

  const displayPeakLoadWatts = summaryData.reduce(
    (max, d) => d.totalHeatLoad > max ? d.totalHeatLoad : max, 0
  );
  const peakSlot              = summaryData.find(d => d.totalHeatLoad === displayPeakLoadWatts);
  const displayPeakLoadTime   = peakSlot?.time ?? '—';
  const displayAcOutputAtPeak = peakSlot?.acOutputWatts ?? 0;
  const displayIsSufficient   = displayAcOutputAtPeak >= displayPeakLoadWatts && displayPeakLoadWatts > 0;
  const displayTotalAcKwh     = summaryData.reduce((sum, d) => sum + d.acOutputWatts / 60 / 1000, 0);
  // Distinguish "AC was simply off at peak" from "AC ran but couldn't meet load".
  // acWasOffAtPeak = true when AC output at the peak slot is zero but the AC
  // was active at some other point in the day (total kWh > 0.1).
  // In this state we cannot conclude the system is undersized — it was just switched off.
  const acWasOffAtPeak = !displayIsSufficient
    && displayAcOutputAtPeak === 0
    && displayTotalAcKwh > 0.1
    && displayPeakLoadWatts > 0;

  const peakLoadTR = (displayPeakLoadWatts / 3517).toFixed(2);
  const acOutputTR = (displayAcOutputAtPeak / 3517).toFixed(2);
  const totalAcKwh = displayTotalAcKwh.toFixed(1);
  const nowLabel  = `${currentISTHour.toString().padStart(2, '0')}:${currentISTMinute.toString().padStart(2, '0')}`;
  const timeRangeLabel = isToday ? `00:00 → ${nowLabel} IST` : `Full Day (00:00 – 23:55)`;

  // ── Sensor position helpers ───────────────────────────────────────────────
  const isDeskSensor = (sensorName: string): boolean => {
    // 0. Zone-level override: if this zone has no desk sensors at all, skip all tiers
    if (!hasDeskSensors) return false;
    // 1. If sensorPositions config exists for this sensor, use it
    if (sensorPositions) {
      const pos = sensorPositions[sensorName];
      if (pos === 'desk') return true;
      if (pos === 'ac_level' || pos === 'exclude') return false;
    }
    // 2. Auto-exclude: sensor reading < 20°C while others are above 24°C (physically inside AC)
    const sensorObj = liveData?.sensors.find(s => s.name === sensorName);
    const otherTemps = liveData?.sensors.filter(s => s.name !== sensorName).map(s => s.temp) ?? [];
    const otherAvg = otherTemps.length > 0 ? otherTemps.reduce((a, b) => a + b, 0) / otherTemps.length : 25;
    if (sensorObj && sensorObj.temp < 20 && otherAvg > 24) return false; // misplaced in AC duct
    // 3. Default: name-based
    return !sensorName.toLowerCase().includes('ac');
  };

  const isAcSensor = (sensorName: string): boolean => {
    if (sensorPositions) {
      const pos = sensorPositions[sensorName];
      if (pos === 'ac_level') return true;
      if (pos === 'desk') return false;
    }
    return sensorName.toLowerCase().includes('ac');
  };

  // ── Capacity-based verdict (for zones with no desk-level sensors) ───────────
  // Used when a zone has only AC-level/ceiling sensors.
  // AC OFF → show AC sensor temp as room proxy (sensor equilibrates to room air when idle)
  // AC ON  → AC sensor reads cold supply air (not room temp) → switch to load vs capacity
  const getCapacityVerdict = (subZoneNames: string[], acUnits: ACUnit[]) => {
    if (!liveData || acUnits.length === 0) return null;
    const acSensors = liveData.sensors.filter(
      s => subZoneNames.includes(s.dbZone) && isAcSensor(s.name)
    );
    if (acSensors.length === 0) return null;

    const acIsOn = acSensors.some(s => s.powerStatus?.toUpperCase() === 'ON');
    const acSensorAvg = acSensors.reduce((sum, s) => sum + s.temp, 0) / acSensors.length;

    if (!acIsOn) {
      // AC off → sensor has equilibrated to room air → valid room temp proxy
      const tempLabel = acSensorAvg > 28 ? 'WARM' : acSensorAvg > 26 ? 'MODERATE' : 'COOL';
      const cls = acSensorAvg > 28 ? 'text-orange-400' : acSensorAvg > 26 ? 'text-yellow-400' : 'text-green-400';
      const cardCls = acSensorAvg > 28 ? 'border-orange-700 bg-orange-900/20'
                    : acSensorAvg > 26 ? 'border-yellow-700 bg-yellow-900/20'
                    : 'border-green-700 bg-green-900/20';
      return { label: `AC OFF · ${tempLabel}`, cls, cardCls, roomTemp: acSensorAvg, acIsOn, isCapacityBased: false };
    }

    // AC ON → sensor reads cold supply air, not room → use load vs capacity
    const totalCapacityW = acUnits.reduce((sum, ac) => sum + ac.ratedCapacityWatts * getCorrectedISEER(ac), 0);
    const currentLoadW = summaryData.length > 0
      ? summaryData[summaryData.length - 1]?.totalHeatLoad ?? 0 : 0;
    const ratio = totalCapacityW > 0 ? currentLoadW / totalCapacityW : 0;

    if (ratio <= 0.85) return {
      label: 'SUFFICIENT', cls: 'text-green-400',
      cardCls: 'border-green-700 bg-green-900/20', ratio, currentLoadW, totalCapacityW, acIsOn, isCapacityBased: true,
    };
    if (ratio <= 1.0) return {
      label: 'MARGINAL', cls: 'text-yellow-400',
      cardCls: 'border-yellow-700 bg-yellow-900/20', ratio, currentLoadW, totalCapacityW, acIsOn, isCapacityBased: true,
    };
    return {
      label: 'INSUFFICIENT', cls: 'text-red-400',
      cardCls: 'border-red-700 bg-red-900/20', ratio, currentLoadW, totalCapacityW, acIsOn, isCapacityBased: true,
    };
  };

  // ── Per-coverage-area verdict logic ─────────────────────────────────────────
  const getAgeFactor = (ageYears: number) => Math.max(0.70, 1 - ageYears * 0.02);
  const totalZoneAreaM2 = results.data[0]?._areaM2 ?? 0;
  const peakHour = peakSlot ? Math.floor(peakSlot.hour) : -1;

  // Outdoor peak temp from today's simulation data → used for ISEER correction
  const outdoorPeakTemp = summaryData.length > 0
    ? Math.max(...summaryData.map(d => d.outdoorTemp ?? 35))
    : 35;

  // Corrected ISEER: accounts for actual outdoor temp vs rated test condition (35°C)
  // COP drops ~2.5% per °C above 35°C; floored at 50% of rated to avoid extreme values
  const getCorrectedISEER = (ac: ACUnit) => {
    const ageFactor    = getAgeFactor(ac.ageYears);
    const tempFactor   = Math.max(0.5, 1 - (outdoorPeakTemp - 35) * 0.025);
    return ac.iseer * ageFactor * tempFactor;
  };

  // Sensor-based verdict for a set of sub-zone names
  // Track A: desk sensors present → ASHRAE comfort verdict
  // Track B: no desk sensors → falls back to getCapacityVerdict (called from coverageVerdicts build)
  const getSensorVerdict = (subZoneNames: string[], acUnitsForZone: ACUnit[] = []) => {
    if (!liveData) return null;
    const deskSensors = liveData.sensors.filter(
      s => subZoneNames.includes(s.dbZone) && isDeskSensor(s.name)
    );
    const acSensors = liveData.sensors.filter(
      s => subZoneNames.includes(s.dbZone) && isAcSensor(s.name)
    );
    // Track B: no desk sensors → delegate to capacity verdict
    if (deskSensors.length === 0) {
      return getCapacityVerdict(subZoneNames, acUnitsForZone);
    }
    const avgDeskTemp = deskSensors.reduce((sum, s) => sum + s.temp, 0) / deskSensors.length;
    const acIsOn = acSensors.some(s => s.powerStatus?.toUpperCase() === 'ON');

    if (!acIsOn && acSensors.length > 0) return {
      label: 'AC OFF', cls: 'text-slate-400',
      cardCls: 'border-slate-700 bg-slate-900/40', avgDeskTemp, acIsOn,
    };
    // ASHRAE 55 / BEE thresholds
    if (avgDeskTemp <= 26) return {
      label: 'COMFORTABLE', cls: 'text-green-400',
      cardCls: 'border-green-700 bg-green-900/20', avgDeskTemp, acIsOn,
    };
    if (avgDeskTemp <= 28) return {
      label: 'WARM', cls: 'text-yellow-400',
      cardCls: 'border-yellow-700 bg-yellow-900/20', avgDeskTemp, acIsOn,
    };
    return {
      label: 'STRUGGLING', cls: 'text-red-400',
      cardCls: 'border-red-700 bg-red-900/20', avgDeskTemp, acIsOn,
    };
  };

  // Sub-zone helpers
  const subZoneArea = (name: string) =>
    (subZoneConfigs || []).find(sz => sz.name === name)?.areaM2 ?? 0;

  const getCoverageType = (subZoneName: string): 'direct' | 'spillover' | 'none' => {
    if (acList.some(ac => (ac.primarySubZones || []).includes(subZoneName))) return 'direct';
    if (acList.some(ac => (ac.spilloverSubZones || []).includes(subZoneName))) return 'spillover';
    return 'none';
  };

  // Build per-AC coverage area verdicts
  const coverageVerdicts = acList
    .filter(ac => (ac.primarySubZones || []).length > 0)
    .map(ac => {
      const primaryZones     = ac.primarySubZones || [];
      const configuredAreaM2 = primaryZones.reduce((sum, name) => sum + subZoneArea(name), 0);
      // When no sub-zone areas are entered, fall back to the full zone floor area.
      // Multiple ACs serving the same undivided room each cover the whole area —
      // do NOT split by AC count (that would under-report coverage and sizing).
      const coverageAreaM2   = configuredAreaM2 > 0
        ? configuredAreaM2
        : totalZoneAreaM2 > 0 ? totalZoneAreaM2 : 0;
      const areaFraction     = totalZoneAreaM2 > 0 && coverageAreaM2 > 0
        ? coverageAreaM2 / totalZoneAreaM2 : null;
      const peakLoadForCoverage = areaFraction != null ? displayPeakLoadWatts * areaFraction : null;

      // Actual electrical watts at peak × corrected ISEER = estimated cooling output
      const sensor            = acBreakdown?.sensors.find(s => s.name === ac.dbSensorName);
      const elecWattsAtPeak   = (sensor && peakHour >= 0) ? (sensor.hours[peakHour] ?? 0) : null;
      const correctedISEER    = getCorrectedISEER(ac);
      const coolingWattsAtPeak = elecWattsAtPeak != null ? elecWattsAtPeak * correctedISEER : null;

      // Sizing check: BEE rule of thumb 0.0625 TR/m² for offices
      const requiredTR  = coverageAreaM2 > 0 ? coverageAreaM2 * 0.0625 : null;
      const installedTR = ac.ratedCapacityWatts / 3517;
      const sizingGap   = requiredTR != null ? installedTR - requiredTR : null;
      const sizingLabel = sizingGap == null ? null
        : sizingGap >= 0      ? { text: 'Adequate',           cls: 'text-green-400' }
        : sizingGap >= -0.5   ? { text: 'Slightly undersized', cls: 'text-yellow-400' }
        :                       { text: 'Undersized',          cls: 'text-red-400' };

      // Track A (desk sensors) → ASHRAE comfort verdict
      // Track B (no desk sensors) → capacity verdict via getCapacityVerdict
      // Short-circuit to AC OFF if this specific AC unit's DB sensor is not ON
      const thisAcLiveSensor = liveData?.sensors.find(s => s.name === ac.dbSensorName);
      const thisAcIsOff = thisAcLiveSensor != null && thisAcLiveSensor.powerStatus?.toUpperCase() !== 'ON';
      const sensorVerdict = thisAcIsOff
        ? { label: 'AC OFF', cls: 'text-slate-400', cardCls: 'border-slate-700 bg-slate-900/40', acIsOn: false }
        : getSensorVerdict(primaryZones, [ac]);

      return {
        ac, primaryZones, coverageAreaM2, configuredAreaM2, areaFraction,
        peakLoadForCoverage, coolingWattsAtPeak, correctedISEER,
        requiredTR, installedTR, sizingGap, sizingLabel,
        sensorVerdict,
      };
    });

  // Identify uncovered sub-zones (no direct AC assigned)
  const allSubZoneNames = (availableSubZones || []).map(sz => sz.name);
  const uncoveredSubZones = allSubZoneNames.filter(name => getCoverageType(name) === 'none');
  const spilloverSubZones = allSubZoneNames.filter(name => getCoverageType(name) === 'spillover');

  // Zone-level sensor verdict (all sensors combined — used for main verdict card)
  // Passes acList so Track B (capacity verdict) can fire if no desk sensors in zone
  const zoneSensorVerdict = getSensorVerdict(
    liveData?.sensors.map(s => s.dbZone).filter((v, i, a) => a.indexOf(v) === i) ?? [],
    acList
  );

  const processedData: ProcessedDataPoint[] = chartData.map(d => ({
    ...d,
    // Only people + equipment/lighting/appliance — matches what the Configure tab inventory shows
    internalCombined: (d.internalLoad || 0) + (d.peopleLoad || 0),
    // Glass conduction (U×A×ΔT) — envelope load, separate from solar SHGC gain
    glassCondLoad: d.glassLoad || 0,
    // Inter-zone transfer: only positive (heat flowing in) for the stacked chart; negative = heat leaving
    zoneTransferLoad: Math.max(0, d.otherLoad || 0),
  }));

  const areaConfig = [
    { key: 'internalCombined' as keyof ProcessedDataPoint, name: 'Internal (people + equip)', color: '#10b981' },
    { key: 'infLoad' as keyof ProcessedDataPoint, name: 'Infiltration', color: '#94a3b8' },
    { key: 'roofLoad' as keyof ProcessedDataPoint, name: 'Roof', color: '#8b5cf6' },
    { key: 'glassCondLoad' as keyof ProcessedDataPoint, name: 'Glass Conduction', color: '#64748b' },
    { key: 'wallLoad' as keyof ProcessedDataPoint, name: 'Wall', color: '#6366f1' },
    { key: 'solarLoad' as keyof ProcessedDataPoint, name: 'Solar', color: '#f59e0b' },
    { key: 'zoneTransferLoad' as keyof ProcessedDataPoint, name: 'Zone Transfer (in)', color: '#f97316' },
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
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Verdict card — sensor-based (ASHRAE 55 / BEE thresholds) */}
        {(() => {
          const sv = zoneSensorVerdict;
          const cardBg = sv
            ? sv.label === 'COMFORTABLE' ? 'bg-green-900/20 border-green-700'
            : sv.label === 'WARM'        ? 'bg-yellow-900/20 border-yellow-700'
            : sv.label === 'STRUGGLING'  ? 'bg-red-900/20 border-red-700'
            :                              'bg-slate-800 border-slate-700'
            : 'bg-slate-800 border-slate-700';
          const icon = sv
            ? sv.label === 'COMFORTABLE' ? <CheckCircle className="text-green-500" size={20} />
            : sv.label === 'WARM'        ? <AlertTriangle className="text-yellow-500" size={20} />
            : sv.label === 'STRUGGLING'  ? <AlertTriangle className="text-red-500" size={20} />
            :                              <AlertTriangle className="text-slate-400" size={20} />
            : <AlertTriangle className="text-slate-400" size={20} />;
          return (
            <div className={`p-4 rounded-xl border ${cardBg}`}>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-gray-300">Verdict</h3>
                {icon}
              </div>
              <p className={`text-2xl font-bold ${sv ? sv.cls : 'text-slate-400'}`}>
                {sv ? sv.label : '—'}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {sv && 'avgDeskTemp' in sv && sv.avgDeskTemp != null
                  ? `Desk avg ${sv.avgDeskTemp.toFixed(1)}°C · ASHRAE/BEE thresholds`
                  : sv && 'roomTemp' in sv && (sv as any).roomTemp != null
                  ? `Room ${(sv as any).roomTemp.toFixed(1)}°C (AC-level sensor, AC off)`
                  : sv && 'ratio' in sv
                  ? `Load ${((sv as any).ratio * 100).toFixed(0)}% of capacity · no desk sensors`
                  : 'No desk-level sensors found'}
              </p>
            </div>
          );
        })()}

        {/* Peak Load card + design day flag */}
        <div className="p-4 bg-slate-800 rounded-xl border border-slate-700">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-gray-300">Peak Load</h3>
            <Zap className="text-yellow-500" size={20} />
          </div>
          <p className="text-2xl font-bold text-white">{peakLoadTR} <span className="text-sm font-normal text-gray-400">TR</span></p>
          <p className="text-xs text-gray-400 mt-1">At {displayPeakLoadTime} ({Math.round(displayPeakLoadWatts)} W)</p>
          {designDayData && (() => {
            const todayPeak = outdoorPeakTemp;
            const isExtremeDay = todayPeak > designDayData.designDayTemp;
            return (
              <p className={`text-[10px] mt-2 leading-snug ${isExtremeDay ? 'text-red-400' : 'text-slate-500'}`}>
                {isExtremeDay
                  ? `🔴 Today (${todayPeak}°C) exceeds design day (${designDayData.designDayTemp}°C) — extreme heat event`
                  : `Design day ${designDayData.designDayTemp}°C · today ${todayPeak}°C · load is conservative`}
                <span className="block text-slate-600">95th pct Apr–Jun {designDayData.dataYears}</span>
              </p>
            );
          })()}
        </div>

        <div className="p-4 bg-slate-800 rounded-xl border border-slate-700">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-gray-300">AC Output at Peak</h3>
            <Zap className="text-blue-400" size={20} />
          </div>
          <p className="text-2xl font-bold text-white">{acOutputTR} <span className="text-sm font-normal text-gray-400">TR</span></p>
          <p className="text-xs text-gray-400 mt-1">At peak hour · {Math.round(displayAcOutputAtPeak)} W</p>
        </div>

        <div className="p-4 bg-slate-800 rounded-xl border border-slate-700">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-gray-300">Total Electricity Consumed</h3>
            <Zap className="text-cyan-400" size={20} />
          </div>
          {(() => {
            // Prefer per-sensor breakdown sum; fall back to zone-level total from historicalAcOutput
            let totalElecKwh: number | null = null;
            if (acBreakdown && acBreakdown.sensors.length > 0) {
              totalElecKwh = acBreakdown.sensors.reduce((sum, s) => {
                const elapsed = s.hours.filter(h => h !== null) as number[];
                return sum + elapsed.reduce((a, b) => a + b, 0) / 1000;
              }, 0);
            } else if (acOutputSource?.hasData && acOutputSource.totalElecKwh !== undefined) {
              totalElecKwh = acOutputSource.totalElecKwh;
            }

            if (totalElecKwh === null) {
              return (
                <>
                  <p className="text-2xl font-bold text-slate-500">—</p>
                  <p className="text-xs text-gray-500 mt-1">No sensor data available</p>
                </>
              );
            }
            return (
              <>
                <p className="text-2xl font-bold text-white">
                  {totalElecKwh.toFixed(1)} <span className="text-sm font-normal text-gray-400">kWh</span>
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  AC electrical input · {timeRangeLabel}
                  <span className="ml-1 text-green-400">· sensor data</span>
                </p>
              </>
            );
          })()}
        </div>

      </div>

      {/* Per-AC Unit Breakdown */}
      {acBreakdown && acBreakdown.sensors.length > 0 && (() => {
        // Compute summary stats per sensor
        const sensorStats = acBreakdown.sensors.map(s => {
          const elapsed = s.hours.filter(h => h !== null) as number[];
          const peakWatts = elapsed.length > 0 ? Math.max(...elapsed) : 0;
          const totalKwh  = elapsed.reduce((sum, h) => sum + h, 0) / 1000;   // each hour slot = 1 h
          const hoursOn   = elapsed.filter(h => h > 0).length;
          return { name: s.name, peakWatts, totalKwh, hoursOn };
        });

        // Combined totals (straight sum of per-sensor stats, for the footer row)
        const combinedPeak  = Math.round(sensorStats.reduce((m, s) => Math.max(m, s.peakWatts), 0));
        const combinedKwh   = sensorStats.reduce((sum, s) => sum + s.totalKwh, 0);

        return (
          <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">AC Unit Breakdown</h3>
              <span className="text-xs text-slate-400 font-mono bg-slate-700 px-2 py-1 rounded">
                {acBreakdown.sensors.length} sensor{acBreakdown.sensors.length !== 1 ? 's' : ''} · {acBreakdown.date}
              </span>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              Electrical input watts per AC sensor (from DB). Multiply by ISEER to get cooling output.
            </p>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-slate-400 border-b border-slate-700 text-xs uppercase tracking-wide">
                    <th className="text-left pb-2 pr-6 font-medium">Sensor / AC Unit</th>
                    <th className="text-right pb-2 pr-6 font-medium">Peak Draw</th>
                    <th className="text-right pb-2 pr-6 font-medium">Total Input</th>
                    <th className="text-right pb-2 font-medium">Hours On</th>
                  </tr>
                </thead>
                <tbody>
                  {sensorStats.map((s, i) => (
                    <tr key={i} className="border-b border-slate-700/40 hover:bg-slate-700/20">
                      <td className="py-2 pr-6 text-white font-medium">{s.name}</td>
                      <td className="py-2 pr-6 text-right font-mono text-blue-300">
                        {(Math.round(s.peakWatts) / 1000).toFixed(2)} kW
                        <span className="text-slate-500 ml-1 text-xs">({Math.round(s.peakWatts)} W)</span>
                      </td>
                      <td className="py-2 pr-6 text-right font-mono text-cyan-300">
                        {s.totalKwh.toFixed(1)} kWh
                      </td>
                      <td className="py-2 text-right font-mono text-slate-300">
                        {s.hoursOn} h
                      </td>
                    </tr>
                  ))}
                </tbody>
                {sensorStats.length > 1 && (
                  <tfoot>
                    <tr className="border-t-2 border-slate-600 bg-slate-700/30">
                      <td className="py-2 pr-6 text-slate-300 font-semibold text-xs uppercase tracking-wide">Zone Combined</td>
                      <td className="py-2 pr-6 text-right font-mono font-semibold text-blue-200">
                        {(combinedPeak / 1000).toFixed(2)} kW
                        <span className="text-slate-400 ml-1 text-xs">({combinedPeak} W)</span>
                      </td>
                      <td className="py-2 pr-6 text-right font-mono font-semibold text-cyan-200">
                        {combinedKwh.toFixed(1)} kWh
                      </td>
                      <td className="py-2 text-right text-slate-400 text-xs">—</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            <p className="text-xs text-slate-500 mt-3">
              💡 Peak draw is the max single-hour average. Combined peak may be lower than AC1+AC2 if both rarely peak simultaneously.
            </p>
          </div>
        );
      })()}

      {/* Per-Coverage-Area Verdicts */}
      {coverageVerdicts.length > 0 && (
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">Coverage Area Analysis</h3>
            <span className="text-xs text-slate-400 bg-slate-700 px-2 py-1 rounded">Per-AC breakdown</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {coverageVerdicts.map(cv => {
              const {
                ac, primaryZones, coverageAreaM2, configuredAreaM2, peakLoadForCoverage,
                coolingWattsAtPeak, requiredTR, installedTR, sizingGap, sizingLabel, sensorVerdict,
              } = cv;
              // Sensor verdict drives the card colour; fallback to slate if no desk sensors
              const cardCls = sensorVerdict ? sensorVerdict.cardCls : 'border-slate-700 bg-slate-900/40';
              return (
                <div key={ac.id} className={`p-4 rounded-xl border ${cardCls}`}>
                  {/* Header: AC name + live sensor verdict */}
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <p className="text-sm font-semibold text-white">{ac.name}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{primaryZones.join(', ')}</p>
                    </div>
                    {sensorVerdict
                      ? <span className={`text-xs font-bold ${sensorVerdict.cls}`}>{sensorVerdict.label}</span>
                      : <span className="text-xs text-slate-500">No sensor data</span>
                    }
                  </div>

                  {/* Track A: desk sensor reading (ASHRAE comfort verdict) */}
                  {sensorVerdict && !('isCapacityBased' in sensorVerdict) && sensorVerdict.avgDeskTemp != null && (
                    <div className="mb-3 pb-3 border-b border-slate-700/50">
                      <p className="text-xs text-slate-500 mb-0.5">Desk avg temperature</p>
                      <p className={`text-lg font-bold font-mono ${sensorVerdict.cls}`}>
                        {sensorVerdict.avgDeskTemp.toFixed(1)}°C
                        <span className="text-xs text-slate-500 font-normal ml-2">setpoint ≤ 26°C</span>
                      </p>
                    </div>
                  )}

                  {/* Track B: no desk sensors — show AC-off room temp OR load vs capacity */}
                  {sensorVerdict && 'isCapacityBased' in sensorVerdict && (
                    <div className="mb-3 pb-3 border-b border-slate-700/50">
                      {!sensorVerdict.isCapacityBased && 'roomTemp' in sensorVerdict ? (
                        /* AC OFF — AC sensor has equilibrated to room air */
                        <>
                          <p className="text-xs text-slate-500 mb-0.5">Room temp <span className="text-slate-600">(AC-level sensor · AC off)</span></p>
                          <p className={`text-lg font-bold font-mono ${sensorVerdict.cls}`}>
                            {(sensorVerdict as any).roomTemp.toFixed(1)}°C
                            <span className="text-xs text-slate-500 font-normal ml-2">sensor equilibrated to room air</span>
                          </p>
                        </>
                      ) : (
                        /* AC ON — sensor reads supply air, not room → show load vs capacity */
                        <>
                          <p className="text-xs text-slate-500 mb-0.5">Load vs capacity <span className="text-slate-600">(no desk sensor · AC on)</span></p>
                          <div className="flex items-baseline gap-2">
                            <p className={`text-lg font-bold font-mono ${sensorVerdict.cls}`}>
                              {((sensorVerdict as any).ratio * 100).toFixed(0)}%
                            </p>
                            <span className="text-xs text-slate-500">
                              {((sensorVerdict as any).currentLoadW / 1000).toFixed(1)} kW load · {((sensorVerdict as any).totalCapacityW / 1000).toFixed(1)} kW capacity
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* Engineering metrics */}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <p className="text-slate-500">Coverage area</p>
                      <p className="text-white font-mono">
                        {coverageAreaM2 > 0 ? `${Math.round(coverageAreaM2)} m²` : '—'}
                        {coverageAreaM2 > 0 && configuredAreaM2 === 0 && (
                          <span className="text-slate-500 font-normal ml-1">(est.)</span>
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500">Peak load (area share)</p>
                      <p className="text-white font-mono">{peakLoadForCoverage != null ? `${(peakLoadForCoverage / 3517).toFixed(2)} TR` : '—'}</p>
                    </div>
                    <div>
                      <p className="text-slate-500">AC cooling at peak</p>
                      <p className="text-white font-mono">{coolingWattsAtPeak != null ? `${(coolingWattsAtPeak / 3517).toFixed(2)} TR` : '—'}</p>
                    </div>
                    <div>
                      <p className="text-slate-500">DB sensor</p>
                      <p className="text-white font-mono">{ac.dbSensorName || '—'}</p>
                    </div>
                  </div>

                  {/* Sizing check */}
                  <div className="mt-3 pt-3 border-t border-slate-700/50">
                    <p className="text-xs text-slate-500 mb-1 uppercase tracking-wide font-semibold">Sizing Check</p>
                    {coverageAreaM2 > 0 && requiredTR != null ? (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-400">
                          Installed {installedTR.toFixed(2)} TR · Required {requiredTR.toFixed(2)} TR
                        </span>
                        {sizingLabel && (
                          <span className={`font-bold ${sizingLabel.cls}`}>{sizingLabel.text}</span>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-600 italic">Enter sub-zone area to enable sizing check</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Spillover and uncovered sub-zone alerts */}
          {(uncoveredSubZones.length > 0 || spilloverSubZones.length > 0) && (
            <div className="mt-4 space-y-2">
              {uncoveredSubZones.map(szName => {
                const sensors = liveData?.sensors.filter(s => s.dbZone === szName) ?? [];
                const avgTemp = sensors.length > 0
                  ? sensors.reduce((sum, s) => sum + s.temp, 0) / sensors.length : null;
                const generalSetpoint = acList.length > 0
                  ? Math.min(...acList.map(ac => ac.iseer)) : 23; // rough fallback
                const setpoint = sensors.find(s => s.setpoint != null)?.setpoint ?? 23;
                const diff = avgTemp != null ? avgTemp - setpoint : null;
                const alertColor = diff == null ? 'border-slate-600 bg-slate-900/40'
                  : diff <= 1 ? 'border-green-700 bg-green-900/20'
                  : diff <= 3 ? 'border-yellow-700 bg-yellow-900/20'
                  : 'border-red-700 bg-red-900/20';
                const alertIcon = diff == null ? '—'
                  : diff <= 1 ? '✅' : diff <= 3 ? '⚠️' : '🔴';
                return (
                  <div key={szName} className={`flex items-center justify-between p-3 rounded-lg border ${alertColor}`}>
                    <div>
                      <p className="text-sm font-medium text-white">{szName} <span className="text-xs text-slate-400 ml-1">· No dedicated AC</span></p>
                      <p className="text-xs text-slate-400 mt-0.5">{sensors.length} sensor{sensors.length !== 1 ? 's' : ''} · monitoring only</p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold text-white">{alertIcon} {avgTemp != null ? `${avgTemp.toFixed(1)}°C` : '—'}</p>
                      {diff != null && <p className="text-xs text-slate-400">{diff > 0 ? '+' : ''}{diff.toFixed(1)}°C vs setpoint</p>}
                    </div>
                  </div>
                );
              })}
              {spilloverSubZones.map(szName => {
                const sensors = liveData?.sensors.filter(s => s.dbZone === szName) ?? [];
                const avgTemp = sensors.length > 0
                  ? sensors.reduce((sum, s) => sum + s.temp, 0) / sensors.length : null;
                const spilloverAcs = acList.filter(ac => (ac.spilloverSubZones || []).includes(szName));
                const spilloverNames = spilloverAcs.length > 0 ? spilloverAcs.map(a => a.name).join(' & ') : 'AC';
                return (
                  <div key={szName} className="flex items-center justify-between p-3 rounded-lg border border-yellow-700/50 bg-yellow-900/10">
                    <div>
                      <p className="text-sm font-medium text-white">{szName} <span className="text-xs text-yellow-400 ml-1">· Spillover from {spilloverNames}</span></p>
                      <p className="text-xs text-slate-400 mt-0.5">Receives incidental cooling when {spilloverNames} {spilloverAcs.length > 1 ? 'are' : 'is'} running</p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold text-white">🌡️ {avgTemp != null ? `${avgTemp.toFixed(1)}°C` : '—'}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Sensor Temperature Grid */}
      {liveData && liveData.sensors.length > 0 && availableSubZones && availableSubZones.length > 1 && (
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white flex items-center gap-2">
              <Thermometer size={18} className="text-orange-400" /> Sensor Temperature Grid
            </h3>
            <span className="text-xs text-slate-400 bg-slate-700 px-2 py-1 rounded">Live readings</span>
          </div>
          <div className="space-y-6">
            {availableSubZones.map(sz => {
              const sensors = liveData.sensors.filter(s => s.dbZone === sz.name);
              if (sensors.length === 0) return null;
              const setpoint = sensors.find(s => s.setpoint != null)?.setpoint ?? 23;

              // Split into AC-level sensors and desk-level sensors
              const acSensors  = sensors.filter(s => isAcSensor(s.name));
              const deskSensors = sensors.filter(s => isDeskSensor(s.name));

              // ΔT: avg AC sensor temp − avg desk sensor temp
              const avgAcTemp   = acSensors.length > 0
                ? acSensors.reduce((sum, s) => sum + s.temp, 0) / acSensors.length : null;
              const avgDeskTemp = deskSensors.length > 0
                ? deskSensors.reduce((sum, s) => sum + s.temp, 0) / deskSensors.length : null;
              const deltaT = avgAcTemp != null && avgDeskTemp != null
                ? +(avgAcTemp - avgDeskTemp).toFixed(1) : null;

              // Fan recommendation: only when AC is ON and ΔT > 2°C
              const acIsOn = acSensors.some(s => s.powerStatus?.toUpperCase() === 'ON');
              const mixingLabel =
                deltaT == null    ? null :
                Math.abs(deltaT) < 1  ? { text: 'Good mixing',     cls: 'text-green-400 border-green-500/30 bg-green-500/10' } :
                Math.abs(deltaT) < 2  ? { text: 'Moderate mixing', cls: 'text-yellow-400 border-yellow-500/30 bg-yellow-500/10' } :
                                        { text: 'Poor mixing',     cls: 'text-red-400 border-red-500/30 bg-red-500/10' };
              const showFanTip = acIsOn && deltaT != null && Math.abs(deltaT) >= 2;

              return (
                <div key={sz.name}>
                  {/* Sub-zone header + mixing badge */}
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-slate-400 uppercase font-semibold">{sz.name}</p>
                    {deltaT != null && mixingLabel && (
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${mixingLabel.cls}`}>
                          {mixingLabel.text}
                        </span>
                        <span className="text-[10px] font-mono text-slate-400">
                          ΔT {deltaT > 0 ? '+' : ''}{deltaT}°C
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Fan recommendation banner */}
                  {showFanTip && (
                    <div className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/30 rounded-lg px-3 py-2 mb-2">
                      <Wind size={14} className="text-blue-400 shrink-0" />
                      <p className="text-xs text-blue-300">
                        Switch on circulation fan — cool air from AC is not reaching desk level (ΔT {deltaT! > 0 ? '+' : ''}{deltaT}°C). A fan will improve mixing and reduce AC load.
                      </p>
                    </div>
                  )}

                  {/* Sensor cards */}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                    {sensors.map(s => {
                      const diff = s.temp - setpoint;
                      const tempColor = diff <= 1 ? 'text-green-400' : diff <= 3 ? 'text-yellow-400' : 'text-red-400';
                      const flag = diff <= 1 ? '' : diff <= 3 ? ' ⚠️' : ' 🔴 HOT SPOT';
                      const isAc = isAcSensor(s.name);
                      return (
                        <div key={s.name} className="flex items-center justify-between bg-slate-900/60 rounded-lg px-3 py-2 border border-slate-700">
                          <div>
                            <p className="text-xs font-medium text-white">{s.name}</p>
                            <p className="text-[10px] text-slate-500">{isAc ? 'AC level' : 'Desk level'}</p>
                            {isAc && s.powerStatus && (
                              <p className={`text-[10px] font-bold ${s.powerStatus.toUpperCase() === 'ON' ? 'text-green-400' : 'text-slate-500'}`}>
                                {s.powerStatus.toUpperCase()}
                              </p>
                            )}
                          </div>
                          <p className={`text-sm font-bold font-mono ${tempColor}`}>
                            {s.temp.toFixed(1)}°C{flag}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Main Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Load Profile Chart */}
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
          <div className="flex items-start justify-between mb-6">
            <div>
              <h3 className="text-lg font-semibold text-white">Total Heat Load vs Time</h3>
              {acOutputSource ? (
                <p className="text-xs mt-1">
                  {acOutputSource.hasData ? (
                    <span className="text-blue-400">● AC Output: sensor data ({acOutputSource.hoursWithAcOn} hrs with AC on)</span>
                  ) : (
                    <span className="text-slate-500">◌ AC Output: no sensor data for this date — showing 0</span>
                  )}
                </p>
              ) : (
                <p className="text-xs mt-1 text-slate-500">◌ AC Output: no sensor data</p>
              )}
            </div>
            <span className="text-xs text-slate-400 font-mono bg-slate-700 px-2 py-1 rounded shrink-0">
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
                <XAxis
                  dataKey="time"
                  stroke="#94a3b8"
                  fontSize={11}
                  ticks={['00:00','02:00','04:00','06:00','08:00','10:00','12:00','14:00','16:00','18:00','20:00','22:00']}
                />
                <YAxis
                  stroke="#94a3b8"
                  fontSize={12}
                  label={{ value: 'Watts', angle: -90, position: 'insideLeft', fill: '#94a3b8' }}
                  domain={[0, 'auto']}
                />
                <Tooltip content={<CustomTooltip ratedCapacity={ratedCapacityWatts} />} />
                <Legend />
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
                <XAxis
                  dataKey="time"
                  stroke="#94a3b8"
                  fontSize={11}
                  ticks={['00:00','02:00','04:00','06:00','08:00','10:00','12:00','14:00','16:00','18:00','20:00','22:00']}
                />
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
              {/* Show one row per hour (the :00 slot) — keeps table readable at 5-min resolution */}
              {chartData.filter(d => d.time.endsWith(':00')).map((d, i) => {
                const load = Math.round(d.totalHeatLoad);
                const output = Math.round(d.acOutputWatts);
                const gap = output - load;
                const acOff = output === 0;
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
          const totalSlots = activeHours.length;
          return totalSlots > 0 ? (
            <div className="mt-3 pt-3 border-t border-slate-700 flex flex-wrap gap-6 text-xs text-slate-400">
              <span>Active 1-min slots: <span className="text-white font-semibold">{totalSlots}</span> ({(totalSlots / 60).toFixed(1)} h)</span>
              <span className="text-green-400">✓ Sufficient: <span className="font-semibold">{sufficientCount}</span> slots ({(sufficientCount / 60).toFixed(1)} h)</span>
              <span className="text-red-400">✗ Undersized: <span className="font-semibold">{undersizedCount}</span> slots ({(undersizedCount / 60).toFixed(1)} h)</span>
              <span>
                Efficiency score:{' '}
                <span className="font-semibold text-white">
                  {((sufficientCount / totalSlots) * 100).toFixed(0)}%
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
              <XAxis dataKey="time" stroke="#94a3b8" fontSize={11} interval={Math.max(1, Math.floor(chartData.length / 8))} />
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

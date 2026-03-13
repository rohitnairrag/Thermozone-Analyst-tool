import React from 'react';
import { SimulationDataPoint, WallDef } from '../types';
import { Bug, Sun, LayoutGrid, Calculator } from 'lucide-react';

interface Props {
  dataPoint: SimulationDataPoint;
  walls: WallDef[];
}

const DebugPanel: React.FC<Props> = ({ dataPoint, walls }) => {
  if (!dataPoint) return null;

  // Flatten all glazing entries from walls for the debug table
  const glazingEntries: { debugKey: string; label: string }[] = [];
  (walls || []).forEach((wall, wIdx) => {
    if (wall.wallType === 'internal') return;
    if (wall.constructionType === 'full_glass') {
      glazingEntries.push({ debugKey: `full_glass_${wall.id}`, label: `Wall ${wIdx + 1} Full Glass (${wall.direction})` });
    } else if (wall.constructionType === 'mixed') {
      (wall.windows || []).forEach((win, winIdx) => {
        glazingEntries.push({ debugKey: `win_${win.id}`, label: `Wall ${wIdx + 1} Win ${winIdx + 1} (${wall.direction})` });
      });
    }
  });

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-8 font-mono text-xs">
      <div className="flex items-center gap-2 border-b border-slate-800 pb-4">
        <Bug className="text-pink-500" size={18} />
        <h3 className="text-sm font-bold text-white uppercase tracking-widest">Engineering Debug Panel - Hour {dataPoint.hour}:00</h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Solar Geometry */}
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-blue-400 border-b border-slate-800 pb-2">
            <Sun size={14} />
            <span className="font-bold uppercase">Solar Geometry</span>
          </div>
          <div className="grid grid-cols-2 gap-y-2">
            <span className="text-slate-500">Solar Altitude:</span>
            <span className="text-white text-right">{dataPoint.solarAltitude.toFixed(2)}°</span>
            <span className="text-slate-500">Solar Azimuth:</span>
            <span className="text-white text-right">{dataPoint.solarAzimuth.toFixed(2)}°</span>
            <span className="text-slate-500">DNI:</span>
            <span className="text-white text-right">{dataPoint.dni.toFixed(1)} W/m²</span>
            <span className="text-slate-500">DHI:</span>
            <span className="text-white text-right">{dataPoint.dhi.toFixed(1)} W/m²</span>
            <span className="text-slate-500">GHI:</span>
            <span className="text-white text-right">{dataPoint.ghi.toFixed(1)} W/m²</span>
          </div>
        </div>

        {/* Heat Load Components */}
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-emerald-400 border-b border-slate-800 pb-2">
            <Calculator size={14} />
            <span className="font-bold uppercase">Load Components (Watts)</span>
          </div>
          <div className="grid grid-cols-2 gap-y-2">
            <span className="text-slate-500">Solar Load:</span>
            <span className="text-white text-right">{dataPoint.solarLoad.toFixed(1)} W</span>
            <span className="text-slate-500">Glass Conduction:</span>
            <span className="text-white text-right">{dataPoint.glassLoad.toFixed(1)} W</span>
            <span className="text-slate-500">Wall Load:</span>
            <span className="text-white text-right">{dataPoint.wallLoad.toFixed(1)} W</span>
            <span className="text-slate-500">Roof Load:</span>
            <span className="text-white text-right">{dataPoint.roofLoad.toFixed(1)} W</span>
            <span className="text-slate-500">Infiltration Load:</span>
            <span className="text-white text-right">{dataPoint.infLoad.toFixed(1)} W</span>
            <span className="text-slate-500">Internal Load:</span>
            <span className="text-white text-right">{dataPoint.internalLoad.toFixed(1)} W</span>
            <span className="text-slate-500">People Load:</span>
            <span className="text-white text-right">{dataPoint.peopleLoad.toFixed(1)} W</span>
            <div className="col-span-2 border-t border-slate-800 mt-2 pt-2 flex justify-between">
              <span className="text-slate-400 font-bold">TOTAL HEAT LOAD:</span>
              <span className="text-pink-500 font-bold">{dataPoint.totalHeatLoad.toFixed(1)} W</span>
            </div>
          </div>
        </div>
      </div>

      {/* Glazing Details */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-orange-400 border-b border-slate-800 pb-2">
          <LayoutGrid size={14} />
          <span className="font-bold uppercase">Glazing Verification</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="text-slate-500 border-b border-slate-800">
                <th className="py-2 font-normal">Surface</th>
                <th className="py-2 font-normal text-right">Azimuth</th>
                <th className="py-2 font-normal text-right">cos(θ)</th>
                <th className="py-2 font-normal text-right">I (W/m²)</th>
                <th className="py-2 font-normal text-right">Solar Gain (W)</th>
              </tr>
            </thead>
            <tbody>
              {glazingEntries.map(entry => {
                const debug = dataPoint.windowDebug[entry.debugKey];
                if (!debug) return null;
                return (
                  <tr key={entry.debugKey} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                    <td className="py-2 text-white">{entry.label}</td>
                    <td className="py-2 text-white text-right">{debug.azimuth}°</td>
                    <td className="py-2 text-white text-right">{debug.cosTheta.toFixed(4)}</td>
                    <td className="py-2 text-white text-right">{debug.incidentRadiation.toFixed(1)}</td>
                    <td className="py-2 text-pink-400 text-right font-bold">{debug.solarGain.toFixed(1)}</td>
                  </tr>
                );
              })}
              {glazingEntries.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-slate-600">No glazing surfaces defined</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default DebugPanel;

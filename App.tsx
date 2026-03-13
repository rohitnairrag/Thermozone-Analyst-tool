import React, { useState, useEffect } from 'react';
import { Settings, Activity, Thermometer, Wind, Server, Plus, Trash2, Image as ImageIcon, Map, Box, Clock, LayoutGrid, Bug } from 'lucide-react';
import { DEFAULT_ACS, DEFAULT_ZONE } from './constants';
import { calculateHeatLoad } from './services/physicsEngine';
import ResultsDashboard from './components/ResultsDashboard';
import DebugPanel from './components/DebugPanel';
import { SimulationResult, ACUnit, ZoneProfile, WallDef, Direction, LocationData, HourlyWeather } from './types';
import { searchLocation, fetchWeather } from './services/weatherService';
import { fetchLiveRoomTemp, LiveTempData } from './services/liveDataService';

const AZIMUTH_MAP: Record<string, number> = {
  'N': 0, 'NE': 45, 'E': 90, 'SE': 135, 'S': 180, 'SW': 225, 'W': 270, 'NW': 315
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

function App() {
  const [activeTab, setActiveTab] = useState<'monitor' | 'configure'>('monitor');
  const [configSection, setConfigSection] = useState<'zone' | 'ac'>('zone');

  // State: Multiple Zones with Persistence
  const [zones, setZones] = useState<ZoneProfile[]>(() => {
    const saved = localStorage.getItem('thermozone_data');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error("Failed to parse saved data", e);
      }
    }
    return [{ id: '1', zone: DEFAULT_ZONE, ac: DEFAULT_ACS }];
  });

  const [activeZoneId, setActiveZoneId] = useState<string>('1');
  const [selectedHour, setSelectedHour] = useState<number>(14);
  const [showDebug, setShowDebug] = useState<boolean>(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);

  // Weather & Location State
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

  // Computed: Get active data
  const activeProfile = zones.find(z => z.id === activeZoneId) ?? zones[0];
  const { zone, ac: acList } = activeProfile;

  const [results, setResults] = useState<SimulationResult | null>(null);

  // Live sensor data from PostgreSQL
  const [liveData, setLiveData] = useState<LiveTempData | null>(null);
  const [liveTempFallback, setLiveTempFallback] = useState(24.5); // used only if DB unreachable

  // Persistence Effect
  useEffect(() => {
    localStorage.setItem('thermozone_data', JSON.stringify(zones));
  }, [zones]);

  // Weather Fetching Effect
  useEffect(() => {
    localStorage.setItem('thermozone_location', JSON.stringify(location));
    const loadWeather = async () => {
      setIsFetchingWeather(true);
      setWeatherError(null);
      const data = await fetchWeather(location.lat, location.lon);
      if (data) {
        setWeather(data);
      } else {
        setWeatherError("Failed to fetch weather data. Please check the location or try again.");
      }
      setIsFetchingWeather(false);
    };
    loadWeather();
  }, [location]);

  // Recalculate
  useEffect(() => {
    if (!weather) return;
    try {
      const res = calculateHeatLoad(zone, acList, weather, location.lat, location.lon);
      setResults(res);
      setWeatherError(null);
    } catch (error) {
      console.error(error);
      setWeatherError("Simulation failed. Please check your zone configuration.");
    }
  }, [zone, acList, weather, location]);

  const handleLocationSearch = async () => {
    if (!locationInput.trim()) return;
    const data = await searchLocation(locationInput);
    if (data) {
      setLocation(data);
      setLocationInput(data.name);
    }
  };

  // Live sensor polling — fetch from PostgreSQL every 5 minutes
  useEffect(() => {
    const loadLiveTemp = async () => {
      const data = await fetchLiveRoomTemp('Working Area 1');
      if (data) {
        setLiveData(data);
      } else {
        // DB unreachable — keep the random-walk fallback ticking
        setLiveTempFallback(prev => Number((prev + (Math.random() - 0.5) * 0.2).toFixed(1)));
      }
    };

    loadLiveTemp(); // immediate first fetch
    const interval = setInterval(loadLiveTemp, 5 * 60 * 1000); // then every 5 min
    return () => clearInterval(interval);
  }, []);

  // --- Multi-Zone Helpers ---

  const updateActiveProfile = (updates: Partial<ZoneProfile>) => {
    setZones(prev => prev.map(z => z.id === activeZoneId ? { ...z, ...updates } : z));
  };

  const addNewZone = () => {
    const newId = Date.now().toString();
    const newProfile: ZoneProfile = {
      id: newId,
      zone: { ...DEFAULT_ZONE, name: `Zone ${zones.length + 1}` },
      ac: [...DEFAULT_ACS]
    };
    setZones(prev => [...prev, newProfile]);
    setActiveZoneId(newId);
  };

  const addWall = () => {
    const newWall: WallDef = {
      id: Date.now().toString(),
      lengthM: 5,
      direction: 'E',
      azimuth: 90
    };
    updateActiveProfile({ zone: { ...zone, walls: [...(zone.walls || []), newWall] } });
  };

  const removeWall = (id: string) => {
    updateActiveProfile({
      zone: {
        ...zone,
        walls: (zone.walls || []).filter(w => w.id !== id),
        // Remove windows attached to the deleted wall
        windows: (zone.windows || []).filter(win => win.wallId !== id)
      }
    });
  };

  const updateWall = (id: string, field: keyof WallDef, value: string | number) => {
    const newWalls = (zone.walls || []).map(w => {
      if (w.id !== id) return w;
      const updated = { ...w, [field]: value };
      if (field === 'direction') updated.azimuth = AZIMUTH_MAP[value as string];
      return updated;
    });
    updateActiveProfile({ zone: { ...zone, walls: newWalls } });
  };

  // Window Handlers
  const addWindow = () => {
    const firstWallId = zone.walls?.[0]?.id ?? '';
    const newWin = { id: Date.now().toString(), wallId: firstWallId, areaM2: 1 };
    updateActiveProfile({ zone: { ...zone, windows: [...(zone.windows || []), newWin] } });
  };

  const removeWindow = (id: string) => {
    updateActiveProfile({ zone: { ...zone, windows: (zone.windows || []).filter(w => w.id !== id) } });
  };

  const updateWindow = (id: string, field: string, value: string | number) => {
    const newWins = (zone.windows || []).map(w => w.id === id ? { ...w, [field]: value } : w);
    updateActiveProfile({ zone: { ...zone, windows: newWins } });
  };

  // AC Handlers
  const addAC = () => {
    const newAC: ACUnit = { id: Date.now().toString(), name: 'New AC', ratedCapacityWatts: 3500, iseer: 3.5, ageYears: 0 };
    updateActiveProfile({ ac: [...acList, newAC] });
  };

  const updateAC = (id: string, field: keyof ACUnit, value: string | number) => {
    const newList = acList.map(ac => ac.id === id ? { ...ac, [field]: value } : ac);
    updateActiveProfile({ ac: newList });
  };

  const removeAC = (id: string) => {
    updateActiveProfile({ ac: acList.filter(ac => ac.id !== id) });
  };

  const totalAcCapacityWatts = acList.reduce((s, a) => s + a.ratedCapacityWatts, 0);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 pb-20 font-inter">
      {/* Header */}
      <header className="bg-slate-900 border-b border-slate-800 sticky top-0 z-50">
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
                {zones.map(z => <option key={z.id} value={z.id}>{z.zone.name}</option>)}
              </select>
              <button onClick={addNewZone} className="text-blue-400 hover:text-white px-2" title="Add New Zone"><Plus size={16} /></button>
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

        {/* Error Banner */}
        {weatherError && (
          <div className="mb-6 p-4 bg-red-900/30 border border-red-700 rounded-xl text-red-300 text-sm">
            {weatherError}
          </div>
        )}

        {/* Sensor Strip */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-2xl p-4 mb-8 flex flex-col md:flex-row items-center justify-between backdrop-blur-sm gap-4">
          <div className="flex items-center gap-6 w-full md:w-auto justify-center md:justify-start flex-wrap">

            {/* Live Room Temp */}
            <div className="flex items-center gap-3">
              <div className="p-2 bg-slate-800 rounded-full">
                <Thermometer className="text-orange-500" size={24} />
              </div>
              <div>
                <p className="text-xs text-slate-400 uppercase tracking-wider">
                  Zone Temp
                  {liveData && (
                    <span className="ml-2 text-green-400 normal-case font-normal">● Live</span>
                  )}
                  {!liveData && (
                    <span className="ml-2 text-yellow-500 normal-case font-normal">⚠ Simulated</span>
                  )}
                </p>
                <p className="text-2xl font-mono font-bold text-white">
                  {liveData ? liveData.avgTemp.toFixed(1) : liveTempFallback}°C
                </p>
              </div>
            </div>

            <div className="h-10 w-px bg-slate-800 hidden sm:block"></div>

            {/* Sensor Count */}
            {liveData && (
              <>
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-slate-800 rounded-full">
                    <Server className="text-blue-400" size={20} />
                  </div>
                  <div>
                    <p className="text-xs text-slate-400 uppercase tracking-wider">Sensors</p>
                    <p className="text-lg font-mono font-bold text-white">{liveData.sensorCount} active</p>
                  </div>
                </div>

                <div className="h-10 w-px bg-slate-800 hidden sm:block"></div>

                {/* Individual sensor readings mini-strip */}
                <div className="flex flex-wrap gap-2">
                  {liveData.sensors.map((s) => (
                    <div
                      key={s.name}
                      className="px-3 py-2 bg-slate-800 rounded-lg border border-slate-700 flex flex-col items-center min-w-[80px]"
                      title={`Last seen: ${new Date(s.deviceTimestamp).toLocaleTimeString()}`}
                    >
                      <span className="text-[10px] text-slate-500 uppercase tracking-tight truncate max-w-[80px]">{s.name}</span>
                      <span className="text-sm font-mono font-bold text-white">{s.temp.toFixed(1)}°C</span>
                      {s.setpoint != null && (
                        <span className="text-[10px] text-blue-400 font-mono">SP {s.setpoint.toFixed(1)}°C</span>
                      )}
                      {s.mode && (
                        <span className="text-[9px] text-slate-400 capitalize">{s.mode.toLowerCase()}</span>
                      )}
                      {s.powerStatus && (
                        <span className={`text-[9px] font-semibold ${s.powerStatus.toLowerCase() === 'on' ? 'text-green-400' : 'text-red-400'}`}>
                          {s.powerStatus.toUpperCase()}
                        </span>
                      )}
                      {s.status === 'offline' && (
                        <span className="text-[9px] text-yellow-500">offline</span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {!liveData && (
              <>
                <div className="h-10 w-px bg-slate-800 hidden sm:block"></div>
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-slate-800 rounded-full">
                    <Wind className="text-blue-400" size={24} />
                  </div>
                  <div>
                    <p className="text-xs text-slate-400 uppercase tracking-wider">System</p>
                    <p className="text-lg font-medium text-green-400">Active</p>
                  </div>
                </div>
              </>
            )}

          </div>

          {/* Last updated timestamp */}
          {liveData && (
            <div className="text-[10px] text-slate-600 text-right shrink-0">
              Last updated<br />
              {new Date(liveData.lastUpdated).toLocaleTimeString()}
            </div>
          )}
        </div>

        {/* --- CONFIGURE TAB --- */}
        {activeTab === 'configure' && (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-8 animate-fade-in">
            {/* Sidebar Navigation */}
            <div className="lg:col-span-1 space-y-2">
              {[
                { id: 'zone', label: 'Zone Metadata', icon: Server },
                { id: 'ac', label: 'AC Specification', icon: Wind },
              ].map((item) => (
                <button
                  key={item.id}
                  onClick={() => setConfigSection(item.id as 'zone' | 'ac')}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${configSection === item.id ? 'bg-slate-800 border border-slate-700 text-white' : 'text-slate-400 hover:bg-slate-900'}`}
                >
                  <item.icon size={18} className={configSection === item.id ? 'text-blue-500' : 'text-slate-500'} />
                  <span className="font-medium">{item.label}</span>
                </button>
              ))}
            </div>

            {/* Config Content */}
            <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-2xl p-6 min-h-[500px]">

              {/* ZONE SECTION */}
              {configSection === 'zone' && (
                <div className="space-y-8">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-4">
                      <InputField label="Zone Name" value={zone.name} onChange={(v) => updateActiveProfile({ zone: { ...zone, name: v as string } })} type="text" />

                      <InputField label="Ceiling Height (m)" value={zone.ceilingHeightM} unit="m" onChange={(v) => updateActiveProfile({ zone: { ...zone, ceilingHeightM: v as number } })} />

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

                  {/* Walls Section */}
                  <div className="border-t border-slate-800 pt-8">
                    <div className="flex justify-between items-center mb-6">
                      <div>
                        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                          <LayoutGrid size={20} className="text-blue-400" />
                          Room Geometry (Walls)
                        </h3>
                        <p className="text-xs text-slate-500 mt-1">Define the room perimeter by adding walls sequentially.</p>
                      </div>
                      <button
                        onClick={addWall}
                        className="flex items-center gap-2 text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg transition-colors shadow-lg shadow-blue-900/20"
                      >
                        <Plus size={16} /> Add Wall
                      </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {(zone.walls || []).length === 0 && (
                        <div className="col-span-full py-12 border-2 border-dashed border-slate-800 rounded-2xl flex flex-col items-center justify-center text-slate-500">
                          <LayoutGrid size={40} className="mb-3 opacity-20" />
                          <p>No walls defined for this zone.</p>
                          <button onClick={addWall} className="mt-4 text-blue-400 hover:text-blue-300 text-sm font-medium">Click to add your first wall</button>
                        </div>
                      )}
                      {(zone.walls || []).map((wall, idx) => (
                        <div key={wall.id} className="bg-slate-950/50 border border-slate-800 p-4 rounded-xl relative group hover:border-slate-700 transition-colors">
                          <div className="absolute -top-2 -left-2 bg-slate-800 text-slate-400 text-[10px] font-bold px-2 py-0.5 rounded border border-slate-700">
                            Wall {idx + 1}
                          </div>
                          <button
                            onClick={() => removeWall(wall.id)}
                            className="absolute -top-2 -right-2 bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white p-1.5 rounded-lg border border-red-500/20 transition-all opacity-0 group-hover:opacity-100"
                          >
                            <Trash2 size={14} />
                          </button>

                          <div className="space-y-4 mt-2">
                            <InputField
                              label="Length (m)"
                              value={wall.lengthM}
                              unit="m"
                              onChange={(v) => updateWall(wall.id, 'lengthM', v as number)}
                            />

                            <div className="flex flex-col gap-1">
                              <label className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">Direction</label>
                              <div className="grid grid-cols-4 gap-1">
                                {Object.keys(AZIMUTH_MAP).map(dir => (
                                  <button
                                    key={dir}
                                    onClick={() => updateWall(wall.id, 'direction', dir)}
                                    className={`py-1 text-[10px] font-bold rounded border transition-all ${wall.direction === dir ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-900 border-slate-800 text-slate-500 hover:border-slate-700'}`}
                                  >
                                    {dir}
                                  </button>
                                ))}
                              </div>
                              <div className="mt-1 flex justify-between items-center px-1">
                                <span className="text-[10px] text-slate-600">Azimuth Angle:</span>
                                <span className="text-[10px] font-mono text-blue-400">{wall.azimuth}°</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Windows Section */}
                  <div className="border-t border-slate-800 pt-8">
                    <div className="flex justify-between items-center mb-6">
                      <div>
                        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                          <ImageIcon size={20} className="text-blue-400" />
                          Windows Specification
                        </h3>
                        <p className="text-xs text-slate-500 mt-1">Assign windows to specific walls. Azimuth is inherited from the wall.</p>
                      </div>
                      <button
                        onClick={addWindow}
                        className="flex items-center gap-2 text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg transition-colors shadow-lg shadow-blue-900/20"
                      >
                        <Plus size={16} /> Add Window
                      </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {(zone.windows || []).length === 0 && (
                        <div className="col-span-full py-12 border-2 border-dashed border-slate-800 rounded-2xl flex flex-col items-center justify-center text-slate-500">
                          <ImageIcon size={40} className="mb-3 opacity-20" />
                          <p>No windows defined for this zone.</p>
                          <button onClick={addWindow} className="mt-4 text-blue-400 hover:text-blue-300 text-sm font-medium">Click to add your first window</button>
                        </div>
                      )}
                      {(zone.windows || []).map((win, idx) => (
                        <div key={win.id} className="bg-slate-950/50 border border-slate-800 p-4 rounded-xl relative group hover:border-slate-700 transition-colors">
                          <div className="absolute -top-2 -left-2 bg-slate-800 text-slate-400 text-[10px] font-bold px-2 py-0.5 rounded border border-slate-700">
                            Window {idx + 1}
                          </div>
                          <button
                            onClick={() => removeWindow(win.id)}
                            className="absolute -top-2 -right-2 bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white p-1.5 rounded-lg border border-red-500/20 transition-all opacity-0 group-hover:opacity-100"
                          >
                            <Trash2 size={14} />
                          </button>

                          <div className="space-y-4 mt-2">
                            <InputField
                              label="Window Area (m²)"
                              value={win.areaM2}
                              unit="m²"
                              onChange={(v) => updateWindow(win.id, 'areaM2', v as number)}
                            />

                            <div className="flex flex-col gap-1">
                              <label className="text-xs text-slate-400 uppercase font-semibold">Assigned Wall</label>
                              <select
                                value={win.wallId}
                                onChange={(e) => updateWindow(win.id, 'wallId', e.target.value)}
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg py-2 px-3 text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm transition-colors"
                              >
                                {(zone.walls || []).map((wall, wIdx) => (
                                  <option key={wall.id} value={wall.id}>
                                    Wall {wIdx + 1} – {wall.direction} ({wall.azimuth}°)
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* AC SECTION */}
              {configSection === 'ac' && (
                <div className="space-y-6">
                  <div className="flex justify-between items-center">
                    <h3 className="font-semibold text-white">Installed AC Units</h3>
                    <button onClick={addAC} className="flex items-center gap-1 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded"><Plus size={14} /> Add Unit</button>
                  </div>
                  <div className="grid grid-cols-1 gap-4">
                    {acList.map((ac) => (
                      <div key={ac.id} className="bg-slate-950/50 border border-slate-800 p-4 rounded-xl flex flex-col md:flex-row gap-4 items-end">
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
                    ))}
                  </div>
                  <div className="p-4 bg-slate-800 rounded-lg flex justify-between items-center">
                    <span className="text-slate-400">Total System Capacity</span>
                    <span className="text-xl font-bold text-white">
                      {(totalAcCapacityWatts / 3517).toFixed(2)} TR
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* --- MONITOR TAB --- */}
        {activeTab === 'monitor' && (
          <div className="space-y-8 animate-fade-in">
            {results && (
              <>
                <ResultsDashboard
                  results={results}
                  ratedCapacityWatts={totalAcCapacityWatts}
                  locationName={location.name}
                  walls={zone.walls}
                  windows={zone.windows}
                />

                {/* Debug Toggle */}
                <div className="flex justify-center">
                  <button
                    onClick={() => setShowDebug(!showDebug)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest transition-all ${showDebug ? 'bg-pink-600 text-white shadow-lg shadow-pink-900/50' : 'bg-slate-800 text-slate-400 hover:text-white border border-slate-700'}`}
                  >
                    <Bug size={14} />
                    {showDebug ? 'Hide Engineering Debug' : 'Show Engineering Debug'}
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
                      windows={zone.windows}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;

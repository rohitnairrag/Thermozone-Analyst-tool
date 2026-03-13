import { ZoneParams, ACUnit, SimulationResult, SimulationDataPoint, HourlyWeather } from '../types';
import { computeFloorArea } from './geometry';

export const calculateHeatLoad = (
  zone: ZoneParams,
  acList: ACUnit[],
  weather: HourlyWeather | null = null,
  lat: number = 12.9716,
  lon: number = 77.5946
): SimulationResult => {
  if (!weather || !weather.temperature) {
    throw new Error("Weather data missing from API.");
  }

  const totalRatedCapacity = acList.reduce((sum, ac) => sum + ac.ratedCapacityWatts, 0);

  const areaM2 = computeFloorArea(zone.walls);
  const roomVolumeM3 = areaM2 * zone.ceilingHeightM;

  // Solar Geometry Constants
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now.getTime() - start.getTime();
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));

  const phi = lat * Math.PI / 180;
  const delta = 23.45 * Math.sin((360 * (284 + dayOfYear) / 365) * Math.PI / 180) * Math.PI / 180;

  // Heat gain constants
  const GROUND_REFLECTANCE = 0.2;
  const FRAME_FACTOR = 0.85;
  const SHGC = 0.3;
  const U_GLASS = 2.7;
  const U_WALL = 1.8;
  const U_ROOF = 1.5;
  const ALPHA_WALL = 0.6;
  const ALPHA_ROOF = 0.8;
  const H_OUT = 20;
  const THERMAL_MASS_FACTOR = 0.7;

  // Infiltration & Internal Gain Constants
  const ACH = 0.5;
  const AIR_DENSITY = 1.2;
  const LIGHTING_DENSITY = 10;
  const EQUIPMENT_DENSITY = 12;
  const PEOPLE_TOTAL_HEAT = 75 + 55;
  const OCCUPANCY_DENSITY_PER_1000FT2 = 5;
  const M2_TO_FT2 = 10.7639;

  const maxPeople = (areaM2 * M2_TO_FT2 * OCCUPANCY_DENSITY_PER_1000FT2) / 1000;

  const getEnthalpy = (T: number, RH: number) => {
    const pws = 6.112 * Math.exp((17.67 * T) / (T + 243.5));
    const pw = (RH / 100) * pws;
    const pAtm = 1013.25;
    const W = (0.62198 * pw) / (pAtm - pw);
    return 1.006 * T + W * (2501 + 1.86 * T);
  };

  const massFlowRate = (AIR_DENSITY * ACH * roomVolumeM3) / 3600;

  const getOccupancyFactor = (h: number) => {
    if (h < 8) return 0;
    if (h === 8) return 0.2;
    if (h === 9) return 0.6;
    if (h >= 10 && h <= 16) return 1;
    if (h === 17) return 0.6;
    if (h === 18) return 0.2;
    return 0;
  };

  const getLightingFactor = (h: number) => {
    if (h < 8) return 0;
    if (h === 8) return 0.4;
    if (h >= 9 && h <= 17) return 1;
    if (h === 18) return 0.4;
    return 0;
  };

  const getEquipmentFactor = (h: number) => {
    if (h < 7) return 0.2;
    if (h >= 7 && h <= 8) return 0.4;
    if (h >= 9 && h <= 17) return 1;
    if (h >= 18 && h <= 20) return 0.5;
    return 0.2;
  };

  // Simulation State
  const RTS = [0.35, 0.25, 0.20, 0.12, 0.08];
  const wallHistory: number[] = [];
  const roofHistory: number[] = [];
  const solarHistory: number[] = [];
  const data: SimulationDataPoint[] = [];

  let currentIndoorTemp = 24.0;
  let totalTempSum = 0;
  let maxTemp = 0;
  let peakLoadWatts = 0;
  let peakLoadTime = '';
  let peakPerformanceFactor = 1;

  const roomThermalMassJperK = areaM2 * 50000;
  const thermalMassWatts = roomThermalMassJperK / 3600;
  const LATENT_HEAT_FACTOR = 1.45;

  for (let hour = 0; hour < 24; hour++) {
    const outdoorTemp = weather.temperature[hour];
    const outdoorRH = weather.relativeHumidity[hour];
    const dni = weather.directRadiation[hour];
    const dhi = weather.diffuseRadiation[hour];
    const ghi = weather.shortwaveRadiation[hour];

    // Solar Geometry
    const H = 15 * (hour - 12) * Math.PI / 180;
    const sinAlpha = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(H);
    const alpha = Math.asin(Math.max(-1, Math.min(1, sinAlpha)));

    let sunAzimuthDeg = 180;
    if (alpha > -0.01) {
      const cosAz = (Math.sin(delta) - Math.sin(phi) * Math.sin(alpha)) / (Math.cos(phi) * Math.cos(alpha));
      const azRad = Math.acos(Math.max(-1, Math.min(1, cosAz)));
      sunAzimuthDeg = azRad * 180 / Math.PI;
      if (H > 0) sunAzimuthDeg = 360 - sunAzimuthDeg;
    }

    const iRoof = alpha > 0 ? (dni * Math.sin(alpha) + dhi) : 0;
    const tSolairRoof = outdoorTemp + (ALPHA_ROOF * iRoof / H_OUT);

    let stepSetPoint = 24;
    if (hour >= 10 && hour <= 17) stepSetPoint = 23;

    let solar = 0;
    let glass = 0;
    let wall = 0;
    let roof = 0;
    let inf = 0;
    let internalEquipment = 0;
    let people = 0;
    const other = 0;

    // 1. Infiltration Load
    const hOut = getEnthalpy(outdoorTemp, outdoorRH);
    const hInDynamic = getEnthalpy(currentIndoorTemp, 50);
    const qInf = massFlowRate * (hOut - hInDynamic) * 1000;
    inf += Math.max(0, qInf);

    // 2. Internal Gains
    const nPeople = maxPeople * getOccupancyFactor(hour);
    people += nPeople * PEOPLE_TOTAL_HEAT;
    internalEquipment += LIGHTING_DENSITY * areaM2 * getLightingFactor(hour);
    internalEquipment += EQUIPMENT_DENSITY * areaM2 * getEquipmentFactor(hour);

    // 3. Roof (Top Floor only)
    if (zone.isTopFloor) {
      const qRoof = U_ROOF * areaM2 * (tSolairRoof - currentIndoorTemp);
      roof += Math.max(0, qRoof);
    }

    // 4. Window Solar Gain & Wall Conduction
    const walls = zone.walls || [];
    const windows = zone.windows || [];
    const hourWindowGains: Record<string, number> = {};
    const hourWindowDebug: Record<string, { azimuth: number; cosTheta: number; incidentRadiation: number; solarGain: number }> = {};

    walls.forEach(wDef => {
      const wallWindows = windows.filter(win => win.wallId === wDef.id);
      const totalWindowAreaOnWall = wallWindows.reduce((sum, win) => sum + win.areaM2, 0);

      wallWindows.forEach(win => {
        const gammaS = sunAzimuthDeg * Math.PI / 180;
        const gammaW = wDef.azimuth * Math.PI / 180;
        const cosTheta = Math.max(0, Math.cos(alpha) * Math.cos(gammaS - gammaW));

        const diffuseComponent = 0.5 * dhi * (1 + Math.sin(alpha));
        const groundComponent = 0.5 * GROUND_REFLECTANCE * ghi;
        const iWin = (alpha > 0 ? dni * cosTheta : 0) + diffuseComponent + groundComponent;

        const qSolar = win.areaM2 * FRAME_FACTOR * SHGC * iWin;
        const qGlass = U_GLASS * win.areaM2 * (outdoorTemp - currentIndoorTemp);

        solar += qSolar;
        glass += Math.max(0, qGlass);

        const windowId = `win_${win.id}`;
        hourWindowGains[windowId] = qSolar;
        hourWindowDebug[windowId] = { azimuth: wDef.azimuth, cosTheta, incidentRadiation: iWin, solarGain: qSolar };
      });

      const wallNetArea = Math.max(0, (wDef.lengthM * zone.ceilingHeightM) - totalWindowAreaOnWall);
      const gammaS_wall = sunAzimuthDeg * Math.PI / 180;
      const gammaW_wall = wDef.azimuth * Math.PI / 180;
      const cosThetaWall = Math.max(0, Math.cos(alpha) * Math.cos(gammaS_wall - gammaW_wall));
      const diffuseFactor = 0.5 * (1 + Math.sin(alpha));
      const iWall = alpha > 0 ? (dni * cosThetaWall + diffuseFactor * dhi + 0.5 * GROUND_REFLECTANCE * ghi) : 0;

      const tSolair = outdoorTemp + (ALPHA_WALL * iWall / H_OUT);
      const qWall = THERMAL_MASS_FACTOR * U_WALL * wallNetArea * (tSolair - currentIndoorTemp);
      wall += Math.max(0, qWall);
    });

    // RTS Implementation
    const convectiveSolar = 0.3 * solar;
    const radiantSolar = 0.7 * solar;
    solarHistory.push(radiantSolar);
    wallHistory.push(wall);
    roofHistory.push(roof);

    let solarDelayed = convectiveSolar;
    let wallDelayed = 0;
    let roofDelayed = 0;
    for (let i = 0; i < RTS.length; i++) {
      solarDelayed += RTS[i] * (solarHistory[hour - i - 1] || 0);
      wallDelayed += RTS[i] * (wallHistory[hour - i] || 0);
      roofDelayed += RTS[i] * (roofHistory[hour - i] || 0);
    }

    const currentTotalLoad = solarDelayed + glass + wallDelayed + roofDelayed + inf + internalEquipment + people + other;

    // AC Capacity
    const degradation = Math.max(0, (outdoorTemp - 35) * 0.015);
    const performanceFactor = 1 - degradation;
    const isWorkingHours = hour >= 8 && hour <= 20;
    const acActive = isWorkingHours || currentTotalLoad > 500;
    const maxAvailableCapacity = acActive ? (totalRatedCapacity * performanceFactor) : 0;

    // Thermal Simulation
    let targetTemp = stepSetPoint + 0.2;
    if (acActive) {
      const loadStress = maxAvailableCapacity > 0 ? (currentTotalLoad / maxAvailableCapacity) : 1;
      targetTemp += Math.min(1.8, loadStress * 2.0);
    } else {
      targetTemp = currentIndoorTemp + (outdoorTemp - currentIndoorTemp) * 0.15;
    }

    let nextTemp = (currentIndoorTemp * 0.70) + (targetTemp * 0.30);
    if (acActive) {
      if (nextTemp < 22.5) nextTemp = 22.5;
      if (nextTemp > 25.8) nextTemp = 25.8;
    } else {
      if (nextTemp < 21) nextTemp = 21;
      if (nextTemp > 28) nextTemp = 28;
    }

    const tempChange = currentIndoorTemp - nextTemp;
    let sensibleWork = currentTotalLoad + (tempChange * thermalMassWatts * 3.0);
    let acOutputEst = sensibleWork > 0 ? sensibleWork * LATENT_HEAT_FACTOR : sensibleWork;

    if (!acActive) acOutputEst = 0;
    if (acOutputEst > maxAvailableCapacity) acOutputEst = maxAvailableCapacity;
    if (acOutputEst < 0) acOutputEst = 0;

    currentIndoorTemp = nextTemp;
    totalTempSum += nextTemp;
    if (nextTemp > maxTemp) maxTemp = nextTemp;

    if (currentTotalLoad > peakLoadWatts) {
      peakLoadWatts = currentTotalLoad;
      peakLoadTime = `${hour}:00`;
      peakPerformanceFactor = performanceFactor;
    }

    data.push({
      time: `${hour}:00`,
      hour,
      outdoorTemp,
      solarLoad: solarDelayed,
      glassLoad: glass,
      wallLoad: wallDelayed,
      roofLoad: roofDelayed,
      infLoad: inf,
      internalLoad: internalEquipment,
      peopleLoad: people,
      otherLoad: other,
      totalHeatLoad: currentTotalLoad,
      windowGains: hourWindowGains,
      coolingCapacityAvailable: maxAvailableCapacity,
      acOutputWatts: acOutputEst,
      indoorTempRaw: nextTemp,
      setPoint: stepSetPoint,
      solarAltitude: alpha * 180 / Math.PI,
      solarAzimuth: sunAzimuthDeg,
      dni,
      dhi,
      ghi,
      windowDebug: hourWindowDebug,
      _areaM2: areaM2
    });
  }

  // Compare peak load against derated capacity at peak hour
  const isSufficient = (totalRatedCapacity * peakPerformanceFactor) >= peakLoadWatts;

  return {
    data,
    peakLoadWatts,
    peakLoadTime,
    isSufficient,
    averageTemp: totalTempSum / 24,
    maxTemp
  };
};

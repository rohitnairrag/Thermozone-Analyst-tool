import { ZoneParams, ACUnit, SimulationResult, SimulationDataPoint, HourlyWeather, InternalLoadItem, ZoneTransferEntry } from '../types';
import { computeFloorArea } from './geometry';
import { computeScheduledInternalLoads } from './internalLoadScheduler';

// Shared envelope U-values (W/m²·K) — imported by HeatFlowDiagram to keep constants in sync
export const U_GLASS = 2.7;  // double-glazed tinted glass
export const U_WALL  = 1.8;  // brick/block wall, no insulation

export const calculateHeatLoad = (
  zone: ZoneParams,
  acList: ACUnit[],
  weather: HourlyWeather | null = null,
  lat: number = 12.9716,
  lon: number = 77.5946,
  realIndoorTemps: number[] | null = null,        // 24-element array from DB (index = hour); overrides simulated indoor temp
  realAcOutputsWatts: number[] | null = null,     // 24-element array from DB (index = hour); total zone AC electrical watts
  internalLoadItems?: InternalLoadItem[],         // optional per-unit inventory; replaces W/m² density method when provided
  adjacentZoneTemps: Record<string, number[]> | null = null,  // zoneId → 24-hr temp array for adjacent zone heat transfer
  initialTempC: number | null = null,             // real starting indoor temp (e.g. yesterday's last sensor reading); overrides the 24°C default
  previousDayWeather: HourlyWeather | null = null, // yesterday's actual weather — used for pre-warm so wall/roof thermal state reflects true prior-day heat gain
): SimulationResult => {
  if (!weather || !weather.temperature) {
    throw new Error("Weather data missing from API.");
  }

  // ── Age-based degradation ────────────────────────────────────────────────
  const getAgeFactor = (ageYears: number) => Math.max(0.70, 1 - ageYears * 0.02);

  const totalRatedCapacity = acList.reduce(
    (sum, ac) => sum + ac.ratedCapacityWatts * getAgeFactor(ac.ageYears), 0
  );
  const avgISEER = acList.length > 0
    ? acList.reduce((s, ac) => s + ac.iseer * getAgeFactor(ac.ageYears), 0) / acList.length
    : 3.70;

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
  const U_ROOF = 1.5;
  const ALPHA_WALL = 0.6;
  const ALPHA_ROOF = 0.8;
  const H_OUT_MIN = 10;
  const EPSILON_ROOF = 0.9;

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

  // ── Wet-bulb temperature (Stull 2011 approximation) ──────────────────────
  // Valid for RH 5–99 %, T –20 to 50 °C. Used for evaporative cooling on wet
  // surfaces during rain events.
  const wetBulb = (T: number, RH: number): number =>
    T * Math.atan(0.151977 * Math.sqrt(RH + 8.313659))
    + Math.atan(T + RH)
    - Math.atan(RH - 1.676331)
    + 0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH)
    - 4.686035;

  // ── Simulation State — 1-minute resolution (1440 slots per day) ──────────
  // slot 0 = 00:00, slot 1 = 00:01, …, slot 1439 = 23:59
  //
  // WINDOW SOLAR RTS — radiant delay for solar gain through glass surfaces.
  // Solar radiation that passes through windows heats room surfaces (desks,
  // floors, walls) which then re-radiate to room air over 1–5 hours.
  // RTS = [0.35, 0.25, 0.20, 0.12, 0.08] captures this convective lag.
  // (This is ASHRAE Step 2 — radiant-to-convective conversion.)
  const RTS = [0.35, 0.25, 0.20, 0.12, 0.08];
  const solarHistory: number[] = [];   // radiant fraction of window solar gain (70%)
  const data: SimulationDataPoint[] = [];

  // ── RC Thermal Mass Model for Walls & Roof ────────────────────────────────
  // ASHRAE Step 1 (Conduction Time Series) requires 18–24 h of wall history to
  // model overnight heat carry-over. A single-node RC model achieves the same
  // result without construction-specific lookup tables.
  //
  // Wall surface temperature evolves toward the current sol-air temperature
  // with time constant τ_WALL. By the time 8 hours have passed the wall has
  // moved ~63 % of the way to the new temperature — so afternoon peak solar
  // (absorbed by walls 12:00–16:00) is still present as positive wall-to-room
  // heat transfer well into the night. This matches EnergyPlus's RC model.
  //
  // τ_WALL = 8 h = 480 slots (medium-weight concrete/brick construction)
  // τ_ROOF = 5 h = 300 slots (lighter roof assembly, exposed to sky radiation)
  const τ_WALL = 480;
  const τ_ROOF = 300;

  // Starting indoor temperature
  let currentIndoorTemp = initialTempC
    ?? (realIndoorTemps && realIndoorTemps[0] != null ? realIndoorTemps[0] : 24.0);

  // Initialize wall/roof surface temps to outdoor air at 07:00 of the prior day
  // (before solar warm-up begins). pwWeather is yesterday's weather if available.
  const pwWeather = previousDayWeather ?? weather;
  let wallSurfaceTemp = pwWeather.temperature[7] ?? currentIndoorTemp;
  let roofSurfaceTemp = pwWeather.temperature[7] ?? currentIndoorTemp;

  let totalTempSum = 0;
  let maxTemp = 0;
  let peakLoadWatts = 0;
  let peakLoadTime = '';
  let peakPerformanceFactor = 1;
  let acOutputAtPeakLoad = 0;

  const SLOT_SECONDS = 60;
  const roomThermalMassJperK = areaM2 * 150_000;

  // ── Helper: solar geometry at a given fractional hour ──────────────────
  const solarGeometry = (fracHour: number) => {
    const H = 15 * (fracHour - 12) * Math.PI / 180;
    const sinAlpha = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(H);
    const alpha = Math.asin(Math.max(-1, Math.min(1, sinAlpha)));
    let azimuthDeg = 180;
    if (alpha > -0.01) {
      const cosAz = (Math.sin(delta) - Math.sin(phi) * Math.sin(alpha)) / (Math.cos(phi) * Math.cos(alpha));
      const azRad = Math.acos(Math.max(-1, Math.min(1, cosAz)));
      azimuthDeg = azRad * 180 / Math.PI;
      if (H > 0) azimuthDeg = 360 - azimuthDeg;
    }
    return { alpha, azimuthDeg };
  };

  // ── Pre-warm: RC thermal mass simulation for hours 07:00–23:59 ───────────
  // Runs the wall/roof RC model through a full 16-hour solar day before the
  // main midnight-to-midnight simulation. By midnight the surface temperatures
  // reflect the afternoon solar absorption and evening cool-down, so the main
  // simulation starts with realistic stored heat in the building envelope.
  //
  // When previousDayWeather is provided (yesterday's actual weather fetched
  // from the API), the pre-warm uses it directly — giving true thermal
  // continuity across days. A hot sunny Sunday correctly leaves walls warmer
  // at Monday midnight than a cloudy Sunday would.
  //
  // Fallback: if no previous day weather is available, today's own weather is
  // used as a proxy (ASHRAE periodic steady-state assumption). This is less
  // accurate but still far better than starting from scratch.
  //
  // Rain / evaporative cooling is applied during pre-warm so that a rain
  // event that started in the afternoon is already reflected in wall/roof
  // surface temperatures at midnight.
  const PREWARM_SLOTS = 1020; // 17 hours × 60 min/hour (07:00 → 23:59)
  // Must be 1020 (not 960) so the RTS 5-step lookback at midnight reads slots
  // 19:00–23:00 (all zero solar) rather than 18:00–22:00 (18:00 has residual
  // solar in Bangalore), which was causing phantom solar gain at hour 00:00.

  let prewarmIndoorTemp = currentIndoorTemp;

  for (let ps = 0; ps < PREWARM_SLOTS; ps++) {
    const fracHourPW = 7 + ps / 60;          // 7.000 … 22.983
    const h0PW = Math.floor(fracHourPW);      // 7 … 22
    const h1PW = Math.min(h0PW + 1, 23);
    const fracPW = fracHourPW - h0PW;

    const lerpPW = (a: number, b: number) => a * (1 - fracPW) + b * fracPW;
    const outdoorTempPW = lerpPW(pwWeather.temperature[h0PW],      pwWeather.temperature[h1PW]);
    const outdoorRHPW   = lerpPW(pwWeather.relativeHumidity[h0PW], pwWeather.relativeHumidity[h1PW]);
    const dniPW  = lerpPW(pwWeather.directRadiation[h0PW],    pwWeather.directRadiation[h1PW]);
    const dhiPW  = lerpPW(pwWeather.diffuseRadiation[h0PW],   pwWeather.diffuseRadiation[h1PW]);
    const ghiPW  = lerpPW(pwWeather.shortwaveRadiation[h0PW], pwWeather.shortwaveRadiation[h1PW]);
    const windPW = pwWeather.windspeed
      ? lerpPW(pwWeather.windspeed[h0PW] ?? 3, pwWeather.windspeed[h1PW] ?? 3) : 3;
    const precipPW = pwWeather.precipitation
      ? lerpPW(pwWeather.precipitation[h0PW] ?? 0, pwWeather.precipitation[h1PW] ?? 0) : 0;

    const H_OUT_PW = Math.max(H_OUT_MIN, 5.8 + 3.94 * windPW);
    const { alpha: alphaPW, azimuthDeg: sunAzPW } = solarGeometry(fracHourPW);

    // ── Rain / evaporative cooling (upgrade path) ─────────────────────────
    // When the wall or roof surface is wet (rain or very high humidity),
    // evaporation cools the outer surface below the dry-bulb outdoor temp.
    // The effective solair temperature is reduced by the evaporative cooling.
    //   wetFraction: 0 = dry, 1 = fully saturated surface.
    //   Wall efficiency 0.6 (vertical surface, partial runoff).
    //   Roof efficiency 0.9 (horizontal, fully exposed to rain).
    const isRainingPW = precipPW > 0.1 || (ghiPW < 5 && outdoorRHPW > 88);
    const wetFrPW = precipPW > 0.1
      ? Math.min(1, precipPW / 5)
      : (isRainingPW ? 0.4 : 0);
    const tWetBulbPW = wetBulb(outdoorTempPW, outdoorRHPW);
    const evapWallPW = (outdoorTempPW - tWetBulbPW) * 0.6 * wetFrPW;
    const evapRoofPW = (outdoorTempPW - tWetBulbPW) * 0.9 * wetFrPW;

    // ── Roof RC update ────────────────────────────────────────────────────
    if (zone.isTopFloor) {
      const iRoofPW = alphaPW > 0 ? (dniPW * Math.sin(alphaPW) + dhiPW) : 0;
      const clearSkyPW = alphaPW > 0.05
        ? Math.min(1, ghiPW / Math.max(1, dniPW * Math.sin(alphaPW) + dhiPW)) : 0;
      const tSolairRoofPW = outdoorTempPW
        + (ALPHA_ROOF * iRoofPW / H_OUT_PW)
        - (EPSILON_ROOF * 63 * clearSkyPW / H_OUT_PW)
        - evapRoofPW;
      roofSurfaceTemp += (tSolairRoofPW - roofSurfaceTemp) / τ_ROOF;
    }

    // ── Wall RC update (aggregate tSolair, area-weighted) ─────────────────
    let tSolairSumPW = 0;
    let extWallAreaPW = 0;
    let solarPW = 0; // window solar gain (for solarHistory)

    const cosThetaFn = (wallAzimuth: number) =>
      Math.max(0, Math.cos(alphaPW) * Math.cos(sunAzPW * Math.PI / 180 - wallAzimuth * Math.PI / 180));

    ;(zone.walls || []).forEach(wDef => {
      if (wDef.wallType === 'internal') return;
      const totalWallAreaPW = wDef.lengthM * zone.ceilingHeightM;

      if (wDef.constructionType === 'full_glass') {
        // Window solar gain (goes into solarHistory RTS)
        const diffusePW  = 0.5 * dhiPW * (1 + Math.sin(alphaPW));
        const groundPW   = 0.5 * GROUND_REFLECTANCE * ghiPW;
        const iWinPW = (alphaPW > 0 ? dniPW * cosThetaFn(wDef.azimuth) : 0) + diffusePW + groundPW;
        solarPW += totalWallAreaPW * FRAME_FACTOR * SHGC * iWinPW;
      } else {
        let winAreaPW = 0;
        if (wDef.constructionType === 'mixed') {
          (wDef.windows || []).forEach(win => {
            const diffusePW = 0.5 * dhiPW * (1 + Math.sin(alphaPW));
            const groundPW  = 0.5 * GROUND_REFLECTANCE * ghiPW;
            const iWinPW    = (alphaPW > 0 ? dniPW * cosThetaFn(wDef.azimuth) : 0) + diffusePW + groundPW;
            solarPW  += win.areaM2 * FRAME_FACTOR * SHGC * iWinPW;
            winAreaPW += win.areaM2;
          });
        }
        const wallNetAreaPW = Math.max(0, totalWallAreaPW - winAreaPW);
        if (wallNetAreaPW <= 0) return;

        const diffFacPW = 0.5 * (1 + Math.sin(alphaPW));
        const iWallPW = alphaPW > 0
          ? (dniPW * cosThetaFn(wDef.azimuth) + diffFacPW * dhiPW + 0.5 * GROUND_REFLECTANCE * ghiPW)
          : 0;
        const tSolairWallPW = outdoorTempPW + (ALPHA_WALL * iWallPW / H_OUT_PW) - evapWallPW;

        tSolairSumPW  += tSolairWallPW * wallNetAreaPW;
        extWallAreaPW += wallNetAreaPW;
      }
    });

    if (extWallAreaPW > 0) {
      wallSurfaceTemp += (tSolairSumPW / extWallAreaPW - wallSurfaceTemp) / τ_WALL;
    }

    // Window solar radiant fraction → solarHistory (for main-loop RTS)
    solarHistory.push(0.7 * solarPW);

    // Evolve pre-warm indoor temperature (no occupants, AC off after hours)
    const hOutPW = getEnthalpy(outdoorTempPW, outdoorRHPW);
    const hInPWi = getEnthalpy(prewarmIndoorTemp, 50);
    const qNetPW = massFlowRate * (hOutPW - hInPWi) * 1000
      + (zone.isTopFloor ? U_ROOF * areaM2 * (roofSurfaceTemp - prewarmIndoorTemp) : 0)
      + (extWallAreaPW > 0 ? U_WALL * extWallAreaPW * (wallSurfaceTemp - prewarmIndoorTemp) : 0)
      + 0.3 * solarPW;
    prewarmIndoorTemp = Math.max(15, Math.min(45, prewarmIndoorTemp + (qNetPW * SLOT_SECONDS) / roomThermalMassJperK));
  }

  // After pre-warm, reset midnight temperature to real anchor if available;
  // otherwise use the physics-simulated evening temperature.
  if (initialTempC == null && !(realIndoorTemps && realIndoorTemps[0] != null)) {
    currentIndoorTemp = prewarmIndoorTemp;
  }

  // ── Main simulation: midnight → 23:59 ────────────────────────────────────
  for (let slot = 0; slot < 1440; slot++) {
    const fracHour = slot / 60;
    const h0 = Math.floor(fracHour);
    const h1 = Math.min(h0 + 1, 23);
    const frac = fracHour - h0;

    const lerp = (a: number, b: number) => a * (1 - frac) + b * frac;
    const outdoorTemp = lerp(weather.temperature[h0],       weather.temperature[h1]);
    const outdoorRH   = lerp(weather.relativeHumidity[h0],  weather.relativeHumidity[h1]);
    const dni         = lerp(weather.directRadiation[h0],   weather.directRadiation[h1]);
    const dhi         = lerp(weather.diffuseRadiation[h0],  weather.diffuseRadiation[h1]);
    const ghi         = lerp(weather.shortwaveRadiation[h0], weather.shortwaveRadiation[h1]);
    const windSpeedMs = weather.windspeed
      ? lerp(weather.windspeed[h0] ?? 3, weather.windspeed[h1] ?? 3) : 3;
    const precipMmH = weather.precipitation
      ? lerp(weather.precipitation[h0] ?? 0, weather.precipitation[h1] ?? 0) : 0;

    const H_OUT = Math.max(H_OUT_MIN, 5.8 + 3.94 * windSpeedMs);

    // ── Rain / evaporative cooling ────────────────────────────────────────
    // Detected when precipitation > 0.1 mm/h, OR when solar is essentially
    // zero combined with very high humidity (cloud/overcast proxy).
    // wetFraction scales evaporation from partial (0.3) to full (1.0).
    const isRaining = precipMmH > 0.1 || (ghi < 5 && outdoorRH > 88);
    const wetFraction = precipMmH > 0.1
      ? Math.min(1, precipMmH / 5)
      : (isRaining ? 0.4 : 0);
    const tWetBulbNow = wetBulb(outdoorTemp, outdoorRH);
    const evapCoolingWall = (outdoorTemp - tWetBulbNow) * 0.6 * wetFraction;
    const evapCoolingRoof = (outdoorTemp - tWetBulbNow) * 0.9 * wetFraction;

    // ── Solar geometry ────────────────────────────────────────────────────
    const { alpha, azimuthDeg: sunAzimuthDeg } = solarGeometry(fracHour);

    // ── Roof solair (with rain evaporative cooling) ───────────────────────
    const iRoof = alpha > 0 ? (dni * Math.sin(alpha) + dhi) : 0;
    const clearSkyFraction = alpha > 0.05
      ? Math.min(1, ghi / Math.max(1, dni * Math.sin(alpha) + dhi)) : 0;
    const deltaR = 63 * clearSkyFraction;
    const tSolairRoof = outdoorTemp
      + (ALPHA_ROOF * iRoof / H_OUT)
      - (EPSILON_ROOF * deltaR / H_OUT)
      - evapCoolingRoof;  // rain cools roof surface toward wet-bulb

    // Set-point
    let stepSetPoint = 24;
    if (h0 >= 10 && h0 <= 17) stepSetPoint = 23;

    let solar = 0;
    let glass = 0;
    let wall  = 0;
    let roof  = 0;
    let inf   = 0;
    let internalEquipment = 0;
    let people = 0;
    let other  = 0;
    const slotTransfers: ZoneTransferEntry[] = [];

    // 1. Infiltration
    const hOut = getEnthalpy(outdoorTemp, outdoorRH);
    const hInDynamic = getEnthalpy(currentIndoorTemp, 50);
    inf += massFlowRate * (hOut - hInDynamic) * 1000;

    // 2. Internal Gains
    if (internalLoadItems && internalLoadItems.length > 0) {
      const sched = computeScheduledInternalLoads(internalLoadItems, h0);
      people            += sched.people;
      internalEquipment += sched.lighting + sched.equipment + sched.appliance;
    } else {
      const nPeople = maxPeople * getOccupancyFactor(h0);
      people            += nPeople * PEOPLE_TOTAL_HEAT;
      internalEquipment += LIGHTING_DENSITY * areaM2 * getLightingFactor(h0);
      internalEquipment += EQUIPMENT_DENSITY * areaM2 * getEquipmentFactor(h0);
    }

    // 3. Roof — RC thermal mass model
    // roofSurfaceTemp tracks the actual roof inner-surface temperature,
    // which lags behind sol-air by τ_ROOF (5 h). After a sunny afternoon
    // the roof surface stays warm into the night, releasing stored heat.
    // After rain the surface drops quickly toward wet-bulb, cutting heat gain.
    if (zone.isTopFloor) {
      roofSurfaceTemp += (tSolairRoof - roofSurfaceTemp) / τ_ROOF;
      roof = U_ROOF * areaM2 * (roofSurfaceTemp - currentIndoorTemp);
    }

    // 4. Windows (solar gain + glass conduction) and Walls (RC thermal mass)
    //
    // Wall thermal mass (RC model — replaces the old 5-step RTS for walls):
    // wallSurfaceTemp tracks the wall inner-surface temperature with an 8 h
    // time constant. During the day it climbs toward the (high) sol-air temp;
    // at night it decays slowly — so at midnight it is still warmer than indoor
    // air, producing a POSITIVE heat flow INTO the room (stored afternoon heat).
    // This matches the physical "flywheel" effect of concrete/brick walls.
    //
    // Rain: evapCoolingWall reduces the effective solair, pulling wallSurfaceTemp
    // down toward wet-bulb. With τ = 8 h the drop is gradual, not instant.
    let tSolairWeightedSum = 0;
    let totalExtWallArea   = 0;

    const walls = zone.walls || [];
    const hourWindowGains: Record<string, number> = {};
    const hourWindowDebug: Record<string, { azimuth: number; cosTheta: number; incidentRadiation: number; solarGain: number }> = {};

    walls.forEach(wDef => {
      if (wDef.wallType === 'internal') {
        if (adjacentZoneTemps && wDef.adjacentZoneId) {
          const adjTemps = adjacentZoneTemps[wDef.adjacentZoneId];
          if (adjTemps) {
            const adjTemp = adjTemps[h0] ?? currentIndoorTemp;
            const totalArea = wDef.lengthM * zone.ceilingHeightM;
            let uEffective: number;
            if (wDef.constructionType === 'full_glass') {
              uEffective = U_GLASS;
            } else if (wDef.constructionType === 'mixed' && wDef.glassAreaM2 != null && wDef.glassAreaM2 > 0) {
              const glassArea  = Math.min(wDef.glassAreaM2, totalArea);
              const opaqueArea = Math.max(0, totalArea - glassArea);
              uEffective = (U_GLASS * glassArea + U_WALL * opaqueArea) / totalArea;
            } else if (wDef.constructionType === 'mixed') {
              uEffective = (U_WALL + U_GLASS) / 2;
            } else {
              uEffective = U_WALL;
            }
            const transferWatts = uEffective * totalArea * (adjTemp - currentIndoorTemp);
            other += transferWatts;
            slotTransfers.push({ wallId: wDef.id, adjacentZoneId: wDef.adjacentZoneId!, watts: transferWatts });
          }
        }
        return;
      }

      const totalWallArea = wDef.lengthM * zone.ceilingHeightM;

      if (wDef.constructionType === 'full_glass') {
        const gammaS = sunAzimuthDeg * Math.PI / 180;
        const gammaW = wDef.azimuth * Math.PI / 180;
        const cosTheta = Math.max(0, Math.cos(alpha) * Math.cos(gammaS - gammaW));
        const diffuseComponent = 0.5 * dhi * (1 + Math.sin(alpha));
        const groundComponent  = 0.5 * GROUND_REFLECTANCE * ghi;
        const iWin = (alpha > 0 ? dni * cosTheta : 0) + diffuseComponent + groundComponent;

        const qSolar = totalWallArea * FRAME_FACTOR * SHGC * iWin;
        const qGlass = U_GLASS * totalWallArea * (outdoorTemp - currentIndoorTemp);
        solar += qSolar;
        glass += qGlass;

        const glassId = `full_glass_${wDef.id}`;
        hourWindowGains[glassId] = qSolar;
        hourWindowDebug[glassId] = { azimuth: wDef.azimuth, cosTheta, incidentRadiation: iWin, solarGain: qSolar };

      } else {
        let totalWindowAreaOnWall = 0;

        if (wDef.constructionType === 'mixed') {
          (wDef.windows || []).forEach(win => {
            const gammaS = sunAzimuthDeg * Math.PI / 180;
            const gammaW = wDef.azimuth * Math.PI / 180;
            const cosTheta = Math.max(0, Math.cos(alpha) * Math.cos(gammaS - gammaW));
            const groundComponent = 0.5 * GROUND_REFLECTANCE * ghi;

            let obstrAngleDeg = 0;
            let svf = 1.0;
            if (win.obstructionHeightM != null && win.obstructionDistanceM != null && win.obstructionDistanceM > 0) {
              obstrAngleDeg = Math.atan2(win.obstructionHeightM, win.obstructionDistanceM) * 180 / Math.PI;
              svf = (1 + Math.cos(obstrAngleDeg * Math.PI / 180)) / 2;
            }

            const obstrAzHalf = (win.obstructionWidthM != null && win.obstructionDistanceM != null && win.obstructionDistanceM > 0)
              ? Math.atan2(win.obstructionWidthM / 2, win.obstructionDistanceM) * 180 / Math.PI
              : 90;

            const sunFacingWall = Math.abs(sunAzimuthDeg - wDef.azimuth) <= 90 || Math.abs(sunAzimuthDeg - wDef.azimuth) >= 270;
            const sunInObstrCone = sunFacingWall && Math.abs(((sunAzimuthDeg - wDef.azimuth) + 360) % 360 - 180) <= obstrAzHalf;

            const directBlocked = obstrAngleDeg > 0 && (alpha * 180 / Math.PI) < obstrAngleDeg && sunInObstrCone;
            const directComponent  = (alpha > 0 && !directBlocked) ? dni * cosTheta : 0;
            const diffuseEffective = 0.5 * dhi * (1 + Math.sin(alpha)) * svf;
            const iWin = directComponent + diffuseEffective + groundComponent;

            const qSolar = win.areaM2 * FRAME_FACTOR * SHGC * iWin;
            const qGlass = U_GLASS * win.areaM2 * (outdoorTemp - currentIndoorTemp);
            solar += qSolar;
            glass += qGlass;
            totalWindowAreaOnWall += win.areaM2;

            const windowId = `win_${win.id}`;
            hourWindowGains[windowId] = qSolar;
            hourWindowDebug[windowId] = { azimuth: wDef.azimuth, cosTheta, incidentRadiation: iWin, solarGain: qSolar };
          });
        }

        // Accumulate opaque wall area and solair for RC model
        const wallNetArea = Math.max(0, totalWallArea - totalWindowAreaOnWall);
        if (wallNetArea > 0) {
          const gammaS_wall = sunAzimuthDeg * Math.PI / 180;
          const gammaW_wall = wDef.azimuth * Math.PI / 180;
          const cosThetaWall  = Math.max(0, Math.cos(alpha) * Math.cos(gammaS_wall - gammaW_wall));
          const diffuseFactor = 0.5 * (1 + Math.sin(alpha));
          const iWall = alpha > 0
            ? (dni * cosThetaWall + diffuseFactor * dhi + 0.5 * GROUND_REFLECTANCE * ghi)
            : 0;
          // Apply evaporative cooling to effective solair when wall surface is wet
          const tSolairWall = outdoorTemp + (ALPHA_WALL * iWall / H_OUT) - evapCoolingWall;

          tSolairWeightedSum += tSolairWall * wallNetArea;
          totalExtWallArea   += wallNetArea;
        }
      }
    });

    // ── RC update: wall surface temperature → wall heat to room ──────────
    if (totalExtWallArea > 0) {
      const tSolairAvg = tSolairWeightedSum / totalExtWallArea;
      wallSurfaceTemp += (tSolairAvg - wallSurfaceTemp) / τ_WALL;
      wall = U_WALL * totalExtWallArea * (wallSurfaceTemp - currentIndoorTemp);
    }

    // ── Window solar: RTS converts radiative fraction to cooling load ─────
    // (ASHRAE Step 2 — unchanged; only glass solar uses RTS, not walls)
    const convectiveSolar = 0.3 * solar;
    const radiantSolar    = 0.7 * solar;
    solarHistory.push(radiantSolar);  // grows to PREWARM_SLOTS + 1440 entries

    let solarDelayed = convectiveSolar;
    for (let i = 0; i < RTS.length; i++) {
      solarDelayed += RTS[i] * (solarHistory[PREWARM_SLOTS + slot - (i + 1) * 60] || 0);
    }

    const currentTotalLoad = solarDelayed + glass + wall + roof + inf + internalEquipment + people + other;

    // ── AC Capacity ───────────────────────────────────────────────────────
    const degradation = Math.max(0, (outdoorTemp - 35) * 0.015);
    const performanceFactor = 1 - degradation;
    const isWorkingHours = h0 >= 8 && h0 <= 20;
    const acActive = isWorkingHours || currentTotalLoad > 500;
    const maxAvailableCapacity = acActive ? (totalRatedCapacity * performanceFactor) : 0;

    const MIN_MEANINGFUL_AC_WATTS = 50;
    const acOutputEst = (realAcOutputsWatts && realAcOutputsWatts[h0] != null && realAcOutputsWatts[h0] >= MIN_MEANINGFUL_AC_WATTS)
      ? realAcOutputsWatts[h0] * avgISEER
      : 0;

    // ── Thermal Simulation ────────────────────────────────────────────────
    let nextTemp: number;
    if (realIndoorTemps && realIndoorTemps[h0] != null) {
      const t0 = realIndoorTemps[h0];
      const t1 = realIndoorTemps[Math.min(h0 + 1, 23)] ?? t0;
      nextTemp = t0 * (1 - frac) + t1 * frac;
    } else {
      const acCoolingThisSlot = acOutputEst > 0
        ? acOutputEst
        : (acActive ? Math.min(currentTotalLoad, maxAvailableCapacity) : 0);

      const qNet   = currentTotalLoad - acCoolingThisSlot;
      const deltaT = (qNet * SLOT_SECONDS) / roomThermalMassJperK;
      nextTemp = currentIndoorTemp + deltaT;

      if (acActive && nextTemp < stepSetPoint - 1) nextTemp = stepSetPoint - 1;
      nextTemp = Math.max(15, Math.min(45, nextTemp));
    }

    currentIndoorTemp = nextTemp;
    totalTempSum += nextTemp;
    if (nextTemp > maxTemp) maxTemp = nextTemp;

    if (currentTotalLoad > peakLoadWatts) {
      peakLoadWatts = currentTotalLoad;
      peakLoadTime = `${h0.toString().padStart(2, '0')}:${(slot % 60).toString().padStart(2, '0')}`;
      peakPerformanceFactor = performanceFactor;
      acOutputAtPeakLoad = acOutputEst;
    }

    data.push({
      time: `${h0.toString().padStart(2, '0')}:${(slot % 60).toString().padStart(2, '0')}`,
      hour: fracHour,
      outdoorTemp,
      solarLoad: solarDelayed,
      glassLoad: glass,
      wallLoad: wall,
      roofLoad: roof,
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
      zoneTransfers: slotTransfers,
      solarAltitude: alpha * 180 / Math.PI,
      solarAzimuth: sunAzimuthDeg,
      dni,
      dhi,
      ghi,
      windowDebug: hourWindowDebug,
      _areaM2: areaM2
    });
  }

  const isSufficient = acOutputAtPeakLoad >= peakLoadWatts;
  const totalDailyAcKwh = data.reduce((sum, d) => sum + d.acOutputWatts / 60 / 1000, 0);

  return {
    data,
    peakLoadWatts,
    peakLoadTime,
    isSufficient,
    averageTemp: totalTempSum / 1440,
    maxTemp,
    acOutputAtPeakLoad,
    totalDailyAcKwh,
  };
};

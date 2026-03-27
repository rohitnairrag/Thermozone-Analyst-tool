import { ZoneParams, ACUnit, SimulationResult, SimulationDataPoint, HourlyWeather, InternalLoadItem, ZoneTransferEntry } from '../types';
import { computeFloorArea } from './geometry';
import { computeTimeRangeInternalLoads } from './internalLoadScheduler';

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
  minuteOccupancy: number[] | null = null,        // 1440-slot camera count array; overrides scheduled people load for slots > 0 only
): SimulationResult => {
  if (!weather || !weather.temperature) {
    throw new Error("Weather data missing from API.");
  }

  // ── Age-based degradation ────────────────────────────────────────────────
  // Split ACs lose ~2% capacity per year due to refrigerant migration, compressor wear
  // and coil fouling. Maximum degradation capped at 30% (i.e. floor at 0.70).
  // Applied to both rated capacity and ISEER (efficiency degrades at the same rate).
  const getAgeFactor = (ageYears: number) => Math.max(0.70, 1 - ageYears * 0.02);

  const totalRatedCapacity = acList.reduce(
    (sum, ac) => sum + ac.ratedCapacityWatts * getAgeFactor(ac.ageYears), 0
  );
  // Weighted-average effective ISEER — used to convert real electrical input → cooling output
  const avgISEER = acList.length > 0
    ? acList.reduce((s, ac) => s + ac.iseer * getAgeFactor(ac.ageYears), 0) / acList.length
    : 3.70;  // BEE 3-star minimum (3.70–3.99); fallback when no AC units configured

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
  const H_OUT_MIN = 10;    // still-air floor (W/m²K)
  const EPSILON_ROOF = 0.9; // long-wave emissivity — most roofing/wall materials
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

  // Simulation State — 1-minute resolution (1440 slots per day)
  // slot 0 = 00:00, slot 1 = 00:01, slot 2 = 00:02, …, slot 1439 = 23:59
  const RTS = [0.35, 0.25, 0.20, 0.12, 0.08];
  const wallHistory: number[] = [];
  const roofHistory: number[] = [];
  const solarHistory: number[] = [];
  const data: SimulationDataPoint[] = [];

  // Starting indoor temperature priority:
  //   1. initialTempC — explicitly supplied (e.g. yesterday's last DB sensor reading)
  //   2. realIndoorTemps[0] — first hour of today's sensor data (Path A anchor)
  //   3. 24.0°C hardcoded fallback (worst case — causes systematic cold-start bias)
  let currentIndoorTemp = initialTempC
    ?? (realIndoorTemps && realIndoorTemps[0] != null ? realIndoorTemps[0] : 24.0);
  let totalTempSum = 0;
  let maxTemp = 0;
  let peakLoadWatts = 0;
  let peakLoadTime = '';
  let peakPerformanceFactor = 1;
  let acOutputAtPeakLoad = 0;   // actual AC output (watts) at the slot where peak load occurs

  // ── Thermal mass ─────────────────────────────────────────────────────────
  // Medium-weight construction (concrete frame, screed floor, block/brick walls) —
  // typical for a Bangalore commercial office building.
  //   Lightweight (plasterboard / raised floor): ~50,000 J/(m²·K)
  //   Medium  (concrete frame, block walls):    ~150,000 J/(m²·K)  ← used here
  //   Heavyweight (exposed concrete / brick):   ~300,000 J/(m²·K)
  // Used in the energy-balance temperature simulation: ΔT = Q_net × Δt / C
  const SLOT_SECONDS = 60;                          // 1-minute slot = 60 s
  const roomThermalMassJperK = areaM2 * 150_000;   // J/K

  for (let slot = 0; slot < 1440; slot++) {
    // Fractional hour: 0, 1/60, 2/60, …, 1439/60 (= 23.983)
    const fracHour = slot / 60;
    const h0 = Math.floor(fracHour);                  // integer hour index into weather arrays
    const h1 = Math.min(h0 + 1, 23);                  // next hour (clamped to 23)
    const frac = fracHour - h0;                        // 0…0.917 — interpolation weight

    // ── Linearly interpolate all weather values between the two bounding hours ──
    const lerp = (a: number, b: number) => a * (1 - frac) + b * frac;
    const outdoorTemp = lerp(weather.temperature[h0],      weather.temperature[h1]);
    const outdoorRH   = lerp(weather.relativeHumidity[h0], weather.relativeHumidity[h1]);
    const dni         = lerp(weather.directRadiation[h0],  weather.directRadiation[h1]);
    const dhi         = lerp(weather.diffuseRadiation[h0], weather.diffuseRadiation[h1]);
    const ghi         = lerp(weather.shortwaveRadiation[h0], weather.shortwaveRadiation[h1]);

    // ── Dynamic outdoor convection coefficient (ASHRAE McAdams formula) ──────
    // H_OUT rises with wind speed: faster wind → walls lose/gain heat more rapidly.
    // During rain/storms wind is typically 5–10 m/s → H_OUT ~25–45 W/m²K vs the
    // old hardcoded 20.  Falls back to H_OUT_MIN (10) when no wind data available.
    const windSpeedMs = weather.windspeed
      ? lerp(weather.windspeed[h0] ?? 3, weather.windspeed[h1] ?? 3)
      : 3;  // 3 m/s default if API didn't return wind data
    const H_OUT = Math.max(H_OUT_MIN, 5.8 + 3.94 * windSpeedMs);

    // ── Solar Geometry (use fractional hour for accurate sun position) ──
    const H = 15 * (fracHour - 12) * Math.PI / 180;
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
    // Long-wave sky correction: clear sky radiates ~63 W/m² away from roof (cooling effect).
    // Under cloud/rain the sky acts as a warm blanket → ΔR → 0.
    // Use GHI fraction of clear-sky maximum as a cloud proxy (0 = fully overcast, 1 = clear).
    const clearSkyFraction = alpha > 0.05
      ? Math.min(1, ghi / Math.max(1, dni * Math.sin(alpha) + dhi))
      : 0;
    const deltaR = 63 * clearSkyFraction;
    const tSolairRoof = outdoorTemp + (ALPHA_ROOF * iRoof / H_OUT) - (EPSILON_ROOF * deltaR / H_OUT);

    // Set-point and working hours use integer hour
    let stepSetPoint = 24;
    if (h0 >= 10 && h0 <= 17) stepSetPoint = 23;

    let solar = 0;
    let glass = 0;
    let wall = 0;
    let roof = 0;
    let inf = 0;
    let internalEquipment = 0;
    let people = 0;
    let other = 0;
    const slotTransfers: ZoneTransferEntry[] = [];

    // 1. Infiltration Load
    const hOut = getEnthalpy(outdoorTemp, outdoorRH);
    const hInDynamic = getEnthalpy(currentIndoorTemp, 50);
    const qInf = massFlowRate * (hOut - hInDynamic) * 1000;
    inf += qInf;

    // 2. Internal Gains — time-range check uses minute-level slot (0–1439)
    if (internalLoadItems && internalLoadItems.length > 0) {
      // ── Inventory / time-range approach ───────────────────────────────────
      const sched = computeTimeRangeInternalLoads(internalLoadItems, slot);
      // Camera overrides people load only when > 0 (filled slots).
      // 0-valued slots (genuine absence or future) fall back to the inventory People item.
      if (minuteOccupancy && minuteOccupancy[slot] > 0) {
        people += minuteOccupancy[slot] * PEOPLE_TOTAL_HEAT;
      } else {
        people += sched.people;
      }
      internalEquipment += sched.lighting + sched.equipment + sched.appliance;
    } else {
      // ── Density-based fallback (generic W/m²) ────────────────────────────
      const nPeople = maxPeople * getOccupancyFactor(h0);
      people            += nPeople * PEOPLE_TOTAL_HEAT;
      internalEquipment += LIGHTING_DENSITY * areaM2 * getLightingFactor(h0);
      internalEquipment += EQUIPMENT_DENSITY * areaM2 * getEquipmentFactor(h0);
    }

    // 3. Roof (Top Floor only)
    if (zone.isTopFloor) {
      const qRoof = U_ROOF * areaM2 * (tSolairRoof - currentIndoorTemp);
      roof += qRoof;
    }

    // 4. Window Solar Gain & Wall Conduction
    const walls = zone.walls || [];
    const hourWindowGains: Record<string, number> = {};
    const hourWindowDebug: Record<string, { azimuth: number; cosTheta: number; incidentRadiation: number; solarGain: number }> = {};

    walls.forEach(wDef => {
      if (wDef.wallType === 'internal') {
        // Heat conduction through shared partition into/from the adjacent zone
        if (adjacentZoneTemps && wDef.adjacentZoneId) {
          const adjTemps = adjacentZoneTemps[wDef.adjacentZoneId];
          if (adjTemps) {
            const adjTemp = adjTemps[h0] ?? currentIndoorTemp;
            const totalArea = wDef.lengthM * zone.ceilingHeightM;
            // Weighted U-value: split wall into glass and opaque portions using measured glassAreaM2
            let uEffective: number;
            if (wDef.constructionType === 'full_glass') {
              uEffective = U_GLASS;
            } else if (wDef.constructionType === 'mixed' && wDef.glassAreaM2 != null && wDef.glassAreaM2 > 0) {
              const glassArea  = Math.min(wDef.glassAreaM2, totalArea);
              const opaqueArea = Math.max(0, totalArea - glassArea);
              uEffective = (U_GLASS * glassArea + U_WALL * opaqueArea) / totalArea;
            } else if (wDef.constructionType === 'mixed') {
              uEffective = (U_WALL + U_GLASS) / 2;  // fallback: no glassAreaM2 provided
            } else {
              uEffective = U_WALL;
            }
            // Positive → heat flowing into this zone (adjacent is hotter); negative → heat leaving
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
        const groundComponent = 0.5 * GROUND_REFLECTANCE * ghi;
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

            // Obstruction: block direct solar + reduce diffuse via Sky View Factor
            let obstrAngleDeg = 0;
            let svf = 1.0;
            if (win.obstructionHeightM != null && win.obstructionDistanceM != null && win.obstructionDistanceM > 0) {
              obstrAngleDeg = Math.atan2(win.obstructionHeightM, win.obstructionDistanceM) * 180 / Math.PI;
              svf = (1 + Math.cos(obstrAngleDeg * Math.PI / 180)) / 2;
            }

            // If obstruction width given, compute azimuth half-angle; default to full 180° frontal blocking
            const obstrAzHalf = (win.obstructionWidthM != null && win.obstructionDistanceM != null && win.obstructionDistanceM > 0)
              ? Math.atan2(win.obstructionWidthM / 2, win.obstructionDistanceM) * 180 / Math.PI
              : 90; // full frontal coverage if width not given

            const sunFacingWall = Math.abs(sunAzimuthDeg - wDef.azimuth) <= 90 || Math.abs(sunAzimuthDeg - wDef.azimuth) >= 270;
            const sunInObstrCone = sunFacingWall && Math.abs(((sunAzimuthDeg - wDef.azimuth) + 360) % 360 - 180) <= obstrAzHalf;

            const directBlocked = obstrAngleDeg > 0 && (alpha * 180 / Math.PI) < obstrAngleDeg && sunInObstrCone;
            const directComponent = (alpha > 0 && !directBlocked) ? dni * cosTheta : 0;
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

        const wallNetArea = Math.max(0, totalWallArea - totalWindowAreaOnWall);
        const gammaS_wall = sunAzimuthDeg * Math.PI / 180;
        const gammaW_wall = wDef.azimuth * Math.PI / 180;
        const cosThetaWall = Math.max(0, Math.cos(alpha) * Math.cos(gammaS_wall - gammaW_wall));
        const diffuseFactor = 0.5 * (1 + Math.sin(alpha));
        const iWall = alpha > 0 ? (dni * cosThetaWall + diffuseFactor * dhi + 0.5 * GROUND_REFLECTANCE * ghi) : 0;

        const tSolair = outdoorTemp + (ALPHA_WALL * iWall / H_OUT);
        const qWall = THERMAL_MASS_FACTOR * U_WALL * wallNetArea * (tSolair - currentIndoorTemp);
        wall += qWall;
      }
    });

    // ── RTS — radiant delays in 1-hour steps (= 60 slots at 1-min resolution) ─
    const convectiveSolar = 0.3 * solar;
    const radiantSolar = 0.7 * solar;
    solarHistory.push(radiantSolar);
    wallHistory.push(wall);
    roofHistory.push(roof);

    let solarDelayed = convectiveSolar;
    let wallDelayed = 0;
    let roofDelayed = 0;
    for (let i = 0; i < RTS.length; i++) {
      // Each delay step is 60 slots (= 1 hour) to preserve the hourly RTS physics
      solarDelayed += RTS[i] * (solarHistory[slot - (i + 1) * 60] || 0);
      wallDelayed  += RTS[i] * (wallHistory[slot - i * 60]          || 0);
      roofDelayed  += RTS[i] * (roofHistory[slot - i * 60]          || 0);
    }

    const currentTotalLoad = solarDelayed + glass + wallDelayed + roofDelayed + inf + internalEquipment + people + other;

    // ── AC Capacity ──────────────────────────────────────────────────────────
    const degradation = Math.max(0, (outdoorTemp - 35) * 0.015);
    const performanceFactor = 1 - degradation;
    const isWorkingHours = h0 >= 8 && h0 <= 20;
    const acActive = isWorkingHours || currentTotalLoad > 500;
    const maxAvailableCapacity = acActive ? (totalRatedCapacity * performanceFactor) : 0;

    // ── AC output (display / verdict) ────────────────────────────────────────
    // Uses real sensor data only: electrical watts from DB × avgISEER = cooling watts.
    // If no real data for this hour the AC is considered OFF for reporting → 0.
    // Uses real sensor data only: electrical watts from DB × avgISEER = cooling watts.
    // If no real data for this hour the AC is considered OFF for reporting → 0.
    const acOutputEst = (realAcOutputsWatts && realAcOutputsWatts[h0] != null && realAcOutputsWatts[h0] > 0)
      ? realAcOutputsWatts[h0] * avgISEER
      : 0;

    // ── Thermal Simulation (energy balance + thermal mass) ───────────────────
    // ΔT = Q_net × Δt / C
    //   Q_net       = heat flowing INTO the room this slot (watts)
    //                 = total heat gain − AC cooling removed
    //   Δt          = SLOT_SECONDS (60 s for 1-min slot)
    //   C           = roomThermalMassJperK (J/K) — concrete construction
    //
    // For the AC cooling term we use:
    //   • Real sensor data (acOutputEst) when available — most accurate.
    //   • Estimated from capacity when no real data: AC removes up to
    //     maxAvailableCapacity, limited by how much load exists.
    //     This avoids runaway heating in the simulated (no-data) path.
    //
    // Real DB data arrays are 24-element (hourly); use h0 as index for both
    // the :00 and :30 slot within that hour.
    let nextTemp: number;
    if (realIndoorTemps && realIndoorTemps[h0] != null) {
      // ── Path A: sensor data available — interpolate between hourly readings ──
      const t0 = realIndoorTemps[h0];
      const t1 = realIndoorTemps[Math.min(h0 + 1, 23)] ?? t0;
      nextTemp = t0 * (1 - frac) + t1 * frac;
    } else {
      // ── Path B: no sensor data — physics simulation ───────────────────────
      // Cooling removed this slot: prefer real AC output, else capacity estimate.
      const acCoolingThisSlot = acOutputEst > 0
        ? acOutputEst                                             // real watts × ISEER
        : (acActive ? Math.min(currentTotalLoad, maxAvailableCapacity) : 0); // estimated

      const qNet   = currentTotalLoad - acCoolingThisSlot;       // net watts into room
      const deltaT = (qNet * SLOT_SECONDS) / roomThermalMassJperK; // °C change this slot
      nextTemp = currentIndoorTemp + deltaT;

      // Thermostat guard: AC cannot cool below setpoint−1°C (compressor cycles off)
      if (acActive && nextTemp < stepSetPoint - 1) nextTemp = stepSetPoint - 1;
      // Physical bounds: dew point floor ~15°C; extreme heat ceiling ~45°C
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

  // Verdict: real AC output at the peak load slot vs the peak load (real data only).
  const isSufficient = acOutputAtPeakLoad >= peakLoadWatts;

  // Total daily AC cooling energy: sum of 1-min slot outputs × (1/60) h ÷ 1000 → kWh
  const totalDailyAcKwh = data.reduce((sum, d) => sum + d.acOutputWatts / 60 / 1000, 0);

  return {
    data,
    peakLoadWatts,
    peakLoadTime,
    isSufficient,
    averageTemp: totalTempSum / 1440,  // 1440 slots per day
    maxTemp,
    acOutputAtPeakLoad,
    totalDailyAcKwh,
  };
};

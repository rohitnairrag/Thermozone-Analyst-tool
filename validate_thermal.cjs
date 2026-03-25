/**
 * ThermoZone Analyst — Thermal Validation Script (Option A)
 *
 * Logic:
 *   During AC-OFF morning window, Q_out = 0.
 *   T_next = T_current + (Q_in × dt) / C_eff
 *   C_eff = areaM2 × 150,000 J/K  (matches physics engine — heavy construction)
 *
 * Compares predicted temperature rise with actual sensor data.
 * Run:  node validate_thermal.cjs
 */

'use strict';

const { Pool } = require('pg');
require('dotenv').config();

// ── DB Connection ─────────────────────────────────────────────────────────────
const db = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     Number(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE || 'cmp_lt_bangalore_live_data',
  user:     process.env.PG_USER     || 'postgres',
  password: process.env.PG_PASSWORD || '',
});

// ── Zone 1 Config (Main Working Area) ─────────────────────────────────────────
const ZONE1_WALLS = [
  { id: 'w1',  lengthM: 10.06, azimuth: 135, wallType: 'external', glassAreaM2: 13.48 },
  { id: 'w2',  lengthM: 7.01,  azimuth: 225, wallType: 'external', glassAreaM2: 9.3934 },
  { id: 'w3',  lengthM: 2.62,  azimuth: 315, wallType: 'internal' },
  { id: 'w4',  lengthM: 3.04,  azimuth: 225, wallType: 'internal' },
  { id: 'w5',  lengthM: 5.42,  azimuth: 225, wallType: 'internal' },
  { id: 'w6',  lengthM: 4.85,  azimuth: 315, wallType: 'external', glassAreaM2: 11.2  },
  { id: 'w7',  lengthM: 5.59,  azimuth: 45,  wallType: 'internal' },
  { id: 'w8',  lengthM: 3.70,  azimuth: 45,  wallType: 'internal' },
  { id: 'w9',  lengthM: 1.92,  azimuth: 45,  wallType: 'internal' },
  { id: 'w10', lengthM: 4.26,  azimuth: 45,  wallType: 'external', glassAreaM2: 5.7   },
  { id: 'w11', lengthM: 1.70,  azimuth: 315, wallType: 'internal' },
  { id: 'w12', lengthM: 2.69,  azimuth: 315, wallType: 'internal' },
  { id: 'w13', lengthM: 1.80,  azimuth: 135, wallType: 'internal' },
];
const CEILING_H     = 3.0;      // m
// DB uses site_group_name, Zone 1 maps to these groups
const DB_ZONES      = ['Working Area 1', 'Working Area 2', 'Embedded Team'];
const LAT           = 12.9716;  // Bangalore
const LON           = 77.5946;

// ── Physics Constants ─────────────────────────────────────────────────────────
const U_WALL          = 0.5;    // W/m²K — 150mm brick + plaster
const U_GLASS         = 5.7;    // W/m²K — single pane
const ALPHA_WALL      = 0.9;    // surface absorptance (dark concrete)
const H_OUT           = 17.0;   // W/m²K — external surface coeff (ASHRAE)
const ACH             = 0.5;    // air changes/hour (ASHRAE 62.1)
const RHO_AIR         = 1.2;    // kg/m³
const CP_AIR          = 1005;   // J/kg·K
const THERMAL_MASS_K  = 150000; // J/K per m² floor (physics engine constant)
const DT_SECONDS      = 1800;   // 30-min timestep

// ── Internal loads baseline (always-on appliances) ────────────────────────────
// Fridge: 200W always on. Lights/equipment = 0 before 8am.
const Q_INTERNAL_BASELINE = 200; // W — fridge only

// ── Geometry helpers ──────────────────────────────────────────────────────────
function computeFloorArea(walls) {
  let x = 0, y = 0;
  const coords = [{ x, y }];
  for (const w of walls) {
    const az = w.azimuth * Math.PI / 180;
    x += w.lengthM * Math.sin(az);
    y += w.lengthM * Math.cos(az);
    coords.push({ x, y });
  }
  let area = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    area += coords[i].x * coords[i+1].y - coords[i+1].x * coords[i].y;
  }
  return Math.max(1, Math.abs(area) / 2);
}

// ── Solar geometry (for computing irradiance on each wall face) ───────────────
function solarAltitudeAndAzimuth(lat, lon, dateObj) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const doy = Math.floor((dateObj - new Date(dateObj.getFullYear(), 0, 0)) / 86400000);
  const B   = (2 * Math.PI / 365) * (doy - 1);
  const decl = toRad(23.45 * Math.sin(toRad(360/365 * (doy - 81))));
  const eot  = 9.87*Math.sin(2*B) - 7.53*Math.cos(B) - 1.5*Math.sin(B); // minutes
  const lstHour = dateObj.getUTCHours() + dateObj.getUTCMinutes()/60 + lon/15;
  const ha  = toRad((lstHour - 12 + eot/60) * 15);
  const latR = toRad(lat);
  const sinAlt = Math.sin(latR)*Math.sin(decl) + Math.cos(latR)*Math.cos(decl)*Math.cos(ha);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const cosAz = (Math.sin(decl) - Math.sin(latR)*Math.sin(alt)) / (Math.cos(latR)*Math.cos(alt));
  const az = ha > 0
    ? 2*Math.PI - Math.acos(Math.max(-1,Math.min(1,cosAz)))
    : Math.acos(Math.max(-1,Math.min(1,cosAz)));
  return { altitudeDeg: toDeg(alt), azimuthDeg: toDeg(az) };
}

function incidentOnWall(altitudeDeg, solarAzDeg, wallAzimuthDeg, dni, dhi) {
  const toRad = d => d * Math.PI / 180;
  const alt = toRad(altitudeDeg);
  const cosTh = Math.cos(alt) * Math.cos(toRad(solarAzDeg - wallAzimuthDeg));
  const iDirect = Math.max(0, cosTh) * dni;
  const iDiffuse = dhi * (1 + Math.sin(alt)) / 2;
  return iDirect + iDiffuse;
}

// ── Open-Meteo weather fetch ──────────────────────────────────────────────────
async function fetchWeather(date) {
  const isToday = date === new Date().toISOString().slice(0,10);
  let url;
  if (isToday) {
    url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
      `&hourly=temperature_2m,relative_humidity_2m,direct_radiation,diffuse_radiation,shortwave_radiation` +
      `&timezone=Asia/Kolkata&forecast_days=1`;
  } else {
    url = `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT}&longitude=${LON}` +
      `&hourly=temperature_2m,relative_humidity_2m,direct_radiation,diffuse_radiation,shortwave_radiation` +
      `&timezone=Asia/Kolkata&start_date=${date}&end_date=${date}`;
  }
  const res = await fetch(url);
  const json = await res.json();
  const h = json.hourly;
  return h.time.map((t, i) => ({
    time:    t,
    tempC:   h.temperature_2m[i],
    rh:      h.relative_humidity_2m[i],
    dni:     h.direct_radiation[i]   ?? 0,
    dhi:     h.diffuse_radiation[i]  ?? 0,
    ghi:     h.shortwave_radiation[i] ?? 0,
  }));
}

// ── DB: Get 30-min granular data for Zone 1 ───────────────────────────────────
async function fetchSensorData30min(date) {
  // device_timestamp is stored as UTC — shift +05:30 to get IST
  const result = await db.query(`
    SELECT
      EXTRACT(HOUR   FROM ((device_timestamp::TIMESTAMP) + INTERVAL '5 hours 30 minutes')) AS hour,
      EXTRACT(MINUTE FROM ((device_timestamp::TIMESTAMP) + INTERVAL '5 hours 30 minutes')) AS minute,
      asset_name AS device_id,
      room_temp::FLOAT AS temperature,
      ac_power_status,
      COALESCE(r_phase_power::FLOAT,0) + COALESCE(y_phase_power::FLOAT,0) + COALESCE(b_phase_power::FLOAT,0) AS total_watts
    FROM public.lt_bangalore_org_live_device_data
    WHERE site_group_name = ANY($1::text[])
      AND DATE((device_timestamp::TIMESTAMP) + INTERVAL '5 hours 30 minutes') = $2::DATE
      AND EXTRACT(HOUR FROM ((device_timestamp::TIMESTAMP) + INTERVAL '5 hours 30 minutes')) >= 5
      AND EXTRACT(HOUR FROM ((device_timestamp::TIMESTAMP) + INTERVAL '5 hours 30 minutes')) < 11
    ORDER BY device_timestamp
  `, [DB_ZONES, date]);
  return result.rows;
}

// ── Aggregate into 30-min slots ───────────────────────────────────────────────
function aggregate30min(rows) {
  // Key: "HH:MM" where MM is 00 or 30
  const slots = {};
  for (const r of rows) {
    const h   = parseInt(r.hour);
    const m   = parseInt(r.minute);
    const key = `${String(h).padStart(2,'0')}:${m < 30 ? '00' : '30'}`;
    if (!slots[key]) slots[key] = { deskTemps:[], acWatts:[], acOn: false };
    const name = (r.device_id || '').toLowerCase();
    const isAcSensor = name.includes('ac');
    if (!isAcSensor) slots[key].deskTemps.push(r.temperature);
    if (r.ac_power_status === true || r.ac_power_status === 'true') slots[key].acOn = true;
    if (r.total_watts > 0) slots[key].acWatts.push(r.total_watts);
  }
  const result = [];
  for (const [time, s] of Object.entries(slots).sort()) {
    const avgDesk = s.deskTemps.length > 0
      ? s.deskTemps.reduce((a,b)=>a+b,0) / s.deskTemps.length
      : null;
    result.push({ time, avgDeskTemp: avgDesk, acOn: s.acOn });
  }
  return result;
}

// ── Q_total simplified for morning (low solar, key drivers: wall + glass + inf) ──
function computeQin(outdoorTemp, indoorTemp, solarData, wallDefs, areaM2, volumeM3, dateObj) {
  const { altitudeDeg, azimuthDeg } = solarAltitudeAndAzimuth(LAT, LON, dateObj);
  const dni = solarData.dni;
  const dhi = solarData.dhi;
  let qWall  = 0;
  let qGlass = 0;
  let qSolar = 0;

  for (const wall of wallDefs) {
    if (wall.wallType !== 'external') continue;
    const wallArea   = wall.lengthM * CEILING_H;
    const glassArea  = wall.glassAreaM2 ?? 0;
    const opaqueArea = Math.max(0, wallArea - glassArea);
    const iWall = incidentOnWall(altitudeDeg, azimuthDeg, wall.azimuth, dni, dhi);
    const tSolAir = outdoorTemp + (ALPHA_WALL * iWall) / H_OUT;
    qWall  += U_WALL * opaqueArea * (tSolAir - indoorTemp);
    qGlass += U_GLASS * glassArea * (outdoorTemp - indoorTemp);
    // Solar through windows (SHGC default 0.6 for mixed/tinted glass)
    qSolar += glassArea * 0.85 * 0.6 * iWall;
  }

  // Infiltration — sensible only (humidity low in early morning)
  const massFlow = ACH * volumeM3 / 3600 * RHO_AIR; // kg/s
  const qInf = massFlow * CP_AIR * (outdoorTemp - indoorTemp);

  const qTotal = qWall + qGlass + qSolar + qInf + Q_INTERNAL_BASELINE;
  return { qTotal, qWall, qGlass, qSolar, qInf };
}

// ── Main Validation ───────────────────────────────────────────────────────────
async function runValidation() {
  const today = new Date().toISOString().slice(0,10);
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  ThermoZone Analyst — Thermal Validation (Option A)`);
  console.log(`  Zone: Main Working Area (Zone 1)   Date: ${today}`);
  console.log(`${'═'.repeat(65)}\n`);

  // 1. Compute geometry
  const areaM2   = computeFloorArea(ZONE1_WALLS);
  const volumeM3 = areaM2 * CEILING_H;
  const C_eff    = areaM2 * THERMAL_MASS_K; // J/K
  console.log(`  Floor area : ${areaM2.toFixed(1)} m²`);
  console.log(`  Volume     : ${volumeM3.toFixed(1)} m³`);
  console.log(`  C_eff      : ${(C_eff/1000).toFixed(0)} kJ/K  (areaM2 × 150,000 J/K·m²)`);
  console.log(`  Air mass   : ${(RHO_AIR*volumeM3).toFixed(0)} kg  (for reference — NOT used)`);
  console.log(`  Mass ratio : ${(C_eff/(RHO_AIR*volumeM3*CP_AIR)).toFixed(1)}×  (C_eff vs air-only)\n`);

  // 2. Fetch weather
  console.log('  Fetching weather from Open-Meteo...');
  const weather = await fetchWeather(today);
  console.log(`  ✓ ${weather.length} hourly slots received\n`);

  // 3. Fetch sensor data
  console.log('  Fetching sensor data from DB (5:00–11:00 AM)...');
  const rows  = await fetchSensorData30min(today);
  const slots = aggregate30min(rows);
  console.log(`  ✓ ${rows.length} raw rows → ${slots.length} 30-min slots\n`);

  if (slots.length === 0) {
    console.log('  ✗ No sensor data found for today in the morning window.');
    await db.end(); return;
  }

  // 4. Find AC-OFF window
  const acOffSlots = slots.filter(s => !s.acOn && s.avgDeskTemp !== null);
  console.log(`  AC-OFF slots found: ${acOffSlots.length} of ${slots.length} total`);
  if (acOffSlots.length < 2) {
    console.log('  ✗ Not enough AC-OFF slots for validation (need at least 2 consecutive).');
    console.log('    (AC may already be ON from early morning, or no data available.)');
    // Fall back: use ALL slots with AC-off flag false, even if just 1 transition
    console.log('\n  Falling back: using all available slots regardless of AC status.\n');
  }

  const validSlots = acOffSlots.length >= 2 ? acOffSlots : slots.filter(s => s.avgDeskTemp !== null);
  if (validSlots.length < 2) {
    console.log('  ✗ Insufficient data. Cannot run validation.'); await db.end(); return;
  }

  // 5. Run energy balance
  console.log(`\n  ${'─'.repeat(63)}`);
  console.log(`  Time   │ T_actual │ T_predict │ Error  │ Q_in  │ Components`);
  console.log(`  ${'─'.repeat(63)}`);

  let T_pred = validSlots[0].avgDeskTemp; // seed with actual sensor reading
  const errors  = [];
  const results = [];

  for (let i = 0; i < validSlots.length; i++) {
    const slot    = validSlots[i];
    const T_actual = slot.avgDeskTemp;
    // Get matching weather hour
    const slotHour = parseInt(slot.time.split(':')[0]);
    const wRow     = weather.find(w => {
      const wHour = new Date(w.time).getHours();
      return wHour === slotHour;
    }) || weather[slotHour] || weather[6];

    const dateObj = new Date(`${today}T${slot.time}:00+05:30`);
    const { qTotal, qWall, qGlass, qSolar, qInf } = computeQin(
      wRow.tempC, T_pred, wRow, ZONE1_WALLS, areaM2, volumeM3, dateObj
    );

    // Store before stepping
    const error = i === 0 ? 0 : T_pred - T_actual;
    errors.push(error);
    results.push({ time: slot.time, T_actual, T_pred, error, qTotal, qWall, qGlass, qSolar, qInf, outdoor: wRow.tempC, acOn: slot.acOn });

    const sign  = error >= 0 ? '+' : '';
    const acFlag = slot.acOn ? ' [AC ON]' : '';
    console.log(
      `  ${slot.time}  │  ${T_actual.toFixed(2)}°C  │  ${T_pred.toFixed(2)}°C   │ ${sign}${error.toFixed(2)}°C │${Math.round(qTotal).toString().padStart(6)}W │` +
      ` Wall:${Math.round(qWall)}W Glass:${Math.round(qGlass)}W Sol:${Math.round(qSolar)}W Inf:${Math.round(qInf)}W${acFlag}`
    );

    // Step temperature for NEXT slot
    if (i < validSlots.length - 1) {
      T_pred = T_pred + (qTotal * DT_SECONDS) / C_eff;
    }
  }

  // 6. Error metrics (skip seed point)
  const errVals   = errors.slice(1);
  const mae       = errVals.reduce((s,e)=>s+Math.abs(e),0) / errVals.length;
  const rmse      = Math.sqrt(errVals.reduce((s,e)=>s+e*e,0) / errVals.length);
  const maxErr    = Math.max(...errVals.map(Math.abs));
  const bias      = errVals.reduce((s,e)=>s+e,0) / errVals.length;
  const totalRise = (validSlots[validSlots.length-1].avgDeskTemp - validSlots[0].avgDeskTemp).toFixed(2);
  const predRise  = (results[results.length-1].T_pred - results[0].T_pred).toFixed(2);

  console.log(`  ${'─'.repeat(63)}`);
  console.log(`\n  📊  VALIDATION RESULTS`);
  console.log(`  ${'─'.repeat(63)}`);
  console.log(`  Slots validated         : ${errVals.length}`);
  console.log(`  Actual temp rise        : ${totalRise}°C  (${validSlots[0].time} → ${validSlots[validSlots.length-1].time})`);
  console.log(`  Predicted temp rise     : ${predRise}°C`);
  console.log(`  MAE  (mean abs error)   : ${mae.toFixed(3)}°C`);
  console.log(`  RMSE                    : ${rmse.toFixed(3)}°C`);
  console.log(`  Max error               : ${maxErr.toFixed(3)}°C`);
  console.log(`  Bias (+ = over-predict) : ${bias.toFixed(3)}°C`);

  // 7. Interpretation
  console.log(`\n  🔍  INTERPRETATION`);
  console.log(`  ${'─'.repeat(63)}`);
  if (rmse < 0.5) {
    console.log(`  ✅ EXCELLENT — RMSE < 0.5°C. Physics model closely matches sensor data.`);
    console.log(`     Heat gain equation is well-calibrated for this zone.`);
  } else if (rmse < 1.0) {
    console.log(`  ✅ GOOD — RMSE < 1.0°C. Model is reasonably accurate.`);
    console.log(`     Small deviations likely from occupant behaviour or door openings.`);
  } else if (rmse < 2.0) {
    console.log(`  ⚠️  MODERATE — RMSE ${rmse.toFixed(2)}°C. Model captures trend but drifts.`);
    console.log(`     Possible causes: thermal mass constant (k=150k J/K·m²) too high or low,`);
    console.log(`     or SHGC/U-values don't match actual glazing.`);
  } else {
    console.log(`  ❌ POOR — RMSE ${rmse.toFixed(2)}°C. Significant model-sensor mismatch.`);
    console.log(`     Review: (1) Is AC truly OFF in this window? (2) Are wall U-values correct?`);
    console.log(`     (3) SHGC may be wrong — east/south morning solar can be high.`);
  }

  if (Math.abs(bias) > 0.5) {
    const dir = bias > 0 ? 'over-predicting' : 'under-predicting';
    console.log(`\n  ⚠️  Systematic bias: model is ${dir} by ${Math.abs(bias).toFixed(2)}°C.`);
    if (bias > 0) {
      console.log(`     → Consider reducing SHGC or thermal mass constant k.`);
      console.log(`     → Or AC may be running at low capacity even when "OFF" by status.`);
    } else {
      console.log(`     → Consider increasing SHGC or reducing k (less thermal mass).`);
      console.log(`     → Or additional unaccounted heat source (equipment, people early).`);
    }
  }

  console.log(`\n  📐  MODEL PARAMETERS USED`);
  console.log(`  ${'─'.repeat(63)}`);
  console.log(`  C_eff = ${(C_eff/1000).toFixed(0)} kJ/K  (${areaM2.toFixed(1)} m² × 150 kJ/K·m²)`);
  console.log(`  U_wall (opaque)  = 0.5 W/m²K  [150mm brick, ASHRAE]`);
  console.log(`  U_glass          = 5.7 W/m²K  [single pane, ASHRAE]`);
  console.log(`  SHGC             = 0.60        [tinted/mixed glass estimate]`);
  console.log(`  ACH infiltration = 0.5 /hr     [ASHRAE 62.1 commercial]`);
  console.log(`  Sol-air method   = Yes          [ASHRAE α=0.9, h_out=17 W/m²K]`);
  console.log(`  Internal loads   = 200W baseline [fridge only, pre-8am]`);
  console.log(`  Timestep         = 1800s (30 min)`);
  console.log();

  await db.end();
}

runValidation().catch(e => {
  console.error('Validation failed:', e.message);
  db.end();
  process.exit(1);
});

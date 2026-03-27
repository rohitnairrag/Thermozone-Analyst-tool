/**
 * ThermoZone Analyst — Live Sensor API
 *
 * Run alongside the Vite dev server:
 *   node server.cjs
 */

// ─── MUST be first: load .env before anything else ──────────────────────────
const path = require('path');
const fs   = require('fs');
const dotenv = require('dotenv');
const envResult = dotenv.config({ path: path.resolve(process.cwd(), '.env') });
if (envResult.error) {
  dotenv.config({ path: path.resolve(__dirname, '.env') });
}

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app  = express();
const PORT = 3001;

// ─── Zone Mapping ─────────────────────────────────────────────────────────────
// Maps app zone names → one or more DB site_group_name values.
// Add more zones here once confirmed with manager.
const ZONE_MAP = {
  'Zone 1': ['Working Area 1', 'Working Area 2', 'Embedded Team'],
  'Zone 2': ['Pantry 1'],
  'Zone 3': ['Meeting Room 1'],
  // 'Zone 4': ['...', '...'],   ← add more as needed
};

/**
 * Resolves an appZone name to its DB site_group_name list.
 * Falls back to treating the value as a raw DB zone name if not in ZONE_MAP.
 */
function resolveDbZones(appZone) {
  return ZONE_MAP[appZone] || [appZone];
}

// ─── Postgres Connection (uses .env values) ──────────────────────────────────
const db = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     Number(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE || 'cmp_lt_bangalore_live_data',
  user:     process.env.PG_USER     || 'postgres',
  password: process.env.PG_PASSWORD || '',
  ssl:      process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

console.log(`[.env] Loaded from: ${path.resolve(process.cwd(), '.env')}`);
console.log(`[DB] Connecting to ${process.env.PG_HOST}:${process.env.PG_PORT} as user "${process.env.PG_USER}" on database "${process.env.PG_DATABASE}"`);
if (!process.env.PG_HOST || process.env.PG_HOST === 'localhost') {
  console.warn('[WARN] PG_HOST is still localhost — .env may not have loaded correctly.');
  console.warn('[WARN] Make sure you run "npm run server" from the project folder containing .env');
}

app.use(cors());
app.use(express.json());

// ─── GET /api/live-temp ──────────────────────────────────────────────────────
// Accepts ?zone=  (app zone name like "Zone 1" OR a raw DB site_group_name)
app.get('/api/live-temp', async (req, res) => {
  try {
    const appZone  = req.query.zone || 'Zone 1';
    const dbZones  = resolveDbZones(appZone);

    // Apply sensor zone overrides for today's date
    const todayISTForOverride = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const overrides = resolveOverridesForDate(readSensorOverrides(), todayISTForOverride);
    const excludeAssets = Object.entries(overrides)
      .filter(([, toZone]) => toZone !== appZone)
      .map(([asset]) => asset);
    const includeAssets = Object.entries(overrides)
      .filter(([, toZone]) => toZone === appZone)
      .map(([asset]) => asset);

    // device_timestamp is stored as UTC — add +05:30 to display correct IST time
    const result = await db.query(`
      SELECT DISTINCT ON (asset_name)
        asset_name,
        site_group_name,
        room_temp::FLOAT          AS room_temp,
        ac_setpoint::FLOAT        AS ac_setpoint,
        ac_mode,
        ac_power_status,
        ac_fanspeed,
        ((device_timestamp::TIMESTAMP) + INTERVAL '5 hours 30 minutes') AS device_timestamp_ist,
        device_status,
        synced_at,
        r_phase_power::FLOAT      AS r_phase_power,
        y_phase_power::FLOAT      AS y_phase_power,
        b_phase_power::FLOAT      AS b_phase_power,
        power::FLOAT              AS power
      FROM public.lt_bangalore_org_live_device_data
      WHERE (
        (site_group_name = ANY($1::text[]) AND asset_name != ALL($2::text[]))
        OR asset_name = ANY($3::text[])
      )
        AND room_temp IS NOT NULL
        AND room_temp::TEXT != 'NaN'
      ORDER BY asset_name, synced_at DESC
    `, [dbZones, excludeAssets, includeAssets]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No sensor data found for zone', zone: appZone, dbZones });
    }

    const sensors = result.rows;
    const temps   = sensors.map(r => r.room_temp).filter(t => !isNaN(t));
    const avgTemp = temps.reduce((a, b) => a + b, 0) / temps.length;

    return res.json({
      avgTemp:     Math.round(avgTemp * 100) / 100,
      sensorCount: sensors.length,
      zone:        appZone,
      dbZones,
      lastUpdated: new Date().toISOString(),
      sensors:     sensors.map(s => {
        const isOn = s.ac_power_status?.toUpperCase() === 'ON';
        const rPhasePower = s.r_phase_power ?? 0;
        const yPhasePower = s.y_phase_power ?? 0;
        const bPhasePower = s.b_phase_power ?? 0;
        const totalPhase  = rPhasePower + yPhasePower + bPhasePower;
        const liveAcOutput = isOn ? (totalPhase > 0 ? totalPhase : (s.power ?? 0)) : 0;

        // Staleness check: if device_timestamp is >2 hours old the sensor
        // has stopped reporting. Flag it so the UI can warn the user.
        // device_timestamp_ist is already shifted to IST (+05:30) but stored
        // without timezone, so we compare against current UTC time adjusted.
        const deviceTsUtc = s.device_timestamp_ist
          ? new Date(s.device_timestamp_ist).getTime() - (5.5 * 60 * 60 * 1000)
          : null;
        const ageMinutes = deviceTsUtc != null
          ? Math.round((Date.now() - deviceTsUtc) / 60000)
          : null;
        const isStale = ageMinutes != null && ageMinutes > 120; // >2 hours old

        return {
          name:            s.asset_name,
          dbZone:          s.site_group_name,
          temp:            s.room_temp,
          setpoint:        s.ac_setpoint,
          mode:            s.ac_mode,
          powerStatus:     s.ac_power_status,
          fanSpeed:        s.ac_fanspeed,
          deviceTimestamp: s.device_timestamp_ist, // already shifted to IST (+05:30)
          status:          s.device_status,
          rPhasePower,
          yPhasePower,
          bPhasePower,
          power:           s.power ?? 0,
          liveAcOutput,
          ageMinutes,      // how old the reading is in minutes
          isStale,         // true if >2 hours since device last reported
        };
      }),
    });
  } catch (err) {
    console.error('[live-temp] DB error:', err.message);
    return res.status(500).json({ error: 'Database query failed', detail: err.message });
  }
});

// ─── GET /api/live-all ────────────────────────────────────────────────────────
// Returns ALL sensors across every zone, with effective zone assignment
// (respects sensorZoneOverrides from zones_config.json).
// Used by the sensor reassignment UI to show where each sensor is and let the
// user drag it to a different zone.
app.get('/api/live-all', async (req, res) => {
  try {
    const allDbZones = Object.values(ZONE_MAP).flat();
    const todayISTStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const overrides = resolveOverridesForDate(readSensorOverrides(), todayISTStr); // assetName → appZoneName (for today)

    const result = await db.query(`
      SELECT DISTINCT ON (asset_name)
        asset_name,
        site_group_name,
        room_temp::FLOAT          AS room_temp,
        ac_setpoint::FLOAT        AS ac_setpoint,
        ac_mode,
        ac_power_status,
        ac_fanspeed,
        ((device_timestamp::TIMESTAMP) + INTERVAL '5 hours 30 minutes') AS device_timestamp_ist,
        device_status,
        synced_at
      FROM public.lt_bangalore_org_live_device_data
      WHERE site_group_name = ANY($1::text[])
        AND room_temp IS NOT NULL
        AND room_temp::TEXT != 'NaN'
      ORDER BY asset_name, synced_at DESC
    `, [allDbZones]);

    // Build reverse lookup: DB site_group_name → app zone name
    const dbZoneToAppZone = {};
    for (const [appZone, dbZones] of Object.entries(ZONE_MAP)) {
      for (const dz of dbZones) {
        dbZoneToAppZone[dz] = appZone;
      }
    }

    const sensors = result.rows.map(s => {
      const naturalZone = dbZoneToAppZone[s.site_group_name] || s.site_group_name;
      const effectiveZone = overrides[s.asset_name] || naturalZone;
      return {
        name:            s.asset_name,
        dbZone:          s.site_group_name,
        naturalZone,
        effectiveZone,
        temp:            s.room_temp,
        setpoint:        s.ac_setpoint,
        mode:            s.ac_mode,
        powerStatus:     s.ac_power_status,
        fanSpeed:        s.ac_fanspeed,
        deviceTimestamp: s.device_timestamp_ist,
        status:          s.device_status,
      };
    });

    return res.json({
      sensors,
      overrides,
      zones: Object.keys(ZONE_MAP),
    });
  } catch (err) {
    console.error('[live-all] DB error:', err.message);
    return res.status(500).json({ error: 'Database query failed', detail: err.message });
  }
});

// ─── Helper: query hourly avg temps for one date ──────────────────────────────
// device_timestamp is stored as UTC (TIMESTAMP WITHOUT TIME ZONE).
// We add +05:30 explicitly to shift into IST before extracting hour / date.
// excludeAssets: sensors to drop from natural dbZones (they were moved elsewhere)
// includeAssets: sensors to add regardless of their DB site_group_name (they moved here)
async function getHourlyAvgsForDate(dbZones, date, excludeAssets = [], includeAssets = []) {
  // Cast to TIMESTAMP first (strips tz info) then add +05:30 to get true IST time
  const result = await db.query(`
    SELECT
      EXTRACT(HOUR FROM ((synced_at::TIMESTAMP) + INTERVAL '5 hours 30 minutes'))::INT AS hour,
      AVG(room_temp::FLOAT) AS avg_temp
    FROM public.lt_bangalore_org_live_device_data
    WHERE (
      (site_group_name = ANY($1::text[]) AND asset_name != ALL($3::text[]))
      OR asset_name = ANY($4::text[])
    )
      AND DATE((synced_at::TIMESTAMP) + INTERVAL '5 hours 30 minutes') = $2::DATE
      AND room_temp IS NOT NULL
      AND room_temp::TEXT != 'NaN'
    GROUP BY EXTRACT(HOUR FROM ((synced_at::TIMESTAMP) + INTERVAL '5 hours 30 minutes'))
    ORDER BY hour
  `, [dbZones, date, excludeAssets, includeAssets]);

  const map = {};
  for (const row of result.rows) {
    map[row.hour] = Math.round(parseFloat(row.avg_temp) * 100) / 100;
  }
  return map;
}

// ─── GET /api/historical-temp ─────────────────────────────────────────────────
// Returns a 24-element array (index = hour 0–23) of real sensor avg temps.
// Fallback priority per hour:
//   1. Today's avg for that hour
//   2. Yesterday's avg for the same hour
//   3. Carry forward from the nearest previous hour (last resort)
// Query params: zone (app zone name), date (YYYY-MM-DD, defaults to today IST)
app.get('/api/historical-temp', async (req, res) => {
  try {
    const appZone = req.query.zone || 'Zone 1';
    const dbZones = resolveDbZones(appZone);

    // Default to today in IST if no date provided
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
      ? req.query.date
      : todayIST;

    // Calculate yesterday's date (UTC noon avoids any DST/TZ boundary issues)
    const dateObj = new Date(date + 'T12:00:00Z');
    dateObj.setUTCDate(dateObj.getUTCDate() - 1);
    const yesterday = dateObj.toISOString().slice(0, 10);

    // Apply sensor zone overrides — resolved per query date so historical data is correct.
    // (e.g. a sensor moved on Mar 14 is in Zone 1 for Mar 12 queries, Zone 4 for Mar 16 queries)
    const allOverrides = readSensorOverrides();
    const overridesForDate      = resolveOverridesForDate(allOverrides, date);
    const overridesForYesterday = resolveOverridesForDate(allOverrides, yesterday);

    const toExclude = (ov) => Object.entries(ov).filter(([, z]) => z !== appZone).map(([a]) => a);
    const toInclude = (ov) => Object.entries(ov).filter(([, z]) => z === appZone).map(([a]) => a);

    // Fetch both days in parallel
    const [todayMap, yesterdayMap] = await Promise.all([
      getHourlyAvgsForDate(dbZones, date,      toExclude(overridesForDate),      toInclude(overridesForDate)),
      getHourlyAvgsForDate(dbZones, yesterday, toExclude(overridesForYesterday), toInclude(overridesForYesterday)),
    ]);

    const hoursFromToday     = Object.keys(todayMap).length;
    const hoursFromYesterday = Object.keys(yesterdayMap).length;

    // For today's date: never fill hours that haven't occurred yet.
    // Current IST hour is the hard ceiling — future hours stay null so the
    // physics engine never uses predicted/yesterday data for upcoming slots.
    const isQueryingToday = date === todayIST;
    const currentHourIST = parseInt(
      new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false })
    );
    const hourCeil = isQueryingToday ? currentHourIST : 23;

    // Build array: today's real data → yesterday fallback (past hours only) → carry-forward
    const temps = new Array(24).fill(null);
    for (let h = 0; h <= hourCeil; h++) {
      if (todayMap[h] !== undefined) {
        temps[h] = todayMap[h];
      } else if (yesterdayMap[h] !== undefined) {
        temps[h] = yesterdayMap[h];   // only used for elapsed hours
      }
    }

    // Carry forward for any remaining nulls up to hourCeil (forward pass)
    let lastKnown = null;
    for (let h = 0; h <= hourCeil; h++) {
      if (temps[h] !== null) lastKnown = temps[h];
      else if (lastKnown !== null) temps[h] = lastKnown;
    }

    // Backward fill for leading nulls (use first known value, up to hourCeil)
    const firstKnown = temps.find(t => t !== null);
    if (firstKnown !== null) {
      for (let h = 0; h <= hourCeil; h++) {
        if (temps[h] === null) temps[h] = firstKnown;
        else break;
      }
    }
    // hours > hourCeil remain null for today — no forecasting

    return res.json({
      zone:              appZone,
      dbZones,
      date,
      yesterday,
      temps,             // null for future hours when querying today
      hoursFromToday,
      hoursFromYesterday,
      hasData:           hoursFromToday > 0 || hoursFromYesterday > 0,
    });
  } catch (err) {
    console.error('[historical-temp] DB error:', err.message);
    return res.status(500).json({ error: 'Database query failed', detail: err.message });
  }
});

// ─── Helper: query hourly total zone AC electrical output for one date ────────
// Per sensor: average electrical draw per hour (phase R+Y+B when ON, else power fallback, else 0).
// Then summed across all sensors = total zone electrical watts per hour.
// device_timestamp is stored as UTC — shift +05:30 to get IST hour/date.
// excludeAssets / includeAssets: same semantics as getHourlyAvgsForDate
async function getHourlyAcOutputForDate(dbZones, date, excludeAssets = [], includeAssets = []) {
  const result = await db.query(`
    SELECT hour, SUM(avg_ac_output)::FLOAT AS total_watts
    FROM (
      SELECT
        EXTRACT(HOUR FROM ((synced_at::TIMESTAMP) + INTERVAL '5 hours 30 minutes'))::INT AS hour,
        asset_name,
        AVG(
          CASE WHEN UPPER(ac_power_status) = 'ON' THEN
            CASE
              WHEN COALESCE(r_phase_power::FLOAT, 0) + COALESCE(y_phase_power::FLOAT, 0) + COALESCE(b_phase_power::FLOAT, 0) > 0
                THEN COALESCE(r_phase_power::FLOAT, 0) + COALESCE(y_phase_power::FLOAT, 0) + COALESCE(b_phase_power::FLOAT, 0)
              ELSE COALESCE(power::FLOAT, 0)
            END
          ELSE 0
          END
        ) AS avg_ac_output
      FROM public.lt_bangalore_org_live_device_data
      WHERE (
        (site_group_name = ANY($1::text[]) AND asset_name != ALL($3::text[]))
        OR asset_name = ANY($4::text[])
      )
        AND LOWER(asset_name) LIKE '%ac%'
        AND DATE((synced_at::TIMESTAMP) + INTERVAL '5 hours 30 minutes') = $2::DATE
      GROUP BY EXTRACT(HOUR FROM ((synced_at::TIMESTAMP) + INTERVAL '5 hours 30 minutes')), asset_name
    ) subq
    GROUP BY hour
    ORDER BY hour
  `, [dbZones, date, excludeAssets, includeAssets]);

  const map = {};
  for (const row of result.rows) {
    map[row.hour] = Math.round(parseFloat(row.total_watts) * 100) / 100;
  }
  return map;
}

// ─── GET /api/historical-ac-output ───────────────────────────────────────────
// Returns a 24-element array (index = hour 0–23) of total zone AC electrical watts.
// Uses ONLY real sensor data for the requested date — no yesterday fallback,
// no carry-forward, no backward-fill. Hours with no DB readings → 0 (AC was off
// or not reporting). Future hours (today, not yet reached) → null.
// Query params: zone (app zone name), date (YYYY-MM-DD, defaults to today IST)
app.get('/api/historical-ac-output', async (req, res) => {
  try {
    const appZone = req.query.zone || 'Zone 1';
    const dbZones = resolveDbZones(appZone);

    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
      ? req.query.date
      : todayIST;

    // Apply sensor zone overrides resolved for the query date
    const overridesForDate = resolveOverridesForDate(readSensorOverrides(), date);
    const excludeAssets = Object.entries(overridesForDate).filter(([, z]) => z !== appZone).map(([a]) => a);
    const includeAssets = Object.entries(overridesForDate).filter(([, z]) => z === appZone).map(([a]) => a);

    // Fetch only the requested date — no yesterday fallback.
    // ac_power_status = 'ON' is already enforced inside getHourlyAcOutputForDate.
    const todayMap = await getHourlyAcOutputForDate(dbZones, date, excludeAssets, includeAssets);
    const hoursFromToday = Object.keys(todayMap).length;

    // For today: cap at current IST hour so future slots stay null.
    const isQueryingToday = date === todayIST;
    const currentHourIST  = parseInt(
      new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false })
    );
    const hourCeil = isQueryingToday ? currentHourIST : 23;

    // Real DB watts for hours that reported; 0 for elapsed hours with no AC data.
    // Future hours (> hourCeil when querying today) remain null.
    const acOutputs = new Array(24).fill(null);
    for (let h = 0; h <= hourCeil; h++) {
      acOutputs[h] = todayMap[h] !== undefined ? todayMap[h] : 0;
    }

    return res.json({
      zone: appZone,
      dbZones,
      date,
      yesterday: '',           // no longer fetched — kept for interface compatibility
      acOutputs,
      hoursFromToday,
      hoursFromYesterday: 0,
      hasData: hoursFromToday > 0,
    });
  } catch (err) {
    console.error('[historical-ac-output] DB error:', err.message);
    return res.status(500).json({ error: 'Database query failed', detail: err.message });
  }
});

// ─── Helper: per-sensor hourly AC electrical output for one date ─────────────
// Returns { sensorName → { hour → avgWatts } } for all AC-named sensors in the zone.
async function getHourlyAcOutputPerSensorForDate(dbZones, date) {
  const result = await db.query(`
    SELECT
      asset_name,
      EXTRACT(HOUR FROM ((device_timestamp::TIMESTAMP) + INTERVAL '5 hours 30 minutes'))::INT AS hour,
      AVG(
        CASE WHEN UPPER(ac_power_status) = 'ON' THEN
          CASE
            WHEN COALESCE(r_phase_power::FLOAT, 0) + COALESCE(y_phase_power::FLOAT, 0) + COALESCE(b_phase_power::FLOAT, 0) > 0
              THEN COALESCE(r_phase_power::FLOAT, 0) + COALESCE(y_phase_power::FLOAT, 0) + COALESCE(b_phase_power::FLOAT, 0)
            ELSE COALESCE(power::FLOAT, 0)
          END
        ELSE 0
        END
      ) AS avg_ac_output
    FROM public.lt_bangalore_org_live_device_data
    WHERE site_group_name = ANY($1::text[])
      AND LOWER(asset_name) LIKE '%ac%'
      AND DATE((device_timestamp::TIMESTAMP) + INTERVAL '5 hours 30 minutes') = $2::DATE
    GROUP BY asset_name, EXTRACT(HOUR FROM ((device_timestamp::TIMESTAMP) + INTERVAL '5 hours 30 minutes'))
    ORDER BY asset_name, hour
  `, [dbZones, date]);

  const sensorMap = {};
  for (const row of result.rows) {
    if (!sensorMap[row.asset_name]) sensorMap[row.asset_name] = {};
    sensorMap[row.asset_name][row.hour] = Math.round(parseFloat(row.avg_ac_output) * 100) / 100;
  }
  return sensorMap;
}

// ─── GET /api/ac-breakdown ────────────────────────────────────────────────────
// Per-sensor hourly AC electrical output for a zone and date.
// Returns sensors: [{ name, hours: (number|null)[] }] — same null/0 semantics as historical-ac-output.
app.get('/api/ac-breakdown', async (req, res) => {
  try {
    const appZone = req.query.zone || 'Zone 1';
    const dbZones = resolveDbZones(appZone);

    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
      ? req.query.date
      : todayIST;

    const isQueryingToday = date === todayIST;
    const currentHourIST = parseInt(
      new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false })
    );
    const hourCeil = isQueryingToday ? currentHourIST : 23;

    const sensorMap = await getHourlyAcOutputPerSensorForDate(dbZones, date);

    const sensors = Object.entries(sensorMap).map(([name, hourMap]) => {
      const hours = new Array(24).fill(null);
      for (let h = 0; h <= hourCeil; h++) {
        hours[h] = hourMap[h] !== undefined ? hourMap[h] : 0;
      }
      return { name, hours };
    });

    return res.json({ zone: appZone, dbZones, date, sensors });
  } catch (err) {
    console.error('[ac-breakdown] DB error:', err.message);
    return res.status(500).json({ error: 'Database query failed', detail: err.message });
  }
});

// ─── GET /api/zones ───────────────────────────────────────────────────────────
// Returns the current app zone definitions so the frontend can display them.
app.get('/api/zones', (_, res) => {
  res.json({
    zones: Object.entries(ZONE_MAP).map(([name, dbZones]) => ({ name, dbZones })),
  });
});

// ─── GET /api/subzones ────────────────────────────────────────────────────────
// Returns sub-zone metadata for a given app zone:
//   - sub-zone names (from ZONE_MAP)
//   - sensor count per sub-zone
//   - suggested area (m²) based on historical AC power ratio over the last 7 days
//     falling back to sensor-count proportional split if no power data exists.
// Query params: zone (app zone name, default "Zone 1"), totalAreaM2 (optional)
app.get('/api/subzones', async (req, res) => {
  try {
    const appZone = req.query.zone || 'Zone 1';
    const dbZones = resolveDbZones(appZone);
    const totalAreaM2 = parseFloat(req.query.totalAreaM2) || null;

    // 1. Sensor count per sub-zone (latest snapshot)
    const sensorCountResult = await db.query(`
      SELECT site_group_name, COUNT(DISTINCT asset_name)::INT AS sensor_count
      FROM public.lt_bangalore_org_live_device_data
      WHERE site_group_name = ANY($1::text[])
        AND room_temp IS NOT NULL
      GROUP BY site_group_name
    `, [dbZones]);

    const sensorCounts = {};
    for (const row of sensorCountResult.rows) {
      sensorCounts[row.site_group_name] = row.sensor_count;
    }

    // 2. Historical avg AC power per sub-zone over the last 7 days (IST)
    const powerResult = await db.query(`
      SELECT
        site_group_name,
        AVG(
          CASE WHEN UPPER(ac_power_status) = 'ON' THEN
            CASE
              WHEN COALESCE(r_phase_power::FLOAT, 0) + COALESCE(y_phase_power::FLOAT, 0) + COALESCE(b_phase_power::FLOAT, 0) > 0
                THEN COALESCE(r_phase_power::FLOAT, 0) + COALESCE(y_phase_power::FLOAT, 0) + COALESCE(b_phase_power::FLOAT, 0)
              ELSE COALESCE(power::FLOAT, 0)
            END
          ELSE 0
          END
        )::FLOAT AS avg_ac_watts
      FROM public.lt_bangalore_org_live_device_data
      WHERE site_group_name = ANY($1::text[])
        AND DATE((device_timestamp::TIMESTAMP) + INTERVAL '5 hours 30 minutes')
            >= (CURRENT_DATE AT TIME ZONE 'Asia/Kolkata') - INTERVAL '7 days'
        AND LOWER(asset_name) LIKE '%ac%'
      GROUP BY site_group_name
    `, [dbZones]);

    const avgPower = {};
    let totalPower = 0;
    for (const row of powerResult.rows) {
      avgPower[row.site_group_name] = Math.max(0, parseFloat(row.avg_ac_watts) || 0);
      totalPower += avgPower[row.site_group_name];
    }

    // 3. Compute suggested areas
    const totalSensors = Object.values(sensorCounts).reduce((a, b) => a + b, 0) || dbZones.length;

    const subZones = dbZones.map(subZoneName => {
      const sc = sensorCounts[subZoneName] || 0;
      const pw = avgPower[subZoneName] || 0;

      let suggestedAreaM2 = 0;
      let suggestedMethod = 'none';

      if (totalAreaM2) {
        if (totalPower > 0 && pw > 0) {
          // Power-ratio method: most physically grounded
          suggestedAreaM2 = Math.round((pw / totalPower) * totalAreaM2 * 10) / 10;
          suggestedMethod = 'power_ratio';
        } else if (totalSensors > 0 && sc > 0) {
          // Sensor-count fallback
          suggestedAreaM2 = Math.round((sc / totalSensors) * totalAreaM2 * 10) / 10;
          suggestedMethod = 'sensor_count';
        }
      }

      return {
        name: subZoneName,
        sensorCount: sc,
        suggestedAreaM2,
        suggestedMethod,
      };
    });

    return res.json({ zone: appZone, dbZones, subZones });
  } catch (err) {
    console.error('[subzones] DB error:', err.message);
    return res.status(500).json({ error: 'Database query failed', detail: err.message });
  }
});

// ─── Zone Config File Persistence ────────────────────────────────────────────
const ZONES_CONFIG_PATH = path.resolve(process.cwd(), 'zones_config.json');

/**
 * Reads the raw sensorZoneOverrides from zones_config.json.
 * Structure: Record<assetName, Array<{ zone: string, from: string (YYYY-MM-DD) }>>
 * Each entry means "this sensor moved to [zone] on [from]".
 */
function readSensorOverrides() {
  try {
    if (!fs.existsSync(ZONES_CONFIG_PATH)) return {};
    const data = JSON.parse(fs.readFileSync(ZONES_CONFIG_PATH, 'utf8'));
    return data.sensorZoneOverrides || {};
  } catch {
    return {};
  }
}

/**
 * Given all overrides and a query date (YYYY-MM-DD), returns a flat
 * Record<assetName, appZoneName> representing where each sensor was on that date.
 *
 * Logic: for each sensor, find the most recent entry whose `from` ≤ queryDate.
 * If none applies (sensor hadn't moved yet), natural DB zone is used (sensor absent from result).
 */
function resolveOverridesForDate(allOverrides, queryDate) {
  const result = {};
  for (const [asset, entries] of Object.entries(allOverrides)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    // Find the most recent entry that was on or before queryDate
    const applicable = entries
      .filter(e => e.from <= queryDate)           // YYYY-MM-DD string comparison is lexicographic = correct
      .sort((a, b) => b.from.localeCompare(a.from))[0];  // most recent first
    if (applicable) {
      result[asset] = applicable.zone;
    }
    // No applicable entry → sensor was in its natural DB zone on queryDate
  }
  return result;
}

// GET /api/zones/config  → read zones_config.json from disk
app.get('/api/zones/config', (_, res) => {
  try {
    if (!fs.existsSync(ZONES_CONFIG_PATH)) {
      return res.status(404).json({ error: 'No saved zones config found' });
    }
    const raw = fs.readFileSync(ZONES_CONFIG_PATH, 'utf8');
    const data = JSON.parse(raw);
    return res.json(data);
  } catch (err) {
    console.error('[zones/config GET] Error reading file:', err.message);
    return res.status(500).json({ error: 'Failed to read zones config', detail: err.message });
  }
});

// POST /api/zones/config  → write zones array (and optional sensorZoneOverrides) to zones_config.json
app.post('/api/zones/config', (req, res) => {
  try {
    const { zones, sensorZoneOverrides } = req.body;
    if (!Array.isArray(zones)) {
      return res.status(400).json({ error: 'Request body must be { zones: [...] }' });
    }
    const payload = {
      savedAt: new Date().toISOString(),
      zones,
      sensorZoneOverrides: sensorZoneOverrides || {},
    };
    fs.writeFileSync(ZONES_CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`[zones/config] Saved ${zones.length} zone(s) to zones_config.json`);
    return res.json({ ok: true, savedAt: payload.savedAt, count: zones.length });
  } catch (err) {
    console.error('[zones/config POST] Error writing file:', err.message);
    return res.status(500).json({ error: 'Failed to save zones config', detail: err.message });
  }
});

// ─── Camera Occupancy ─────────────────────────────────────────────────────────
// Camera-to-zone mapping (camera_id → which sub-areas they cover):
//   cam 5, 8  → Working Area 1 (Zone 1 sub-zone)
//   cam 1,3,7 → Working Area 2 (Zone 1 sub-zone)
//   cam 4     → Working Area 2 + Embedded Team combined (Zone 1 sub-zones)
//   cam 2     → Reception (Zone 4)
//   No cameras in Pantry (Zone 2) or Meeting Room 1 (Zone 3) — defaults used there.
//
// Zone 1 total count formula (avoids double-counting):
//   WA1     = MAX(cam5, cam8)
//   WA2+ET  = MAX(cam4, cam1, cam3, cam7)
//     (cam4 sees WA2+ET combined; cams 1,3,7 see WA2 only; taking max gives WA2+ET)
//   Zone 1  = WA1 + WA2+ET
//
// Zone 4 count = cam2

// GET /api/camera-occupancy?date=YYYY-MM-DD
// Returns 1440-slot (per-minute) people counts for Zone 1 and Zone 4.
//
// Date resolution rules:
//   1. Requested date < earliest camera date  → historical pattern: use earliest available date
//   2. Requested date ≥ earliest camera date but NO data that day → holiday: return all 0s
//   3. Requested date has camera data → use it directly
//
// Safety guards applied after data is fetched:
//   • Slots 0–599 (midnight–9:59 AM): use live camera count if data exists; zero if no data
//   • Late camera start backfill: if first camera reading after 10 AM has a gap (e.g. camera
//     comes online at 11 AM), slots 600 → (first reading − 1) are filled with the PREVIOUS
//     DAY's counts for those same minute slots (more realistic than repeating today's first peak).
app.get('/api/camera-occupancy', async (req, res) => {
  try {
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    let date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
      ? req.query.date
      : todayIST;

    // Fetch earliest available date and check if requested date has data — run in parallel
    const [earliestResult, checkResult] = await Promise.all([
      db.query(`SELECT MIN(DATE(timestamp))::TEXT AS earliest FROM cameralogstest`),
      db.query(`SELECT COUNT(*) FROM cameralogstest WHERE DATE(timestamp) = $1::DATE`, [date]),
    ]);

    const earliestDate = earliestResult.rows[0]?.earliest ?? null;
    const hasData = parseInt(checkResult.rows[0].count) > 0;

    let usingFallbackDate = false;
    let fallbackDate = null;

    if (!hasData) {
      if (earliestDate && date < earliestDate) {
        // Rule 1: before cameras were installed → use earliest date as historical pattern
        fallbackDate = earliestDate;
        date = earliestDate;
        usingFallbackDate = true;
      } else {
        // Rule 2: within camera era but no data (holiday / office closed) → return all zeros
        return res.json({
          date,
          usingFallbackDate: false,
          fallbackDate: null,
          isHoliday: true,
          zone1: new Array(1440).fill(0),
          zone4: new Array(1440).fill(0),
        });
      }
    }

    // Query per-minute MAX count per camera for the resolved date.
    // timestamp is stored as IST (TIMESTAMP WITHOUT TIME ZONE) — no offset needed.
    const result = await db.query(`
      SELECT
        camera_id,
        (EXTRACT(HOUR FROM timestamp) * 60 + EXTRACT(MINUTE FROM timestamp))::INT AS slot,
        MAX(count)::INT AS max_count
      FROM cameralogstest
      WHERE DATE(timestamp) = $1::DATE
      GROUP BY camera_id, slot
      ORDER BY slot, camera_id
    `, [date]);

    // ── Helper: build camera slot map from query rows ────────────────────────
    const buildCamSlots = (rows) => {
      const m = {};
      for (const r of rows) {
        if (!m[r.camera_id]) m[r.camera_id] = {};
        m[r.camera_id][r.slot] = r.max_count;
      }
      return m;
    };

    // ── Helper: apply zone formulas for one slot ──────────────────────────────
    const computeZoneSlots = (camSlots) => {
      const getCount = (id, s) => camSlots[id]?.[s] ?? 0;
      const zone1 = new Array(1440).fill(0);
      const zone4 = new Array(1440).fill(0);
      for (let slot = 0; slot < 1440; slot++) {
        // Zone 1: cameras cover non-overlapping areas, so SUM (not MAX) gives the best headcount.
        // People are stationary at desks; at any given minute each person is in one camera's frame only.
        // WA1 = cam5 + cam8;  WA2+ET = cam4 + cam1 + cam3 + cam7
        const wa1   = getCount('5', slot) + getCount('8', slot);
        const wa2et = getCount('4', slot) + getCount('1', slot) + getCount('3', slot) + getCount('7', slot);
        zone1[slot] = wa1 + wa2et;
        // Zone 4: Reception = cam2
        zone4[slot] = getCount('2', slot);
      }
      return { zone1, zone4 };
    };

    // Build today's zone arrays — no hard pre-10-AM block:
    //   slots 0–599 with camera data → use it (camera may detect arrivals/cleaning)
    //   slots 0–599 with no camera data → naturally stay 0
    const todayCamSlots = buildCamSlots(result.rows);
    const { zone1, zone4 } = computeZoneSlots(todayCamSlots);

    // ── Late camera start: backfill gap with PREVIOUS DAY's data ─────────────
    // If the first camera reading on a given day comes after 10:00 AM (slot 600),
    // fill the gap [600 … firstSlot-1] using the equivalent slots from yesterday.
    // Using yesterday's real counts (same time-of-day) is more realistic than
    // repeating today's first reading or leaving the gap as zero.
    const OFFICE_START_SLOT = 600; // 10:00 AM

    const gapEnd = (arr) => {
      for (let s = OFFICE_START_SLOT; s < 1440; s++) { if (arr[s] > 0) return s; }
      return -1; // no data from 10 AM onwards
    };

    const z1Gap = gapEnd(zone1); // -1 = no data; 600 = no gap; >600 = gap exists
    const z4Gap = gapEnd(zone4);
    const hasGap = (z1Gap > OFFICE_START_SLOT) || (z4Gap > OFFICE_START_SLOT);

    if (hasGap) {
      // Calculate yesterday relative to the resolved date
      const dateObj = new Date(date + 'T12:00:00Z');
      dateObj.setUTCDate(dateObj.getUTCDate() - 1);
      const yesterday = dateObj.toISOString().slice(0, 10);

      const yResult = await db.query(`
        SELECT
          camera_id,
          (EXTRACT(HOUR FROM timestamp) * 60 + EXTRACT(MINUTE FROM timestamp))::INT AS slot,
          MAX(count)::INT AS max_count
        FROM cameralogstest
        WHERE DATE(timestamp) = $1::DATE
        GROUP BY camera_id, slot
      `, [yesterday]);

      const { zone1: yZone1, zone4: yZone4 } = computeZoneSlots(buildCamSlots(yResult.rows));

      // Fill the gap slots with yesterday's counts (0 if yesterday also had no data)
      if (z1Gap > OFFICE_START_SLOT) {
        for (let s = OFFICE_START_SLOT; s < z1Gap; s++) zone1[s] = yZone1[s];
      }
      if (z4Gap > OFFICE_START_SLOT) {
        for (let s = OFFICE_START_SLOT; s < z4Gap; s++) zone4[s] = yZone4[s];
      }
    }

    // ── Carry-forward fill ────────────────────────────────────────────────────
    // Cameras fire every ~20s; many minute-slots have 0 between readings.
    // Carry the last known count for up to 5 consecutive zero slots so the
    // physics engine sees realistic occupancy instead of a sparse spike signal.
    // A gap longer than 5 slots is treated as genuinely empty (person left).
    const carryForwardFill = (arr, maxGap = 5) => {
      let lastVal = 0;
      let gapCount = 0;
      for (let s = 0; s < 1440; s++) {
        if (arr[s] > 0) {
          lastVal = arr[s];
          gapCount = 0;
        } else {
          gapCount++;
          if (lastVal > 0 && gapCount <= maxGap) {
            arr[s] = lastVal;
          } else if (gapCount > maxGap) {
            lastVal = 0; // genuine empty period — stop carrying
          }
        }
      }
    };
    carryForwardFill(zone1, 30);
    carryForwardFill(zone4, 30);

    return res.json({
      date,
      usingFallbackDate,
      fallbackDate,
      isHoliday: false,
      zone1,   // 1440-slot people count for Zone 1 (Main Working Area)
      zone4,   // 1440-slot people count for Zone 4 (Reception)
    });
  } catch (err) {
    console.error('[camera-occupancy] DB error:', err.message);
    return res.status(500).json({ error: 'Database query failed', detail: err.message });
  }
});

// ─── Camera debug: per-camera counts for recent slots ─────────────────────────
app.get('/api/camera-debug', async (req, res) => {
  try {
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const nowIST   = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const curSlot  = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();
    const fromSlot = Math.max(0, curSlot - 5);
    const result = await db.query(`
      SELECT camera_id, slot, max_count FROM (
        SELECT camera_id,
               (EXTRACT(HOUR FROM timestamp)*60 + EXTRACT(MINUTE FROM timestamp))::INT AS slot,
               MAX(count)::INT AS max_count
        FROM cameralogstest
        WHERE DATE(timestamp) = $1::DATE
        GROUP BY camera_id, slot
      ) t
      WHERE slot >= $2 AND slot <= $3
      ORDER BY slot, camera_id
    `, [todayIST, fromSlot, curSlot]);
    res.json({ currentSlot: curSlot, rows: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`\n✅  ThermoZone live-sensor API running on http://localhost:${PORT}`);
  console.log(`   GET /api/live-temp?zone=<name>              → Latest avg temp for a zone`);
  console.log(`   GET /api/live-all                           → All sensors with effective zone assignment`);
  console.log(`   GET /api/historical-temp?zone=<name>&date=YYYY-MM-DD → Hourly avg temps`);
  console.log(`   GET /api/historical-ac-output?zone=<name>  → Hourly zone AC electrical watts`);
  console.log(`   GET /api/zones                              → List all app zones\n`);
});

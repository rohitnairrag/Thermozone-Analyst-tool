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

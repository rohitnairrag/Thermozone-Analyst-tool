/**
 * ThermoZone Analyst — Live Sensor API
 *
 * Run alongside the Vite dev server:
 *   node server.cjs
 */

// ─── MUST be first: load .env before anything else ──────────────────────────
const path = require('path');
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
  'Zone 2': ['Pantry'],
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
      WHERE site_group_name = ANY($1::text[])
        AND room_temp IS NOT NULL
        AND room_temp::TEXT != 'NaN'
      ORDER BY asset_name, synced_at DESC
    `, [dbZones]);

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
        };
      }),
    });
  } catch (err) {
    console.error('[live-temp] DB error:', err.message);
    return res.status(500).json({ error: 'Database query failed', detail: err.message });
  }
});

// ─── Helper: query hourly avg temps for one date ──────────────────────────────
// device_timestamp is stored as UTC (TIMESTAMP WITHOUT TIME ZONE).
// We add +05:30 explicitly to shift into IST before extracting hour / date.
async function getHourlyAvgsForDate(dbZones, date) {
  // Cast to TIMESTAMP first (strips tz info) then add +05:30 to get true IST time
  const result = await db.query(`
    SELECT
      EXTRACT(HOUR FROM ((synced_at::TIMESTAMP) + INTERVAL '5 hours 30 minutes'))::INT AS hour,
      AVG(room_temp::FLOAT) AS avg_temp
    FROM public.lt_bangalore_org_live_device_data
    WHERE site_group_name = ANY($1::text[])
      AND DATE((synced_at::TIMESTAMP) + INTERVAL '5 hours 30 minutes') = $2::DATE
      AND room_temp IS NOT NULL
      AND room_temp::TEXT != 'NaN'
    GROUP BY EXTRACT(HOUR FROM ((synced_at::TIMESTAMP) + INTERVAL '5 hours 30 minutes'))
    ORDER BY hour
  `, [dbZones, date]);

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

    // Fetch both days in parallel
    const [todayMap, yesterdayMap] = await Promise.all([
      getHourlyAvgsForDate(dbZones, date),
      getHourlyAvgsForDate(dbZones, yesterday),
    ]);

    const hoursFromToday     = Object.keys(todayMap).length;
    const hoursFromYesterday = Object.keys(yesterdayMap).length;

    // Build 24-element array: today → yesterday → carry-forward
    const temps = new Array(24).fill(null);
    for (let h = 0; h < 24; h++) {
      if (todayMap[h] !== undefined) {
        temps[h] = todayMap[h];
      } else if (yesterdayMap[h] !== undefined) {
        temps[h] = yesterdayMap[h];
      }
      // else stays null — handled by carry-forward below
    }

    // Carry forward for any remaining nulls (forward pass)
    let lastKnown = null;
    for (let h = 0; h < 24; h++) {
      if (temps[h] !== null) lastKnown = temps[h];
      else if (lastKnown !== null) temps[h] = lastKnown;
    }

    // Backward fill for leading nulls (use first known value)
    const firstKnown = temps.find(t => t !== null);
    if (firstKnown !== null) {
      for (let h = 0; h < 24; h++) {
        if (temps[h] === null) temps[h] = firstKnown;
        else break;
      }
    }

    return res.json({
      zone:              appZone,
      dbZones,
      date,
      yesterday,
      temps,             // 24 real-sensor values; null only if DB has no data at all
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
async function getHourlyAcOutputForDate(dbZones, date) {
  const result = await db.query(`
    SELECT hour, COALESCE(SUM(avg_ac_output), 0)::FLOAT AS total_watts
    FROM (
      SELECT
        EXTRACT(HOUR FROM ((synced_at::TIMESTAMP) + INTERVAL '5 hours 30 minutes'))::INT AS hour,
        asset_name,
        AVG(
          CASE WHEN UPPER(ac_power_status) = 'ON' THEN
            CASE
              WHEN COALESCE(NULLIF(r_phase_power::FLOAT,'NaN'::FLOAT),0) + COALESCE(NULLIF(y_phase_power::FLOAT,'NaN'::FLOAT),0) + COALESCE(NULLIF(b_phase_power::FLOAT,'NaN'::FLOAT),0) > 0
                THEN COALESCE(NULLIF(r_phase_power::FLOAT,'NaN'::FLOAT),0) + COALESCE(NULLIF(y_phase_power::FLOAT,'NaN'::FLOAT),0) + COALESCE(NULLIF(b_phase_power::FLOAT,'NaN'::FLOAT),0)
              WHEN COALESCE(NULLIF(power::FLOAT,'NaN'::FLOAT), 0) > 0
                THEN COALESCE(NULLIF(power::FLOAT,'NaN'::FLOAT), 0)
              ELSE NULL
            END
          ELSE NULL
          END
        ) AS avg_ac_output
      FROM public.lt_bangalore_org_live_device_data
      WHERE site_group_name = ANY($1::text[])
        AND DATE((synced_at::TIMESTAMP) + INTERVAL '5 hours 30 minutes') = $2::DATE
      GROUP BY EXTRACT(HOUR FROM ((synced_at::TIMESTAMP) + INTERVAL '5 hours 30 minutes')), asset_name
    ) subq
    GROUP BY hour
    ORDER BY hour
  `, [dbZones, date]);

  const map = {};
  for (const row of result.rows) {
    map[row.hour] = Math.round(parseFloat(row.total_watts) * 100) / 100;
  }
  return map;
}

// ─── GET /api/historical-ac-output ───────────────────────────────────────────
// Returns a 24-element array (index = hour 0–23) of total zone AC electrical watts.
// Fallback priority: today → yesterday same hour → carry-forward → backward-fill.
// Query params: zone (app zone name), date (YYYY-MM-DD, defaults to today IST)
app.get('/api/historical-ac-output', async (req, res) => {
  try {
    const appZone = req.query.zone || 'Zone 1';
    const dbZones = resolveDbZones(appZone);

    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
      ? req.query.date
      : todayIST;

    // Calculate yesterday's date (UTC noon avoids any DST/TZ boundary issues)
    const dateObj = new Date(date + 'T12:00:00Z');
    dateObj.setUTCDate(dateObj.getUTCDate() - 1);
    const yesterday = dateObj.toISOString().slice(0, 10);

    const [todayMap, yesterdayMap] = await Promise.all([
      getHourlyAcOutputForDate(dbZones, date),
      getHourlyAcOutputForDate(dbZones, yesterday),
    ]);

    const hoursFromToday     = Object.keys(todayMap).length;
    const hoursFromYesterday = Object.keys(yesterdayMap).length;

    const acOutputs = new Array(24).fill(null);
    for (let h = 0; h < 24; h++) {
      if (todayMap[h] !== undefined)      acOutputs[h] = todayMap[h];
      else if (yesterdayMap[h] !== undefined) acOutputs[h] = yesterdayMap[h];
    }

    // For today: if the current hour still has no power data, seed it from the live reading.
    // Power columns are only populated in the very latest DB record per sensor.
    // Once synced_at advances to the next hour the previous hour loses its power data.
    // Seeding from live here ensures carry-forward has a real value to propagate.
    if (date === todayIST) {
      const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const currentHour = nowIST.getHours();
      if (acOutputs[currentHour] == null || acOutputs[currentHour] === 0) {
        const liveResult = await db.query(`
          SELECT COALESCE(SUM(live_power), 0)::FLOAT AS total_watts
          FROM (
            SELECT DISTINCT ON (asset_name)
              CASE WHEN UPPER(ac_power_status) = 'ON' THEN
                CASE
                  WHEN COALESCE(NULLIF(r_phase_power::FLOAT,'NaN'::FLOAT),0) + COALESCE(NULLIF(y_phase_power::FLOAT,'NaN'::FLOAT),0) + COALESCE(NULLIF(b_phase_power::FLOAT,'NaN'::FLOAT),0) > 0
                    THEN COALESCE(NULLIF(r_phase_power::FLOAT,'NaN'::FLOAT),0) + COALESCE(NULLIF(y_phase_power::FLOAT,'NaN'::FLOAT),0) + COALESCE(NULLIF(b_phase_power::FLOAT,'NaN'::FLOAT),0)
                  WHEN COALESCE(NULLIF(power::FLOAT,'NaN'::FLOAT), 0) > 0
                    THEN COALESCE(NULLIF(power::FLOAT,'NaN'::FLOAT), 0)
                  ELSE 0
                END
              ELSE 0
              END AS live_power
            FROM public.lt_bangalore_org_live_device_data
            WHERE site_group_name = ANY($1::text[])
              AND room_temp IS NOT NULL
              AND room_temp::TEXT != 'NaN'
            ORDER BY asset_name, synced_at DESC
          ) latest
        `, [dbZones]);
        const livePower = liveResult.rows[0]?.total_watts ?? 0;
        if (livePower > 0) {
          acOutputs[currentHour] = Math.round(livePower * 100) / 100;
        }
      }
    }

    // Carry forward
    let lastKnown = null;
    for (let h = 0; h < 24; h++) {
      if (acOutputs[h] !== null) lastKnown = acOutputs[h];
      else if (lastKnown !== null) acOutputs[h] = lastKnown;
    }

    // Backward fill for leading nulls
    const firstKnown = acOutputs.find(t => t !== null);
    if (firstKnown !== null) {
      for (let h = 0; h < 24; h++) {
        if (acOutputs[h] === null) acOutputs[h] = firstKnown;
        else break;
      }
    }

    return res.json({
      zone: appZone,
      dbZones,
      date,
      yesterday,
      acOutputs,        // 24 electrical-watt values; null only if DB has no data at all
      hoursFromToday,
      hoursFromYesterday,
      hasData: hoursFromToday > 0 || hoursFromYesterday > 0,
    });
  } catch (err) {
    console.error('[historical-ac-output] DB error:', err.message);
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

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`\n✅  ThermoZone live-sensor API running on http://localhost:${PORT}`);
  console.log(`   GET /api/live-temp?zone=<name>              → Latest avg temp for a zone`);
  console.log(`   GET /api/historical-temp?zone=<name>&date=YYYY-MM-DD → Hourly avg temps`);
  console.log(`   GET /api/historical-ac-output?zone=<name>  → Hourly zone AC electrical watts`);
  console.log(`   GET /api/zones                              → List all app zones\n`);
});

/**
 * ThermoZone Analyst — Live Sensor API
 * Exposes GET /api/live-temp  →  average room temp from Working Area 1 sensors
 *
 * Run alongside the Vite dev server:
 *   node server.cjs
 */

// ─── MUST be first: load .env before anything else ──────────────────────────
const path = require('path');
// Try CWD first (works when running via npm run server), then __dirname as fallback
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

// ─── Postgres Connection (uses .env values) ──────────────────────────────────
const db = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     Number(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE || 'cmp_lt_bangalore_live_data',
  user:     process.env.PG_USER     || 'postgres',
  password: process.env.PG_PASSWORD || '',
  ssl:      process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Log what config was loaded (password masked)
console.log(`[.env] Loaded from: ${path.resolve(process.cwd(), '.env')}`);
console.log(`[DB] Connecting to ${process.env.PG_HOST}:${process.env.PG_PORT} as user "${process.env.PG_USER}" on database "${process.env.PG_DATABASE}"`);
if (!process.env.PG_HOST || process.env.PG_HOST === 'localhost') {
  console.warn('[WARN] PG_HOST is still localhost — .env may not have loaded correctly.');
  console.warn('[WARN] Make sure you run "npm run server" from the project folder containing .env');
}

app.use(cors());
app.use(express.json());

// ─── GET /api/live-temp ──────────────────────────────────────────────────────
app.get('/api/live-temp', async (req, res) => {
  try {
    const zone = req.query.zone || 'Working Area 1';

    const result = await db.query(`
      SELECT
        asset_name,
        room_temp::FLOAT          AS room_temp,
        ac_setpoint::FLOAT        AS ac_setpoint,
        ac_mode,
        ac_power_status,
        ac_fanspeed,
        device_timestamp,
        device_status,
        synced_at,
        r_phase_power::FLOAT      AS r_phase_power,
        y_phase_power::FLOAT      AS y_phase_power,
        b_phase_power::FLOAT      AS b_phase_power,
        power::FLOAT              AS power
      FROM public.lt_bangalore_org_live_device_data
      WHERE site_group_name = $1
        AND room_temp IS NOT NULL
        AND room_temp::TEXT != 'NaN'
      ORDER BY synced_at DESC
    `, [zone]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No sensor data found for zone', zone });
    }

    const sensors = result.rows;
    const temps   = sensors.map(r => r.room_temp).filter(t => !isNaN(t));
    const avgTemp = temps.reduce((a, b) => a + b, 0) / temps.length;

    return res.json({
      avgTemp:     Math.round(avgTemp * 100) / 100,
      sensorCount: sensors.length,
      zone,
      lastUpdated: new Date().toISOString(),
      sensors:     sensors.map(s => {
        const isOn = s.ac_power_status === 'ON';
        const rPhasePower = s.r_phase_power ?? 0;
        const yPhasePower = s.y_phase_power ?? 0;
        const bPhasePower = s.b_phase_power ?? 0;
        const totalPhase  = rPhasePower + yPhasePower + bPhasePower;
        // Live AC Output = sum of 3-phase power when AC is ON, else 0
        const liveAcOutput = isOn ? (totalPhase > 0 ? totalPhase : (s.power ?? 0)) : 0;
        return {
          name:            s.asset_name,
          temp:            s.room_temp,
          setpoint:        s.ac_setpoint,
          mode:            s.ac_mode,
          powerStatus:     s.ac_power_status,
          fanSpeed:        s.ac_fanspeed,
          deviceTimestamp: s.device_timestamp,
          status:          s.device_status,
          rPhasePower,
          yPhasePower,
          bPhasePower,
          power:           s.power ?? 0,
          liveAcOutput,    // watts — 0 when AC is off
        };
      }),
    });
  } catch (err) {
    console.error('[live-temp] DB error:', err.message);
    return res.status(500).json({ error: 'Database query failed', detail: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`\n✅  ThermoZone live-sensor API running on http://localhost:${PORT}`);
  console.log(`   GET /api/live-temp        → Working Area 1 average`);
  console.log(`   GET /api/live-temp?zone=X → Any zone average\n`);
});

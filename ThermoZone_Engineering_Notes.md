# ThermoZone Analyst — Engineering Notes & Roadmap
*Last updated: 12 March 2026*

---

## 1. PARKED IDEA — Historical Live Data for Heat Load Calculation

**Context:** The app currently fetches live temperature and AC setpoints from PostgreSQL every 5 minutes and displays them in the sensor strip UI. However, these readings are **never passed into `calculateHeatLoad()`** — the physics engine uses hardcoded values instead:
- `currentIndoorTemp = 24.0` (should use live `avgTemp`)
- `stepSetPoint = 24 / 23` (should use live AC setpoint from sensors)

**Immediate fix (ready to implement):**
- Extend `calculateHeatLoad(zone, acList, weather, lat, lon)` signature to accept optional `liveIndoorTemp?` and `liveSetpoint?`
- In `App.tsx`, derive average setpoint from `liveData.sensors` and pass both values through
- Use `liveIndoorTemp ?? 24.0` and `liveSetpoint ?? 24` as fallbacks in the physics engine

**Parked idea — Hybrid Rolling Model:**
Rohit will obtain historical live sensor data from the database. Once available, implement the following approach:

- **Past hours (0 → current hour):** Use actual stored hourly averages from sensor readings
- **Future hours (current hour → 23):** Continue using physics engine + weather forecast
- This makes the simulation progressively more accurate throughout the day — 100% real data by 23:00

**What to store vs. delete:**
- **Keep permanently:** Hourly averages — one `{ hour, avgTemp, avgSetpoint, sample_count }` row per zone per hour (~24 rows/day, negligible storage)
- **Discard:** Individual per-poll raw readings after they are aggregated into hourly buckets

**Suggested DB table:**
```sql
CREATE TABLE zone_hourly_actuals (
  recorded_date  DATE,
  hour           INT,       -- 0–23
  zone           TEXT,
  avg_temp_c     FLOAT,
  avg_setpoint_c FLOAT,
  sample_count   INT        -- how many polls were averaged
);
```

**Status:** ⏸ Parked — waiting for historical data to become available.

---

## 2. PARKED IDEA — Floor Plan Recognition for Multi-Zone Expansion

**Context:** The current manual wall-by-wall entry is too friction-heavy for real offices with multiple zones (Working Area, Pantry, Meeting Room, Reception, etc.). A floor plan–based approach is needed.

### Proposed Architecture: Hybrid AI + Guided Wizard

**Stage 1 — Upload floor plan**
User uploads image or PDF of the office floor plan (photo, PNG export, or sketch).

**Stage 2 — AI room detection (Gemini Vision)**
- Already have `geminiService.ts` — this is the key asset
- Gemini identifies rooms/zones by label, estimates room shapes and relative proportions
- Classifies walls as **external** (on building perimeter) vs. **internal** (shared between rooms)
- Effort: ~2 days of work given existing Gemini integration

**Stage 3 — Scale calibration**
- Images have no inherent scale — one reference measurement is required
- App highlights a wall and asks: *"What is the length of this wall?"*
- All other dimensions are derived from this single input

**Stage 4 — Zone-by-zone confirmation wizard**
For each detected zone, a simple card asks only what AI cannot determine from the image:
- Is this external wall exposed to outside air, or does it face another building?
- Does this external wall have windows? If yes — less than 25%, ~50%, or more than 75% glazed?
- What is this wall made of — concrete/brick, glass curtain wall, or a mix?
- For internal walls: solid wall or glass partition?

**Stage 5 — Auto-calculation**
Once wizard is complete, the app auto-computes wall areas, window areas, internal/external classification, and runs `calculateHeatLoad` for each zone. No manual entry.

### What AI Will Get Right vs. Struggle With

| AI handles well | AI will struggle with |
|---|---|
| Room labels and names | Exact dimensions without annotation |
| Perimeter vs. internal wall classification | Differentiating structural vs. partition walls |
| Rough room proportions | Identifying floor level (for roof heat gain) |
| Number of rooms and layout | Low-res or angled photos |

All failure cases are recoverable via targeted user questions or conservative defaults.

### Constraints and Decisions
- **Do not** attempt DXF/DWG parsing — too complex, ask users to export as PNG/PDF
- **Do not** auto-detect wall material from image — always a user input, but simplified to a one-click choice
- **Do not** handle non-rectangular rooms automatically in v1 — flag as "complex geometry" and ask user to approximate area

### Recommended Build Order
1. Stage 1 + 2: Upload + AI detection (independently shippable)
2. Stage 3: Scale calibration
3. Stage 4: Zone wizard UI (most time-consuming — ~2–3 weeks)
4. Stage 5: Auto-calculation wiring

**Estimated effort:** 3–4 weeks of focused development

**Status:** ⏸ Parked — implement when ready. Say the word to start.

---

## Summary of Decisions

| Topic | Decision | Status |
|---|---|---|
| Live temp/setpoint wiring into heat load | Ready to implement (quick fix) | ⏸ Parked |
| Historical hourly data model | Waiting for historical DB data | ⏸ Parked |
| Floor plan zone recognition | Architecture defined, ready to build | ⏸ Parked |

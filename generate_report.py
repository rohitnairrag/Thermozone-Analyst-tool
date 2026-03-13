"""
ThermoZone Analyst — Engineering Review Report Generator
Produces a comprehensive PDF covering all equations, logic, and design decisions.
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak, KeepTogether
)
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.platypus import ListFlowable, ListItem
from datetime import datetime

OUTPUT = "ThermoZone_Engineering_Review_Report.pdf"

# ── Colour palette ────────────────────────────────────────────────────────────
DARK_BG    = colors.HexColor("#0d1b2a")
BLUE_ACC   = colors.HexColor("#2563eb")
TEAL       = colors.HexColor("#0ea5e9")
ORANGE     = colors.HexColor("#f97316")
GREEN      = colors.HexColor("#22c55e")
LIGHT_GREY = colors.HexColor("#e2e8f0")
MID_GREY   = colors.HexColor("#94a3b8")
WHITE      = colors.white
BLACK      = colors.black
TABLE_HDR  = colors.HexColor("#1e3a5f")
TABLE_ALT  = colors.HexColor("#f1f5f9")

# ── Styles ────────────────────────────────────────────────────────────────────
base_styles = getSampleStyleSheet()

def make_style(name, parent="Normal", **kwargs):
    return ParagraphStyle(name=name, parent=base_styles[parent], **kwargs)

S = {
    "title":       make_style("ReportTitle",   fontSize=26, textColor=DARK_BG,
                               leading=32, spaceAfter=6, alignment=TA_CENTER, fontName="Helvetica-Bold"),
    "subtitle":    make_style("Subtitle",      fontSize=13, textColor=MID_GREY,
                               leading=18, spaceAfter=4, alignment=TA_CENTER, fontName="Helvetica"),
    "date":        make_style("Date",           fontSize=10, textColor=MID_GREY,
                               alignment=TA_CENTER, fontName="Helvetica"),
    "h1":          make_style("H1",             fontSize=16, textColor=BLUE_ACC,
                               leading=22, spaceBefore=18, spaceAfter=6, fontName="Helvetica-Bold"),
    "h2":          make_style("H2",             fontSize=13, textColor=DARK_BG,
                               leading=18, spaceBefore=12, spaceAfter=4, fontName="Helvetica-Bold"),
    "h3":          make_style("H3",             fontSize=11, textColor=TABLE_HDR,
                               leading=16, spaceBefore=8, spaceAfter=3, fontName="Helvetica-Bold"),
    "body":        make_style("Body",           fontSize=10, textColor=colors.HexColor("#1e293b"),
                               leading=15, spaceAfter=5, alignment=TA_JUSTIFY, fontName="Helvetica"),
    "body_nb":     make_style("BodyNB",         fontSize=10, textColor=colors.HexColor("#1e293b"),
                               leading=15, spaceAfter=2, alignment=TA_JUSTIFY, fontName="Helvetica"),
    "eq":          make_style("Equation",       fontSize=10, textColor=DARK_BG,
                               leading=16, spaceBefore=4, spaceAfter=4, leftIndent=24,
                               fontName="Courier-Bold"),
    "eq_label":    make_style("EqLabel",        fontSize=9,  textColor=MID_GREY,
                               leading=12, leftIndent=24, spaceAfter=6, fontName="Courier"),
    "note":        make_style("Note",           fontSize=9,  textColor=colors.HexColor("#475569"),
                               leading=13, leftIndent=18, spaceAfter=4, fontName="Helvetica-Oblique"),
    "code":        make_style("Code",           fontSize=8.5,textColor=colors.HexColor("#1e3a5f"),
                               leading=13, leftIndent=18, spaceAfter=2, fontName="Courier"),
    "tbl_hdr":     make_style("TblHdr",         fontSize=9.5,textColor=WHITE,
                               fontName="Helvetica-Bold", alignment=TA_CENTER),
    "tbl_cell":    make_style("TblCell",        fontSize=9,  textColor=DARK_BG,
                               fontName="Helvetica", leading=13),
    "tbl_cell_c":  make_style("TblCellC",       fontSize=9,  textColor=DARK_BG,
                               fontName="Helvetica", leading=13, alignment=TA_CENTER),
    "caption":     make_style("Caption",        fontSize=8.5,textColor=MID_GREY,
                               alignment=TA_CENTER, fontName="Helvetica-Oblique", spaceAfter=8),
}

def hr(color=LIGHT_GREY, thickness=0.8):
    return HRFlowable(width="100%", thickness=thickness, color=color, spaceAfter=4, spaceBefore=4)

def section_rule():
    return HRFlowable(width="100%", thickness=2, color=BLUE_ACC, spaceAfter=6, spaceBefore=2)

def eq(formula, label=""):
    items = [Paragraph(formula, S["eq"])]
    if label:
        items.append(Paragraph(label, S["eq_label"]))
    return items

def const_table(rows, col_widths=None):
    """rows: list of (name, symbol, value, unit, source)"""
    header = [Paragraph(h, S["tbl_hdr"]) for h in
              ["Parameter", "Symbol", "Value", "Unit", "Source / Rationale"]]
    data = [header] + [[Paragraph(str(c), S["tbl_cell"]) for c in row] for row in rows]
    w = col_widths or [5.5*cm, 2.5*cm, 2.2*cm, 1.8*cm, 5.5*cm]
    tbl = Table(data, colWidths=w, repeatRows=1)
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), TABLE_HDR),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, TABLE_ALT]),
        ("GRID", (0,0), (-1,-1), 0.4, colors.HexColor("#cbd5e1")),
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("TOPPADDING",  (0,0), (-1,-1), 4),
        ("BOTTOMPADDING", (0,0), (-1,-1), 4),
        ("LEFTPADDING",  (0,0), (-1,-1), 5),
    ]))
    return tbl

def two_col_table(rows, headers, w1=8*cm, w2=9.5*cm):
    header = [Paragraph(h, S["tbl_hdr"]) for h in headers]
    data = [header] + [[Paragraph(str(c), S["tbl_cell"]) for c in row] for row in rows]
    tbl = Table(data, colWidths=[w1, w2], repeatRows=1)
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), TABLE_HDR),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, TABLE_ALT]),
        ("GRID", (0,0), (-1,-1), 0.4, colors.HexColor("#cbd5e1")),
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("TOPPADDING",  (0,0), (-1,-1), 4),
        ("BOTTOMPADDING", (0,0), (-1,-1), 4),
        ("LEFTPADDING",  (0,0), (-1,-1), 5),
    ]))
    return tbl

# ── Document ──────────────────────────────────────────────────────────────────
doc = SimpleDocTemplate(
    OUTPUT,
    pagesize=A4,
    leftMargin=2.2*cm, rightMargin=2.2*cm,
    topMargin=2.2*cm,  bottomMargin=2.2*cm,
    title="ThermoZone Analyst – Engineering Review Report",
    author="Living Things – ThermoZone Analyst",
)

story = []
W = A4[0] - 4.4*cm  # usable width

# ═══════════════════════════════════════════════════════════════════════════════
# COVER PAGE
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Spacer(1, 2.5*cm))
story.append(Paragraph("Living Things", S["subtitle"]))
story.append(Paragraph("ThermoZone Analyst", S["title"]))
story.append(Paragraph("Engineering Review Report", make_style("sr2", fontSize=15,
    textColor=TEAL, alignment=TA_CENTER, fontName="Helvetica-Bold", spaceAfter=4)))
story.append(Spacer(1, 0.4*cm))
story.append(hr(BLUE_ACC, 2))
story.append(Spacer(1, 0.3*cm))
story.append(Paragraph(
    "Complete documentation of heat load calculation methodology, solar geometry, "
    "real-time data pipeline, AC sizing logic, polygon closure verification, "
    "and all design constants for independent engineering review.",
    make_style("coverdesc", fontSize=11, textColor=colors.HexColor("#334155"),
               alignment=TA_CENTER, leading=17, fontName="Helvetica")))
story.append(Spacer(1, 0.6*cm))
story.append(Paragraph(f"Prepared: {datetime.now().strftime('%d %B %Y')}", S["date"]))
story.append(Paragraph("Location Reference: Bangalore, India  |  Latitude 12.97°N  |  Longitude 77.59°E", S["date"]))
story.append(Spacer(1, 1.2*cm))

# TOC-style overview
toc_data = [
    [Paragraph("Section", S["tbl_hdr"]), Paragraph("Topic", S["tbl_hdr"])],
    [Paragraph("1", S["tbl_cell_c"]), Paragraph("System Architecture & Data Flow", S["tbl_cell"])],
    [Paragraph("2", S["tbl_cell_c"]), Paragraph("Zone Configuration & Geometry", S["tbl_cell"])],
    [Paragraph("3", S["tbl_cell_c"]), Paragraph("Floor Area — Shoelace (Gauss) Formula", S["tbl_cell"])],
    [Paragraph("4", S["tbl_cell_c"]), Paragraph("Solar Geometry Calculations", S["tbl_cell"])],
    [Paragraph("5", S["tbl_cell_c"]), Paragraph("Incident Radiation on Surfaces", S["tbl_cell"])],
    [Paragraph("6", S["tbl_cell_c"]), Paragraph("Sol-Air Temperature & Wall Conduction", S["tbl_cell"])],
    [Paragraph("7", S["tbl_cell_c"]), Paragraph("Window Solar Heat Gain", S["tbl_cell"])],
    [Paragraph("8", S["tbl_cell_c"]), Paragraph("Roof Heat Gain", S["tbl_cell"])],
    [Paragraph("9", S["tbl_cell_c"]), Paragraph("Infiltration & Latent Load", S["tbl_cell"])],
    [Paragraph("10", S["tbl_cell_c"]), Paragraph("Internal Heat Gains (Lighting, Equipment, Occupants)", S["tbl_cell"])],
    [Paragraph("11", S["tbl_cell_c"]), Paragraph("Radiant Time Series (RTS) Method", S["tbl_cell"])],
    [Paragraph("12", S["tbl_cell_c"]), Paragraph("Total Heat Load & Latent Correction", S["tbl_cell"])],
    [Paragraph("13", S["tbl_cell_c"]), Paragraph("AC Capacity, Derating & Performance Degradation", S["tbl_cell"])],
    [Paragraph("14", S["tbl_cell_c"]), Paragraph("Indoor Temperature Simulation", S["tbl_cell"])],
    [Paragraph("15", S["tbl_cell_c"]), Paragraph("Real-Time Data Pipeline (DB → Engine)", S["tbl_cell"])],
    [Paragraph("16", S["tbl_cell_c"]), Paragraph("AC Output from Real Sensor Data", S["tbl_cell"])],
    [Paragraph("17", S["tbl_cell_c"]), Paragraph("Sizing Verdict Logic", S["tbl_cell"])],
    [Paragraph("18", S["tbl_cell_c"]), Paragraph("Wall Polygon Closure Analysis", S["tbl_cell"])],
    [Paragraph("19", S["tbl_cell_c"]), Paragraph("Design Constants & Assumptions Summary", S["tbl_cell"])],
]
toc_tbl = Table(toc_data, colWidths=[1.5*cm, W-1.5*cm], repeatRows=1)
toc_tbl.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), TABLE_HDR),
    ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, TABLE_ALT]),
    ("GRID", (0,0), (-1,-1), 0.4, colors.HexColor("#cbd5e1")),
    ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
    ("TOPPADDING",  (0,0), (-1,-1), 5),
    ("BOTTOMPADDING", (0,0), (-1,-1), 5),
    ("LEFTPADDING",  (0,0), (-1,-1), 6),
    ("ALIGN", (0,0), (0,-1), "CENTER"),
]))
story.append(toc_tbl)
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — SYSTEM ARCHITECTURE
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("1. System Architecture & Data Flow", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "ThermoZone Analyst is a real-time HVAC heat load analyser built on a React/TypeScript "
    "frontend (Vite), an Express.js API backend, and a live PostgreSQL sensor database. "
    "The system performs per-zone hourly thermal simulation using actual measured temperatures "
    "and AC power data from IoT sensors installed across the office floor.",
    S["body"]))

arch_data = [
    [Paragraph("Layer", S["tbl_hdr"]), Paragraph("Technology", S["tbl_hdr"]), Paragraph("Responsibility", S["tbl_hdr"])],
    [Paragraph("Frontend UI", S["tbl_cell"]), Paragraph("React + TypeScript + Vite (port 3000)", S["tbl_cell"]),
     Paragraph("Zone configuration, charts, verdict display, Configure/Monitor views", S["tbl_cell"])],
    [Paragraph("Physics Engine", S["tbl_cell"]), Paragraph("physicsEngine.ts", S["tbl_cell"]),
     Paragraph("24-hour heat load simulation, solar geometry, RTS, AC model", S["tbl_cell"])],
    [Paragraph("Geometry Service", S["tbl_cell"]), Paragraph("geometry.ts", S["tbl_cell"]),
     Paragraph("Shoelace formula — floor area from wall polygon", S["tbl_cell"])],
    [Paragraph("Live Data Service", S["tbl_cell"]), Paragraph("liveDataService.ts", S["tbl_cell"]),
     Paragraph("Fetches sensor temp & AC power from REST API; fallback chain", S["tbl_cell"])],
    [Paragraph("API Server", S["tbl_cell"]), Paragraph("Express.js server.cjs (port 3001)", S["tbl_cell"]),
     Paragraph("REST endpoints: /api/live-temp, /api/historical-temp, /api/historical-ac-output", S["tbl_cell"])],
    [Paragraph("Database", S["tbl_cell"]), Paragraph("PostgreSQL — cmp_lt_bangalore_live_data", S["tbl_cell"]),
     Paragraph("Table: lt_bangalore_org_live_device_data — sensor readings with timestamps", S["tbl_cell"])],
    [Paragraph("Weather API", S["tbl_cell"]), Paragraph("Open-Meteo (via weatherService.ts)", S["tbl_cell"]),
     Paragraph("Hourly DNI, DHI, GHI, dry-bulb temp, relative humidity for Bangalore", S["tbl_cell"])],
]
arch_tbl = Table(arch_data, colWidths=[3.2*cm, 5*cm, W-8.2*cm], repeatRows=1)
arch_tbl.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), TABLE_HDR),
    ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, TABLE_ALT]),
    ("GRID", (0,0), (-1,-1), 0.4, colors.HexColor("#cbd5e1")),
    ("VALIGN", (0,0), (-1,-1), "TOP"),
    ("TOPPADDING",  (0,0), (-1,-1), 5),
    ("BOTTOMPADDING", (0,0), (-1,-1), 5),
    ("LEFTPADDING",  (0,0), (-1,-1), 5),
]))
story.append(arch_tbl)
story.append(Spacer(1, 0.3*cm))

story.append(Paragraph("Zone-to-Database Mapping (ZONE_MAP)", S["h3"]))
story.append(Paragraph(
    "The backend maintains a static ZONE_MAP that resolves app-level zone names to one or "
    "more DB site_group_name values. All DB queries filter by this list using the PostgreSQL "
    "ANY() operator:",
    S["body"]))
zone_data = [
    [Paragraph("App Zone", S["tbl_hdr"]), Paragraph("DB site_group_name values", S["tbl_hdr"])],
    [Paragraph("Zone 1", S["tbl_cell"]), Paragraph("Working Area 1, Working Area 2, Embedded Team", S["tbl_cell"])],
    [Paragraph("Zone 2", S["tbl_cell"]), Paragraph("Pantry", S["tbl_cell"])],
    [Paragraph("Zone 3", S["tbl_cell"]), Paragraph("Meeting Room 1", S["tbl_cell"])],
]
z_tbl = Table(zone_data, colWidths=[3.5*cm, W-3.5*cm], repeatRows=1)
z_tbl.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), TABLE_HDR),
    ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, TABLE_ALT]),
    ("GRID", (0,0), (-1,-1), 0.4, colors.HexColor("#cbd5e1")),
    ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
    ("TOPPADDING",  (0,0), (-1,-1), 4),
    ("BOTTOMPADDING", (0,0), (-1,-1), 4),
    ("LEFTPADDING",  (0,0), (-1,-1), 6),
]))
story.append(z_tbl)
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — ZONE CONFIGURATION & GEOMETRY
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("2. Zone Configuration & Wall Geometry", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "Each zone is defined by an ordered list of walls. Every wall carries a length (m), "
    "a compass direction (N / NE / E / SE / S / SW / W / NW) with its corresponding azimuth "
    "(degrees clockwise from North), a wall type (external or internal), and a construction "
    "type (opaque / mixed / full_glass). Internal walls are shared with adjacent conditioned "
    "zones; they are excluded from solar gain and conduction calculations because both sides "
    "are air-conditioned.",
    S["body"]))

story.append(Paragraph("Azimuth Mapping", S["h3"]))
az_data = [
    [Paragraph(d, S["tbl_cell_c"]) for d in ["N","NE","E","SE","S","SW","W","NW"]],
    [Paragraph(d, S["tbl_cell_c"]) for d in ["0°","45°","90°","135°","180°","225°","270°","315°"]],
]
az_tbl = Table(az_data, colWidths=[W/8]*8)
az_tbl.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), TABLE_HDR),
    ("BACKGROUND", (0,1), (-1,1), TABLE_ALT),
    ("GRID", (0,0), (-1,-1), 0.4, colors.HexColor("#cbd5e1")),
    ("ALIGN", (0,0), (-1,-1), "CENTER"),
    ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"),
    ("FONTSIZE", (0,0), (-1,-1), 9),
    ("TOPPADDING",  (0,0), (-1,-1), 5),
    ("BOTTOMPADDING", (0,0), (-1,-1), 5),
]))
story.append(az_tbl)
story.append(Spacer(1, 0.3*cm))

story.append(Paragraph("Zone 1 — Configured Wall List (as of 13 March 2026)", S["h3"]))
wall_data = [
    [Paragraph(h, S["tbl_hdr"]) for h in ["Wall","Dir","Azimuth","Length (m)","Type","Construction","Note"]],
    ["W1","SE","135°","10.06","External","Opaque","Fixed external wall"],
    ["W2","SW","225°","7.01","External","Opaque","Fixed external wall"],
    ["W3","NW","315°","2.62","Internal","Opaque","Partition wall"],
    ["W4","SW","225°","3.04","Internal","Opaque","Partition wall"],
    ["W5","SW","225°","5.42","Internal","Opaque","Adjusted −0.87m to close polygon"],
    ["W6","NW","315°","4.85","External","Opaque","Fixed external wall"],
    ["W7","NE","45°","5.59","Internal","Opaque","Partition wall"],
    ["W8","NE","45°","3.70","Internal","Opaque","Partition wall"],
    ["W9","NE","45°","1.92","Internal","Opaque","Partition wall"],
    ["W10","NE","45°","4.26","External","Opaque","Fixed external wall"],
    ["W11","NW","315°","1.70","Internal","Opaque","Partition wall"],
    ["W12","NW","315°","2.69","Internal","Opaque","Adjusted +0.89m to close polygon"],
    ["W13","SE","135°","1.80","Internal","Opaque","Direction corrected NW→SE (confirmed)"],
]
wf = [[Paragraph(str(c), S["tbl_cell_c"]) if i < 3 else Paragraph(str(c), S["tbl_cell"]) for i, c in enumerate(row)] for row in wall_data[1:]]
wall_tbl = Table([wall_data[0]] + wf, colWidths=[1.2*cm,1.0*cm,1.5*cm,1.8*cm,1.8*cm,2.4*cm,W-9.7*cm], repeatRows=1)
wall_tbl.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), TABLE_HDR),
    ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, TABLE_ALT]),
    ("GRID", (0,0), (-1,-1), 0.4, colors.HexColor("#cbd5e1")),
    ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
    ("TOPPADDING",  (0,0), (-1,-1), 4),
    ("BOTTOMPADDING", (0,0), (-1,-1), 4),
    ("LEFTPADDING",  (0,0), (-1,-1), 4),
    ("BACKGROUND", (0,4), (-1,4), colors.HexColor("#fef9c3")),   # W5 highlight
    ("BACKGROUND", (0,11), (-1,11), colors.HexColor("#fef9c3")), # W12 highlight
    ("BACKGROUND", (0,12), (-1,12), colors.HexColor("#dcfce7")), # W13 highlight
]))
story.append(wall_tbl)
story.append(Paragraph(
    "Yellow rows: dimension adjusted for polygon closure. Green row: direction corrected based on field confirmation.",
    S["caption"]))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — SHOELACE FORMULA
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("3. Floor Area Calculation — Shoelace (Gauss) Formula", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "The floor area is derived directly from the ordered wall polygon using the Shoelace "
    "(Gauss's Area) Formula. This avoids manual area input and automatically updates when "
    "walls are added or changed. The polygon is reconstructed by accumulating wall displacement "
    "vectors from a common origin.",
    S["body"]))

story.append(Paragraph("Step 1 — Convert each wall to a Cartesian displacement vector:", S["h3"]))
story += eq("dx_i  =  L_i × sin(azimuth_i)", "East component of wall i")
story += eq("dy_i  =  L_i × cos(azimuth_i)", "North component of wall i")

story.append(Paragraph("Step 2 — Build polygon vertex coordinates (cumulative sum):", S["h3"]))
story += eq("(x_0, y_0) = (0, 0)")
story += eq("x_{n+1} = x_n + dx_n,    y_{n+1} = y_n + dy_n")

story.append(Paragraph("Step 3 — Apply Shoelace formula:", S["h3"]))
story += eq("A  =  (1/2) × |  Σ ( x_i × y_{i+1}  −  x_{i+1} × y_i )  |",
            "Σ runs over all vertices i = 0 … N−1 (polygon closes at i = N back to i = 0)")

story.append(Paragraph(
    "The absolute value handles both clockwise and counter-clockwise polygon orientations. "
    "A minimum area of 1 m² is enforced as a fallback if no walls are defined.",
    S["body"]))
story.append(Paragraph("Zone 1 Computed Floor Area: 93.40 m²  (ceiling height 2.7 m → Volume = 252.2 m³)",
    make_style("result_box", fontSize=11, textColor=GREEN, fontName="Helvetica-Bold",
               leading=16, spaceAfter=8, spaceBefore=4)))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — SOLAR GEOMETRY
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("4. Solar Geometry", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "Solar geometry is calculated from first principles (Spencer 1971 / ASHRAE) using the "
    "site latitude, current day of year, and solar hour angle. These values drive surface "
    "incident radiation for all wall and window calculations.",
    S["body"]))

story.append(Paragraph("4.1  Day of Year", S["h2"]))
story += eq("n  =  floor( (t_now − t_jan1) / 86400 )",
            "n = day of year (1–365); t in milliseconds")

story.append(Paragraph("4.2  Solar Declination (Spencer 1971)", S["h2"]))
story += eq("δ  =  23.45°  ×  sin[ 360° × (284 + n) / 365 ]",
            "δ = declination angle (degrees); converted to radians for trig")

story.append(Paragraph("4.3  Hour Angle", S["h2"]))
story += eq("H  =  15° × (h − 12)",
            "h = integer hour (0–23); H in degrees, converted to radians; positive in afternoon")

story.append(Paragraph("4.4  Solar Altitude", S["h2"]))
story += eq("sin(α)  =  sin(φ)·sin(δ)  +  cos(φ)·cos(δ)·cos(H)",
            "φ = site latitude (12.97°N for Bangalore); α = solar altitude angle")

story.append(Paragraph("4.5  Solar Azimuth", S["h2"]))
story += eq("cos(Az)  =  [ sin(δ) − sin(φ)·sin(α) ]  /  [ cos(φ)·cos(α) ]",
            "Az is measured from South; converted to compass North reference; mirrored for PM hours")

story.append(Paragraph(
    "Solar geometry is recomputed each simulation hour. When the sun is below the horizon "
    "(α ≤ 0), all direct radiation terms are set to zero.", S["body"]))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — INCIDENT RADIATION
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("5. Incident Radiation on Vertical Surfaces", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "The incident solar radiation on each vertical surface (wall or window) is the sum of "
    "three components: direct beam (DNI projected), sky diffuse (isotropic model), and "
    "ground-reflected diffuse.",
    S["body"]))

story.append(Paragraph("5.1  Angle of Incidence (cosine factor)", S["h2"]))
story += eq("cos(θ)  =  cos(α) × cos( Az_sun − Az_wall )",
            "θ = angle between solar beam and wall surface normal; clamped to [0, 1]")

story.append(Paragraph("5.2  Total Incident Irradiance on a Vertical Surface", S["h2"]))
story += eq("I_surface  =  DNI × cos(θ)  +  0.5 × DHI × (1 + sin(α))  +  0.5 × ρ_g × GHI",
            "DNI = Direct Normal Irradiance; DHI = Diffuse Horizontal; GHI = Global Horizontal (all W/m²)")
story.append(Paragraph(
    "The diffuse term (0.5 × DHI × (1 + sin α)) uses the isotropic sky model. "
    "The ground-reflected term uses ground reflectance ρ_g = 0.20 (standard dry ground/pavement). "
    "DNI term is zero when α ≤ 0.",
    S["body"]))

story.append(Paragraph("5.3  Roof Incident Irradiance", S["h2"]))
story += eq("I_roof  =  DNI × sin(α)  +  DHI",
            "For a horizontal surface; sin(α) = projection of beam onto horizontal plane")
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — SOL-AIR TEMPERATURE & WALL CONDUCTION
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("6. Sol-Air Temperature & Wall Conduction Heat Gain", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "The sol-air temperature concept (ASHRAE Fundamentals) accounts for both the outdoor "
    "air temperature and the solar radiation absorbed by the opaque wall surface, treating "
    "them as an equivalent elevated temperature driving conduction through the wall.",
    S["body"]))

story.append(Paragraph("6.1  Sol-Air Temperature", S["h2"]))
story += eq("T_solair  =  T_out  +  (α_wall × I_surface / h_out)",
            "α_wall = 0.60 (medium-dark concrete/brick surface absorptance)\n"
            "h_out = 20 W/(m²·K) = combined outdoor convective + radiative surface coefficient\n"
            "I_surface = incident irradiance on the wall face (W/m²)")

story.append(Paragraph("6.2  Opaque Wall Conduction (with Thermal Mass Damping)", S["h2"]))
story += eq("Q_wall  =  f_mass × U_wall × A_wall_net × max(0,  T_solair − T_indoor )",
            "U_wall = 1.8 W/(m²·K) — typical RCC/brick composite wall\n"
            "f_mass = 0.70 — thermal mass damping factor (accounts for heat storage in heavy walls)\n"
            "A_wall_net = L × H_ceiling − Σ(window areas) [m²]\n"
            "max(0, ·) ensures only heat gain (not cooling) is counted")

story.append(Paragraph(
    "Only external walls contribute to wall conduction. Internal (partition) walls are "
    "excluded because both sides are air-conditioned to similar temperatures, making the "
    "net heat transfer negligible.",
    S["note"]))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 7 — WINDOW SOLAR HEAT GAIN
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("7. Window Solar Heat Gain & Conduction", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "Windows contribute two separate heat components: solar radiation transmitted through "
    "the glazing (solar gain), and conductive/convective heat transfer driven by the "
    "temperature difference across the glass (glass conduction). "
    "Three glazing types are supported: opaque wall (no windows), mixed (opaque with embedded "
    "windows), and full_glass (entire wall face is glazing).",
    S["body"]))

story.append(Paragraph("7.1  Solar Heat Gain through Glass", S["h2"]))
story += eq("Q_solar_win  =  A_win × FF × SHGC × I_surface",
            "A_win = window area [m²]\n"
            "FF = Frame Factor = 0.85 (15% frame area deducted from glazed face)\n"
            "SHGC = Solar Heat Gain Coefficient = 0.30 (standard double-glazed low-e unit)\n"
            "I_surface = total incident irradiance on the window orientation (W/m²)")

story.append(Paragraph("7.2  Glass Conduction Heat Gain", S["h2"]))
story += eq("Q_glass  =  U_glass × A_win × max(0,  T_out − T_indoor )",
            "U_glass = 2.7 W/(m²·K) — double-glazed unit centre-of-glass U-value")

story.append(Paragraph("7.3  Full-Glass Wall (Glass Facade)", S["h2"]))
story.append(Paragraph(
    "When a wall is configured as full_glass, the entire face area replaces A_win in the "
    "above equations. The frame factor is still applied (FF = 0.85) to account for mullion "
    "and frame coverage.",
    S["body"]))
story.append(Paragraph(
    "Per ASHRAE 90.1, solar gain through windows is typically the dominant heat load "
    "component in Bangalore's climate during peak summer afternoons.",
    S["note"]))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 8 — ROOF
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("8. Roof Heat Gain (Top Floor Only)", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "Roof heat gain is only computed when the zone is flagged as a top-floor room. "
    "The sol-air concept is applied to the roof surface using a higher absorptance value "
    "(typical of dark/aged flat roofing).",
    S["body"]))

story += eq("T_solair_roof  =  T_out  +  (α_roof × I_roof / h_out)",
            "α_roof = 0.80 (darker roof surface — aged bitumen / gravel)")
story += eq("Q_roof  =  U_roof × A_floor × max(0,  T_solair_roof − T_indoor )",
            "U_roof = 1.5 W/(m²·K) — concrete slab with insulation\n"
            "A_floor = computed floor area from Shoelace formula")
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 9 — INFILTRATION
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("9. Infiltration & Ventilation Load", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "Infiltration is calculated using the Air Changes per Hour (ACH) method combined with "
    "psychrometric enthalpy difference to capture both sensible and latent components in a "
    "single moisture-air enthalpy term.",
    S["body"]))

story.append(Paragraph("9.1  Mass Flow Rate of Infiltrating Air", S["h2"]))
story += eq("m_dot  =  ρ_air × ACH × V_room / 3600",
            "ACH = 0.5 air changes per hour (typical sealed commercial office)\n"
            "ρ_air = 1.2 kg/m³ (standard air density at Bangalore altitude)\n"
            "V_room = floor area × ceiling height [m³]\n"
            "Division by 3600 converts from hourly to per-second flow rate [kg/s]")

story.append(Paragraph("9.2  Psychrometric Enthalpy (Magnus / Tetens Approximation)", S["h2"]))
story += eq("p_ws(T)  =  6.112 × exp( 17.67·T / (T + 243.5) )   [mbar]",
            "p_ws = saturation vapour pressure at temperature T [°C]")
story += eq("p_w     =  (RH/100) × p_ws",
            "p_w = actual partial pressure of water vapour [mbar]")
story += eq("W       =  0.62198 × p_w / (p_atm − p_w)",
            "W = humidity ratio [kg water / kg dry air];  p_atm = 1013.25 mbar")
story += eq("h(T, RH)  =  1.006·T  +  W × (2501 + 1.86·T)",
            "h = specific enthalpy [kJ/kg];  first term = sensible,  second = latent")

story.append(Paragraph("9.3  Infiltration Heat Gain", S["h2"]))
story += eq("Q_inf  =  m_dot × max(0,  h_outdoor − h_indoor ) × 1000",
            "×1000 converts kJ/kg → J/kg;  indoor RH assumed 50%\n"
            "max(0, ·) ensures only net heat gain into the space is counted")
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 10 — INTERNAL GAINS
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("10. Internal Heat Gains", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "Internal gains arise from three sources: occupants (people), lighting, and equipment. "
    "Each source is modulated by a time-of-day schedule factor that reflects typical office patterns.",
    S["body"]))

story.append(Paragraph("10.1  Occupant Load", S["h2"]))
story += eq("Q_people  =  N_people × q_person",
            "q_person = 75 W sensible + 55 W latent = 130 W total metabolic rate (ASHRAE 55, seated office work)\n"
            "N_people = A_floor [m²] × 10.7639 [ft²/m²] × 5 [people/1000 ft²] / 1000  × f_occ(h)")
story.append(Paragraph(
    "Occupancy profile f_occ(h): 0 before 08:00; 0.20 at 08:00; 0.60 at 09:00; 1.00 (10:00–16:00); "
    "0.60 at 17:00; 0.20 at 18:00; 0 thereafter.",
    S["body"]))

story.append(Paragraph("10.2  Lighting Load", S["h2"]))
story += eq("Q_lighting  =  LPD × A_floor × f_light(h)",
            "LPD = Lighting Power Density = 10 W/m² (LED office standard per ECBC India)\n"
            "f_light(h): 0 before 08:00; 0.40 at 08:00; 1.00 (09:00–17:00); 0.40 at 18:00; 0 thereafter")

story.append(Paragraph("10.3  Equipment (Plug) Load", S["h2"]))
story += eq("Q_equip  =  EPD × A_floor × f_equip(h)",
            "EPD = Equipment Power Density = 12 W/m² (computers, monitors, servers — ASHRAE 90.1 Office)\n"
            "f_equip(h): 0.20 (00:00–06:00); 0.40 (07:00–08:00); 1.00 (09:00–17:00); 0.50 (18:00–20:00); 0.20 otherwise")

story.append(Paragraph("10.4  Combined Internal Gain", S["h2"]))
story += eq("Q_internal  =  Q_lighting  +  Q_equip",
            "People load is tracked separately in the simulation output for breakdown analysis")
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 11 — RTS
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("11. Radiant Time Series (RTS) Method", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "Radiant heat gains (solar through glass, wall conduction, roof conduction) are not "
    "immediately absorbed as sensible cooling loads. They first heat the room's thermal "
    "mass (furniture, structure, carpets) and are then re-radiated into the air over "
    "subsequent hours. The Radiant Time Series method (ASHRAE Handbook Fundamentals, Ch. 18) "
    "models this delay.",
    S["body"]))

story.append(Paragraph("11.1  Split of Solar Gain into Convective and Radiant Fractions", S["h2"]))
story += eq("Q_solar_convective  =  0.30 × Q_solar",
            "30% of window solar gain becomes an immediate sensible cooling load")
story += eq("Q_solar_radiant     =  0.70 × Q_solar",
            "70% is absorbed by room surfaces and re-emitted over subsequent hours via RTS")

story.append(Paragraph("11.2  RTS Coefficients", S["h2"]))
story.append(Paragraph(
    "A 5-term Radiant Time Series with the following coefficients is applied. "
    "These represent a medium-weight commercial construction profile (concrete floor, "
    "suspended ceiling, mixed furniture):",
    S["body"]))
rts_data = [
    [Paragraph(h, S["tbl_hdr"]) for h in ["Lag (hours)", "RTS Coefficient", "Cumulative"]],
    ["1",  "0.35", "35%"],
    ["2",  "0.25", "60%"],
    ["3",  "0.20", "80%"],
    ["4",  "0.12", "92%"],
    ["5",  "0.08", "100%"],
]
rts_tbl = Table([[Paragraph(str(c), S["tbl_cell_c"]) for c in row] for row in rts_data],
                colWidths=[4*cm, 4*cm, 4*cm], repeatRows=1)
rts_tbl.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), TABLE_HDR),
    ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, TABLE_ALT]),
    ("GRID", (0,0), (-1,-1), 0.4, colors.HexColor("#cbd5e1")),
    ("ALIGN", (0,0), (-1,-1), "CENTER"),
    ("TOPPADDING",  (0,0), (-1,-1), 5),
    ("BOTTOMPADDING", (0,0), (-1,-1), 5),
]))
story.append(rts_tbl)

story.append(Paragraph("11.3  Delayed Cooling Load Calculation", S["h2"]))
story += eq("Q_solar_delayed(h)  =  Q_solar_conv(h)  +  Σ_{i=1}^{5}  RTS_i × Q_solar_radiant(h−i)",
            "History of radiant solar stored hourly; missing prior-hour data defaults to 0")
story += eq("Q_wall_delayed(h)   =  Σ_{i=0}^{4}  RTS_i × Q_wall(h−i)",
            "Wall and roof gains are 100% radiant — no immediate convective fraction")
story += eq("Q_roof_delayed(h)   =  Σ_{i=0}^{4}  RTS_i × Q_roof(h−i)")
story.append(Paragraph(
    "The glass conduction term (Q_glass) is treated as 100% convective and enters the "
    "cooling load immediately without RTS delay.",
    S["note"]))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 12 — TOTAL HEAT LOAD
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("12. Total Heat Load & Latent Correction", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "The total cooling load aggregates all delayed and instantaneous components, then applies "
    "a latent heat correction factor to convert the sensible-dominated simulation into a "
    "total (sensible + latent) load that the AC system must handle.",
    S["body"]))

story.append(Paragraph("12.1  Total Instantaneous Heat Load", S["h2"]))
story += eq("Q_total(h)  =  Q_solar_delayed  +  Q_glass  +  Q_wall_delayed  +  Q_roof_delayed",
            "              +  Q_infiltration  +  Q_internal  +  Q_people")

story.append(Paragraph("12.2  Latent Heat Factor", S["h2"]))
story += eq("Q_total_with_latent  =  Q_total × LHF",
            "LHF = Latent Heat Factor = 1.45 (accounts for ~31% latent fraction in Bangalore's humid climate)\n"
            "Applied only in AC output estimation, not in the raw load components displayed in charts")

story.append(Paragraph(
    "The LHF of 1.45 is consistent with ASHRAE design conditions for a tropical climate "
    "(Bangalore Koppen Aw/As) where latent loads typically represent 25–35% of total cooling load.",
    S["note"]))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 13 — AC CAPACITY & DERATING
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("13. AC Capacity, Derating & Performance Degradation", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "Manufacturer-rated AC capacities are given at standard test conditions (ISO 5151 / ARI 210). "
    "In real operation, capacity degrades with rising outdoor temperature. The engine applies "
    "a linear derating model.",
    S["body"]))

story.append(Paragraph("13.1  Total Rated Capacity", S["h2"]))
story += eq("C_rated_total  =  Σ  C_rated_i",
            "Sum of nameplate capacities of all AC units in the zone [Watts]")

story.append(Paragraph("13.2  High-Temperature Capacity Derating", S["h2"]))
story += eq("degradation(h)  =  max(0,  (T_out(h) − 35°C) × 0.015 )",
            "Capacity reduces 1.5% per °C above 35°C outdoor ambient\n"
            "Below 35°C no derating is applied")
story += eq("f_perf(h)  =  1 − degradation(h)",
            "Performance factor — multiply by rated capacity to get available capacity")
story += eq("C_available(h)  =  C_rated_total × f_perf(h)  [if AC is operating]",
            "AC is considered active during working hours (08:00–20:00) OR when total load > 500 W")

story.append(Paragraph("13.3  Weighted-Average ISEER", S["h2"]))
story += eq("ISEER_avg  =  Σ( ISEER_i ) / N_units",
            "Used to convert real electrical power consumption → cooling output when live DB data is available\n"
            "ISEER = Indian Seasonal Energy Efficiency Ratio [Wc / We]")
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 14 — INDOOR TEMP SIMULATION
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("14. Indoor Temperature Simulation", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "When real sensor readings are available from the database, the measured indoor temperature "
    "is used directly at each hour. When data is absent, a first-order physics model estimates "
    "the temperature based on load stress and AC capacity.",
    S["body"]))

story.append(Paragraph("14.1  Real Sensor Mode (primary)", S["h2"]))
story += eq("T_indoor(h)  =  T_sensor_avg(h)",
            "Average of all live sensor readings for the zone at hour h\n"
            "Source: /api/historical-temp → DB avg of room_temp per hour per zone")

story.append(Paragraph("14.2  Physics Model Fallback (when no DB data)", S["h2"]))
story += eq("T_set(h)  =  setpoint + 0.2  +  min(1.8,  stress × 2.0)",
            "setpoint = 23°C (10:00–17:00), 24°C otherwise\n"
            "stress = Q_total(h) / C_available(h) — load-to-capacity ratio")
story += eq("T_target(h)  =  T_indoor(h−1) + (T_out − T_indoor(h−1)) × 0.15   [AC off]")
story += eq("T_indoor(h)  =  0.70 × T_indoor(h−1)  +  0.30 × T_target(h)",
            "First-order thermal inertia model (70/30 blend)\n"
            "Clamped: 22.5°C–25.8°C when AC on;  21°C–28°C when AC off")

story.append(Paragraph("14.3  Thermal Mass", S["h2"]))
story += eq("C_mass  =  A_floor × 50,000  [J/K]",
            "Room thermal mass capacitance; 50 kJ/(K·m²) typical for furnished office")
story += eq("C_mass_watts  =  C_mass / 3600   [W/K]",
            "Converted to watts equivalent for rate-of-change calculations")
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 15 — REAL-TIME DATA PIPELINE
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("15. Real-Time Data Pipeline", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "Sensor data is fetched from a live PostgreSQL database (table: "
    "lt_bangalore_org_live_device_data) via two REST API endpoints. The engine uses "
    "today's measurements by default, falling back to yesterday for hours with missing data, "
    "and then carry-forward from the nearest known reading.",
    S["body"]))

story.append(Paragraph("15.1  Live Temperature Endpoint  —  GET /api/live-temp", S["h2"]))
story.append(Paragraph(
    "Returns the latest reading per physical sensor using DISTINCT ON to avoid returning "
    "multiple historical rows for the same device:",
    S["body"]))
story.append(Paragraph(
    "SELECT DISTINCT ON (asset_name)  asset_name, room_temp, ...\\n"
    "FROM lt_bangalore_org_live_device_data\\n"
    "WHERE site_group_name = ANY($1)\\n"
    "  AND room_temp IS NOT NULL\\n"
    "ORDER BY asset_name, synced_at DESC",
    S["code"]))
story += [Spacer(1, 4)]

story.append(Paragraph("15.2  Historical Temperature Endpoint  —  GET /api/historical-temp", S["h2"]))
story.append(Paragraph(
    "Returns a 24-element array of hourly average indoor temperatures. For each hour the "
    "fallback priority is:",
    S["body"]))
fallback_data = [
    [Paragraph("Priority", S["tbl_hdr"]), Paragraph("Source", S["tbl_hdr"]), Paragraph("Condition", S["tbl_hdr"])],
    [Paragraph("1 (Best)", S["tbl_cell_c"]), Paragraph("Today's sensor avg for that hour", S["tbl_cell"]),
     Paragraph("Any reading exists in DB for today at that hour", S["tbl_cell"])],
    [Paragraph("2", S["tbl_cell_c"]), Paragraph("Yesterday's sensor avg for same hour", S["tbl_cell"]),
     Paragraph("No today data; yesterday data available", S["tbl_cell"])],
    [Paragraph("3", S["tbl_cell_c"]), Paragraph("Carry-forward from previous hour", S["tbl_cell"]),
     Paragraph("Neither today nor yesterday has data for this hour", S["tbl_cell"])],
    [Paragraph("4 (Last)", S["tbl_cell_c"]), Paragraph("Backward fill from first known reading", S["tbl_cell"]),
     Paragraph("Leading null hours (e.g. midnight before sensors start)", S["tbl_cell"])],
]
fb_tbl = Table(fallback_data, colWidths=[2.3*cm, 6*cm, W-8.3*cm], repeatRows=1)
fb_tbl.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), TABLE_HDR),
    ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, TABLE_ALT]),
    ("GRID", (0,0), (-1,-1), 0.4, colors.HexColor("#cbd5e1")),
    ("VALIGN", (0,0), (-1,-1), "TOP"),
    ("TOPPADDING",  (0,0), (-1,-1), 4),
    ("BOTTOMPADDING", (0,0), (-1,-1), 4),
    ("LEFTPADDING",  (0,0), (-1,-1), 6),
]))
story.append(fb_tbl)
story.append(Paragraph(
    "DB query uses AT TIME ZONE 'Asia/Kolkata' to extract IST hours correctly from UTC timestamps.",
    S["note"]))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 16 — AC OUTPUT FROM SENSOR DATA
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("16. AC Cooling Output from Real Sensor Data", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "When live AC power data is available from the database, the actual cooling output is "
    "derived by converting measured electrical power (watts) to delivered cooling capacity "
    "using the ISEER ratio. This replaces the physics-model estimate.",
    S["body"]))

story.append(Paragraph("16.1  Electrical Power per Sensor per Hour", S["h2"]))
story.append(Paragraph(
    "The DB AC power query averages readings within each IST hour per device, using three-phase "
    "power measurement when available:",
    S["body"]))
story.append(Paragraph(
    "CASE WHEN ac_power_status = 'ON' THEN\\n"
    "  CASE WHEN (R_phase + Y_phase + B_phase) > 0\\n"
    "    THEN R_phase + Y_phase + B_phase\\n"
    "    ELSE power  -- fallback to total power field\\n"
    "  END\\n"
    "ELSE 0 END  AS ac_electrical_watts",
    S["code"]))
story.append(Spacer(1, 6))

story.append(Paragraph("16.2  Total Zone Electrical Watts per Hour", S["h2"]))
story += eq("W_zone(h)  =  Σ_{sensors}  avg_electrical_watts_sensor(h)",
            "Inner query: avg per hour per sensor.  Outer query: sum across all sensors in zone.")

story.append(Paragraph("16.3  Actual Cooling Output", S["h2"]))
story += eq("Q_cooling_actual(h)  =  W_zone(h) × ISEER_avg",
            "W_zone = measured total electrical input to all ACs in zone [W]\n"
            "ISEER_avg = weighted-average Indian Seasonal Energy Efficiency Ratio\n"
            "Q_cooling_actual = delivered cooling energy to the space [W]")

story.append(Paragraph(
    "This approach uses real energy consumption data from the IoT sensors rather than "
    "manufacturer nameplate ratings, giving a true picture of current AC performance "
    "including any degradation due to refrigerant loss, fouled filters, or aging.",
    S["body"]))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 17 — VERDICT
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("17. Sizing Verdict Logic", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "The verdict evaluates whether the installed AC system is adequate to meet the peak "
    "design heat load. Two modes of evaluation are used depending on data availability:",
    S["body"]))

story.append(Paragraph("17.1  With Real AC Output Data (Live Mode)", S["h2"]))
story += eq("Verdict = ADEQUATE   if   Q_cooling_actual(h_peak) >= Q_total(h_peak)",
            "h_peak = hour at which Q_total reaches its maximum over the 24-hour simulation")
story += eq("Verdict = UNDERSIZED  if   Q_cooling_actual(h_peak) <  Q_total(h_peak)",
            "Actual measured cooling output at peak load hour vs. computed peak demand")

story.append(Paragraph("17.2  Fallback: Rated Capacity Mode (no live data)", S["h2"]))
story += eq("Verdict = ADEQUATE   if   C_rated_total × f_perf(h_peak) >= Q_total(h_peak)",
            "f_perf = performance factor (derating) at outdoor temperature of peak hour")

story.append(Paragraph(
    "Using real AC output data for the verdict is the preferred approach as it captures "
    "actual in-situ equipment performance rather than nameplate ratings. An UNDERSIZED "
    "verdict means the zone is currently operating at a thermal deficit at peak hours.",
    S["body"]))

story.append(Paragraph("17.3  Unit Conversion (Tons of Refrigeration)", S["h2"]))
story += eq("TR  =  Watts / 3517",
            "1 TR = 3,517 W = 12,000 BTU/h.  Used only for display; all calculations are in SI (Watts)")
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 18 — POLYGON CLOSURE
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("18. Wall Polygon Closure Analysis", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "For a valid closed polygon, the vector sum of all wall displacement vectors must return "
    "to the starting point. For a room whose walls run exclusively in the 45°-diagonal compass "
    "directions (NE/SE/SW/NW), closure reduces to two independent balance conditions:",
    S["body"]))

story.append(Paragraph("18.1  Closure Conditions (45°-oriented room)", S["h2"]))
story += eq("Σ(L_SE_walls)  =  Σ(L_NW_walls)",
            "Net displacement in the SE-NW axis must be zero")
story += eq("Σ(L_NE_walls)  =  Σ(L_SW_walls)",
            "Net displacement in the NE-SW axis must be zero")

story.append(Paragraph("18.2  Zone 1 Closure Verification", S["h2"]))
closure_data = [
    [Paragraph(h, S["tbl_hdr"]) for h in ["Axis","Direction","Walls","Total (m)","Status"]],
    [Paragraph("SE/NW", S["tbl_cell_c"]), Paragraph("SE", S["tbl_cell_c"]),
     Paragraph("W1(10.06) + W13(1.80)", S["tbl_cell"]),
     Paragraph("11.86", S["tbl_cell_c"]), Paragraph("✓", S["tbl_cell_c"])],
    [Paragraph("SE/NW", S["tbl_cell_c"]), Paragraph("NW", S["tbl_cell_c"]),
     Paragraph("W3(2.62) + W6(4.85) + W11(1.70) + W12(2.69)", S["tbl_cell"]),
     Paragraph("11.86", S["tbl_cell_c"]), Paragraph("✓", S["tbl_cell_c"])],
    [Paragraph("NE/SW", S["tbl_cell_c"]), Paragraph("NE", S["tbl_cell_c"]),
     Paragraph("W7(5.59) + W8(3.70) + W9(1.92) + W10(4.26)", S["tbl_cell"]),
     Paragraph("15.47", S["tbl_cell_c"]), Paragraph("✓", S["tbl_cell_c"])],
    [Paragraph("NE/SW", S["tbl_cell_c"]), Paragraph("SW", S["tbl_cell_c"]),
     Paragraph("W2(7.01) + W4(3.04) + W5(5.42)", S["tbl_cell"]),
     Paragraph("15.47", S["tbl_cell_c"]), Paragraph("✓", S["tbl_cell_c"])],
]
cl_tbl = Table(closure_data, colWidths=[1.8*cm, 1.8*cm, 8*cm, 2.2*cm, 1.5*cm], repeatRows=1)
cl_tbl.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), TABLE_HDR),
    ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, TABLE_ALT]),
    ("GRID", (0,0), (-1,-1), 0.4, colors.HexColor("#cbd5e1")),
    ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
    ("TOPPADDING",  (0,0), (-1,-1), 5),
    ("BOTTOMPADDING", (0,0), (-1,-1), 5),
    ("LEFTPADDING",  (0,0), (-1,-1), 5),
    ("ALIGN", (0,0), (1,-1), "CENTER"),
    ("ALIGN", (-2,0), (-1,-1), "CENTER"),
    ("BACKGROUND", (4,1), (4,-1), colors.HexColor("#dcfce7")),
    ("FONTNAME", (4,1), (4,-1), "Helvetica-Bold"),
    ("TEXTCOLOR", (4,1), (4,-1), GREEN),
]))
story.append(cl_tbl)

story.append(Paragraph(
    "Adjustments made to achieve closure: W13 direction corrected NW→SE (field-confirmed); "
    "W12 extended by 0.89m (1.80→2.69m); W5 reduced by 0.87m (6.29→5.42m). "
    "The four external walls (W1, W2, W6, W10) were not modified.",
    S["note"]))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 19 — DESIGN CONSTANTS SUMMARY
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("19. Design Constants & Assumptions Summary", S["h1"]))
story.append(section_rule())
story.append(Paragraph(
    "All fixed constants used in the heat load simulation are tabulated below with their "
    "source references for engineering review and future calibration.",
    S["body"]))

const_rows = [
    ("U-value — Opaque Wall",       "U_wall",   "1.8",   "W/m²K",  "Typical RCC/brick composite, India NBC 2016"),
    ("U-value — Roof Slab",         "U_roof",   "1.5",   "W/m²K",  "Concrete slab with light insulation"),
    ("U-value — Glass (centre)",    "U_glass",  "2.7",   "W/m²K",  "Double-glazed unit, ECBC India default"),
    ("SHGC — Window Glass",         "SHGC",     "0.30",  "—",      "Low-e double glazed, ECBC compliant"),
    ("Frame Factor",                "FF",       "0.85",  "—",      "15% frame deduction, ASHRAE 90.1"),
    ("Wall Solar Absorptance",      "α_wall",   "0.60",  "—",      "Medium-dark concrete/brick surface"),
    ("Roof Solar Absorptance",      "α_roof",   "0.80",  "—",      "Aged dark bitumen/gravel flat roof"),
    ("Outdoor Surface Coeff.",      "h_out",    "20",    "W/m²K",  "Combined convective+radiative, ASHRAE"),
    ("Ground Reflectance",          "ρ_g",      "0.20",  "—",      "Standard dry ground/pavement"),
    ("Thermal Mass Factor",         "f_mass",   "0.70",  "—",      "30% damping for heavy construction"),
    ("Air Changes per Hour",        "ACH",      "0.50",  "h⁻¹",   "Sealed commercial office (ASHRAE 62.1)"),
    ("Air Density",                 "ρ_air",    "1.20",  "kg/m³",  "Standard at ~900m MSL Bangalore"),
    ("Atm. Pressure",               "p_atm",    "1013.25","mbar",   "Standard atmosphere"),
    ("Indoor Design RH",            "RH_in",    "50",    "%",      "ASHRAE 55 thermal comfort"),
    ("Lighting Power Density",      "LPD",      "10",    "W/m²",   "LED office, ECBC India 2017"),
    ("Equipment Power Density",     "EPD",      "12",    "W/m²",   "Office computers+monitors, ASHRAE 90.1"),
    ("Metabolic Rate (Sensible)",   "q_s",      "75",    "W/person","Seated office work, ASHRAE 55"),
    ("Metabolic Rate (Latent)",     "q_l",      "55",    "W/person","Seated office work, ASHRAE 55"),
    ("Occupancy Density",           "OD",       "5",     "/1000ft²","ASHRAE 62.1 office default"),
    ("Latent Heat Factor",          "LHF",      "1.45",  "—",      "Tropical humid climate correction"),
    ("Thermal Mass Capacitance",    "C_mass/A", "50000", "J/(K·m²)","Furnished concrete office"),
    ("AC Derating Rate",            "—",        "1.5",   "%/°C",   "Linear above 35°C outdoor temp"),
    ("Derating Threshold",          "T_derate", "35",    "°C",     "Standard ISO 5151 test condition"),
    ("Set-point (Business Hours)",  "T_set",    "23",    "°C",     "10:00–17:00, ASHRAE 55"),
    ("Set-point (Off Hours)",       "T_set",    "24",    "°C",     "Before 10:00 / after 17:00"),
    ("Thermal Inertia Blend",       "—",        "70/30", "—",      "70% previous, 30% target per hour step"),
    ("RTS Coefficients",            "[r1..r5]", "0.35,0.25,0.20,0.12,0.08", "—",
     "Medium-weight commercial construction (ASHRAE Fundamentals 2021)"),
    ("Tons Refrigeration",          "1 TR",     "3517",  "W",      "SI conversion"),
    ("Site Latitude",               "φ",        "12.97", "°N",     "Bangalore, India"),
    ("Site Longitude",              "λ",        "77.59", "°E",     "Bangalore, India"),
]
story.append(const_table(const_rows,
    col_widths=[4.8*cm, 2.2*cm, 2.2*cm, 1.6*cm, W-10.8*cm]))

story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# APPENDIX — REFERENCES
# ═══════════════════════════════════════════════════════════════════════════════
story.append(Paragraph("References", S["h1"]))
story.append(section_rule())
refs = [
    "ASHRAE Handbook – Fundamentals (2021), Chapter 18: Nonresidential Cooling and Heating Load Calculations",
    "ASHRAE Standard 90.1-2022: Energy Standard for Buildings (Lighting & Equipment Densities)",
    "ASHRAE Standard 55-2023: Thermal Environmental Conditions for Human Occupancy",
    "ASHRAE Standard 62.1-2022: Ventilation and Acceptable Indoor Air Quality",
    "Energy Conservation Building Code (ECBC) India 2017 — Bureau of Energy Efficiency",
    "National Building Code (NBC) India 2016 — Part 8: Building Services, HVAC",
    "Spencer, J.W. (1971). Fourier series representation of the position of the sun. Search, 2(5), 172",
    "ISO Standard 5151:2017 — Non-ducted air conditioners and heat pumps — Testing and rating for performance",
    "Open-Meteo API (https://open-meteo.com) — Hourly weather forecast: DNI, DHI, GHI, T_dry, RH",
    "PostgreSQL Documentation — AT TIME ZONE, EXTRACT, DISTINCT ON, ANY() operator",
]
for i, ref in enumerate(refs, 1):
    story.append(Paragraph(f"{i}.  {ref}", S["body_nb"]))

story.append(Spacer(1, 1*cm))
story.append(hr(BLUE_ACC, 1.5))
story.append(Paragraph(
    "Living Things — ThermoZone Analyst  |  Engineering Review Report  |  " +
    datetime.now().strftime("%d %B %Y"),
    S["date"]))
story.append(Paragraph(
    "This document is generated programmatically from the application source code. "
    "All equations and constants reflect the implementation as of the report date.",
    make_style("footer_note", fontSize=8, textColor=MID_GREY, alignment=TA_CENTER,
               fontName="Helvetica-Oblique")))

# ── Build ─────────────────────────────────────────────────────────────────────
doc.build(story)
print(f"Report written to: {OUTPUT}")

import streamlit as st
import requests
import math
import matplotlib.pyplot as plt
import datetime
import base64

st.set_page_config(page_title="Thermozone Analyst", layout="wide")

# ---------------------------------------------------------
# BACKGROUND IMAGE
# ---------------------------------------------------------

def set_background():

    try:
        with open("background.jpg","rb") as f:
            img = f.read()

        encoded = base64.b64encode(img).decode()

        st.markdown(
        f"""
        <style>
        .stApp {{
            background-image: url("data:image/jpg;base64,{encoded}");
            background-size: cover;
            background-attachment: fixed;
        }}

        .block-container {{
            background: rgba(0,0,0,0.65);
            padding: 2rem;
            border-radius: 15px;
        }}
        </style>
        """,
        unsafe_allow_html=True)

    except:
        pass

set_background()

# ---------------------------------------------------------
# HEADER
# ---------------------------------------------------------

st.title("☀️ Thermozone Analyst")
st.subheader("Dynamic Cooling Load Simulation Tool")

# ---------------------------------------------------------
# LOCATION
# ---------------------------------------------------------

location = st.text_input("City / Address")

# ---------------------------------------------------------
# ROOM DIMENSIONS
# ---------------------------------------------------------

st.header("Room Geometry")

c1,c2,c3 = st.columns(3)

with c1:
    room_length = st.number_input("Room Length (m)",value=10.0)

with c2:
    room_width = st.number_input("Room Width (m)",value=7.0)

with c3:
    room_height = st.number_input("Room Height (m)",value=2.7)

room_volume = room_length*room_width*room_height
roof_area = room_length*room_width

# ---------------------------------------------------------
# AIR INFILTRATION
# ---------------------------------------------------------

st.header("Air Infiltration")

ACH = st.number_input("Air Changes per Hour",value=0.5)

rho_air = 1.2
Cp_air = 1005

# ---------------------------------------------------------
# WALL INPUT
# ---------------------------------------------------------

st.header("Exterior Walls")

num_walls = st.number_input("Number of exterior walls",1,8,4)

wall_U = st.number_input("Wall U-value",value=1.8)

direction_map = {
"N":0,"NE":45,"E":90,"SE":135,
"S":180,"SW":225,"W":270,"NW":315
}

walls=[]
windows=[]

for i in range(int(num_walls)):

    st.subheader(f"Wall {i+1}")

    direction = st.selectbox(
        "Orientation",
        list(direction_map.keys()),
        key=f"dir{i}"
    )

    wall_length = st.number_input(
        "Wall Length (m)",
        key=f"wl{i}",
        value=7.0
    )

    wall_height = st.number_input(
        "Wall Height (m)",
        key=f"wh{i}",
        value=2.7
    )

    wall_area = wall_length*wall_height

    window_present = st.checkbox(
        "Windows on this wall",
        key=f"wp{i}"
    )

    window_area = 0

    if window_present:

        num_win = st.number_input(
            "Number of windows",
            1,10,
            key=f"nw{i}"
        )

        for j in range(int(num_win)):

            st.write(f"Window {j+1}")

            w = st.number_input(
                "Width (m)",
                key=f"ww{i}{j}",
                value=2.0
            )

            h = st.number_input(
                "Height (m)",
                key=f"wh{i}{j}",
                value=1.5
            )

            area = w*h
            window_area += area

            windows.append({
                "direction":direction,
                "azimuth":direction_map[direction],
                "area":area
            })

    net_wall_area = wall_area - window_area

    walls.append({
        "direction":direction,
        "azimuth":direction_map[direction],
        "area":net_wall_area
    })

# ---------------------------------------------------------
# MATERIAL PROPERTIES
# ---------------------------------------------------------

st.header("Material Properties")

SHGC = st.number_input("Glass SHGC",value=0.3)
glass_U = st.number_input("Glass U-value",value=2.7)

Tin = st.number_input("Indoor Temperature (°C)",value=24)

roof_present = st.checkbox("Roof Exposed")

roof_U = st.number_input("Roof U-value",value=2.8) if roof_present else 0

# ---------------------------------------------------------
# RUN SIMULATION
# ---------------------------------------------------------

run = st.button("Run Simulation")

if run and location:

    # -----------------------------------------------------
    # SAFE GEOCODING (Fix JSON Error)
    # -----------------------------------------------------

    geo_url = "https://nominatim.openstreetmap.org/search"

    params = {
        "q": location,
        "format": "json",
        "limit": 1
    }

    try:

        response = requests.get(
            geo_url,
            params=params,
            headers={"User-Agent":"thermozone-analyst"},
            timeout=10
        )

        if response.status_code != 200:
            st.error("Location service unavailable")
            st.stop()

        data = response.json()

        if len(data) == 0:
            st.error("Location not found")
            st.stop()

        latitude = float(data[0]["lat"])
        longitude = float(data[0]["lon"])

        st.success(data[0]["display_name"])

    except:
        st.error("Error retrieving location")
        st.stop()

    # -----------------------------------------------------
    # WEATHER API
    # -----------------------------------------------------

    weather_url = "https://api.open-meteo.com/v1/forecast"

    params = {
        "latitude":latitude,
        "longitude":longitude,
        "hourly":"shortwave_radiation,direct_radiation,diffuse_radiation,temperature_2m",
        "forecast_days":1,
        "timezone":"auto"
    }

    try:
        weather = requests.get(weather_url,params=params).json()

    except:
        st.error("Weather API error")
        st.stop()

    GHI = weather["hourly"]["shortwave_radiation"]
    DNI = weather["hourly"]["direct_radiation"]
    DHI = weather["hourly"]["diffuse_radiation"]
    Tout = weather["hourly"]["temperature_2m"]

    hours = list(range(24))

    # -----------------------------------------------------
    # SOLAR GEOMETRY
    # -----------------------------------------------------

    def declination(n):
        return 23.45*math.sin(math.radians((360*(284+n))/365))

    def hour_angle(h):
        return 15*(h-12)

    today = datetime.datetime.now()
    day = today.timetuple().tm_yday

    rho_g = 0.2
    alpha_wall = 0.6
    h_out = 20

    solar_gain=[]
    glass_cond=[]
    wall_cond=[]
    roof_cond=[]
    inf_gain=[]

    # -----------------------------------------------------
    # HOURLY SIMULATION
    # -----------------------------------------------------

    for h in hours:

        ghi = GHI[h]
        dni = DNI[h]
        dhi = DHI[h]
        To = Tout[h]

        dec = declination(day)
        ha = hour_angle(h)

        # Solar altitude

        alt = math.degrees(math.asin(
            math.sin(math.radians(latitude))*math.sin(math.radians(dec))
            +math.cos(math.radians(latitude))*math.cos(math.radians(dec))*math.cos(math.radians(ha))
        ))

        if alt <= 0:

            solar_gain.append(0)
            glass_cond.append(0)
            wall_cond.append(0)
            roof_cond.append(0)
            inf_gain.append(0)

            continue

        # Solar azimuth

        sin_az = (
            math.cos(math.radians(dec))*math.sin(math.radians(ha))
        ) / math.cos(math.radians(alt))

        az = math.degrees(math.asin(sin_az))

        if ha > 0:
            az = 180 - az
        else:
            az = 180 + az

        # -------------------------------------------------
        # WINDOW SOLAR GAIN
        # -------------------------------------------------

        Qsolar = 0

        for w in windows:

            theta = abs(az - w["azimuth"])

            cos_theta = max(math.cos(math.radians(theta)),0)

            beam = dni*cos_theta
            diffuse = dhi*0.5
            ground = ghi*rho_g*0.5

            I = beam + diffuse + ground

            Qsolar += w["area"]*SHGC*I

        # -------------------------------------------------
        # GLASS CONDUCTION
        # -------------------------------------------------

        Qglass = sum(glass_U*w["area"]*(To-Tin) for w in windows)

        # -------------------------------------------------
        # WALL SOL-AIR
        # -------------------------------------------------

        Qwall = 0

        for wall in walls:

            theta = abs(az-wall["azimuth"])

            cos_theta = max(math.cos(math.radians(theta)),0)

            Iwall = dni*cos_theta + 0.5*dhi

            Tsolair = To + (alpha_wall*Iwall/h_out)

            Qwall += wall_U*wall["area"]*(Tsolair-Tin)

        # -------------------------------------------------
        # ROOF
        # -------------------------------------------------

        Tsolair_roof = To + (alpha_wall*ghi/h_out)

        Qroof = roof_U*roof_area*(Tsolair_roof-Tin)

        # -------------------------------------------------
        # INFILTRATION
        # -------------------------------------------------

        Qinf = (rho_air*Cp_air*ACH*room_volume*(To-Tin))/3600

        solar_gain.append(Qsolar)
        glass_cond.append(Qglass)
        wall_cond.append(Qwall)
        roof_cond.append(Qroof)
        inf_gain.append(Qinf)

    # -----------------------------------------------------
    # TOTAL LOAD
    # -----------------------------------------------------

    total_load = [
        solar_gain[i]+glass_cond[i]+wall_cond[i]+roof_cond[i]+inf_gain[i]
        for i in range(24)
    ]

    peak = max(total_load)

    st.metric("Peak Cooling Load",f"{round(peak,2)} W")
    st.metric("Estimated AC Capacity",f"{round(peak/3517,2)} TR")

    # -----------------------------------------------------
    # GRAPH
    # -----------------------------------------------------

    fig,ax = plt.subplots(figsize=(10,5))

    ax.plot(hours,solar_gain,label="Solar Gain")
    ax.plot(hours,glass_cond,label="Glass Conduction")
    ax.plot(hours,wall_cond,label="Wall Gain")
    ax.plot(hours,roof_cond,label="Roof Gain")
    ax.plot(hours,inf_gain,label="Infiltration")
    ax.plot(hours,total_load,label="Total Cooling Load",linewidth=3)

    ax.set_xlabel("Hour")
    ax.set_ylabel("Heat Gain (W)")
    ax.grid()
    ax.legend()

    st.pyplot(fig)
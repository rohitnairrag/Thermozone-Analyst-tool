import streamlit as st
import requests
import math
import matplotlib.pyplot as plt
import datetime
import base64

# -------------------------------------------------
# PAGE CONFIG
# -------------------------------------------------

st.set_page_config(
    page_title="Thermozone Analyst",
    layout="wide",
    page_icon="☀️"
)

# -------------------------------------------------
# BACKGROUND IMAGE
# -------------------------------------------------

def set_background():

    with open("background.jpg","rb") as f:
        img = f.read()

    encoded = base64.b64encode(img).decode()

    css = f"""
    <style>
    .stApp {{
        background-image: url("data:image/jpg;base64,{encoded}");
        background-size: cover;
        background-position: center;
        background-attachment: fixed;
    }}

    .block-container {{
        background-color: rgba(0,0,0,0.65);
        padding: 2rem;
        border-radius: 15px;
    }}
    </style>
    """

    st.markdown(css, unsafe_allow_html=True)

set_background()

# -------------------------------------------------
# HEADER
# -------------------------------------------------

st.markdown(
"""
<h1 style='text-align:center;color:white;'>Thermozone Analyst</h1>
<h4 style='text-align:center;color:white;'>Dynamic Cooling Load Simulation Tool</h4>
""",
unsafe_allow_html=True
)

st.write("")

# -------------------------------------------------
# SIDEBAR INPUTS
# -------------------------------------------------

st.sidebar.header("Simulation Inputs")

location = st.sidebar.text_input("City / Address")

# -------------------------------------------------
# ROOM
# -------------------------------------------------

st.header("Room Geometry")

col1,col2,col3 = st.columns(3)

with col1:
    room_length = st.number_input("Room Length (m)",value=10.0)

with col2:
    room_width = st.number_input("Room Width (m)",value=7.0)

with col3:
    room_height = st.number_input("Room Height (m)",value=2.7)

room_volume = room_length*room_width*room_height
roof_area = room_length*room_width

# -------------------------------------------------
# INFILTRATION
# -------------------------------------------------

st.header("Air Infiltration")

ACH = st.number_input("Air Changes per Hour",value=0.5)

rho_air = 1.2
Cp_air = 1005

# -------------------------------------------------
# WALL INPUT
# -------------------------------------------------

st.header("Exterior Walls")

num_walls = st.number_input("Number of exterior walls",1,8,4)

wall_U = st.number_input("Wall U-value",value=1.8)

direction_map = {
"N":0,"NE":45,"E":90,"SE":135,
"S":180,"SW":225,"W":270,"NW":315
}

walls=[]
windows=[]
window_labels=[]

for i in range(int(num_walls)):

    st.subheader(f"Wall {i+1}")

    col1,col2,col3 = st.columns(3)

    with col1:
        direction = st.selectbox(
            "Orientation",
            list(direction_map.keys()),
            key=f"dir{i}"
        )

    with col2:
        wall_length = st.number_input(
            "Wall Length (m)",
            key=f"wl{i}",
            value=7.0
        )

    with col3:
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

    window_area=0

    if window_present:

        num_win = st.number_input(
            "Number of windows",
            1,10,
            key=f"nw{i}"
        )

        for j in range(int(num_win)):

            st.write(f"Window {j+1}")

            col1,col2 = st.columns(2)

            with col1:
                w = st.number_input(
                    "Width (m)",
                    key=f"ww{i}{j}",
                    value=2.0
                )

            with col2:
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

            window_labels.append(f"{direction} window")

    net_wall_area = wall_area - window_area

    walls.append({
        "direction":direction,
        "azimuth":direction_map[direction],
        "area":net_wall_area
    })

# -------------------------------------------------
# MATERIAL
# -------------------------------------------------

st.header("Material Properties")

col1,col2,col3 = st.columns(3)

with col1:
    SHGC = st.number_input("Glass SHGC",value=0.3)

with col2:
    glass_U = st.number_input("Glass U-value",value=2.7)

with col3:
    Tin = st.number_input("Indoor Temp (°C)",value=24.0)

roof_present = st.checkbox("Roof exposed")

roof_U = st.number_input("Roof U-value",value=2.8) if roof_present else 0

# -------------------------------------------------
# RUN SIMULATION
# -------------------------------------------------

run = st.button("Run Simulation")

if run and location:

    st.info("Fetching weather data...")

    geo_url="https://nominatim.openstreetmap.org/search"

    params={"q":location,"format":"json","limit":1}

    response=requests.get(
        geo_url,
        params=params,
        headers={"User-Agent":"thermal-model"}
    )

    data=response.json()

    latitude=float(data[0]["lat"])
    longitude=float(data[0]["lon"])

    st.success(data[0]["display_name"])

    # --------------------------------
    # WEATHER API
    # --------------------------------

    url="https://api.open-meteo.com/v1/forecast"

    params={
        "latitude":latitude,
        "longitude":longitude,
        "hourly":"shortwave_radiation,direct_radiation,diffuse_radiation,temperature_2m",
        "forecast_days":1,
        "timezone":"auto"
    }

    weather=requests.get(url,params=params).json()

    GHI=weather["hourly"]["shortwave_radiation"]
    DNI=weather["hourly"]["direct_radiation"]
    DHI=weather["hourly"]["diffuse_radiation"]
    Tout=weather["hourly"]["temperature_2m"]

    hours=list(range(24))

    # --------------------------------
    # SOLAR GEOMETRY
    # --------------------------------

    def declination(n):
        return 23.45*math.sin(math.radians((360*(284+n))/365))

    def hour_angle(h):
        return 15*(h-12)

    today=datetime.datetime.now()
    day=today.timetuple().tm_yday

    rho_g=0.2
    alpha_wall=0.6
    h_out=20

    solar_gain=[]
    glass_cond=[]
    wall_cond=[]
    roof_cond=[]
    inf_gain=[]

    # --------------------------------
    # SIMULATION LOOP
    # --------------------------------

    for h in hours:

        ghi=GHI[h]
        dni=DNI[h]
        dhi=DHI[h]
        To=Tout[h]

        dec=declination(day)
        ha=hour_angle(h)

        alt=math.degrees(math.asin(
            math.sin(math.radians(latitude))*math.sin(math.radians(dec))
            +math.cos(math.radians(latitude))*math.cos(math.radians(dec))*math.cos(math.radians(ha))
        ))

        if alt<=0:

            solar_gain.append(0)
            glass_cond.append(0)
            wall_cond.append(0)
            roof_cond.append(0)
            inf_gain.append(0)

            continue

        az=180

        # --------------------------
        # WINDOW SOLAR GAIN
        # --------------------------

        Qsolar=0

        for w in windows:

            theta=abs(az-w["azimuth"])

            cos_theta=max(math.cos(math.radians(theta)),0)

            beam=dni*cos_theta
            diffuse=dhi*0.5
            ground=ghi*rho_g*0.5

            I=beam+diffuse+ground

            Qsolar+=w["area"]*SHGC*I

        # --------------------------
        # GLASS CONDUCTION
        # --------------------------

        Qglass=sum(glass_U*w["area"]*(To-Tin) for w in windows)

        # --------------------------
        # WALL CONDUCTION
        # --------------------------

        Qwall=0

        for wall in walls:

            theta=abs(az-wall["azimuth"])

            cos_theta=max(math.cos(math.radians(theta)),0)

            Iwall=dni*cos_theta+0.5*dhi

            Tsolair=To+(alpha_wall*Iwall/h_out)

            Qwall+=wall_U*wall["area"]*(Tsolair-Tin)

        # --------------------------
        # ROOF
        # --------------------------

        Tsolair_roof=To+(alpha_wall*ghi/h_out)

        Qroof=roof_U*roof_area*(Tsolair_roof-Tin)

        # --------------------------
        # INFILTRATION
        # --------------------------

        Qinf=(rho_air*Cp_air*ACH*room_volume*(To-Tin))/3600

        solar_gain.append(Qsolar)
        glass_cond.append(Qglass)
        wall_cond.append(Qwall)
        roof_cond.append(Qroof)
        inf_gain.append(Qinf)

    total_load=[solar_gain[i]+glass_cond[i]+wall_cond[i]+roof_cond[i]+inf_gain[i] for i in range(24)]

    peak=max(total_load)

    # -------------------------------------------------
    # RESULTS
    # -------------------------------------------------

    st.metric("Peak Cooling Load",f"{round(peak,2)} W")
    st.metric("Estimated AC Capacity",f"{round(peak/3517,2)} TR")

    fig,ax=plt.subplots()

    ax.plot(hours,solar_gain,label="Solar Gain")
    ax.plot(hours,glass_cond,label="Glass Conduction")
    ax.plot(hours,wall_cond,label="Wall Gain")
    ax.plot(hours,roof_cond,label="Roof Gain")
    ax.plot(hours,inf_gain,label="Infiltration")
    ax.plot(hours,total_load,label="Total Cooling Load",linewidth=3)

    ax.legend()
    ax.grid()

    st.pyplot(fig)
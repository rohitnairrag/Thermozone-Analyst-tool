import streamlit as st
import requests
import math
import matplotlib.pyplot as plt
import datetime
import base64

# ----------------------------
# PAGE CONFIG
# ----------------------------

st.set_page_config(
    page_title="Thermozone Analyst",
    layout="wide",
    page_icon="☀️"
)

# ----------------------------
# BACKGROUND IMAGE
# ----------------------------

def set_bg():

    with open("background.jpg","rb") as f:
        data = f.read()

    encoded = base64.b64encode(data).decode()

    css = f"""
    <style>
    .stApp {{
        background-image: url("data:image/jpg;base64,{encoded}");
        background-size: cover;
        background-position: center;
        background-attachment: fixed;
    }}
    </style>
    """

    st.markdown(css, unsafe_allow_html=True)

set_bg()

# ----------------------------
# HEADER
# ----------------------------

st.markdown(
"""
<h1 style='text-align:center;color:white;'>Thermozone Analyst</h1>
<h4 style='text-align:center;color:white;'>Dynamic Cooling Load Simulator</h4>
""",
unsafe_allow_html=True
)

st.write("")

# ----------------------------
# SIDEBAR INPUTS
# ----------------------------

st.sidebar.header("Simulation Inputs")

location = st.sidebar.text_input("City / Address")

room_length = st.sidebar.number_input("Room Length (m)",value=10.0)
room_width = st.sidebar.number_input("Room Width (m)",value=7.0)
room_height = st.sidebar.number_input("Room Height (m)",value=2.7)

ACH = st.sidebar.number_input("Air Changes Per Hour",value=0.5)

wall_U = st.sidebar.number_input("Wall U Value",value=1.8)

glass_U = st.sidebar.number_input("Glass U Value",value=2.7)

SHGC = st.sidebar.number_input("Glass SHGC",value=0.3)

roof_exposed = st.sidebar.checkbox("Roof Exposed")

roof_U = 2.8 if roof_exposed else 0

Tin = st.sidebar.number_input("Indoor Temperature °C",value=24.0)

run = st.sidebar.button("Run Simulation")

# ----------------------------
# MAIN
# ----------------------------

if run and location:

    with st.spinner("Running simulation..."):

        # --------------------------------
        # LOCATION
        # --------------------------------

        geo_url="https://nominatim.openstreetmap.org/search"

        params={"q":location,"format":"json","limit":1}

        response=requests.get(
            geo_url,
            params=params,
            headers={"User-Agent":"thermal-model"}
        )

        data=response.json()

        lat=float(data[0]["lat"])
        lon=float(data[0]["lon"])

        st.success(f"Location detected: {data[0]['display_name']}")

        # --------------------------------
        # ROOM
        # --------------------------------

        volume = room_length*room_width*room_height
        roof_area = room_length*room_width

        rho_air=1.2
        Cp_air=1005

        # --------------------------------
        # WEATHER
        # --------------------------------

        url="https://api.open-meteo.com/v1/forecast"

        params={
            "latitude":lat,
            "longitude":lon,
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
        # SIMULATION
        # --------------------------------

        solar=[]
        glass=[]
        wall=[]
        roof=[]
        inf=[]
        total=[]

        for h in hours:

            ghi=GHI[h]
            dni=DNI[h]
            dhi=DHI[h]
            To=Tout[h]

            # solar gain simplified
            solar_gain = SHGC * ghi * 10

            # glass conduction
            glass_gain = glass_U * 10 * (To-Tin)

            # wall conduction
            wall_gain = wall_U * 40 * (To-Tin)

            # roof
            roof_gain = roof_U * roof_area * (To-Tin)

            # infiltration
            inf_gain=(rho_air*Cp_air*ACH*volume*(To-Tin))/3600

            total_gain = solar_gain+glass_gain+wall_gain+roof_gain+inf_gain

            solar.append(solar_gain)
            glass.append(glass_gain)
            wall.append(wall_gain)
            roof.append(roof_gain)
            inf.append(inf_gain)
            total.append(total_gain)

        peak=max(total)

# ----------------------------
# DASHBOARD METRICS
# ----------------------------

        c1,c2,c3 = st.columns(3)

        c1.metric("Peak Cooling Load",f"{round(peak,2)} W")

        c2.metric("AC Capacity",f"{round(peak/3517,2)} TR")

        c3.metric("Room Area",f"{round(room_length*room_width,2)} m²")

# ----------------------------
# GRAPHS
# ----------------------------

        tab1,tab2 = st.tabs(["Cooling Load","Heat Gain Components"])

        with tab1:

            fig,ax=plt.subplots()

            ax.plot(hours,total,label="Total Load",linewidth=3)

            ax.set_xlabel("Hour")
            ax.set_ylabel("Heat Gain W")

            ax.grid()

            st.pyplot(fig)

        with tab2:

            fig2,ax2=plt.subplots()

            ax2.plot(hours,solar,label="Solar")
            ax2.plot(hours,glass,label="Glass")
            ax2.plot(hours,wall,label="Walls")
            ax2.plot(hours,roof,label="Roof")
            ax2.plot(hours,inf,label="Infiltration")

            ax2.legend()
            ax2.grid()

            st.pyplot(fig2)
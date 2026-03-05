import streamlit as st
import requests
import math
import matplotlib.pyplot as plt
import datetime
import base64

# ---------------------------------
# PAGE CONFIG
# ---------------------------------

st.set_page_config(
    page_title="Thermozone Analyst",
    layout="wide",
    page_icon="☀️"
)

# ---------------------------------
# BACKGROUND
# ---------------------------------

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

# ---------------------------------
# HEADER
# ---------------------------------

st.markdown(
"""
<h1 style='text-align:center;color:white;'>Thermozone Analyst</h1>
<h4 style='text-align:center;color:white;'>Dynamic Cooling Load Simulator</h4>
""",
unsafe_allow_html=True
)

# ---------------------------------
# SIDEBAR INPUTS
# ---------------------------------

st.sidebar.header("Simulation Inputs")

location = st.sidebar.text_input("City / Address")

room_length = st.sidebar.number_input("Room Length (m)",value=10.0)
room_width = st.sidebar.number_input("Room Width (m)",value=7.0)
room_height = st.sidebar.number_input("Room Height (m)",value=2.7)

ACH = st.sidebar.number_input("Air Changes per Hour",value=0.5)

wall_U = st.sidebar.number_input("Wall U Value",value=1.8)

glass_U = st.sidebar.number_input("Glass U Value",value=2.7)

SHGC = st.sidebar.number_input("Glass SHGC",value=0.3)

roof_exposed = st.sidebar.checkbox("Roof Exposed")

roof_U = st.sidebar.number_input("Roof U Value",value=2.8) if roof_exposed else 0

Tin = st.sidebar.number_input("Indoor Temperature (°C)",value=24.0)

# Window Inputs

st.sidebar.header("Window Inputs")

num_windows = st.sidebar.number_input("Number of Windows",1,10,3)

windows = []

directions = {
"N":0,"NE":45,"E":90,"SE":135,
"S":180,"SW":225,"W":270,"NW":315
}

for i in range(num_windows):

    st.sidebar.subheader(f"Window {i+1}")

    direction = st.sidebar.selectbox(
        "Orientation",
        list(directions.keys()),
        key=i
    )

    width = st.sidebar.number_input(
        "Width (m)",
        key=f"w{i}",
        value=2.0
    )

    height = st.sidebar.number_input(
        "Height (m)",
        key=f"h{i}",
        value=1.5
    )

    windows.append({
        "area":width*height,
        "azimuth":directions[direction]
    })

run = st.sidebar.button("Run Simulation")

# ---------------------------------
# SIMULATION
# ---------------------------------

if run and location:

    with st.spinner("Running simulation..."):

        # ------------------------------
        # GEOLOCATION
        # ------------------------------

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

        st.success(f"Location: {data[0]['display_name']}")

        # ------------------------------
        # WEATHER
        # ------------------------------

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

        # ------------------------------
        # ROOM
        # ------------------------------

        volume = room_length*room_width*room_height
        roof_area = room_length*room_width

        rho_air=1.2
        Cp_air=1005

        # ------------------------------
        # SOLAR FUNCTIONS
        # ------------------------------

        def declination(n):
            return 23.45*math.sin(math.radians((360*(284+n))/365))

        def hour_angle(h):
            return 15*(h-12)

        today=datetime.datetime.now()
        day=today.timetuple().tm_yday

        # ------------------------------
        # ARRAYS
        # ------------------------------

        solar=[]
        glass=[]
        wall=[]
        roof=[]
        inf=[]
        total=[]

        rho_g=0.2
        alpha_wall=0.6
        h_out=20

        # ------------------------------
        # MAIN LOOP
        # ------------------------------

        for h in hours:

            ghi=GHI[h]
            dni=DNI[h]
            dhi=DHI[h]
            To=Tout[h]

            dec=declination(day)
            ha=hour_angle(h)

            alt=math.degrees(math.asin(
                math.sin(math.radians(lat))*math.sin(math.radians(dec))
                +math.cos(math.radians(lat))*math.cos(math.radians(dec))*math.cos(math.radians(ha))
            ))

            if alt<=0:

                solar.append(0)
                glass.append(0)
                wall.append(0)
                roof.append(0)
                inf.append(0)
                total.append(0)

                continue

            az=180

            # ------------------------------
            # WINDOW SOLAR
            # ------------------------------

            Qsolar=0

            for w in windows:

                theta=abs(az-w["azimuth"])

                cos_theta=max(math.cos(math.radians(theta)),0)

                beam=dni*cos_theta
                diffuse=dhi*0.5
                ground=ghi*rho_g*0.5

                I=beam+diffuse+ground

                Qsolar+=w["area"]*SHGC*I

            # ------------------------------
            # GLASS CONDUCTION
            # ------------------------------

            Qglass=sum(glass_U*w["area"]*(To-Tin) for w in windows)

            # ------------------------------
            # WALL CONDUCTION (SOL AIR)
            # ------------------------------

            Tsolair=To+(alpha_wall*ghi/h_out)

            wall_area=(room_length+room_width)*2*room_height

            Qwall=wall_U*wall_area*(Tsolair-Tin)

            # ------------------------------
            # ROOF
            # ------------------------------

            Tsolair_roof=To+(alpha_wall*ghi/h_out)

            Qroof=roof_U*roof_area*(Tsolair_roof-Tin)

            # ------------------------------
            # INFILTRATION
            # ------------------------------

            Qinf=(rho_air*Cp_air*ACH*volume*(To-Tin))/3600

            # ------------------------------
            # TOTAL
            # ------------------------------

            Qtotal=Qsolar+Qglass+Qwall+Qroof+Qinf

            solar.append(Qsolar)
            glass.append(Qglass)
            wall.append(Qwall)
            roof.append(Qroof)
            inf.append(Qinf)
            total.append(Qtotal)

        peak=max(total)

# ---------------------------------
# DASHBOARD METRICS
# ---------------------------------

        c1,c2,c3=st.columns(3)

        c1.metric("Peak Cooling Load",f"{round(peak,2)} W")

        c2.metric("AC Capacity",f"{round(peak/3517,2)} TR")

        c3.metric("Room Area",f"{round(room_length*room_width,2)} m²")

# ---------------------------------
# GRAPHS
# ---------------------------------

        tab1,tab2=st.tabs(["Cooling Load","Heat Gain Components"])

        with tab1:

            fig,ax=plt.subplots()

            ax.plot(hours,total,label="Total Load",linewidth=3)

            ax.set_xlabel("Hour")
            ax.set_ylabel("Heat Gain W")
            ax.grid()

            st.pyplot(fig)

        with tab2:

            fig2,ax2=plt.subplots()

            ax2.plot(hours,solar,label="Solar Gain")
            ax2.plot(hours,glass,label="Glass Conduction")
            ax2.plot(hours,wall,label="Wall Gain")
            ax2.plot(hours,roof,label="Roof Gain")
            ax2.plot(hours,inf,label="Infiltration")

            ax2.legend()
            ax2.grid()

            st.pyplot(fig2)
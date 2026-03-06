import streamlit as st
import requests
import math
import matplotlib.pyplot as plt
import datetime

st.title("Thermozone Analyst")

st.header("Location")

location = st.text_input("Enter City / Address")

if location:

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

    st.write("Latitude:",latitude)
    st.write("Longitude:",longitude)

    st.header("Room Dimensions")

    room_length = st.number_input("Room length (m)",value=10.0)
    room_width = st.number_input("Room width (m)",value=7.0)
    room_height = st.number_input("Room height (m)",value=2.7)

    room_volume=room_length*room_width*room_height
    roof_area=room_length*room_width

    st.header("Air Infiltration")

    ACH=st.number_input("Air changes per hour",value=0.5)

    rho_air=1.2
    Cp_air=1005

    st.header("Walls and Windows")

    num_walls=st.number_input("Number of exterior walls",min_value=1,max_value=8,value=4)

    wall_U=st.number_input("Wall U-value",value=1.8)

    direction_map={
        "N":0,"NE":45,"E":90,"SE":135,
        "S":180,"SW":225,"W":270,"NW":315
    }

    walls=[]
    windows=[]
    window_labels=[]

    for i in range(int(num_walls)):

        st.subheader(f"Wall {i+1}")

        direction=st.selectbox(
            "Orientation",
            ["N","NE","E","SE","S","SW","W","NW"],
            key=f"dir{i}"
        )

        wall_length=st.number_input("Wall length",key=f"wl{i}",value=7.0)
        wall_height=st.number_input("Wall height",key=f"wh{i}",value=2.7)

        wall_area=wall_length*wall_height

        window_present=st.checkbox("Windows on this wall?",key=f"wp{i}")

        window_area=0

        if window_present:

            num_win=st.number_input(
                "Number of windows",
                min_value=1,
                value=1,
                key=f"nw{i}"
            )

            for j in range(int(num_win)):

                w=st.number_input("Window width",key=f"ww{i}{j}",value=2.0)
                h=st.number_input("Window height",key=f"wh{i}{j}",value=1.5)

                area=w*h

                window_area+=area

                windows.append({
                    "direction":direction,
                    "azimuth":direction_map[direction],
                    "area":area
                })

                window_labels.append(direction+" window")

        net_wall_area=wall_area-window_area

        walls.append({
            "direction":direction,
            "azimuth":direction_map[direction],
            "area":net_wall_area
        })

    st.header("Glass Properties")

    SHGC=st.number_input("Glass SHGC",value=0.3)
    glass_U=st.number_input("Glass U Value",value=2.7)

    roof_present=st.checkbox("Roof Exposed")

    if roof_present:
        roof_U=st.number_input("Roof U Value",value=2.8)
    else:
        roof_U=0

    T_inside=st.number_input("Indoor Temperature",value=24.0)

    if st.button("Run Simulation"):

        st.write("Fetching weather data...")

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
        T_out=weather["hourly"]["temperature_2m"]

        def declination(n):
            return 23.45*math.sin(math.radians((360*(284+n))/365))

        def hour_angle(h):
            return 15*(h-12)

        today=datetime.datetime.now()
        day=today.timetuple().tm_yday

        hours=list(range(24))

        solar_gain=[]
        glass_cond=[]
        wall_cond=[]
        roof_cond=[]
        inf_gain=[]
        window_gain_map={i:[] for i in range(len(windows))}

        for h in hours:

            ghi=GHI[h]
            dni=DNI[h]
            dhi=DHI[h]
            Tout=T_out[h]

            dec=declination(day)
            ha=hour_angle(h)

            alt=math.degrees(math.asin(
                math.sin(math.radians(latitude))*math.sin(math.radians(dec))+
                math.cos(math.radians(latitude))*math.cos(math.radians(dec))*math.cos(math.radians(ha))
            ))

            if alt<=0:

                solar_gain.append(0)
                glass_cond.append(0)
                wall_cond.append(0)
                roof_cond.append(0)
                inf_gain.append(0)

                for i in range(len(windows)):
                    window_gain_map[i].append(0)

                continue

            az=180

            rho_g=0.2

            Qsolar=0

            for i,w in enumerate(windows):

                theta=abs(az-w["azimuth"])

                cos_theta=max(math.cos(math.radians(theta)),0)

                beam=dni*cos_theta
                diffuse=dhi*0.5
                ground=ghi*rho_g*0.5

                I=beam+diffuse+ground

                q=w["area"]*SHGC*I

                Qsolar+=q
                window_gain_map[i].append(q)

            Qglass=sum(glass_U*w["area"]*(Tout-T_inside) for w in windows)

            Qwall=0

            for wall in walls:

                Qwall+=wall_U*wall["area"]*(Tout-T_inside)

            Qroof=roof_U*roof_area*(Tout-T_inside)

            Qinf=(rho_air*Cp_air*ACH*room_volume*(Tout-T_inside))/3600

            solar_gain.append(Qsolar)
            glass_cond.append(Qglass)
            wall_cond.append(Qwall)
            roof_cond.append(Qroof)
            inf_gain.append(Qinf)

        total_load=[]

        for i in range(24):

            total=(
                solar_gain[i]+
                glass_cond[i]+
                wall_cond[i]+
                roof_cond[i]+
                inf_gain[i]
            )

            total_load.append(total)

        fig,ax=plt.subplots()

        ax.plot(hours,solar_gain,label="Solar Gain")
        ax.plot(hours,glass_cond,label="Glass Conduction")
        ax.plot(hours,wall_cond,label="Wall Gain")
        ax.plot(hours,roof_cond,label="Roof Gain")
        ax.plot(hours,inf_gain,label="Infiltration")
        ax.plot(hours,total_load,label="Total Heat Load",linewidth=3)

        ax.set_xlabel("Hour")
        ax.set_ylabel("Heat Gain (W)")
        ax.legend()
        ax.grid()

        st.pyplot(fig)

        fig2,ax2=plt.subplots()

        for i,data in window_gain_map.items():
            ax2.plot(hours,data,label=window_labels[i])

        ax2.set_xlabel("Hour")
        ax2.set_ylabel("Solar Gain (W)")
        ax2.legend()
        ax2.grid()

        st.pyplot(fig2)

        peak=max(total_load)

        st.write("Peak Heat Load:",round(peak,2),"W")
        st.write("Approx AC Capacity:",round(peak/3517,2),"TR")
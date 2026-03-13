import { LocationData, HourlyWeather } from '../types';

export const searchLocation = async (query: string): Promise<LocationData | null> => {
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`, {
      headers: { 'User-Agent': 'ThermoZoneAnalyst/1.0' }
    });
    const data = await response.json();
    if (data && data.length > 0) {
      return {
        name: data[0].display_name,
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon)
      };
    }
    return null;
  } catch (error) {
    console.error('Error searching location:', error);
    return null;
  }
};

export const fetchWeather = async (lat: number, lon: number): Promise<HourlyWeather | null> => {
  try {
    // Open-Meteo forecast API — today's weather
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,relative_humidity_2m,direct_radiation,diffuse_radiation,shortwave_radiation&timezone=auto&forecast_days=1`;
    const response = await fetch(url);
    const data = await response.json();
    if (data && data.hourly) {
      return {
        temperature: data.hourly.temperature_2m,
        directRadiation: data.hourly.direct_radiation,
        diffuseRadiation: data.hourly.diffuse_radiation,
        shortwaveRadiation: data.hourly.shortwave_radiation,
        relativeHumidity: data.hourly.relative_humidity_2m
      };
    }
    return null;
  } catch (error) {
    console.error('Error fetching weather:', error);
    return null;
  }
};

/**
 * Fetches historical hourly weather for a specific past date using Open-Meteo Archive API.
 * Falls back to forecast API if date is today.
 */
export const fetchWeatherForDate = async (
  lat: number,
  lon: number,
  date: string                    // YYYY-MM-DD
): Promise<HourlyWeather | null> => {
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (date === todayIST) {
    // Use forecast for today
    return fetchWeather(lat, lon);
  }
  try {
    // Open-Meteo Archive API for historical dates
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
      `&start_date=${date}&end_date=${date}` +
      `&hourly=temperature_2m,relative_humidity_2m,direct_radiation,diffuse_radiation,shortwave_radiation` +
      `&timezone=Asia%2FKolkata`;
    const response = await fetch(url);
    const data = await response.json();
    if (data && data.hourly) {
      return {
        temperature: data.hourly.temperature_2m,
        directRadiation: data.hourly.direct_radiation,
        diffuseRadiation: data.hourly.diffuse_radiation,
        shortwaveRadiation: data.hourly.shortwave_radiation,
        relativeHumidity: data.hourly.relative_humidity_2m
      };
    }
    return null;
  } catch (error) {
    console.error('Error fetching historical weather:', error);
    return null;
  }
};

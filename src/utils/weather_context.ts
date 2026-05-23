import axios from 'axios';

export interface WeatherContext {
    temperature: number;
    apparentTemperature: number;
    humidity: number;
    windSpeed: number; // km/h
    windGusts?: number; // km/h
    precipitation: number; // mm
    weatherCode: number;
    weatherCondition: string;
    cloudCover: number; // %
}

// WMO Weather interpretation codes (WW)
const getWeatherCondition = (code: number): string => {
    switch (code) {
        case 0: return 'Clear sky';
        case 1: return 'Mainly clear';
        case 2: return 'Partly cloudy';
        case 3: return 'Overcast';
        case 45: return 'Fog';
        case 48: return 'Depositing rime fog';
        case 51: return 'Light drizzle';
        case 53: return 'Moderate drizzle';
        case 55: return 'Dense drizzle';
        case 56: return 'Light freezing drizzle';
        case 57: return 'Dense freezing drizzle';
        case 61: return 'Slight rain';
        case 63: return 'Moderate rain';
        case 65: return 'Heavy rain';
        case 66: return 'Light freezing rain';
        case 67: return 'Heavy freezing rain';
        case 71: return 'Slight snow fall';
        case 73: return 'Moderate snow fall';
        case 75: return 'Heavy snow fall';
        case 77: return 'Snow grains';
        case 80: return 'Slight rain showers';
        case 81: return 'Moderate rain showers';
        case 82: return 'Violent rain showers';
        case 85: return 'Slight snow showers';
        case 86: return 'Heavy snow showers';
        case 95: return 'Thunderstorm';
        case 96: return 'Thunderstorm with slight hail';
        case 99: return 'Thunderstorm with heavy hail';
        default: return 'Unknown';
    }
};

const weatherCache = new Map<string, WeatherContext>();

export const fetchWeatherContext = async (
    lat: number,
    lon: number,
    startTimeLocal: string // e.g., '2023-10-25 08:30:00'
): Promise<WeatherContext | undefined> => {
    // extract date and hour
    const dateMatch = startTimeLocal.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):/);
    if (!dateMatch) return undefined;
    
    const date = dateMatch[1];
    const hour = parseInt(dateMatch[2], 10);
    
    // cache key
    const cacheKey = `${lat.toFixed(4)}_${lon.toFixed(4)}_${date}_${hour}`;
    if (weatherCache.has(cacheKey)) {
        return weatherCache.get(cacheKey);
    }
    
    try {
        console.log(`AI Insights: Fetching weather context from Open-Meteo for ${date} hour ${hour}...`);
        
        let url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${date}&end_date=${date}&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m&timezone=auto`;
        let response = await axios.get(url).catch(() => undefined);
        
        if (!response || !response.data || !response.data.hourly || response.data.hourly.temperature_2m.length === 0) {
            // Fallback to forecast API for very recent dates
            url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&start_date=${date}&end_date=${date}&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m&timezone=auto`;
            response = await axios.get(url).catch(() => undefined);
        }
        
        if (!response || !response.data || !response.data.hourly) {
             console.log(`AI Insights: No weather data found for ${date}`);
             return undefined;
        }
        
        const hourlyData = response.data.hourly;
        const temp = hourlyData.temperature_2m[hour];
        
        if (temp === null || temp === undefined) {
             return undefined;
        }

        const context: WeatherContext = {
            temperature: temp,
            apparentTemperature: hourlyData.apparent_temperature[hour],
            humidity: hourlyData.relative_humidity_2m[hour],
            precipitation: hourlyData.precipitation[hour],
            weatherCode: hourlyData.weather_code[hour],
            weatherCondition: getWeatherCondition(hourlyData.weather_code[hour]),
            cloudCover: hourlyData.cloud_cover[hour],
            windSpeed: hourlyData.wind_speed_10m[hour],
            windGusts: hourlyData.wind_gusts_10m ? hourlyData.wind_gusts_10m[hour] : undefined
        };
        
        weatherCache.set(cacheKey, context);
        return context;
        
    } catch (error: any) {
        console.error('AI Insights: Failed to fetch weather context:', error.message || error);
        return undefined;
    }
};

export const formatWeatherContext = (ctx?: WeatherContext): string => {
    if (!ctx) return '';
    
    const lines: string[] = [];
    lines.push(`- Condition: ${ctx.weatherCondition} (Code: ${ctx.weatherCode})`);
    lines.push(`- Temperature: ${ctx.temperature}°C (Feels like: ${ctx.apparentTemperature}°C)`);
    lines.push(`- Humidity: ${ctx.humidity}%`);
    lines.push(`- Wind: ${ctx.windSpeed} km/h` + (ctx.windGusts ? ` (Gusts: ${ctx.windGusts} km/h)` : ''));
    if (ctx.precipitation > 0) {
        lines.push(`- Precipitation: ${ctx.precipitation} mm`);
    }
    if (ctx.cloudCover > 0) {
        lines.push(`- Cloud Cover: ${ctx.cloudCover}%`);
    }
    
    return lines.join('\n');
};

import { GoogleGenerativeAI } from '@google/generative-ai';
import {
    GEMINI_API_KEY_DEFAULT,
    VERTEX_API_KEY_DEFAULT,
    AI_INSIGHTS_ENABLED_DEFAULT,
    PRIORITIZE_VERTEX_AI_DEFAULT,
} from '../constant';
import { initAIInsightsTable, saveAIInsight, hasAIInsight, AIInsightData, getAllAIInsights } from './sqlite';
import { addActivityComment, hasActivityInsight } from './garmin_common';
import { GarminClientType } from './type';
import { fetchPerformanceContext, formatPerformanceContext, PerformanceContext } from './garmin_performance';
import { fetchWeatherContext, formatWeatherContext, WeatherContext } from './weather_context';
import { GoogleAuth } from 'google-auth-library';
import axios from 'axios';
const fs = require('fs');

const core = require('@actions/core');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || GEMINI_API_KEY_DEFAULT;
const VERTEX_API_KEY = process.env.VERTEX_API_KEY || VERTEX_API_KEY_DEFAULT || '';
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
const AI_INSIGHTS_ENABLED = process.env.AI_INSIGHTS_ENABLED !== 'false' && AI_INSIGHTS_ENABLED_DEFAULT;
const PRIORITIZE_VERTEX_AI = process.env.PRIORITIZE_VERTEX_AI === 'true' || PRIORITIZE_VERTEX_AI_DEFAULT;
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const VERTEX_REGION = 'us-central1';

let genAI: GoogleGenerativeAI | null = null;

/**
 * Check if AI Insights feature is enabled
 */
export const isAIInsightsEnabled = (): boolean => {
    if (!AI_INSIGHTS_ENABLED) {
        return false;
    }
    if (!GEMINI_API_KEY && !VERTEX_API_KEY && !GOOGLE_APPLICATION_CREDENTIALS) {
        console.log('AI Insights: No AI credentials set (GEMINI_API_KEY, VERTEX_API_KEY, or GOOGLE_APPLICATION_CREDENTIALS), feature disabled');
        return false;
    }
    return true;
};

const getGeminiClient = (apiKey: string): GoogleGenerativeAI => {
    return new GoogleGenerativeAI(apiKey);
};

/**
 * Generate activity insights using Vertex AI REST API with Service Account
 */
const generateWithVertexFallback = async (prompt: string): Promise<string | null> => {
    if (!GOOGLE_APPLICATION_CREDENTIALS) {
        return null;
    }

    try {
        console.log('AI Insights: Attempting Vertex AI fallback...');
        let credentials;
        
        // Check if GOOGLE_APPLICATION_CREDENTIALS is a JSON string or a file path
        if (GOOGLE_APPLICATION_CREDENTIALS.trim().startsWith('{')) {
            credentials = JSON.parse(GOOGLE_APPLICATION_CREDENTIALS);
        } else {
            // Assume it's a file path
            console.log(`AI Insights: Reading credentials from path: ${GOOGLE_APPLICATION_CREDENTIALS}`);
            const fileContent = fs.readFileSync(GOOGLE_APPLICATION_CREDENTIALS, 'utf8');
            credentials = JSON.parse(fileContent);
        }
        
        const projectId = credentials.project_id;
        
        if (!projectId) {
            throw new Error('Vertex AI: MISSING project_id in credentials');
        }

        const auth = new GoogleAuth({
            credentials,
            scopes: 'https://www.googleapis.com/auth/cloud-platform',
        });

        const authResult: any = await auth.getAccessToken();
        const authToken = authResult.token || authResult;

        if (!authToken) {
            throw new Error('Vertex AI: Failed to obtain access token');
        }

        const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${VERTEX_REGION}/publishers/google/models/${GEMINI_MODEL}:generateContent`;

        const response = await axios.post(
            url,
            {
                contents: [{
                    role: 'user',
                    parts: [{ text: prompt }]
                }],
                generationConfig: {
                    temperature: 0.2,
                    topP: 0.8,
                    maxOutputTokens: 1024
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Content-Type': 'application/json',
                }
            }
        );

        if (response.data && response.data.candidates && response.data.candidates[0].content) {
            return response.data.candidates[0].content.parts[0].text;
        }
        
        console.error('Vertex AI Response error:', response.data);
        return null;
    } catch (error: any) {
        console.error('AI Insights: Vertex AI fallback failed:', (error.response && error.response.data) || error.message);
        return null;
    }
};

/**
 * Activity data structure from Garmin API
 */
export interface GarminActivity {
    activityId: string | number;
    activityName: string;
    activityType?: {
        typeKey?: string;
    };
    startTimeLocal: string;
    startLatitude?: number;
    startLongitude?: number;
    distance?: number;
    duration?: number;
    movingDuration?: number;
    elapsedDuration?: number;
    averageSpeed?: number;
    maxSpeed?: number;
    averageHR?: number;
    maxHR?: number;
    calories?: number;
    elevationGain?: number;
    elevationLoss?: number;
    minElevation?: number;
    maxElevation?: number;
    averageRunningCadenceInStepsPerMinute?: number;
    maxRunningCadenceInStepsPerMinute?: number;
    aerobicTrainingEffect?: number;
    anaerobicTrainingEffect?: number;
    trainingEffectLabel?: string;
    vO2MaxValue?: number;
    avgStrideLength?: number;
    avgGroundContactTime?: number;
    avgVerticalOscillation?: number;
    avgVerticalRatio?: number;
    activityTrainingLoad?: number;
    // Power metrics
    avgPower?: number;
    maxPower?: number;
    normPower?: number;
    // Stamina
    beginningStamina?: number;
    endingStamina?: number;
    minStamina?: number;
    // Temperature
    avgTemperature?: number;
    minTemperature?: number;
    maxTemperature?: number;
    // Intensity Minutes
    moderateIntensityMinutes?: number;
    vigorousIntensityMinutes?: number;
    // Body Battery
    bodyBatteryChange?: number;
    // Sweat/Hydration
    estimatedSweatLoss?: number;
    // Pace metrics
    avgGradeAdjustedPace?: number;
    bestPace?: number;
}

/**
 * Historical context for trending analysis
 */
export interface HistoricalContext {
    yesterdayActivity?: GarminActivity;
    lastWeekActivity?: GarminActivity;
    recentActivitiesOfSameType: GarminActivity[];
    recentActivitiesOfAllTypes: GarminActivity[];
}

/**
 * Calculate date ranges for historical comparison
 */
const getDateString = (date: Date): string => {
    return date.toISOString().split('T')[0];
};

/**
 * Find activities from specific time periods for comparison
 */
export const getHistoricalContext = (
    currentActivity: GarminActivity,
    allActivities: GarminActivity[]
): HistoricalContext => {
    const activityType = currentActivity.activityType && currentActivity.activityType.typeKey;
    const currentDate = new Date(currentActivity.startTimeLocal);
    
    // Filter out current activity
    const otherActivities = allActivities.filter(a => 
        String(a.activityId) !== String(currentActivity.activityId)
    );
    
    // Filter activities of the same type
    const sameTypeActivities = otherActivities.filter(a => 
        (a.activityType && a.activityType.typeKey === activityType)
    );
    
    // Calculate yesterday's date range
    const yesterday = new Date(currentDate);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = getDateString(yesterday);
    
    // Calculate last week's date range (7 days ago +/- 1 day)
    const lastWeekStart = new Date(currentDate);
    lastWeekStart.setDate(lastWeekStart.getDate() - 8);
    const lastWeekEnd = new Date(currentDate);
    lastWeekEnd.setDate(lastWeekEnd.getDate() - 6);
    
    // Find yesterday's activity (of same type for benchmarking)
    const yesterdayActivity = sameTypeActivities.find(a => {
        const actDate = getDateString(new Date(a.startTimeLocal));
        return actDate === yesterdayStr;
    });
    
    // Find last week's activity (of same type for benchmarking)
    const lastWeekActivity = sameTypeActivities.find(a => {
        const actDate = new Date(a.startTimeLocal);
        return actDate >= lastWeekStart && actDate <= lastWeekEnd;
    });
    
    // Get recent activities of same type (last 5)
    const recentActivitiesOfSameType = sameTypeActivities
        .filter(a => new Date(a.startTimeLocal) < currentDate)
        .sort((a, b) => new Date(b.startTimeLocal).getTime() - new Date(a.startTimeLocal).getTime())
        .slice(0, 5);

    // Get recent activities of ALL types (last 7) to show overall training load
    const recentActivitiesOfAllTypes = otherActivities
        .filter(a => new Date(a.startTimeLocal) < currentDate)
        .sort((a, b) => new Date(b.startTimeLocal).getTime() - new Date(a.startTimeLocal).getTime())
        .slice(0, 7);
    
    return {
        yesterdayActivity,
        lastWeekActivity,
        recentActivitiesOfSameType,
        recentActivitiesOfAllTypes,
    };
};

/**
 * Extract relevant metrics from a Garmin activity to keep the prompt focused
 */
const extractMetrics = (activity: any) => {
    if (!activity) return undefined;
    
    // Pre-calculate pace and distance for convenience
    let paceMinPerKm = activity.averageSpeed && activity.averageSpeed > 0
        ? (1000 / activity.averageSpeed / 60).toFixed(2)
        : undefined;
        
    // Use moving pace if total idle time (crosswalks, quick stops) is small (e.g., <= 3 mins)
    // to reflect actual running pace without penalizing for minor stops.
    if (activity.distance && activity.distance > 0 && activity.movingDuration && activity.movingDuration > 0) {
        const totalTime = activity.elapsedDuration || activity.duration || activity.movingDuration;
        const idleTimeMinutes = (totalTime - activity.movingDuration) / 60;
        
        if (idleTimeMinutes > 0 && idleTimeMinutes <= 3) {
            const movingPace = (activity.movingDuration / 60) / (activity.distance / 1000);
            paceMinPerKm = movingPace.toFixed(2);
        }
    }

    const distanceKm = activity.distance ? (activity.distance / 1000).toFixed(2) : undefined;
    const durationMin = activity.duration ? (activity.duration / 60).toFixed(1) : undefined;
    
    // Pick keys from the interface to ensure no bloated nested data gets sent
    const keys = [
        'activityId', 'activityName', 'startTimeLocal', 
        'averageHR', 'maxHR', 'calories', 
        'elevationGain', 'elevationLoss', 'minElevation', 'maxElevation', 
        'averageRunningCadenceInStepsPerMinute', 'maxRunningCadenceInStepsPerMinute', 
        'aerobicTrainingEffect', 'anaerobicTrainingEffect', 'trainingEffectLabel', 
        'vO2MaxValue', 'avgStrideLength', 'avgGroundContactTime', 'avgVerticalOscillation', 
        'avgVerticalRatio', 'activityTrainingLoad', 'avgPower', 'maxPower', 'normPower', 
        'beginningStamina', 'endingStamina', 'minStamina', 'avgTemperature', 'minTemperature', 
        'maxTemperature', 'moderateIntensityMinutes', 'vigorousIntensityMinutes', 
        'bodyBatteryChange', 'estimatedSweatLoss', 'bestPace', 'avgGradeAdjustedPace'
    ];
    
    const result: any = {
        distanceKm,
        durationMin,
        paceMinPerKm
    };
    
    for (const key of keys) {
        if (activity[key] !== undefined && activity[key] !== null) {
            result[key] = activity[key];
        }
    }
    
    if (activity.activityType && activity.activityType.typeKey) {
        result.activityType = activity.activityType.typeKey;
    }
    
    return result;
};

/**
 * Extract time of day from timestamp
 */
const getTimeOfDay = (timestamp: string): string => {
    try {
        const date = new Date(timestamp);
        const hour = date.getHours();
        if (hour >= 5 && hour < 12) return 'Morning';
        if (hour >= 12 && hour < 17) return 'Afternoon';
        if (hour >= 17 && hour < 21) return 'Evening';
        return 'Night';
    } catch {
        return 'Unknown';
    }
};

/**
 * Format activity data into a prompt for Gemini
 */
const formatActivityPrompt = (
    activity: GarminActivity, 
    historicalContext?: HistoricalContext,
    performanceContext?: PerformanceContext,
    weatherContextObj?: WeatherContext
): string => {
    const activityType = (activity.activityType && activity.activityType.typeKey) || 'unknown';
    const timeOfDay = getTimeOfDay(activity.startTimeLocal);
    
    // Physiological context from performance indicators
    const performanceContextMsg = formatPerformanceContext(performanceContext);
    
    // Activity name typically contains location (e.g., "Shenzhen Running", "Park Run")
    // The location context is preserved in the activity name field

    // Infer workout type from data points (not activity name)
    const workoutHints: string[] = [];
    
    // Interval/Sprint detection: high max HR vs moderate avg HR indicates HR spikes
    if (activity.maxHR && activity.averageHR) {
        const hrVariance = activity.maxHR - activity.averageHR;
        if (hrVariance > 30) {
            workoutHints.push(`INTERVAL/SPRINT INDICATOR: High HR variance (${hrVariance} bpm between max and avg) suggests interval training with intensity spikes`);
        }
    }
    
    // High intensity detection: high anaerobic effect
    if (activity.anaerobicTrainingEffect && activity.anaerobicTrainingEffect >= 3.0) {
        workoutHints.push(`HIGH INTENSITY INDICATOR: Anaerobic effect ${activity.anaerobicTrainingEffect.toFixed(1)} indicates significant speed/power work`);
    }
    
    // Recovery/Easy run detection: low HR, high aerobic effect, low anaerobic
    if (activity.aerobicTrainingEffect && activity.anaerobicTrainingEffect) {
        if (activity.aerobicTrainingEffect >= 2.0 && activity.anaerobicTrainingEffect < 1.0) {
            workoutHints.push(`EASY/RECOVERY INDICATOR: High aerobic (${activity.aerobicTrainingEffect.toFixed(1)}) with low anaerobic (${activity.anaerobicTrainingEffect.toFixed(1)}) suggests recovery or easy pace`);
        }
    }
    
    // Long run detection: duration > 60 min with moderate intensity
    const durationMinutes = activity.duration ? activity.duration / 60 : 0;
    if (durationMinutes > 60 && activity.aerobicTrainingEffect && activity.aerobicTrainingEffect >= 3.0) {
        workoutHints.push(`LONG RUN INDICATOR: Duration ${durationMinutes.toFixed(0)} min with aerobic effect ${activity.aerobicTrainingEffect.toFixed(1)} suggests endurance training`);
    }
    
    // Tempo/Threshold detection: sustained high HR (avg HR close to max HR - within 15 bpm)
    if (activity.maxHR && activity.averageHR) {
        const hrGap = activity.maxHR - activity.averageHR;
        if (hrGap <= 15 && activity.averageHR > 150) {
            workoutHints.push(`TEMPO/THRESHOLD INDICATOR: Sustained high HR (avg ${activity.averageHR} bpm, only ${hrGap} bpm below max) suggests threshold effort`);
        }
    }
    
    // Hill workout detection: significant elevation gain relative to distance
    if (activity.elevationGain && activity.distance) {
        const distanceKm = activity.distance / 1000;
        const elevationPerKm = activity.elevationGain / distanceKm;
        if (elevationPerKm > 30) {
            workoutHints.push(`HILL WORKOUT INDICATOR: ${activity.elevationGain.toFixed(0)}m elevation gain (${elevationPerKm.toFixed(1)}m/km) indicates significant climbing`);
        }
    }
    
    const workoutContext = workoutHints.length > 0 
        ? `\n\n--- WORKOUT TYPE INFERENCE (from data) ---\n${workoutHints.join('\n')}`
        : '';

    // Weather/temperature inference from device sensor data and external API
    const weatherHints: string[] = [];
    
    // Add external API weather data if available
    const externalWeather = formatWeatherContext(weatherContextObj);
    if (externalWeather) {
        weatherHints.push(externalWeather);
    }
    
    // Supplement with device sensor temperature which reflects local microclimate
    if (activity.avgTemperature !== undefined && activity.avgTemperature !== null) {
        weatherHints.push(`Device Sensor Average Temp: ${activity.avgTemperature}°C`);
        
        if (activity.minTemperature !== undefined && activity.maxTemperature !== undefined) {
            weatherHints.push(`Device Sensor Range: ${activity.minTemperature}°C – ${activity.maxTemperature}°C`);
        }
        
        // Heat stress indicators based on device temp
        if (activity.avgTemperature >= 32) {
            weatherHints.push(`⚠️ EXTREME HEAT: ${activity.avgTemperature}°C – significant cardiovascular strain expected. HR likely elevated 10-20 bpm above normal. Pace will naturally slow. High dehydration and heat illness risk.`);
        } else if (activity.avgTemperature >= 28) {
            weatherHints.push(`⚠️ HOT CONDITIONS: ${activity.avgTemperature}°C – expect elevated HR (5-15 bpm above normal), increased sweat rate, and pace degradation of 2-5%. Hydration is critical.`);
        } else if (activity.avgTemperature >= 24) {
            weatherHints.push(`WARM CONDITIONS: ${activity.avgTemperature}°C – mild heat impact on performance. HR may be slightly elevated. Adequate hydration needed.`);
        } else if (activity.avgTemperature >= 10 && activity.avgTemperature < 24) {
            weatherHints.push(`FAVORABLE CONDITIONS: ${activity.avgTemperature}°C – near-optimal temperature range for endurance performance.`);
        } else if (activity.avgTemperature >= 0 && activity.avgTemperature < 10) {
            weatherHints.push(`COLD CONDITIONS: ${activity.avgTemperature}°C – muscles may take longer to warm up. Risk of reduced flexibility and slower early pace. Extended warm-up beneficial.`);
        } else if (activity.avgTemperature < 0) {
            weatherHints.push(`⚠️ FREEZING CONDITIONS: ${activity.avgTemperature}°C – significant cold stress. Breathing cold air strains airways. Risk of hypothermia on longer efforts. Layering essential.`);
        }
        
        // Sweat loss correlation with temperature
        if (activity.estimatedSweatLoss && activity.avgTemperature >= 25) {
            weatherHints.push(`Estimated Sweat Loss: ${activity.estimatedSweatLoss}ml – correlate with temperature for hydration assessment.`);
        }
    }

    const weatherContext = weatherHints.length > 0
        ? `\n\n--- WEATHER / TEMPERATURE CONTEXT ---\n${weatherHints.join('\n')}`
        : '';
        
    const currentActivityMetricsMsg = JSON.stringify(extractMetrics(activity), null, 2);
    
    const historicalContextMsg = historicalContext ? JSON.stringify({
        yesterdayActivity: extractMetrics(historicalContext.yesterdayActivity),
        lastWeekActivity: extractMetrics(historicalContext.lastWeekActivity),
        recentActivitiesOfSameType: historicalContext.recentActivitiesOfSameType.map(a => extractMetrics(a)),
        recentActivitiesOfAllTypes: historicalContext.recentActivitiesOfAllTypes.map(a => extractMetrics(a))
    }, null, 2) : 'No historical data available.';

    return `Analyze this ${activityType} workout and provide brief, actionable insights in 2-3 sentences.

IMPORTANT: Analyze the workout HOLISTICALLY. Consider:
1. Use the WORKOUT TYPE INFERENCE section (if present) which is derived from actual metrics
2. Metrics should be interpreted in context - a sprint workout may have low average cadence but very high intensity
3. Compare aerobic vs anaerobic training effects to understand the workout's purpose
4. A high max HR with moderate average HR suggests interval training
5. Don't judge metrics in isolation - understand the full picture
6. Time of day affects performance (morning: fresh but stiff, afternoon: peak body temp, evening: accumulated fatigue, night: lower visibility)
7. The activity name often contains LOCATION info (city, park, trail) - consider terrain and environmental factors
8. CRITICAL: Evaluate ALL provided metrics comprehensively (e.g., pace, heart rate, average stride length, training effect, cadence, power, and any other performance metric available) alongside the date.
9. CRITICAL: Analyze the time elapsed since the previous activities of ANY type (using startTimeLocal), while paying special attention to those of the same type for performance trending. Correlate this with current performance metrics. Consider its potential impact (e.g., fatigue from insufficient rest across different sports, detraining from a long gap, or optimal recovery) and explicitly mention this impact in the insights.
10. CRITICAL: Consider the PERFORMANCE CONTEXT which shows the body's readiness state on the day of the activity. A low Training Readiness or depleted Body Battery should adjust your expectations for pace/HR. A high HRV indicates good recovery.
11. CRITICAL: Prioritize SLEEP DATA as a foundational metric. Poor sleep quality or insufficient duration (below 7 hours) is a primary driver of reduced performance and increased strain. Correlate sleep scores and quality with the workout intensity and recovery advice.
12. CRITICAL: Factor in WEATHER AND TEMPERATURE conditions during the workout. The device sensor captures ambient temperature. Heat (≥28°C) elevates HR by 5-20 bpm, degrades pace, and increases dehydration risk – adjust pace/HR expectations accordingly and don't penalize performance for heat-related slowdowns. Cold (<10°C) can slow warm-up, reduce flexibility, and strain airways. Optimal performance range is roughly 10-22°C. Always correlate temperature with sweat loss, HR drift, and pacing when evaluating the workout.

=== PHYSIOLOGICAL PERFORMANCE CONTEXT (Readiness, Sleep, HRV, Body Battery) ===
${performanceContextMsg}

=== CURRENT ACTIVITY METRICS ===
${currentActivityMetricsMsg}

=== HISTORICAL CONTEXT ===
${historicalContextMsg}${workoutContext}${weatherContext}

Focus on: understanding the workout's PURPOSE based on the inferred workout type and metrics, evaluating training intensity, weather impact on performance, recovery recommendations, and trending performance vs historical data (and rest periods) if available. Keep response concise (2-3 sentences).

At the end of your response, add a confidence score from 0.0 to 1.0 indicating how confident you are in your analysis based on the data quality. Format: [CONFIDENCE: X.X]`;
};

/**
 * Result from AI insights generation
 */
export interface AIInsightResult {
    insight: string;
    model: string;
    confidence: number;
    weatherCondition?: string;
}

/**
 * Parse confidence from AI response
 */
const parseConfidence = (text: string): { insight: string; confidence: number } => {
    const match = text.match(/\[CONFIDENCE:\s*([0-9.]+)\]/i);
    if (match) {
        const confidence = parseFloat(match[1]);
        const insight = text.replace(/\[CONFIDENCE:\s*[0-9.]+\]/i, '').trim();
        return { insight, confidence: Math.min(1.0, Math.max(0.0, confidence)) };
    }
    return { insight: text, confidence: 0.7 }; // Default confidence if not provided
};
// Rate limiting configuration
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000; // 2 seconds base delay
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 1000; // Minimum 1 second between requests

/**
 * Wait for rate limiting
 */
const waitForRateLimit = async (): Promise<void> => {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
        const waitTime = MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest;
        console.log(`AI Insights: Rate limiting - waiting ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    lastRequestTime = Date.now();
};

/**
 * Sleep for a given duration
 */
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Generate AI insights for an activity using Gemini with retry logic
 * @param activity The current activity to analyze
 * @param allActivities Optional array of all recent activities for trend comparison
 * @param client Optional Garmin client to fetch physiological performance context
 */
export const generateActivityInsights = async (
    activity: GarminActivity,
    allActivities?: GarminActivity[],
    client?: GarminClientType
): Promise<AIInsightResult | null> => {
    if (!isAIInsightsEnabled()) {
        return null;
    }

    const activityId = String(activity.activityId);
    const activityType = (activity.activityType && activity.activityType.typeKey) || 'unknown';
    const activityDate = activity.startTimeLocal.split(' ')[0]; // Extract YYYY-MM-DD
    
    // Performance Context fetching logic...
    let performanceContext: PerformanceContext | undefined = undefined;
    if (client) {
        try {
            performanceContext = await fetchPerformanceContext(client, activityDate);
        } catch (error) {
            console.error(`AI Insights: Failed to fetch performance context for ${activityId}:`, error);
        }
    }
    
    // Calculate historical context...
    const historicalContext = allActivities && allActivities.length > 1
        ? getHistoricalContext(activity, allActivities)
        : undefined;

    // Fetch Weather context...
    let weatherContextObj: WeatherContext | undefined = undefined;
    if (activity.startLatitude && activity.startLongitude) {
        weatherContextObj = await fetchWeatherContext(
            activity.startLatitude,
            activity.startLongitude,
            activity.startTimeLocal
        );
    }

    const prompt = formatActivityPrompt(activity, historicalContext, performanceContext, weatherContextObj);

    // PRIORITY 0: Try Vertex AI Service Account Fallback FIRST if prioritized
    if (PRIORITIZE_VERTEX_AI && GOOGLE_APPLICATION_CREDENTIALS) {
        console.log('AI Insights: Vertex AI is prioritized. Attempting Service Account first...');
        const vertexText = await generateWithVertexFallback(prompt);
        if (vertexText) {
            const { insight, confidence } = parseConfidence(vertexText.trim());
            console.log(`AI Insights: Generated successfully via prioritized Vertex AI (confidence: ${(confidence * 100).toFixed(0)}%)`);
            return {
                insight,
                model: `${GEMINI_MODEL}-vertex`,
                confidence,
                weatherCondition: weatherContextObj?.weatherCondition,
            };
        }
        console.log('AI Insights: Prioritized Vertex AI failed. Falling back to Gemini Tiered Keys...');
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Apply rate limiting
            await waitForRateLimit();
            
            // Determine which API key to use for this attempt
            // If primary key fails after first attempt, try fallback key if available
            const currentApiKey = (attempt > 1 && VERTEX_API_KEY) ? VERTEX_API_KEY : GEMINI_API_KEY;
            
            if (!currentApiKey) {
                // If no API key available, skip to Vertex Fallback (Service Account) handled in catch
                throw new Error('NO_API_KEY');
            }

            const client = getGeminiClient(currentApiKey);
            const model = client.getGenerativeModel({ model: GEMINI_MODEL });
            
            console.log(`AI Insights: Calling Gemini API (${currentApiKey === VERTEX_API_KEY ? 'Fallback Key' : 'Primary Key'}, attempt ${attempt}/${MAX_RETRIES})...`);
            const prompt = formatActivityPrompt(activity, historicalContext, performanceContext, weatherContextObj);
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            
            const { insight, confidence } = parseConfidence(text.trim());
            
            console.log(`AI Insights: Generated successfully (confidence: ${(confidence * 100).toFixed(0)}%)`);
            
            return {
                insight,
                model: GEMINI_MODEL,
                confidence,
                weatherCondition: weatherContextObj?.weatherCondition,
            };
        } catch (error: any) {
            const isRateLimited = (error && error.status === 429) || (error && error.statusText === 'Too Many Requests') || (error.message && error.message.includes('429'));
            const isNoKey = error.message === 'NO_API_KEY';
            
            // On last attempt or non-rate-limit critical error, try Vertex AI Service Account fallback if available
            if ((attempt === MAX_RETRIES || (!isRateLimited && !isNoKey)) && GOOGLE_APPLICATION_CREDENTIALS) {
                const prompt = formatActivityPrompt(activity, historicalContext, performanceContext);
                const vertexText = await generateWithVertexFallback(prompt);
                
                if (vertexText) {
                    const { insight, confidence } = parseConfidence(vertexText.trim());
                    console.log(`AI Insights: Generated successfully via Vertex AI Fallback (confidence: ${(confidence * 100).toFixed(0)}%)`);
                    
                    return {
                        insight,
                        model: `${GEMINI_MODEL}-vertex`,
                        confidence,
                        weatherCondition: weatherContextObj?.weatherCondition,
                    };
                }
            }

            if ((isRateLimited || isNoKey) && attempt < MAX_RETRIES) {
                // Extract retry delay from error if available, otherwise use exponential backoff
                let retryDelay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
                
                // Try to parse retryDelay from error details
                if (error && error.errorDetails) {
                    const retryInfo = error.errorDetails.find((d: any) => d['@type'] && d['@type'].includes('RetryInfo'));
                    if (retryInfo && retryInfo.retryDelay) {
                        const match = retryInfo.retryDelay.match(/(\d+)/);
                        if (match) {
                            retryDelay = parseInt(match[1]) * 1000; // Convert seconds to ms
                        }
                    }
                }
                
                console.log(`AI Insights: Rate limited (429). Waiting ${retryDelay / 1000}s before retry...`);
                await sleep(retryDelay);
                continue;
            }
            
            console.error(`AI Insights: Error generating insights for activity ${activityId}:`, 
                isRateLimited ? 'Rate limit exceeded after all retries' : error);
            return null;
        }
    }
    
    return null;
};

/**
 * Process an activity with AI insights - generates, saves, and posts as comment
 * @param activity The Garmin activity data
 * @param client Optional Garmin client for posting comments to the source activity
 * @param allActivities Optional array of all recent activities for trend comparison
 * @param forceUpdate If true, replaces existing insight in Garmin description
 */
export const processActivityWithInsights = async (
    activity: GarminActivity,
    client?: GarminClientType,
    allActivities?: GarminActivity[],
    forceUpdate: boolean = false
): Promise<AIInsightResult | null> => {
    if (!isAIInsightsEnabled()) {
        return null;
    }

    const activityId = String(activity.activityId);
    const activityName = activity.activityName;
    
    console.log(`AI Insights: Processing activity ${activityId} ("${activityName}")...`);
    
    try {
        // Initialize table if needed
        await initAIInsightsTable();

        // Check if already has insights (skip this check if forceUpdate is true since DB was already cleared)
        if (!forceUpdate && await hasAIInsight(activityId)) {
            console.log(`AI Insights: Activity ${activityId} already has insights in database, skipping`);
            return null;
        }

        console.log(`AI Insights: No existing insights found, generating new insights...`);
        
        // Generate insights with historical context and performance details
        const result = await generateActivityInsights(activity, allActivities, client);
        
        if (result) {
            // Save to database with model and confidence
            console.log(`AI Insights: Saving insights to database...`);
            const insightData: AIInsightData = {
                activityId,
                activityName: activity.activityName,
                insight: result.insight,
                model: result.model,
                confidence: result.confidence,
                weatherCondition: result.weatherCondition,
            };
            await saveAIInsight(insightData);
            console.log(`AI Insights: Saved to database successfully`);
            
            // Post as comment to Garmin activity if client is provided
            if (client) {
                console.log(`AI Insights: Posting as comment to Garmin activity ${activityId}...`);
                const commentSuccess = await addActivityComment(
                    activityId, 
                    result.insight, 
                    client, 
                    result.model, 
                    !!forceUpdate, 
                    result.confidence,
                    result.weatherCondition
                );
                if (commentSuccess) {
                    console.log(`AI Insights: Comment posted successfully`);
                } else {
                    console.log(`AI Insights: Failed to post comment (will retry on next run)`);
                }
            } else {
                console.log(`AI Insights: No client provided, skipping comment posting`);
            }
            
            // Log the insights summary
            console.log(`\n🤖 AI Insights for "${activityName}" (${activityId}):`);
            console.log(`   Model: ${result.model} | Confidence: ${(result.confidence * 100).toFixed(0)}%`);
            console.log(`   ${result.insight.replace(/\n/g, '\n   ')}`);
            console.log('');
            
            return result;
        } else {
            console.log(`AI Insights: Failed to generate insights for activity ${activityId}`);
        }
        
        return null;
    } catch (error) {
        console.error(`AI Insights: Error processing activity ${activityId}:`, error);
        return null;
    }
};

/**
 * Process multiple activities with AI insights (for legacy processing)
 * @param activities Array of Garmin activities
 * @param client Optional Garmin client for posting comments
 */
export const processActivitiesWithInsights = async (
    activities: GarminActivity[],
    client?: GarminClientType
): Promise<number> => {
    if (!isAIInsightsEnabled()) {
        console.log('AI Insights: Feature is disabled');
        return 0;
    }

    await initAIInsightsTable();
    
    let processedCount = 0;
    
    for (const activity of activities) {
        const activityId = String(activity.activityId);
        
        if (await hasAIInsight(activityId)) {
            console.log(`AI Insights: Activity ${activityId} already has insights, skipping`);
            continue;
        }
        
        const insights = await processActivityWithInsights(activity, client, activities);
        if (insights) {
            processedCount++;
            // Add a small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    return processedCount;
};

/**
 * Sync missing insights to Garmin activities
 * Checks all activities with insights in the database and posts to Garmin if not present in activity description
 * @param client Garmin client for posting comments
 * @returns Number of activities synced
 */
export const syncMissingInsightsToGarmin = async (
    client: GarminClientType
): Promise<number> => {
    await initAIInsightsTable();
    
    console.log('AI Insights: Checking database for insights to sync to Garmin...');
    
    const allInsights = await getAllAIInsights();
    
    if (allInsights.length === 0) {
        console.log('AI Insights: No insights found in database');
        return 0;
    }
    
    console.log(`AI Insights: Found ${allInsights.length} insights in database, checking Garmin activities...`);
    
    let syncedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    for (const insight of allInsights) {
        try {
            // Check if the activity already has the insight in its description
            const hasInsight = await hasActivityInsight(insight.activityId, client);
            
            if (hasInsight) {
                skippedCount++;
                continue;
            }
            
            console.log(`AI Insights: Posting insight to activity ${insight.activityId} (${insight.activityName})...`);
            
            const success = await addActivityComment(
                insight.activityId, 
                insight.insight, 
                client,
                insight.model || 'unknown',
                false,
                insight.confidence || 1,
                insight.weatherCondition
            );
            
            if (success) {
                syncedCount++;
                console.log(`AI Insights: ✅ Synced insight to activity ${insight.activityId}`);
            } else {
                errorCount++;
                console.log(`AI Insights: ❌ Failed to sync insight to activity ${insight.activityId}`);
            }
            
            // Add delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            errorCount++;
            console.error(`AI Insights: Error syncing activity ${insight.activityId}:`, error);
        }
    }
    
    console.log(`AI Insights: Sync complete - Synced: ${syncedCount}, Skipped (already present): ${skippedCount}, Errors: ${errorCount}`);
    
    return syncedCount;
};

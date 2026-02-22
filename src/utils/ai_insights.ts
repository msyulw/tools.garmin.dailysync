import { GoogleGenerativeAI } from '@google/generative-ai';
import {
    GEMINI_API_KEY_DEFAULT,
    AI_INSIGHTS_ENABLED_DEFAULT,
} from '../constant';
import { initAIInsightsTable, saveAIInsight, hasAIInsight, AIInsightData, getAllAIInsights } from './sqlite';
import { addActivityComment, hasActivityInsight } from './garmin_common';
import { GarminClientType } from './type';

const core = require('@actions/core');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? GEMINI_API_KEY_DEFAULT;
const AI_INSIGHTS_ENABLED = process.env.AI_INSIGHTS_ENABLED !== 'false' && AI_INSIGHTS_ENABLED_DEFAULT;
const GEMINI_MODEL = 'gemini-2.5-flash-lite';

let genAI: GoogleGenerativeAI | null = null;

/**
 * Check if AI Insights feature is enabled
 */
export const isAIInsightsEnabled = (): boolean => {
    if (!AI_INSIGHTS_ENABLED) {
        return false;
    }
    if (!GEMINI_API_KEY) {
        console.log('AI Insights: GEMINI_API_KEY not set, feature disabled');
        return false;
    }
    return true;
};

/**
 * Initialize the Gemini client
 */
const getGeminiClient = (): GoogleGenerativeAI => {
    if (!genAI) {
        genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    }
    return genAI;
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
    recentActivities: GarminActivity[];
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
    const activityType = currentActivity.activityType?.typeKey;
    const currentDate = new Date(currentActivity.startTimeLocal);
    
    // Filter activities of the same type, excluding current activity
    const sameTypeActivities = allActivities.filter(a => 
        a.activityType?.typeKey === activityType && 
        String(a.activityId) !== String(currentActivity.activityId)
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
    
    // Find yesterday's activity
    const yesterdayActivity = sameTypeActivities.find(a => {
        const actDate = getDateString(new Date(a.startTimeLocal));
        return actDate === yesterdayStr;
    });
    
    // Find last week's activity
    const lastWeekActivity = sameTypeActivities.find(a => {
        const actDate = new Date(a.startTimeLocal);
        return actDate >= lastWeekStart && actDate <= lastWeekEnd;
    });
    
    // Get recent activities (last 7 activities of same type)
    const recentActivities = sameTypeActivities
        .filter(a => new Date(a.startTimeLocal) < currentDate)
        .sort((a, b) => new Date(b.startTimeLocal).getTime() - new Date(a.startTimeLocal).getTime())
        .slice(0, 7);
    
    return {
        yesterdayActivity,
        lastWeekActivity,
        recentActivities,
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
    
    if (activity.activityType?.typeKey) {
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
const formatActivityPrompt = (activity: GarminActivity, historicalContext?: HistoricalContext): string => {
    const activityType = activity.activityType?.typeKey || 'unknown';
    const timeOfDay = getTimeOfDay(activity.startTimeLocal);
    
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
        
    const currentActivityMetricsMsg = JSON.stringify(extractMetrics(activity), null, 2);
    
    const historicalContextMsg = historicalContext ? JSON.stringify({
        yesterdayActivity: extractMetrics(historicalContext.yesterdayActivity),
        lastWeekActivity: extractMetrics(historicalContext.lastWeekActivity),
        recentActivities: historicalContext.recentActivities.map(a => extractMetrics(a))
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
9. CRITICAL: Analyze the time elapsed since the previous activities of the same type (using startTimeLocal) and correlate it with the performance metrics. Consider its potential impact (e.g., fatigue from insufficient rest, detraining from a long gap, or optimal recovery) and explicitly mention this impact in the insights.

=== CURRENT ACTIVITY METRICS ===
${currentActivityMetricsMsg}

=== HISTORICAL CONTEXT ===
${historicalContextMsg}${workoutContext}

Focus on: understanding the workout's PURPOSE based on the inferred workout type and metrics, evaluating training intensity, recovery recommendations, and trending performance vs historical data (and rest periods) if available. Keep response concise (2-3 sentences).

At the end of your response, add a confidence score from 0.0 to 1.0 indicating how confident you are in your analysis based on the data quality. Format: [CONFIDENCE: X.X]`;
};

/**
 * Result from AI insights generation
 */
export interface AIInsightResult {
    insight: string;
    model: string;
    confidence: number;
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
 */
export const generateActivityInsights = async (
    activity: GarminActivity,
    allActivities?: GarminActivity[]
): Promise<AIInsightResult | null> => {
    if (!isAIInsightsEnabled()) {
        return null;
    }

    const activityId = String(activity.activityId);
    const activityType = activity.activityType?.typeKey || 'unknown';
    
    // Calculate historical context if we have additional activities
    const historicalContext = allActivities && allActivities.length > 1
        ? getHistoricalContext(activity, allActivities)
        : undefined;
    
    if (historicalContext) {
        const hasYesterday = historicalContext.yesterdayActivity ? 'yes' : 'no';
        const hasLastWeek = historicalContext.lastWeekActivity ? 'yes' : 'no';
        console.log(`AI Insights: Historical context - Yesterday: ${hasYesterday}, Last week: ${hasLastWeek}, Recent activities: ${historicalContext.recentActivities.length}`);
    }
    
    console.log(`AI Insights: Generating insights for activity ${activityId} (${activityType}: "${activity.activityName}")...`);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Apply rate limiting
            await waitForRateLimit();
            
            const client = getGeminiClient();
            const model = client.getGenerativeModel({ model: GEMINI_MODEL });
            
            console.log(`AI Insights: Calling ${GEMINI_MODEL} API (attempt ${attempt}/${MAX_RETRIES})...`);
            const prompt = formatActivityPrompt(activity, historicalContext);
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            
            const { insight, confidence } = parseConfidence(text.trim());
            
            console.log(`AI Insights: Generated successfully (confidence: ${(confidence * 100).toFixed(0)}%)`);
            
            return {
                insight,
                model: GEMINI_MODEL,
                confidence,
            };
        } catch (error: any) {
            const isRateLimited = error?.status === 429 || error?.statusText === 'Too Many Requests';
            
            if (isRateLimited && attempt < MAX_RETRIES) {
                // Extract retry delay from error if available, otherwise use exponential backoff
                let retryDelay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
                
                // Try to parse retryDelay from error details
                if (error?.errorDetails) {
                    const retryInfo = error.errorDetails.find((d: any) => d['@type']?.includes('RetryInfo'));
                    if (retryInfo?.retryDelay) {
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
        
        // Generate insights with historical context
        const result = await generateActivityInsights(activity, allActivities);
        
        if (result) {
            // Save to database with model and confidence
            console.log(`AI Insights: Saving insights to database...`);
            const insightData: AIInsightData = {
                activityId,
                activityName: activity.activityName,
                insight: result.insight,
                model: result.model,
                confidence: result.confidence,
            };
            await saveAIInsight(insightData);
            console.log(`AI Insights: Saved to database successfully`);
            
            // Post as comment to Garmin activity if client is provided
            if (client) {
                console.log(`AI Insights: Posting as comment to Garmin activity ${activityId}...`);
                const timestamp = new Date().toLocaleString('zh-CN', { timeZoneName: 'short' });
                const commentText = `🤖 AI Insights (${result.model}, ${timestamp}):\n${result.insight}\n\nConfidence: ${(result.confidence * 100).toFixed(0)}%`;
                const commentSuccess = await addActivityComment(activityId, commentText, client, forceUpdate);
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
            
            // Format the insight comment
            const confidencePercent = (insight.confidence * 100).toFixed(0);
            const timestamp = insight.createdAt 
                ? new Date(insight.createdAt + ' UTC').toLocaleString('zh-CN', { timeZoneName: 'short' }) 
                : new Date().toLocaleString('zh-CN', { timeZoneName: 'short' });
            const formattedInsight = `🤖 AI Insights (${insight.model}, ${timestamp}):\n${insight.insight}\n\nConfidence: ${confidencePercent}%`;
            
            console.log(`AI Insights: Posting insight to activity ${insight.activityId} (${insight.activityName})...`);
            
            const success = await addActivityComment(
                insight.activityId, 
                formattedInsight, 
                client,
                false
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

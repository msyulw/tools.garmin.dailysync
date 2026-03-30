import { GarminClientType } from './type';

/**
 * Performance metrics for a given day
 */
export interface PerformanceContext {
    date: string;
    trainingReadiness?: {
        score: number;
        level: string;
    };
    hrvStatus?: {
        lastNightAvg: number;
        weeklyAvg: number;
        status: string;
    };
    bodyBattery?: {
        charged: number;
        drained: number;
        current: number;
    };
    vo2Max?: {
        value: number;
        type: string;
    };
    sleep?: {
        score: number;
        quality: string;
        durationHours: number;
    };
}

/**
 * Cache for performance context to avoid redundant API calls within the same run
 */
const performanceCache = new Map<string, PerformanceContext>();

/**
 * Fetch daily performance metrics from Garmin Connect
 * @param client GarminConnect client
 * @param date Date string in YYYY-MM-DD format
 */
export const fetchPerformanceContext = async (
    client: GarminClientType,
    date: string
): Promise<PerformanceContext | undefined> => {
    // Check cache first
    if (performanceCache.has(date)) {
        return performanceCache.get(date);
    }

    try {
        console.log(`AI Insights: Fetching performance context for ${date}...`);
        
        // Base API URL from client
        const baseUrl = ((client && client.url) ? client.url.GC_API : 'https://connectapi.garmin.com');
        
        // Run requests in parallel with individual error handling
        // Run requests sequentially to avoid session issues on CN
        const readiness = await client.client.get(baseUrl + '/metrics-service/metrics/trainingreadiness/' + date)
            .catch(() => undefined);
        
        const hrv = await client.client.get(baseUrl + '/hrv-service/hrv/' + date)
            .catch(() => undefined);
            
        // Body Battery
        const bodyBattery = await client.client.get(baseUrl + '/wellness-service/wellness/bodyBattery/reports/daily?startDate=' + date + '&endDate=' + date)
            .then(r => (r && r[0]))
            .catch(() => {
                // Fallback for Global which uses calendarDate
                return client.client.get(baseUrl + '/wellness-service/wellness/bodyBattery/reports/daily?calendarDate=' + date)
                    .then(r => (r && r[0]))
                    .catch(() => undefined);
            });
            
        const maxMet = await client.client.get(baseUrl + '/metrics-service/metrics/maxmet/daily/' + date + '/' + date)
            .then(r => (r && r[0]))
            .catch(() => undefined);
            
        // Daily Sleep
        const sleep = await client.client.get(baseUrl + '/wellness-service/wellness/dailySleepData?date=' + date)
            .catch(() => {
                // Fallback for CN which sometimes prefers /user or /modern segments
                return client.client.get(baseUrl + '/wellness-service/wellness/dailySleepData/user?date=' + date)
                    .catch(() => undefined);
            });

        const readinessEntry = readiness && (readiness[0] || (Array.isArray(readiness) ? undefined : readiness));
        const hrvSummary = hrv && hrv.hrvSummary;
        const bbEntry = bodyBattery && (bodyBattery[0] || (Array.isArray(bodyBattery) ? undefined : bodyBattery));
        const maxMetEntry = maxMet && (maxMet[0] || (Array.isArray(maxMet) ? undefined : maxMet))?.generic;
        const sleepDTO = sleep && sleep.dailySleepDTO;

        const context: PerformanceContext = {
            date,
            trainingReadiness: (readinessEntry && readinessEntry.score !== undefined) ? {
                score: readinessEntry.score,
                level: readinessEntry.level || 'Unknown',
            } : undefined,
            hrvStatus: (hrvSummary && hrvSummary.lastNightAvg) ? {
                lastNightAvg: hrvSummary.lastNightAvg,
                weeklyAvg: hrvSummary.weeklyAvg,
                status: hrvSummary.status || 'Unknown',
            } : undefined,
            bodyBattery: (bbEntry && bbEntry.charged !== undefined) ? {
                charged: bbEntry.charged,
                drained: bbEntry.drained,
                current: (bbEntry.bodyBatteryValuesArray && bbEntry.bodyBatteryValuesArray.length > 0)
                    ? bbEntry.bodyBatteryValuesArray[bbEntry.bodyBatteryValuesArray.length - 1][1]
                    : bbEntry.bodyBatteryLevel,
            } : undefined,
            vo2Max: (maxMetEntry && maxMetEntry.vo2MaxPreciseValue) ? {
                value: Math.round(maxMetEntry.vo2MaxPreciseValue || maxMetEntry.vo2MaxValue || 0),
                type: 'Running',
            } : undefined,
            sleep: (sleepDTO && sleepDTO.sleepScores) ? {
                score: sleepDTO.sleepScores.overall && sleepDTO.sleepScores.overall.value,
                quality: sleepDTO.sleepScores.overall && sleepDTO.sleepScores.overall.qualifierKey,
                durationHours: parseFloat((sleepDTO.sleepTimeSeconds / 3600).toFixed(1)),
            } : undefined,
        };

        // Cache the result
        performanceCache.set(date, context);
        return context;
    } catch (error) {
        console.error(`AI Insights: Failed to fetch performance context for ${date}:`, error);
        return undefined;
    }
};

/**
 * Format performance context into a concise summary for the AI prompt
 */
export const formatPerformanceContext = (ctx?: PerformanceContext): string => {
    if (!ctx) return 'No physiological performance data available for this date.';

    const lines: string[] = [];
    
    if (ctx.trainingReadiness) {
        lines.push(`- Training Readiness: ${ctx.trainingReadiness.score} (${ctx.trainingReadiness.level})`);
    }
    
    if (ctx.hrvStatus) {
        lines.push(`- HRV Status: ${ctx.hrvStatus.status} (Last Night: ${ctx.hrvStatus.lastNightAvg} ms, Weekly Avg: ${ctx.hrvStatus.weeklyAvg} ms)`);
    }
    
    if (ctx.bodyBattery) {
        lines.push(`- Body Battery: Current ${ctx.bodyBattery.current}, Charged ${ctx.bodyBattery.charged}, Drained ${ctx.bodyBattery.drained}`);
    }
    
    if (ctx.vo2Max) {
        lines.push(`- VO2 Max: ${ctx.vo2Max.value} (${ctx.vo2Max.type})`);
    }
    
    if (ctx.sleep && ctx.sleep.score) {
        lines.push(`- Sleep: ${ctx.sleep.score} (${ctx.sleep.quality}), Duration: ${ctx.sleep.durationHours}h`);
    }

    if (lines.length === 0) {
        return 'No physiological performance data available for this date.';
    }

    return lines.join('\n');
};

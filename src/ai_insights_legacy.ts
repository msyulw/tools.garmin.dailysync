/**
 * AI Insights Legacy Processing
 * 
 * This script processes historical activities that don't have AI insights yet.
 * 
 * Usage: LEGACY_COUNT=50 yarn ai_insights
 * 
 * Environment variables:
 *   - LEGACY_COUNT: Maximum number of legacy activities to process (default: 10)
 *   - GEMINI_API_KEY: Google Gemini API key (required)
 *   - AI_INSIGHTS_ENABLED: Enable/disable AI insights (default: true)
 */

import { getGaminCNClient } from './utils/garmin_cn';
import { getGaminGlobalClient } from './utils/garmin_global';
import { processActivitiesWithInsights, isAIInsightsEnabled, GarminActivity } from './utils/ai_insights';
import { AI_INSIGHTS_LEGACY_COUNT_DEFAULT } from './constant';
import { initDB } from './utils/sqlite';

const core = require('@actions/core');

const LEGACY_COUNT = Number(process.env.LEGACY_COUNT) || AI_INSIGHTS_LEGACY_COUNT_DEFAULT;
const USE_GLOBAL = process.env.USE_GLOBAL === 'true';

const processLegacyActivities = async () => {
    console.log('========================================');
    console.log('AI Insights Legacy Processing');
    console.log('========================================');
    console.log(`Max activities to process: ${LEGACY_COUNT}`);
    console.log(`Using ${USE_GLOBAL ? 'Global' : 'CN'} account`);
    console.log('');

    if (!isAIInsightsEnabled()) {
        console.log('AI Insights is not enabled. Please check your configuration.');
        console.log('Make sure GEMINI_API_KEY is set and AI_INSIGHTS_ENABLED is not false.');
        return;
    }

    try {
        await initDB();

        // Get the Garmin client
        const client = USE_GLOBAL 
            ? await getGaminGlobalClient() 
            : await getGaminCNClient();

        if (!client) {
            console.error('Failed to initialize Garmin client');
            return;
        }

        // Fetch activities
        console.log(`Fetching up to ${LEGACY_COUNT} activities...`);
        const activities = await client.getActivities(0, LEGACY_COUNT) as GarminActivity[];
        console.log(`Found ${activities.length} activities`);
        console.log('');

        // Process activities with AI insights (and post comments to Garmin)
        const processedCount = await processActivitiesWithInsights(activities, client);

        console.log('========================================');
        console.log(`Processing complete!`);
        console.log(`Activities processed with new AI insights: ${processedCount}`);
        console.log(`Activities skipped (already had insights): ${activities.length - processedCount}`);
        console.log('========================================');

    } catch (error) {
        console.error('Error processing legacy activities:', error);
        core.setFailed(error instanceof Error ? error.message : String(error));
        throw error;
    }
};

// Run the script
processLegacyActivities().catch((e) => {
    core.setFailed(e.message);
    process.exit(1);
});

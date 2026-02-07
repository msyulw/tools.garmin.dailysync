/**
 * Sync Missing AI Insights to Garmin
 * 
 * Checks all activities with insights in the database and posts them to Garmin
 * if not already present in the activity description.
 * 
 * Usage: yarn sync_insights
 * 
 * Environment variables:
 *   - USE_GLOBAL: Use global account instead of CN (default: false)
 */

import { getGaminCNClient } from './utils/garmin_cn';
import { getGaminGlobalClient } from './utils/garmin_global';
import { syncMissingInsightsToGarmin } from './utils/ai_insights';
import { initDB } from './utils/sqlite';

const core = require('@actions/core');

const USE_GLOBAL = process.env.USE_GLOBAL === 'true';

const syncInsights = async () => {
    console.log('========================================');
    console.log('Sync Missing AI Insights to Garmin');
    console.log('========================================');
    console.log(`Using ${USE_GLOBAL ? 'Global' : 'CN'} account`);
    console.log('');

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

        // Sync missing insights
        const syncedCount = await syncMissingInsightsToGarmin(client);

        console.log('========================================');
        console.log(`Sync complete! Activities synced: ${syncedCount}`);
        console.log('========================================');

    } catch (error) {
        console.error('Error syncing insights:', error);
        core.setFailed(error instanceof Error ? error.message : String(error));
        throw error;
    }
};

// Run the script
syncInsights().catch((e) => {
    core.setFailed(e.message);
    process.exit(1);
});

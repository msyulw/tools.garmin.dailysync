/**
 * Refresh AI Insights
 * 
 * Re-process recent activities for AI insights with trending comparisons.
 * This forces regeneration of insights, useful after algorithm updates.
 * 
 * Usage: yarn refresh-insights --count 10
 *        yarn refresh-insights -n 10
 *        yarn refresh-insights          (defaults to 5 activities)
 * 
 * Options:
 *   --count, -n   Number of most recent activities to process (default: 5)
 *   --force, -f   Force regeneration even if insights exist
 *   --global      Use Global account instead of CN
 *   --help, -h    Show help
 * 
 * Environment variables (alternative):
 *   - REFRESH_COUNT: Number of activities (overridden by --count)
 *   - USE_GLOBAL: Use global account if true
 */

import { getGaminCNClient } from './utils/garmin_cn';
import { getGaminGlobalClient } from './utils/garmin_global';
import { 
    processActivityWithInsights, 
    isAIInsightsEnabled, 
    GarminActivity 
} from './utils/ai_insights';
import { initDB, initAIInsightsTable, getDB } from './utils/sqlite';

const core = require('@actions/core');

// Parse command line arguments
const parseArgs = (): { count: number; force: boolean; useGlobal: boolean; showHelp: boolean } => {
    const args = process.argv.slice(2);
    let count = Number(process.env.REFRESH_COUNT) || 5;
    let force = false;
    let useGlobal = process.env.USE_GLOBAL === 'true';
    let showHelp = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        if (arg === '--count' || arg === '-n') {
            const nextArg = args[i + 1];
            if (nextArg && !nextArg.startsWith('-')) {
                count = parseInt(nextArg, 10);
                if (isNaN(count) || count <= 0) {
                    console.error(`Invalid count: ${nextArg}. Must be a positive number.`);
                    process.exit(1);
                }
                i++; // Skip next arg
            }
        } else if (arg.startsWith('--count=')) {
            count = parseInt(arg.split('=')[1], 10);
            if (isNaN(count) || count <= 0) {
                console.error(`Invalid count. Must be a positive number.`);
                process.exit(1);
            }
        } else if (arg === '--force' || arg === '-f') {
            force = true;
        } else if (arg === '--global') {
            useGlobal = true;
        } else if (arg === '--help' || arg === '-h') {
            showHelp = true;
        } else if (/^\d+$/.test(arg)) {
            // Allow bare number as count: yarn refresh-insights 10
            count = parseInt(arg, 10);
        }
    }

    return { count, force, useGlobal, showHelp };
};

const showHelpMessage = () => {
    console.log(`
Refresh AI Insights - Re-process activities with latest AI algorithm

Usage:
  yarn refresh-insights [options] [count]

Options:
  --count, -n <N>  Number of most recent activities to process (default: 5)
  --force, -f      Force regeneration even if insights already exist
  --global         Use Global account instead of CN
  --help, -h       Show this help message

Examples:
  yarn refresh-insights                    # Process 5 most recent activities
  yarn refresh-insights 10                 # Process 10 most recent activities
  yarn refresh-insights --count 10         # Same as above
  yarn refresh-insights -n 10 --force      # Force regenerate 10 activities
  yarn refresh-insights --global -n 20     # Process 20 activities from Global account
`);
};

/**
 * Delete existing insight from database to force regeneration
 */
const deleteInsight = async (activityId: string): Promise<void> => {
    const db = await getDB();
    await db.run('DELETE FROM ai_insights WHERE activity_id = ?', activityId);
};

const refreshInsights = async () => {
    const { count, force, useGlobal, showHelp } = parseArgs();

    if (showHelp) {
        showHelpMessage();
        return;
    }

    console.log('========================================');
    console.log('🔄 Refresh AI Insights');
    console.log('========================================');
    console.log(`Activities to process: ${count}`);
    console.log(`Force regeneration: ${force ? 'Yes' : 'No'}`);
    console.log(`Account: ${useGlobal ? 'Global' : 'CN'}`);
    console.log('');

    if (!isAIInsightsEnabled()) {
        console.log('❌ AI Insights is not enabled. Please check your configuration.');
        console.log('Make sure GEMINI_API_KEY is set and AI_INSIGHTS_ENABLED is not false.');
        return;
    }

    try {
        await initDB();
        await initAIInsightsTable();

        // Get the Garmin client
        const client = useGlobal 
            ? await getGaminGlobalClient() 
            : await getGaminCNClient();

        if (!client) {
            console.error('❌ Failed to initialize Garmin client');
            return;
        }

        // Fetch activities
        console.log(`📥 Fetching ${count} most recent activities...`);
        const activities = await client.getActivities(0, count) as GarminActivity[];
        console.log(`✅ Found ${activities.length} activities`);
        console.log('');

        // Process each activity
        let processedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (const activity of activities) {
            const activityId = String(activity.activityId);
            const activityName = activity.activityName;
            const activityDate = activity.startTimeLocal?.split('T')[0] || 'Unknown';

            console.log(`\n📋 Activity: "${activityName}" (${activityDate})`);

            try {
                if (force) {
                    // Delete existing insight to force regeneration
                    await deleteInsight(activityId);
                    console.log(`   🗑️  Deleted existing insight for regeneration`);
                }

                // Process with all activities for trend context
                const result = await processActivityWithInsights(activity, client, activities, force);
                
                if (result) {
                    processedCount++;
                    console.log(`   ✅ Generated new insight (confidence: ${(result.confidence * 100).toFixed(0)}%)`);
                } else {
                    skippedCount++;
                    console.log(`   ⏭️  Skipped (already has insight or generation failed)`);
                }
            } catch (error) {
                errorCount++;
                console.error(`   ❌ Error:`, error);
            }

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log('\n========================================');
        console.log('📊 Summary');
        console.log('========================================');
        console.log(`✅ Processed with new insights: ${processedCount}`);
        console.log(`⏭️  Skipped: ${skippedCount}`);
        if (errorCount > 0) {
            console.log(`❌ Errors: ${errorCount}`);
        }
        console.log('========================================');

    } catch (error) {
        console.error('❌ Error refreshing insights:', error);
        core.setFailed(error instanceof Error ? error.message : String(error));
        throw error;
    }
};

// Run the script
refreshInsights().catch((e) => {
    core.setFailed(e.message);
    process.exit(1);
});

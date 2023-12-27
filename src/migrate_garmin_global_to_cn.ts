import { migrateGarminGlobal2GarminCN } from './utils/garmin_global';

const core = require('@actions/core');

try {
    migrateGarminGlobal2GarminCN();
} catch (e) {
    core.setFailed(e.message);
    throw new Error(e);
}





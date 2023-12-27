import { migrateGarminCN2GarminGlobal } from './utils/garmin_cn';

const core = require('@actions/core');

try {
    migrateGarminCN2GarminGlobal();
} catch (e) {
    core.setFailed(e.message);
    throw new Error(e);
}





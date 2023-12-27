import { syncGarminGlobal2GarminCN } from './utils/garmin_global';

const core = require('@actions/core');

try {
    syncGarminGlobal2GarminCN();
} catch (e) {
    core.setFailed(e.message);
    throw new Error(e);
}





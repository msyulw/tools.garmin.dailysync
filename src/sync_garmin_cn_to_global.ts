import { syncGarminCN2GarminGlobal } from './utils/garmin_cn';

const core = require('@actions/core');

try {
    syncGarminCN2GarminGlobal();
} catch (e) {
    core.setFailed(e.message);
    throw new Error(e);
}





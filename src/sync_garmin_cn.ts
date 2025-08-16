import { downloadAllGarminCN } from './utils/garmin_cn';

const core = require('@actions/core');

try {
   downloadAllGarminCN(100);
} catch (e) {
    core.setFailed(e.message);
    throw new Error(e);
}





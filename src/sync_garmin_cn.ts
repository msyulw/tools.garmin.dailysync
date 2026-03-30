import { downloadAllGarminCN } from './utils/garmin_cn';

const core = require('@actions/core');

const count = process.env.REFRESH_COUNT ? Number(process.env.REFRESH_COUNT) : undefined;

try {
   downloadAllGarminCN(100, count);
} catch (e) {
    core.setFailed(e.message);
    throw new Error(e);
}





import { doRQGoogleSheets } from './utils/runningquotient';

const core = require('@actions/core');



try {
    doRQGoogleSheets();
} catch (e) {
    core.setFailed(e.message);
    throw new Error(e);
}





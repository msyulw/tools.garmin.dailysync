import { getGaminGlobalClient } from './garmin_global';
import {
    AESKEY_DEFAULT,
    GARMIN_MIGRATE_NUM_DEFAULT,
    GARMIN_MIGRATE_START_DEFAULT,
    GARMIN_PASSWORD_DEFAULT,
    GARMIN_USERNAME_DEFAULT,
    GARMIN_SYNC_NUM_DEFAULT
} from '../constant';
import { isDownloaded, downloadGarminActivity, uploadGarminActivity } from './garmin_common';
import { GarminClientType } from './type';
import { number2capital } from './number_tricks';
import { processActivityWithInsights, GarminActivity, isAIInsightsEnabled } from './ai_insights';
const core = require('@actions/core');
import _ from 'lodash';
import { getSessionFromDB, initDB, saveSessionToDB, updateSessionToDB } from './sqlite';

const CryptoJS = require('crypto-js');
const fs = require('fs');

const { GarminConnect } = require('@gooin/garmin-connect');

const GARMIN_USERNAME = process.env.GARMIN_USERNAME ?? GARMIN_USERNAME_DEFAULT;
const GARMIN_PASSWORD = process.env.GARMIN_PASSWORD ?? GARMIN_PASSWORD_DEFAULT;
const GARMIN_MIGRATE_NUM = process.env.GARMIN_MIGRATE_NUM ?? GARMIN_MIGRATE_NUM_DEFAULT;
const GARMIN_MIGRATE_START = process.env.GARMIN_MIGRATE_START ?? GARMIN_MIGRATE_START_DEFAULT;
const GARMIN_SYNC_NUM = process.env.GARMIN_SYNC_NUM ?? GARMIN_SYNC_NUM_DEFAULT;

export const getGaminCNClient = async (): Promise<GarminClientType> => {
    if (_.isEmpty(GARMIN_USERNAME) || _.isEmpty(GARMIN_PASSWORD)) {
        const errMsg = '请填写中国区用户名及密码：GARMIN_USERNAME,GARMIN_PASSWORD';
        core.setFailed(errMsg);
        return Promise.reject(errMsg);
    }

    const GCClient = new GarminConnect({username: GARMIN_USERNAME, password: GARMIN_PASSWORD}, 'garmin.cn');

    try {
        await initDB();

        const currentSession = await getSessionFromDB('CN');
        if (!currentSession) {
            await GCClient.login();
            await saveSessionToDB('CN', GCClient.exportToken());
        } else {
            //  Wrap error message in GCClient, prevent terminate in github actions.
            try {
                console.log('GarminCN: login by saved session');
                await GCClient.loadToken(currentSession.oauth1, currentSession.oauth2);
            } catch (e) {
                console.log('Warn: renew  GarminCN Session..');
                await GCClient.login(GARMIN_USERNAME, GARMIN_PASSWORD);
                await updateSessionToDB('CN', GCClient.sessionJson);
            }

        }

        const userInfo = await GCClient.getUserProfile();
        const { fullName, userName: emailAddress, location } = userInfo;
        if (!fullName) {
            throw Error('佳明中国区登录失败')
        }
        console.log('Garmin userInfo CN: ', { fullName, emailAddress, location });

        return GCClient;
    } catch (err) {
        console.error(err);
        core.setFailed(err);
    }
};

export const migrateGarminCN2GarminGlobal = async (count = 200) => {
    const actIndex = Number(GARMIN_MIGRATE_START) ?? 0;
    // const actPerGroup = 10;
    const totalAct = Number(GARMIN_MIGRATE_NUM) ?? count;

    const clientCN = await getGaminCNClient();
    const clientGlobal = await getGaminGlobalClient();

    const actSlices = await clientCN.getActivities(actIndex, totalAct);
    // only running
    // const runningActs = _.filter(actSlices, { activityType: { typeKey: 'running' } });

    const runningActs = actSlices;
    for (let j = 0; j < runningActs.length; j++) {
        const act = runningActs[j];
        // console.log({ act });
        // 下载佳明原始数据
        const filePath = await downloadGarminActivity(act.activityId, clientCN);
        // 上传到佳明国际区
        console.log(`本次开始向国际区上传第 ${number2capital(j + 1)} 条数据，相对总数上传到 ${number2capital(j + 1 + actIndex)} 条，  【 ${act.activityName} 】，开始于 【 ${act.startTimeLocal} 】，活动ID: 【 ${act.activityId} 】`);
        await uploadGarminActivity(filePath, clientGlobal);
        // await new Promise(resolve => setTimeout(resolve, 2000));
    }
};

export const syncGarminCN2GarminGlobal = async () => {
    const timeStamp = new Date().toLocaleString("zh-cn")
    const clientCN = await getGaminCNClient();
    const clientGlobal = await getGaminGlobalClient();

    let cnActs = await clientCN.getActivities(0, Number(GARMIN_SYNC_NUM));
    const globalActs = await clientGlobal.getActivities(0, 1);

    const latestGlobalActStartTime = globalActs[0]?.startTimeLocal ?? '0';
    const latestCnActStartTime = cnActs[0]?.startTimeLocal ?? '0';
    if (latestCnActStartTime === latestGlobalActStartTime) {
        console.log(timeStamp + ` 没有要同步的活动内容, 最近的活动:  【 ${cnActs[0].activityName} 】, 开始于: 【 ${latestCnActStartTime} 】`);
    } else {
        // fix: #18
        _.reverse(cnActs);
        let actualNewActivityCount = 1;
        for (let i = 0; i < cnActs.length; i++) {
            const cnAct = cnActs[i];
            if (cnAct.startTimeLocal > latestGlobalActStartTime) {
                // Download original Garmin data
                const filePath = await downloadGarminActivity(cnAct.activityId, clientCN);
                // Generate AI insights and add to source activity (with trending context)
                await processActivityWithInsights(cnAct as GarminActivity, clientCN, cnActs as GarminActivity[]);
                // Upload to Garmin Global
                console.log(timeStamp + ` 本次开始向国际区上传第 ${number2capital(actualNewActivityCount)} 条数据，【 ${cnAct.activityName} 】，开始于 【 ${cnAct.startTimeLocal} 】，活动ID: 【 ${cnAct.activityId} 】`);
                await uploadGarminActivity(filePath, clientGlobal);
                await new Promise(resolve => setTimeout(resolve, 1000));
                actualNewActivityCount++;
            }
        }
    }
};

export const downloadAllGarminCN = async (count = 200) => {
    const actIndex = Number(GARMIN_MIGRATE_START) ?? 0;
    const totalAct = count;
    const clientCN = await getGaminCNClient();
    
    console.log(`Fetching up to ${totalAct} activities from CN starting at index ${actIndex}...`);
    const actSlices = await clientCN.getActivities(actIndex, totalAct);
    console.log(`Found ${actSlices.length} activities`);
    
    const runningActs = actSlices;
    let downloadedCount = 0;
    let insightsCount = 0;

    for (let j = 0; j < runningActs.length; j++) {
        const act = runningActs[j];
        
        // Download activity if not already downloaded
        if (!isDownloaded(act.activityId)) {
            const filePath = await downloadGarminActivity(act.activityId, clientCN);
            console.log(`下载 ${filePath} 完成`);
            downloadedCount++;
        }
        
        // Process AI insights if enabled
        if (isAIInsightsEnabled()) {
            const result = await processActivityWithInsights(act as GarminActivity, clientCN, runningActs as GarminActivity[]);
            if (result) {
                insightsCount++;
            }
        }
    }
    
    console.log(`\n========================================`);
    console.log(`Processing complete!`);
    console.log(`Activities downloaded: ${downloadedCount}`);
    if (isAIInsightsEnabled()) {
        console.log(`AI insights generated: ${insightsCount}`);
    }
    console.log(`========================================`);
};

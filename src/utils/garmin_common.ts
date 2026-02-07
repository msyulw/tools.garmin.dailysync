import fs from 'fs';

const core = require('@actions/core');
import {
    DOWNLOAD_DIR,
    FILE_SUFFIX,
    GARMIN_MIGRATE_NUM_DEFAULT,
    GARMIN_MIGRATE_START_DEFAULT,
    GARMIN_PASSWORD_DEFAULT,
    GARMIN_URL_DEFAULT,
    GARMIN_USERNAME_DEFAULT,
} from '../constant';
import { GarminClientType } from './type';
import _ from 'lodash';
const decompress = require('decompress');

const unzipper = require('unzipper');

/**
 * 上传 .fit file
 * @param fitFilePath
 * @param client
 */
export const uploadGarminActivity = async (fitFilePath: string, client: GarminClientType): Promise<void> => {
    if (!fs.existsSync(DOWNLOAD_DIR)) {
        fs.mkdirSync(DOWNLOAD_DIR);
    }
    try {
        const upload = await client.uploadActivity(fitFilePath);
        console.log('upload to garmin activity', upload);
    } catch (error) {
        console.log('upload to garmin activity error', error);
    }
};

/**
 * 下载 garmin 活动原始数据，并解压保存到本地
 * @param activityId
 * @param client GarminClientType
 */
export const downloadGarminActivity = async (activityId, client: GarminClientType): Promise<string> => {
    if (!fs.existsSync(DOWNLOAD_DIR)) {
        fs.mkdirSync(DOWNLOAD_DIR);
    }
    const activity = await client.getActivity({ activityId: activityId });
    await client.downloadOriginalActivityData(activity, DOWNLOAD_DIR);
    const originZipFile = DOWNLOAD_DIR + '/' + activityId + '.zip';
    const baseFilePath = `${DOWNLOAD_DIR}/`;
    const unzipped = await decompress(originZipFile, DOWNLOAD_DIR);
    const unzippedFileName = unzipped?.[0].path;
    const path = baseFilePath + unzippedFileName;
    console.log('downloadGarminActivity - path:', path)
    return path;
};

export const isDownloaded = (activityId, ) => {
    const originZipFile = DOWNLOAD_DIR + '/' + activityId + '.zip';
    return fs.existsSync(originZipFile)
};

/**
 * Add AI insights to a Garmin activity description
 * Uses PUT via X-Http-Method-Override to activity-service/activity/{activityId}
 * @param activityId The activity ID to update
 * @param comment The AI insight text to add
 * @param client GarminClientType
 * @param forceCheck If true, re-add insight even if one already exists
 * @returns true if successful, false otherwise
 */
export const addActivityComment = async (
    activityId: string | number, 
    comment: string, 
    client: GarminClientType,
    forceCheck: boolean = false
): Promise<boolean> => {
    try {
        // Get current activity details
        const activity = await client.getActivity({ activityId: activityId });
        
        if (!activity) {
            console.log(`AI Insights: Could not fetch activity ${activityId}`);
            return false;
        }
        
        let currentDescription = activity.description || '';
        
        // Check if AI insight is already present
        const hasExistingInsight = currentDescription.includes('🤖 AI Insights') || currentDescription.includes('AI Insights (');
        
        if (hasExistingInsight) {
            if (!forceCheck) {
                console.log(`AI Insights: Activity ${activityId} already has AI insight, skipping`);
                return true;
            }
            // Remove existing AI insight to replace with new one
            // Pattern matches: optional separator (---) + 🤖 AI Insights... until end or next separator
            const insightPattern = /(\n\n---\n\n)?🤖 AI Insights[^]*?(?=\n\n---\n\n|$)/g;
            currentDescription = currentDescription.replace(insightPattern, '').trim();
            console.log(`AI Insights: Replacing existing insight for activity ${activityId}`);
        }
        
        // Prepare the updated description with separator
        const separator = currentDescription ? '\n\n---\n\n' : '';
        const newDescription = currentDescription + separator + comment;
        
        // Use POST with X-Http-Method-Override: PUT (same pattern the library uses for DELETE)
        const activityUrl = client.url?.ACTIVITY + activityId;
        
        await client.client.post(activityUrl, {
            activityId: Number(activityId),
            activityName: activity.activityName,
            description: newDescription,
        }, {
            headers: {
                'X-Http-Method-Override': 'PUT',
            }
        });
        
        console.log(`AI Insights: Activity ${activityId} description updated successfully`);
        return true;
    } catch (error: any) {
        const errorMessage = error?.message || error?.statusText || 'Unknown error';
        const statusCode = error?.response?.status || error?.status || 'N/A';
        console.error(`AI Insights: Failed to update activity ${activityId} (status: ${statusCode}): ${errorMessage}`);
        return false;
    }
};

/**
 * Check if an activity already has AI insights in its description
 */
export const hasActivityInsight = async (activityId: string | number, client: GarminClientType): Promise<boolean> => {
    try {
        const activity = await client.getActivity({ activityId: activityId });
        const description = activity?.description || '';
        return description.includes('🤖 AI Insights') || description.includes('AI Insights (');
    } catch (error) {
        return false;
    }
};

export const getGarminStatistics = async (client: GarminClientType): Promise<Record<string, any>> => {
    // Get a list of default length with most recent activities
    const acts = await client.getActivities(0, 10);
    // console.log('acts', acts);

    //  跑步 typeKey: 'running'
    //  操场跑步 typeKey: 'track_running'
    //  跑步机跑步 typeKey: 'treadmill_running'
    //  沿街跑步 typeKey: 'street_running'

    // 包含running关键字的都算
    const recentRunningAct = _.filter(acts, act => act?.activityType?.typeKey?.includes('running'))[0];
    console.log('recentRunningAct type: ', recentRunningAct.activityType?.typeKey);

    const {
        activityId, // 活动id
        activityName, // 活动名称
        startTimeLocal, // 活动开始时间
        distance, // 距离
        duration, // 时间
        averageSpeed, // 平均速度 m/s
        averageHR, // 平均心率
        maxHR, // 最大心率
        averageRunningCadenceInStepsPerMinute, // 平均每分钟步频
        aerobicTrainingEffect, // 有氧效果
        anaerobicTrainingEffect, // 无氧效果
        avgGroundContactTime, // 触地时间
        avgStrideLength, // 步幅
        vO2MaxValue, // VO2Max
        avgVerticalOscillation, // 垂直振幅
        avgVerticalRatio, // 垂直振幅比
        avgGroundContactBalance, // 触地平衡
        trainingEffectLabel, // 训练效果
        activityTrainingLoad, // 训练负荷
    } = recentRunningAct;

    const pace = 1 / (averageSpeed / 1000 * 60);
    const pace_min = Math.floor(1 / (averageSpeed / 1000 * 60));
    const pace_second = (pace - pace_min) * 60;
    // 秒数小于10前面添加0， 如01，避免谷歌表格识别不成分钟数。  5:9 -> 5:09
    const pace_second_text = pace_second < 10 ? '0' + pace_second.toFixed(0) : pace_second.toFixed(0);
    // console.log('pace', pace);
    // console.log('pace_min', pace_min);
    // console.log('pace_second', pace_second);

    return {
        activityId, // 活动id
        activityName, // 活动名称
        startTimeLocal, // 活动开始时间
        distance, // 距离
        duration, // 持续时间
        // averageSpeed 是 m/s
        averageSpeed, // 速度
        averagePace: pace,  // min/km
        averagePaceText: `${pace_min}:${pace_second_text}`,  // min/km
        averageHR, // 平均心率
        maxHR, // 最大心率
        averageRunningCadenceInStepsPerMinute, // 平均每分钟步频
        aerobicTrainingEffect, // 有氧效果
        anaerobicTrainingEffect, // 无氧效果
        avgGroundContactTime, // 触地时间
        avgStrideLength, // 步幅
        vO2MaxValue, // 最大摄氧量
        avgVerticalOscillation, // 垂直振幅
        avgVerticalRatio, // 垂直振幅比
        avgGroundContactBalance, // 触地平衡
        trainingEffectLabel, // 训练效果
        activityTrainingLoad, // 训练负荷
        activityURL: GARMIN_URL_DEFAULT.ACTIVITY_URL + activityId, // 活动链接
    };
    // const detail = await GCClient.getActivity(recentRunningAct);
    // console.log('detail', detail);
};

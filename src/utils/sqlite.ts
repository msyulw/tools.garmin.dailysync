import { AESKEY_DEFAULT, DB_FILE_PATH, DOWNLOAD_DIR, GARMIN_USERNAME_DEFAULT } from '../constant';
import sqlite3 from 'sqlite3';
import { Database, open } from 'sqlite';

const CryptoJS = require('crypto-js');

const GARMIN_USERNAME = process.env.GARMIN_USERNAME ?? GARMIN_USERNAME_DEFAULT;
const AESKEY = process.env.AESKEY ?? AESKEY_DEFAULT;

export const initDB = async () => {
    const db = await getDB();
    await db.exec(`CREATE TABLE IF NOT EXISTS garmin_session (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user VARCHAR(20),
            region VARCHAR(20),
            session  TEXT
        )`);
};

export const getDB = async () => {
    return await open({
        filename: DB_FILE_PATH,
        driver: sqlite3.Database,
    });
};

export const saveSessionToDB = async (type: 'CN' | 'GLOBAL', session: Record<string, any>) => {
    const db = await getDB();
    const encryptedSessionStr = encryptSession(session);
    await db.run(
        `INSERT INTO garmin_session (user,region,session) VALUES (?,?,?)`,
        GARMIN_USERNAME, type, encryptedSessionStr,
    );
};

export const updateSessionToDB = async (type: 'CN' | 'GLOBAL', session: Record<string, any>) => {
    const db = await getDB();
    const encryptedSessionStr = encryptSession(session);
    await db.run(
        'UPDATE garmin_session SET session = ? WHERE user = ? AND region = ?',
        encryptedSessionStr,
        GARMIN_USERNAME,
        type,
    );
};

export const getSessionFromDB = async (type: 'CN' | 'GLOBAL'): Promise<Record<string, any> | undefined> => {
    const db = await getDB();
    const queryResult = await db.get(
        'SELECT session FROM garmin_session WHERE user = ? AND region = ? ',
        GARMIN_USERNAME, type,
    );
    if (!queryResult) {
        return undefined;
    }
    const encryptedSessionStr = queryResult?.session;
    // return {}
    return decryptSession(encryptedSessionStr);
};

export const encryptSession = (session: Record<string, any>): string => {
    const sessionStr = JSON.stringify(session);
    return CryptoJS.AES.encrypt(sessionStr, AESKEY).toString();
};
export const decryptSession = (sessionStr: string): Record<string, any> => {
    const bytes = CryptoJS.AES.decrypt(sessionStr, AESKEY);
    const session = bytes.toString(CryptoJS.enc.Utf8);
    return JSON.parse(session);
};

/**
 * AI Insights Table Functions
 */

/**
 * Check if a column exists in a table
 */
const columnExists = async (db: any, tableName: string, columnName: string): Promise<boolean> => {
    const result = await db.all(`PRAGMA table_info(${tableName})`);
    return result.some((col: { name: string }) => col.name === columnName);
};

/**
 * Initialize AI Insights table with migration support
 * Handles schema evolution by adding missing columns to existing tables
 */
export const initAIInsightsTable = async () => {
    const db = await getDB();
    
    // Check if table exists
    const tableExists = await db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ai_insights'"
    );
    
    if (!tableExists) {
        // Create new table with full schema
        await db.exec(`CREATE TABLE ai_insights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            activity_id VARCHAR(50) UNIQUE,
            activity_name TEXT,
            insight TEXT,
            model VARCHAR(50),
            confidence REAL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log('AI Insights: Created new ai_insights table');
    } else {
        // Migrate existing table - add missing columns
        const migrations: Array<{ column: string; type: string; defaultValue?: string }> = [
            { column: 'model', type: 'VARCHAR(50)', defaultValue: "'unknown'" },
            { column: 'confidence', type: 'REAL', defaultValue: '0.7' },
            { column: 'created_at', type: 'DATETIME', defaultValue: "datetime('now')" },
        ];
        
        for (const migration of migrations) {
            if (!(await columnExists(db, 'ai_insights', migration.column))) {
                const defaultClause = migration.defaultValue ? ` DEFAULT ${migration.defaultValue}` : '';
                await db.exec(`ALTER TABLE ai_insights ADD COLUMN ${migration.column} ${migration.type}${defaultClause}`);
                console.log(`AI Insights: Added column '${migration.column}' to ai_insights table`);
            }
        }
    }
};

export interface AIInsightData {
    activityId: string;
    activityName: string;
    insight: string;
    model: string;
    confidence: number;
}

export const saveAIInsight = async (data: AIInsightData): Promise<void> => {
    const db = await getDB();
    await db.run(
        `INSERT OR REPLACE INTO ai_insights (activity_id, activity_name, insight, model, confidence, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        data.activityId, data.activityName, data.insight, data.model, data.confidence,
    );
};

export const getAIInsight = async (activityId: string): Promise<string | undefined> => {
    const db = await getDB();
    const result = await db.get(
        'SELECT insight FROM ai_insights WHERE activity_id = ?',
        activityId,
    );
    return result?.insight;
};

export const hasAIInsight = async (activityId: string): Promise<boolean> => {
    const insight = await getAIInsight(activityId);
    return insight !== undefined;
};

export const getActivitiesWithoutInsights = async (activityIds: string[]): Promise<string[]> => {
    if (activityIds.length === 0) return [];
    const db = await getDB();
    const placeholders = activityIds.map(() => '?').join(',');
    const results = await db.all(
        `SELECT activity_id FROM ai_insights WHERE activity_id IN (${placeholders})`,
        ...activityIds,
    );
    const existingIds = new Set(results.map((r: { activity_id: string }) => r.activity_id));
    return activityIds.filter(id => !existingIds.has(id));
};

export interface AIInsightRecord extends AIInsightData {
    id: number;
    createdAt: string;
}

/**
 * Get all AI insights from the database
 */
export const getAllAIInsights = async (): Promise<AIInsightRecord[]> => {
    const db = await getDB();
    const results = await db.all(
        'SELECT id, activity_id, activity_name, insight, model, confidence, created_at FROM ai_insights ORDER BY id DESC'
    );
    return results.map((r: any) => ({
        id: r.id,
        activityId: r.activity_id,
        activityName: r.activity_name,
        insight: r.insight,
        model: r.model,
        confidence: r.confidence,
        createdAt: r.created_at,
    }));
};

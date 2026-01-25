/**
 * Dynamic Config Module - Loads configuration from MongoDB with fallback to process.env
 *
 * This module allows configuration to be stored in MongoDB, enabling config changes
 * without requiring Docker image rebuilds (which take ~3 minutes).
 *
 * Environment Variables:
 * - CONFIG_FROM_MONGODB: Set to "true" to enable loading config from MongoDB
 * - CONFIG_MONGODB_URI: MongoDB connection string
 * - CONFIG_COLLECTION: Collection name to read config from (default: "uragent-urcard-config")
 *
 * Usage:
 *   import { getConfig, initDynamicConfig } from "@openswe/shared/dynamic-config";
 *
 *   // Initialize at app startup (call once)
 *   await initDynamicConfig();
 *
 *   // Get config value (MongoDB first, then process.env fallback)
 *   const apiKey = getConfig("GOOGLE_API_KEY");
 *
 * MongoDB Document Structure:
 *   {
 *     "_id": "default",
 *     "GOOGLE_API_KEY": "AIzaSy...",
 *     "LLM_PROVIDER": "google-genai",
 *     ...
 *   }
 */

// In-memory cache of config loaded from MongoDB
let mongoConfig: Record<string, string> | null = null;
let isInitialized = false;
let initError: Error | null = null;

/**
 * Check if dynamic config from MongoDB is enabled
 */
export function isConfigFromMongoDBEnabled(): boolean {
    return process.env.CONFIG_FROM_MONGODB === "true";
}

/**
 * Get the MongoDB URI for config
 */
function getConfigMongoDBUri(): string {
    return process.env.CONFIG_MONGODB_URI || "";
}

/**
 * Get the collection name for config
 */
function getConfigCollection(): string {
    return process.env.CONFIG_COLLECTION || "uragent-urcard-config";
}

/**
 * Initialize the dynamic config by loading from MongoDB
 * This should be called once at app startup
 *
 * @returns true if config was loaded successfully, false if disabled or failed
 */
export async function initDynamicConfig(): Promise<boolean> {
    if (isInitialized) {
        return mongoConfig !== null;
    }

    if (!isConfigFromMongoDBEnabled()) {
        console.log("[DynamicConfig] Disabled - using process.env only");
        isInitialized = true;
        return false;
    }

    const mongoUri = getConfigMongoDBUri();
    if (!mongoUri) {
        console.warn("[DynamicConfig] CONFIG_MONGODB_URI not set - using process.env only");
        isInitialized = true;
        return false;
    }

    try {
        console.log("[DynamicConfig] Loading config from MongoDB...");

        // Dynamic import to avoid requiring mongodb when not needed
        const { MongoClient } = await import("mongodb");

        const client = new MongoClient(mongoUri, {
            serverSelectionTimeoutMS: 5000, // 5 second timeout
            connectTimeoutMS: 5000,
        });

        await client.connect();

        const db = client.db(); // Uses database from connection string
        const collection = db.collection(getConfigCollection());

        // Load the default config document (using string _id)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const configDoc = await collection.findOne({ _id: "default" } as any);

        await client.close();

        if (configDoc) {
            // Extract all string values from the document (excluding _id and metadata)
            mongoConfig = {};
            for (const [key, value] of Object.entries(configDoc)) {
                if (key !== "_id" && key !== "updatedAt" && key !== "updatedBy" && typeof value === "string") {
                    mongoConfig[key] = value;
                }
            }
            console.log(`[DynamicConfig] Loaded ${Object.keys(mongoConfig).length} config keys from MongoDB`);
        } else {
            console.warn("[DynamicConfig] No config document found in MongoDB - using process.env only");
        }

        isInitialized = true;
        return mongoConfig !== null;
    } catch (error) {
        initError = error instanceof Error ? error : new Error(String(error));
        console.error("[DynamicConfig] Failed to load from MongoDB:", initError.message);
        console.warn("[DynamicConfig] Falling back to process.env only");
        isInitialized = true;
        return false;
    }
}

/**
 * Get a configuration value
 * First checks MongoDB config (if loaded), then falls back to process.env
 *
 * @param key - The configuration key (e.g., "GOOGLE_API_KEY")
 * @returns The configuration value or undefined if not found
 */
export function getConfig(key: string): string | undefined {
    // Check MongoDB config first (if loaded)
    if (mongoConfig && key in mongoConfig) {
        return mongoConfig[key];
    }

    // Fall back to process.env
    return process.env[key];
}

/**
 * Get a configuration value as a number
 *
 * @param key - The configuration key
 * @param defaultValue - Default value if not found or not a valid number
 * @returns The configuration value as a number
 */
export function getConfigNumber(key: string, defaultValue?: number): number | undefined {
    const value = getConfig(key);
    if (value === undefined) {
        return defaultValue;
    }
    const num = parseInt(value, 10);
    return isNaN(num) ? defaultValue : num;
}

/**
 * Get a configuration value as a boolean
 *
 * @param key - The configuration key
 * @param defaultValue - Default value if not found
 * @returns The configuration value as a boolean
 */
export function getConfigBoolean(key: string, defaultValue?: boolean): boolean | undefined {
    const value = getConfig(key);
    if (value === undefined) {
        return defaultValue;
    }
    return value === "true" || value === "1" || value === "yes";
}

/**
 * Check if dynamic config has been initialized
 */
export function isConfigInitialized(): boolean {
    return isInitialized;
}

/**
 * Check if config was successfully loaded from MongoDB
 */
export function isConfigLoadedFromMongoDB(): boolean {
    return mongoConfig !== null;
}

/**
 * Get the initialization error if any
 */
export function getConfigInitError(): Error | null {
    return initError;
}

/**
 * Get all keys loaded from MongoDB (for debugging)
 */
export function getMongoConfigKeys(): string[] {
    return mongoConfig ? Object.keys(mongoConfig) : [];
}

/**
 * Reset the config state (for testing purposes)
 */
export function resetConfigState(): void {
    mongoConfig = null;
    isInitialized = false;
    initError = null;
}

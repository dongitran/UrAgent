/**
 * Google API Key Manager
 * 
 * Manages multiple Google API keys with simple round-robin rotation.
 * Similar pattern to sandbox-provider/key-manager.ts but simplified for LLM usage.
 * 
 * Usage:
 * ```typescript
 * const manager = getGoogleApiKeyManager();
 * const apiKey = manager.getNextKey();
 * ```
 * 
 * Environment:
 * - GOOGLE_API_KEY: Single key or comma-separated keys
 *   Example: "key1,key2,key3"
 */

import { createLogger, LogLevel } from "../logger.js";

const logger = createLogger(LogLevel.DEBUG, "GoogleApiKeyManager");

/**
 * Statistics for monitoring
 */
export interface GoogleApiKeyManagerStats {
    totalKeys: number;
    currentIndex: number;
    totalCalls: number;
    keys: string[]; // Masked keys for logging
}

/**
 * Google API Key Manager
 * 
 * Handles simple round-robin rotation between multiple API keys.
 * Thread-safe for single-threaded Node.js environment.
 */
export class GoogleApiKeyManager {
    private keys: string[] = [];
    private currentIndex: number = 0;
    private totalCalls: number = 0;

    constructor() {
        this.loadKeysFromEnv();
    }

    /**
     * Load and parse API keys from environment variable
     * Keys can be comma-separated for multiple accounts
     */
    private loadKeysFromEnv(): void {
        const envValue = process.env.GOOGLE_API_KEY || '';
        this.keys = this.parseKeys(envValue);

        logger.info("[GoogleApiKeyManager] Initialized", {
            keyCount: this.keys.length,
            maskedKeys: this.keys.map(k => this.maskKey(k)),
        });

        if (this.keys.length === 0) {
            logger.warn("[GoogleApiKeyManager] No API keys found! Set GOOGLE_API_KEY environment variable");
        }
    }

    /**
     * Parse comma-separated keys, trim whitespace, filter empty
     */
    private parseKeys(envValue: string): string[] {
        return envValue
            .split(',')
            .map(k => k.trim())
            .filter(k => k.length > 0);
    }

    /**
     * Mask API key for logging (show first 8 and last 4 chars)
     */
    private maskKey(key: string): string {
        if (key.length <= 16) {
            return key.substring(0, 4) + '***';
        }
        return key.substring(0, 8) + '***' + key.substring(key.length - 4);
    }

    /**
     * Get next API key using round-robin rotation
     * 
     * @returns API key string
     * @throws Error if no keys are available
     */
    getNextKey(): string {
        if (this.keys.length === 0) {
            throw new Error(
                "No Google API keys available. Set GOOGLE_API_KEY environment variable."
            );
        }

        this.totalCalls++;
        const key = this.keys[this.currentIndex];
        const usedIndex = this.currentIndex;

        // Advance to next key (wrap around)
        this.currentIndex = (this.currentIndex + 1) % this.keys.length;

        logger.debug("[GoogleApiKeyManager] Key selected", {
            call: this.totalCalls,
            keyIndex: usedIndex,
            totalKeys: this.keys.length,
            maskedKey: this.maskKey(key),
        });

        return key;
    }

    /**
     * Get a specific key by index
     * Useful for retrying with a specific key
     */
    getKey(index: number): string | null {
        if (index >= 0 && index < this.keys.length) {
            return this.keys[index];
        }
        return null;
    }

    /**
     * Get total number of keys
     */
    getKeyCount(): number {
        return this.keys.length;
    }

    /**
     * Check if multiple keys are configured
     */
    hasMultipleKeys(): boolean {
        return this.keys.length > 1;
    }

    /**
     * Get statistics for monitoring
     */
    getStats(): GoogleApiKeyManagerStats {
        return {
            totalKeys: this.keys.length,
            currentIndex: this.currentIndex,
            totalCalls: this.totalCalls,
            keys: this.keys.map(k => this.maskKey(k)),
        };
    }

    /**
     * Reset rotation state (useful for testing)
     */
    reset(): void {
        this.currentIndex = 0;
        this.totalCalls = 0;
        logger.debug("[GoogleApiKeyManager] State reset");
    }

    /**
     * Reload keys from environment (useful if env vars change)
     */
    reload(): void {
        this.loadKeysFromEnv();
        this.reset();
        logger.info("[GoogleApiKeyManager] Keys reloaded from environment");
    }
}

// Singleton instance
let keyManagerInstance: GoogleApiKeyManager | null = null;

/**
 * Get or create the Google API key manager singleton
 */
export function getGoogleApiKeyManager(): GoogleApiKeyManager {
    if (!keyManagerInstance) {
        keyManagerInstance = new GoogleApiKeyManager();
    }
    return keyManagerInstance;
}

/**
 * Reset the key manager singleton (useful for testing)
 */
export function resetGoogleApiKeyManager(): void {
    if (keyManagerInstance) {
        keyManagerInstance.reset();
    }
    keyManagerInstance = null;
}

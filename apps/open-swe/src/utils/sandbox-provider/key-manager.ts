/**
 * Multi-Provider Key Manager
 * 
 * Manages multiple API keys for multiple sandbox providers (Daytona, E2B)
 * with round-robin rotation between providers and keys.
 * 
 * Rotation pattern: daytona_key1 → e2b_key1 → daytona_key2 → e2b_key2 → ...
 * 
 * Usage:
 * ```typescript
 * const manager = getKeyManager();
 * const { provider, apiKey } = manager.getNext();
 * // Use provider and apiKey to create sandbox
 * ```
 */

import { createLogger, LogLevel } from "../logger.js";
import { SandboxProviderType } from "./types.js";

const logger = createLogger(LogLevel.DEBUG, "KeyManager");

/**
 * Key entry with provider type and API key
 */
export interface KeyEntry {
  provider: SandboxProviderType;
  apiKey: string;
  index: number; // Index within provider's key list
}

/**
 * Statistics for a provider
 */
export interface ProviderStats {
  provider: SandboxProviderType;
  totalKeys: number;
  currentIndex: number;
  keys: string[]; // Masked keys for logging
}

/**
 * Multi-Provider Key Manager
 * 
 * Handles round-robin rotation between multiple providers and their keys.
 * Thread-safe for single-threaded Node.js environment.
 */
export class MultiProviderKeyManager {
  private daytonaKeys: string[] = [];
  private e2bKeys: string[] = [];
  
  // Round-robin state
  private currentProviderIndex: number = 0; // 0 = daytona, 1 = e2b
  private daytonaKeyIndex: number = 0;
  private e2bKeyIndex: number = 0;
  
  // Track total calls for logging
  private totalCalls: number = 0;
  
  constructor() {
    this.loadKeysFromEnv();
  }
  
  /**
   * Load and parse API keys from environment variables
   * Keys can be comma-separated for multiple accounts
   */
  private loadKeysFromEnv(): void {
    // Parse Daytona keys (comma-separated)
    const daytonaEnv = process.env.DAYTONA_API_KEY || '';
    this.daytonaKeys = this.parseKeys(daytonaEnv);
    
    // Parse E2B keys (comma-separated)
    const e2bEnv = process.env.E2B_API_KEY || '';
    this.e2bKeys = this.parseKeys(e2bEnv);
    
    logger.info("[KeyManager] Initialized", {
      daytonaKeyCount: this.daytonaKeys.length,
      e2bKeyCount: this.e2bKeys.length,
      totalKeys: this.daytonaKeys.length + this.e2bKeys.length,
    });
    
    if (this.daytonaKeys.length === 0 && this.e2bKeys.length === 0) {
      logger.warn("[KeyManager] No API keys found! Set DAYTONA_API_KEY and/or E2B_API_KEY");
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
   * Get available providers (those with at least one key)
   */
  getAvailableProviders(): SandboxProviderType[] {
    const available: SandboxProviderType[] = [];
    if (this.daytonaKeys.length > 0) {
      available.push(SandboxProviderType.DAYTONA);
    }
    if (this.e2bKeys.length > 0) {
      available.push(SandboxProviderType.E2B);
    }
    return available;
  }
  
  /**
   * Check if multi-provider mode is available
   * Requires at least one key from each provider
   */
  isMultiProviderAvailable(): boolean {
    return this.daytonaKeys.length > 0 && this.e2bKeys.length > 0;
  }
  
  /**
   * Get total number of keys across all providers
   */
  getTotalKeyCount(): number {
    return this.daytonaKeys.length + this.e2bKeys.length;
  }
  
  /**
   * Get next provider and API key using round-robin rotation
   * 
   * Rotation pattern (interleaved):
   * daytona_key[0] → e2b_key[0] → daytona_key[1] → e2b_key[1] → ...
   * 
   * When one provider runs out of keys, it wraps around:
   * - If daytona has 2 keys and e2b has 3 keys:
   *   d[0] → e[0] → d[1] → e[1] → d[0] → e[2] → d[1] → e[0] → ...
   * 
   * @returns KeyEntry with provider type and API key
   * @throws Error if no keys are available
   */
  getNext(): KeyEntry {
    this.totalCalls++;
    
    const availableProviders = this.getAvailableProviders();
    if (availableProviders.length === 0) {
      throw new Error("No API keys available. Set DAYTONA_API_KEY and/or E2B_API_KEY");
    }
    
    // If only one provider available, use it with round-robin on its keys
    if (availableProviders.length === 1) {
      const entry = this.getNextFromProvider(availableProviders[0]);
      logger.debug("[KeyManager] Single provider selection", {
        call: this.totalCalls,
        provider: entry.provider,
        keyIndex: entry.index,
        maskedKey: this.maskKey(entry.apiKey),
      });
      return entry;
    }
    
    // Multi-provider round-robin
    // Alternate between providers: daytona → e2b → daytona → e2b
    const providers = [SandboxProviderType.DAYTONA, SandboxProviderType.E2B];
    let provider = providers[this.currentProviderIndex];
    
    // Skip provider if it has no keys (shouldn't happen if availableProviders.length > 1)
    if (!availableProviders.includes(provider)) {
      this.currentProviderIndex = (this.currentProviderIndex + 1) % 2;
      provider = providers[this.currentProviderIndex];
    }
    
    const entry = this.getNextFromProvider(provider);
    
    // Move to next provider for next call
    this.currentProviderIndex = (this.currentProviderIndex + 1) % 2;
    
    logger.debug("[KeyManager] Round-robin selection", {
      call: this.totalCalls,
      provider: entry.provider,
      keyIndex: entry.index,
      maskedKey: this.maskKey(entry.apiKey),
      nextProvider: providers[this.currentProviderIndex],
      daytonaNextIndex: this.daytonaKeyIndex,
      e2bNextIndex: this.e2bKeyIndex,
    });
    
    return entry;
  }
  
  /**
   * Get next key from a specific provider
   */
  private getNextFromProvider(provider: SandboxProviderType): KeyEntry {
    if (provider === SandboxProviderType.DAYTONA) {
      if (this.daytonaKeys.length === 0) {
        throw new Error("No Daytona API keys available");
      }
      const key = this.daytonaKeys[this.daytonaKeyIndex];
      const index = this.daytonaKeyIndex;
      
      // Advance to next key (wrap around)
      this.daytonaKeyIndex = (this.daytonaKeyIndex + 1) % this.daytonaKeys.length;
      
      return { provider: SandboxProviderType.DAYTONA, apiKey: key, index };
    }
    
    if (provider === SandboxProviderType.E2B) {
      if (this.e2bKeys.length === 0) {
        throw new Error("No E2B API keys available");
      }
      const key = this.e2bKeys[this.e2bKeyIndex];
      const index = this.e2bKeyIndex;
      
      // Advance to next key (wrap around)
      this.e2bKeyIndex = (this.e2bKeyIndex + 1) % this.e2bKeys.length;
      
      return { provider: SandboxProviderType.E2B, apiKey: key, index };
    }
    
    throw new Error(`Unsupported provider: ${provider}`);
  }
  
  /**
   * Get a specific key by provider and index
   * Useful for retrying with a specific key
   */
  getKey(provider: SandboxProviderType, index: number): KeyEntry | null {
    if (provider === SandboxProviderType.DAYTONA) {
      if (index >= 0 && index < this.daytonaKeys.length) {
        return { provider, apiKey: this.daytonaKeys[index], index };
      }
    }
    if (provider === SandboxProviderType.E2B) {
      if (index >= 0 && index < this.e2bKeys.length) {
        return { provider, apiKey: this.e2bKeys[index], index };
      }
    }
    return null;
  }
  
  /**
   * Get statistics for all providers
   */
  getStats(): ProviderStats[] {
    const stats: ProviderStats[] = [];
    
    if (this.daytonaKeys.length > 0) {
      stats.push({
        provider: SandboxProviderType.DAYTONA,
        totalKeys: this.daytonaKeys.length,
        currentIndex: this.daytonaKeyIndex,
        keys: this.daytonaKeys.map(k => this.maskKey(k)),
      });
    }
    
    if (this.e2bKeys.length > 0) {
      stats.push({
        provider: SandboxProviderType.E2B,
        totalKeys: this.e2bKeys.length,
        currentIndex: this.e2bKeyIndex,
        keys: this.e2bKeys.map(k => this.maskKey(k)),
      });
    }
    
    return stats;
  }
  
  /**
   * Reset rotation state (useful for testing)
   */
  reset(): void {
    this.currentProviderIndex = 0;
    this.daytonaKeyIndex = 0;
    this.e2bKeyIndex = 0;
    this.totalCalls = 0;
    logger.debug("[KeyManager] State reset");
  }
  
  /**
   * Reload keys from environment (useful if env vars change)
   */
  reload(): void {
    this.loadKeysFromEnv();
    this.reset();
    logger.info("[KeyManager] Keys reloaded from environment");
  }
}

// Singleton instance
let keyManagerInstance: MultiProviderKeyManager | null = null;

/**
 * Get or create the key manager singleton
 */
export function getKeyManager(): MultiProviderKeyManager {
  if (!keyManagerInstance) {
    keyManagerInstance = new MultiProviderKeyManager();
  }
  return keyManagerInstance;
}

/**
 * Reset the key manager singleton (useful for testing)
 */
export function resetKeyManager(): void {
  if (keyManagerInstance) {
    keyManagerInstance.reset();
  }
  keyManagerInstance = null;
}

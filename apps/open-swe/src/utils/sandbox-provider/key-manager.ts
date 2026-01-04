/**
 * Multi-Provider Key Manager
 * 
 * Manages multiple API keys for multiple sandbox providers (Daytona, E2B)
 * with WEIGHTED round-robin rotation to ensure fair distribution.
 * 
 * Weighted Rotation Pattern:
 * - Keys are distributed proportionally based on count per provider
 * - Example: 1 Daytona key + 6 E2B keys = ratio 1:6
 *   Every 7 requests: 1 Daytona, 6 E2B (each E2B key used once)
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
 * Handles WEIGHTED round-robin rotation between multiple providers and their keys.
 * Ensures fair distribution based on number of keys per provider.
 * Thread-safe for single-threaded Node.js environment.
 */
export class MultiProviderKeyManager {
  private daytonaKeys: string[] = [];
  private e2bKeys: string[] = [];
  
  // Round-robin state for keys within each provider
  private daytonaKeyIndex: number = 0;
  private e2bKeyIndex: number = 0;
  
  // Weighted round-robin state
  // We create a "slot" array that determines which provider to use
  // Example: [d, e, e, e, e, e, e] for 1 daytona : 6 e2b
  private providerSlots: SandboxProviderType[] = [];
  private currentSlotIndex: number = 0;
  
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
    
    // Build weighted provider slots
    this.buildProviderSlots();
    
    logger.info("[KeyManager] Initialized with weighted rotation", {
      daytonaKeyCount: this.daytonaKeys.length,
      e2bKeyCount: this.e2bKeys.length,
      totalKeys: this.daytonaKeys.length + this.e2bKeys.length,
      slotPattern: this.providerSlots.length > 0 
        ? `${this.providerSlots.length} slots (${this.daytonaKeys.length} daytona : ${this.e2bKeys.length} e2b)`
        : 'none',
    });
    
    if (this.daytonaKeys.length === 0 && this.e2bKeys.length === 0) {
      logger.warn("[KeyManager] No API keys found! Set DAYTONA_API_KEY and/or E2B_API_KEY");
    }
  }
  
  /**
   * Build weighted provider slots for fair distribution
   * 
   * Creates an array where each provider appears proportionally to its key count.
   * Example: 1 Daytona + 6 E2B = [D, E, E, E, E, E, E]
   * Example: 2 Daytona + 3 E2B = [D, D, E, E, E]
   * 
   * This ensures each KEY (not provider) gets equal usage over time.
   */
  private buildProviderSlots(): void {
    this.providerSlots = [];
    
    // Add slots for each Daytona key
    for (let i = 0; i < this.daytonaKeys.length; i++) {
      this.providerSlots.push(SandboxProviderType.DAYTONA);
    }
    
    // Add slots for each E2B key
    for (let i = 0; i < this.e2bKeys.length; i++) {
      this.providerSlots.push(SandboxProviderType.E2B);
    }
    
    // Shuffle to interleave providers (optional but provides better distribution)
    // Using a deterministic interleave pattern instead of random shuffle
    if (this.daytonaKeys.length > 0 && this.e2bKeys.length > 0) {
      this.providerSlots = this.interleaveSlots(
        this.daytonaKeys.length,
        this.e2bKeys.length
      );
    }
  }
  
  /**
   * Create an interleaved slot pattern for fair distribution
   * 
   * Example: 1 Daytona + 6 E2B
   * Instead of [D, E, E, E, E, E, E], creates [E, E, E, D, E, E, E]
   * (Daytona in the middle for better spread)
   * 
   * Example: 2 Daytona + 6 E2B  
   * Creates [E, E, D, E, E, D, E, E] (evenly distributed)
   */
  private interleaveSlots(daytonaCount: number, e2bCount: number): SandboxProviderType[] {
    const total = daytonaCount + e2bCount;
    const slots: SandboxProviderType[] = new Array(total);
    
    // Calculate spacing for the smaller group
    const minCount = Math.min(daytonaCount, e2bCount);
    const minProvider = daytonaCount <= e2bCount ? SandboxProviderType.DAYTONA : SandboxProviderType.E2B;
    const maxProvider = daytonaCount <= e2bCount ? SandboxProviderType.E2B : SandboxProviderType.DAYTONA;
    
    // Fill all slots with the majority provider first
    for (let i = 0; i < total; i++) {
      slots[i] = maxProvider;
    }
    
    // Distribute minority provider evenly
    // Using "bresenham-like" distribution for even spacing
    if (minCount > 0) {
      const step = total / minCount;
      for (let i = 0; i < minCount; i++) {
        // Calculate position with offset to center the distribution
        const pos = Math.floor(step * i + step / 2);
        slots[pos] = minProvider;
      }
    }
    
    return slots;
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
   * Get next provider and API key using WEIGHTED round-robin rotation
   * 
   * Weighted Rotation ensures each KEY gets equal usage:
   * - 1 Daytona + 6 E2B: Every 7 calls, Daytona used 1x, each E2B key used 1x
   * - 2 Daytona + 3 E2B: Every 5 calls, each Daytona key used 1x, each E2B key used 1x
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
    
    // Multi-provider WEIGHTED round-robin
    // Use the slot array to determine which provider
    const provider = this.providerSlots[this.currentSlotIndex];
    
    // Get next key from the selected provider
    const entry = this.getNextFromProvider(provider);
    
    // Move to next slot (wrap around)
    this.currentSlotIndex = (this.currentSlotIndex + 1) % this.providerSlots.length;
    
    logger.debug("[KeyManager] Weighted round-robin selection", {
      call: this.totalCalls,
      provider: entry.provider,
      keyIndex: entry.index,
      maskedKey: this.maskKey(entry.apiKey),
      slotIndex: (this.currentSlotIndex - 1 + this.providerSlots.length) % this.providerSlots.length,
      totalSlots: this.providerSlots.length,
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
    this.currentSlotIndex = 0;
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
  
  /**
   * Get the current slot pattern (for debugging/testing)
   */
  getSlotPattern(): SandboxProviderType[] {
    return [...this.providerSlots];
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

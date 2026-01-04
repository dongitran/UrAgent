/**
 * Sandbox Provider Factory
 * 
 * This module provides a unified interface for creating and managing sandboxes
 * across different providers (Daytona, E2B, Local, Multi).
 * 
 * Usage:
 * ```typescript
 * import { getSandboxProvider, SandboxProviderType } from './sandbox-provider';
 * 
 * // Get provider based on environment or config
 * const provider = getSandboxProvider();
 * 
 * // Or specify provider type
 * const daytonaProvider = getSandboxProvider({ type: SandboxProviderType.DAYTONA });
 * const e2bProvider = getSandboxProvider({ type: SandboxProviderType.E2B });
 * 
 * // Multi-provider mode (round-robin between Daytona and E2B)
 * // Set SANDBOX_PROVIDER=multi and provide comma-separated keys:
 * // DAYTONA_API_KEY=key1,key2,key3
 * // E2B_API_KEY=key1,key2
 * const multiProvider = getSandboxProvider({ type: SandboxProviderType.MULTI });
 * 
 * // Create sandbox
 * const sandbox = await provider.create({ template: 'my-template' });
 * 
 * // Execute command
 * const result = await sandbox.executeCommand({
 *   command: 'echo "Hello World"',
 *   workdir: '/home/user',
 * });
 * 
 * // Git operations
 * await sandbox.git.clone({
 *   url: 'https://github.com/user/repo.git',
 *   targetDir: '/home/user/repo',
 *   branch: 'main',
 *   token: 'github_token',
 * });
 * ```
 */

export * from "./types.js";
export * from "./daytona-provider.js";
export * from "./e2b-provider.js";
export * from "./key-manager.js";

import { createLogger, LogLevel } from "../logger.js";
import {
  ISandboxProvider,
  ISandbox,
  SandboxProviderType,
  SandboxProviderConfig,
  CreateSandboxOptions,
  SandboxInfo,
} from "./types.js";
import { DaytonaSandboxProvider, getDaytonaProvider } from "./daytona-provider.js";
import { E2BSandboxProvider, getE2BProvider } from "./e2b-provider.js";
import { getKeyManager, MultiProviderKeyManager } from "./key-manager.js";

const logger = createLogger(LogLevel.DEBUG, "SandboxProviderFactory");

/**
 * Determine provider type from environment
 */
function getProviderTypeFromEnv(): SandboxProviderType {
  const envProvider = process.env.SANDBOX_PROVIDER?.toLowerCase();
  
  switch (envProvider) {
    case 'e2b':
      return SandboxProviderType.E2B;
    case 'local':
      return SandboxProviderType.LOCAL;
    case 'multi':
      return SandboxProviderType.MULTI;
    case 'daytona':
    default:
      // Default to Daytona if DAYTONA_API_KEY is set, otherwise check E2B
      if (process.env.DAYTONA_API_KEY) {
        return SandboxProviderType.DAYTONA;
      }
      if (process.env.E2B_API_KEY) {
        return SandboxProviderType.E2B;
      }
      return SandboxProviderType.DAYTONA;
  }
}

/**
 * Multi-Provider Sandbox Provider
 * 
 * Wraps multiple providers and uses round-robin key rotation
 * to distribute sandbox creation across providers and API keys.
 */
class MultiSandboxProvider implements ISandboxProvider {
  private keyManager: MultiProviderKeyManager;
  private providerCache: Map<string, ISandboxProvider> = new Map();
  
  readonly name = 'multi';
  
  constructor() {
    this.keyManager = getKeyManager();
    
    const stats = this.keyManager.getStats();
    logger.info("[MULTI] Provider initialized", {
      providers: stats.map(s => ({ provider: s.provider, keyCount: s.totalKeys })),
      totalKeys: this.keyManager.getTotalKeyCount(),
    });
  }
  
  /**
   * Get or create a provider instance for a specific provider type and API key
   */
  private getProviderInstance(providerType: SandboxProviderType, apiKey: string): ISandboxProvider {
    const cacheKey = `${providerType}:${apiKey.substring(0, 8)}`;
    
    let provider = this.providerCache.get(cacheKey);
    if (!provider) {
      if (providerType === SandboxProviderType.DAYTONA) {
        provider = new DaytonaSandboxProvider({ apiKey });
      } else if (providerType === SandboxProviderType.E2B) {
        provider = new E2BSandboxProvider({ apiKey });
      } else {
        throw new Error(`Unsupported provider type in multi mode: ${providerType}`);
      }
      this.providerCache.set(cacheKey, provider);
    }
    
    return provider;
  }
  
  async create(options?: CreateSandboxOptions): Promise<ISandbox> {
    const totalKeys = this.keyManager.getTotalKeyCount();
    let lastError: Error | undefined;
    
    // Import constants for provider-specific defaults
    const { DAYTONA_SNAPSHOT_NAME, E2B_TEMPLATE_NAME } = await import("@openswe/shared/constants");
    
    // Try up to totalKeys times (each key once)
    for (let attempt = 0; attempt < totalKeys; attempt++) {
      // Get next provider and key from round-robin rotation
      const { provider: providerType, apiKey, index } = this.keyManager.getNext();
      
      // CRITICAL: Determine correct template/user based on selected provider
      // Do NOT use options.template as it may be wrong for this provider
      let providerOptions: CreateSandboxOptions;
      if (providerType === SandboxProviderType.DAYTONA) {
        providerOptions = {
          ...options,
          template: DAYTONA_SNAPSHOT_NAME, // e.g., "open-swe-vcpu2-mem4-disk5"
          user: 'daytona',
        };
      } else if (providerType === SandboxProviderType.E2B) {
        providerOptions = {
          ...options,
          template: E2B_TEMPLATE_NAME, // e.g., "base"
          user: 'user',
        };
      } else {
        providerOptions = options || {};
      }
      
      logger.info("[MULTI] Creating sandbox", {
        provider: providerType,
        keyIndex: index,
        template: providerOptions.template,
        user: providerOptions.user,
        attempt: attempt + 1,
        maxAttempts: totalKeys,
      });
      
      const provider = this.getProviderInstance(providerType, apiKey);
      
      try {
        const sandbox = await provider.create(providerOptions);
        
        logger.info("[MULTI] Sandbox created successfully", {
          provider: providerType,
          keyIndex: index,
          sandboxId: sandbox.id,
          template: providerOptions.template,
          attempts: attempt + 1,
        });
        
        return sandbox;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        logger.warn("[MULTI] Failed to create sandbox, trying next key", {
          provider: providerType,
          keyIndex: index,
          attempt: attempt + 1,
          error: lastError.message,
        });
        
        // Continue to next key
      }
    }
    
    // All keys failed
    logger.error("[MULTI] All keys exhausted, sandbox creation failed", {
      totalAttempts: totalKeys,
      lastError: lastError?.message,
    });
    
    throw lastError ?? new Error("Failed to create sandbox after trying all available keys");
  }
  
  async get(sandboxId: string): Promise<ISandbox> {
    // Try to determine provider from sandbox ID format
    // Daytona IDs are UUIDs, E2B IDs have specific format
    const isE2BId = sandboxId.includes('-') && !sandboxId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    
    // Try E2B first if it looks like E2B ID, otherwise try Daytona
    const providersToTry = isE2BId 
      ? [SandboxProviderType.E2B, SandboxProviderType.DAYTONA]
      : [SandboxProviderType.DAYTONA, SandboxProviderType.E2B];
    
    let lastError: Error | undefined;
    
    for (const providerType of providersToTry) {
      const stats = this.keyManager.getStats().find(s => s.provider === providerType);
      if (!stats) continue;
      
      // Try each key for this provider
      for (let i = 0; i < stats.totalKeys; i++) {
        const keyEntry = this.keyManager.getKey(providerType, i);
        if (!keyEntry) continue;
        
        try {
          const provider = this.getProviderInstance(providerType, keyEntry.apiKey);
          const sandbox = await provider.get(sandboxId);
          
          logger.debug("[MULTI] Found sandbox", {
            sandboxId,
            provider: providerType,
            keyIndex: i,
          });
          
          return sandbox;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          // Continue trying other keys/providers
        }
      }
    }
    
    throw lastError ?? new Error(`Sandbox not found: ${sandboxId}`);
  }
  
  async stop(sandboxId: string): Promise<void> {
    const sandbox = await this.get(sandboxId);
    await sandbox.stop();
  }
  
  async delete(sandboxId: string): Promise<boolean> {
    // Similar to get(), try all providers
    const providersToTry = [SandboxProviderType.DAYTONA, SandboxProviderType.E2B];
    
    for (const providerType of providersToTry) {
      const stats = this.keyManager.getStats().find(s => s.provider === providerType);
      if (!stats) continue;
      
      for (let i = 0; i < stats.totalKeys; i++) {
        const keyEntry = this.keyManager.getKey(providerType, i);
        if (!keyEntry) continue;
        
        try {
          const provider = this.getProviderInstance(providerType, keyEntry.apiKey);
          const result = await provider.delete(sandboxId);
          if (result) {
            logger.debug("[MULTI] Deleted sandbox", {
              sandboxId,
              provider: providerType,
              keyIndex: i,
            });
            return true;
          }
        } catch {
          // Continue trying other keys/providers
        }
      }
    }
    
    return false;
  }
  
  async list(): Promise<SandboxInfo[]> {
    const allSandboxes: SandboxInfo[] = [];
    
    // List from all providers and keys
    for (const providerType of [SandboxProviderType.DAYTONA, SandboxProviderType.E2B]) {
      const stats = this.keyManager.getStats().find(s => s.provider === providerType);
      if (!stats) continue;
      
      for (let i = 0; i < stats.totalKeys; i++) {
        const keyEntry = this.keyManager.getKey(providerType, i);
        if (!keyEntry) continue;
        
        try {
          const provider = this.getProviderInstance(providerType, keyEntry.apiKey);
          const sandboxes = await provider.list();
          allSandboxes.push(...sandboxes);
        } catch (error) {
          logger.warn("[MULTI] Failed to list sandboxes", {
            provider: providerType,
            keyIndex: i,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    
    return allSandboxes;
  }
  
  /**
   * Get key manager for external access (stats, etc.)
   */
  getKeyManager(): MultiProviderKeyManager {
    return this.keyManager;
  }
}

// Singleton for multi-provider
let multiProviderInstance: MultiSandboxProvider | null = null;

/**
 * Get or create the multi-provider instance
 */
function getMultiProvider(): MultiSandboxProvider {
  if (!multiProviderInstance) {
    multiProviderInstance = new MultiSandboxProvider();
  }
  return multiProviderInstance;
}

/**
 * Get sandbox provider based on configuration
 */
export function getSandboxProvider(config?: Partial<SandboxProviderConfig>): ISandboxProvider {
  const providerType = config?.type || getProviderTypeFromEnv();
  
  logger.debug("Getting sandbox provider", { providerType });
  
  switch (providerType) {
    case SandboxProviderType.E2B:
      return getE2BProvider(config?.e2b);
    
    case SandboxProviderType.MULTI:
      return getMultiProvider();
    
    case SandboxProviderType.LOCAL:
      // For local mode, we don't need a provider - handled separately
      throw new Error("Local mode should be handled by isLocalMode() check, not through provider");
    
    case SandboxProviderType.DAYTONA:
    default:
      return getDaytonaProvider(config?.daytona);
  }
}

/**
 * Create a new provider instance (not singleton)
 */
export function createSandboxProvider(config: SandboxProviderConfig): ISandboxProvider {
  logger.debug("Creating new sandbox provider", { type: config.type });
  
  switch (config.type) {
    case SandboxProviderType.E2B:
      return new E2BSandboxProvider(config.e2b);
    
    case SandboxProviderType.MULTI:
      return new MultiSandboxProvider();
    
    case SandboxProviderType.LOCAL:
      throw new Error("Local mode should be handled by isLocalMode() check, not through provider");
    
    case SandboxProviderType.DAYTONA:
    default:
      return new DaytonaSandboxProvider(config.daytona);
  }
}

/**
 * Check if a provider type is available (has required credentials)
 */
export function isProviderAvailable(type: SandboxProviderType): boolean {
  switch (type) {
    case SandboxProviderType.DAYTONA:
      return !!process.env.DAYTONA_API_KEY;
    
    case SandboxProviderType.E2B:
      return !!process.env.E2B_API_KEY;
    
    case SandboxProviderType.MULTI:
      // Multi requires at least one key from any provider
      return !!process.env.DAYTONA_API_KEY || !!process.env.E2B_API_KEY;
    
    case SandboxProviderType.LOCAL:
      return true;
    
    default:
      return false;
  }
}

/**
 * Get list of available providers
 */
export function getAvailableProviders(): SandboxProviderType[] {
  const available: SandboxProviderType[] = [];
  
  if (isProviderAvailable(SandboxProviderType.DAYTONA)) {
    available.push(SandboxProviderType.DAYTONA);
  }
  if (isProviderAvailable(SandboxProviderType.E2B)) {
    available.push(SandboxProviderType.E2B);
  }
  if (isProviderAvailable(SandboxProviderType.MULTI)) {
    available.push(SandboxProviderType.MULTI);
  }
  available.push(SandboxProviderType.LOCAL);
  
  return available;
}

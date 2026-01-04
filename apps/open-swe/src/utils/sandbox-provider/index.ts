/**
 * Sandbox Provider Factory
 * 
 * This module provides a unified interface for creating and managing sandboxes
 * across different providers (Daytona, E2B, Local).
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

import { createLogger, LogLevel } from "../logger.js";
import {
  ISandboxProvider,
  SandboxProviderType,
  SandboxProviderConfig,
} from "./types.js";
import { DaytonaSandboxProvider, getDaytonaProvider } from "./daytona-provider.js";
import { E2BSandboxProvider, getE2BProvider } from "./e2b-provider.js";

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
 * Get sandbox provider based on configuration
 */
export function getSandboxProvider(config?: Partial<SandboxProviderConfig>): ISandboxProvider {
  const providerType = config?.type || getProviderTypeFromEnv();
  
  logger.debug("Getting sandbox provider", { providerType });
  
  switch (providerType) {
    case SandboxProviderType.E2B:
      return getE2BProvider(config?.e2b);
    
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
  available.push(SandboxProviderType.LOCAL);
  
  return available;
}

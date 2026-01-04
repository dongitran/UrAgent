/**
 * Sandbox Provider Tests
 * 
 * Basic unit tests for the sandbox provider abstraction layer
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  SandboxProviderType,
  SandboxState,
  ISandbox,
  ISandboxProvider,
} from '../types.js';
import {
  getSandboxProvider,
  isProviderAvailable,
  getAvailableProviders,
} from '../index.js';

// Mock environment variables
const originalEnv = process.env;

beforeEach(() => {
  jest.resetModules();
  process.env = { ...originalEnv };
});

describe('SandboxProviderType', () => {
  it('should have correct enum values', () => {
    expect(SandboxProviderType.DAYTONA).toBe('daytona');
    expect(SandboxProviderType.E2B).toBe('e2b');
    expect(SandboxProviderType.LOCAL).toBe('local');
  });
});

describe('SandboxState', () => {
  it('should have correct enum values', () => {
    expect(SandboxState.STARTED).toBe('started');
    expect(SandboxState.STOPPED).toBe('stopped');
    expect(SandboxState.ARCHIVED).toBe('archived');
    expect(SandboxState.CREATING).toBe('creating');
    expect(SandboxState.UNKNOWN).toBe('unknown');
  });
});

describe('isProviderAvailable', () => {
  it('should return true for Daytona when API key is set', () => {
    process.env.DAYTONA_API_KEY = 'test-key';
    expect(isProviderAvailable(SandboxProviderType.DAYTONA)).toBe(true);
  });

  it('should return false for Daytona when API key is not set', () => {
    delete process.env.DAYTONA_API_KEY;
    expect(isProviderAvailable(SandboxProviderType.DAYTONA)).toBe(false);
  });

  it('should return true for E2B when API key is set', () => {
    process.env.E2B_API_KEY = 'test-key';
    expect(isProviderAvailable(SandboxProviderType.E2B)).toBe(true);
  });

  it('should return false for E2B when API key is not set', () => {
    delete process.env.E2B_API_KEY;
    expect(isProviderAvailable(SandboxProviderType.E2B)).toBe(false);
  });

  it('should always return true for LOCAL', () => {
    expect(isProviderAvailable(SandboxProviderType.LOCAL)).toBe(true);
  });
});

describe('getAvailableProviders', () => {
  it('should always include LOCAL provider', () => {
    delete process.env.DAYTONA_API_KEY;
    delete process.env.E2B_API_KEY;
    const providers = getAvailableProviders();
    expect(providers).toContain(SandboxProviderType.LOCAL);
  });

  it('should include Daytona when API key is set', () => {
    process.env.DAYTONA_API_KEY = 'test-key';
    const providers = getAvailableProviders();
    expect(providers).toContain(SandboxProviderType.DAYTONA);
  });

  it('should include E2B when API key is set', () => {
    process.env.E2B_API_KEY = 'test-key';
    const providers = getAvailableProviders();
    expect(providers).toContain(SandboxProviderType.E2B);
  });
});

describe('getSandboxProvider', () => {
  it('should return Daytona provider by default when DAYTONA_API_KEY is set', () => {
    process.env.DAYTONA_API_KEY = 'test-key';
    delete process.env.SANDBOX_PROVIDER;
    const provider = getSandboxProvider();
    expect(provider.name).toBe('daytona');
  });

  it('should return E2B provider when SANDBOX_PROVIDER=e2b', () => {
    process.env.E2B_API_KEY = 'test-key';
    process.env.SANDBOX_PROVIDER = 'e2b';
    const provider = getSandboxProvider();
    expect(provider.name).toBe('e2b');
  });

  it('should return Daytona provider when explicitly configured', () => {
    process.env.DAYTONA_API_KEY = 'test-key';
    const provider = getSandboxProvider({ type: SandboxProviderType.DAYTONA });
    expect(provider.name).toBe('daytona');
  });

  it('should throw error for LOCAL provider type', () => {
    expect(() => {
      getSandboxProvider({ type: SandboxProviderType.LOCAL });
    }).toThrow('Local mode should be handled by isLocalMode()');
  });
});

describe('ISandbox interface', () => {
  it('should define required properties and methods', () => {
    // Type check - this test verifies the interface structure at compile time
    const mockSandbox = {
      id: 'test-id',
      state: SandboxState.STARTED,
      executeCommand: jest.fn(),
      readFile: jest.fn(),
      writeFile: jest.fn(),
      exists: jest.fn(),
      mkdir: jest.fn(),
      remove: jest.fn(),
      git: {
        clone: jest.fn(),
        add: jest.fn(),
        commit: jest.fn(),
        push: jest.fn(),
        pull: jest.fn(),
        createBranch: jest.fn(),
        status: jest.fn(),
      },
      start: jest.fn(),
      stop: jest.fn(),
      getNative: jest.fn(),
    } as unknown as ISandbox;

    expect(mockSandbox.id).toBe('test-id');
    expect(mockSandbox.state).toBe(SandboxState.STARTED);
    expect(typeof mockSandbox.executeCommand).toBe('function');
    expect(typeof mockSandbox.git.clone).toBe('function');
  });
});

describe('ISandboxProvider interface', () => {
  it('should define required properties and methods', () => {
    // Type check - this test verifies the interface structure at compile time
    const mockProvider = {
      name: 'test-provider',
      create: jest.fn(),
      get: jest.fn(),
      stop: jest.fn(),
      delete: jest.fn(),
      list: jest.fn(),
    } as unknown as ISandboxProvider;

    expect(mockProvider.name).toBe('test-provider');
    expect(typeof mockProvider.create).toBe('function');
    expect(typeof mockProvider.get).toBe('function');
    expect(typeof mockProvider.stop).toBe('function');
    expect(typeof mockProvider.delete).toBe('function');
    expect(typeof mockProvider.list).toBe('function');
  });
});

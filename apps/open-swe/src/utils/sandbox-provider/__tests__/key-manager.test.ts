/**
 * Unit tests for MultiProviderKeyManager
 * 
 * Run with: npx vitest run src/utils/sandbox-provider/__tests__/key-manager.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MultiProviderKeyManager, resetKeyManager } from '../key-manager.js';
import { SandboxProviderType } from '../types.js';

describe('MultiProviderKeyManager', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv };
    resetKeyManager();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetKeyManager();
  });

  describe('parseKeys', () => {
    it('should parse single key', () => {
      process.env.DAYTONA_API_KEY = 'dtn_key1';
      process.env.E2B_API_KEY = '';
      
      const manager = new MultiProviderKeyManager();
      const stats = manager.getStats();
      
      expect(stats).toHaveLength(1);
      expect(stats[0].provider).toBe(SandboxProviderType.DAYTONA);
      expect(stats[0].totalKeys).toBe(1);
    });

    it('should parse multiple comma-separated keys', () => {
      process.env.DAYTONA_API_KEY = 'dtn_key1,dtn_key2,dtn_key3';
      process.env.E2B_API_KEY = 'e2b_key1,e2b_key2';
      
      const manager = new MultiProviderKeyManager();
      const stats = manager.getStats();
      
      expect(stats).toHaveLength(2);
      
      const daytonaStats = stats.find(s => s.provider === SandboxProviderType.DAYTONA);
      const e2bStats = stats.find(s => s.provider === SandboxProviderType.E2B);
      
      expect(daytonaStats?.totalKeys).toBe(3);
      expect(e2bStats?.totalKeys).toBe(2);
    });

    it('should trim whitespace from keys', () => {
      process.env.DAYTONA_API_KEY = ' dtn_key1 , dtn_key2 ';
      process.env.E2B_API_KEY = '';
      
      const manager = new MultiProviderKeyManager();
      const entry = manager.getNext();
      
      expect(entry.apiKey).toBe('dtn_key1');
    });

    it('should filter empty keys', () => {
      process.env.DAYTONA_API_KEY = 'dtn_key1,,dtn_key2,';
      process.env.E2B_API_KEY = '';
      
      const manager = new MultiProviderKeyManager();
      const stats = manager.getStats();
      
      expect(stats[0].totalKeys).toBe(2);
    });
  });

  describe('round-robin rotation', () => {
    it('should alternate between providers', () => {
      process.env.DAYTONA_API_KEY = 'dtn_key1';
      process.env.E2B_API_KEY = 'e2b_key1';
      
      const manager = new MultiProviderKeyManager();
      
      const first = manager.getNext();
      const second = manager.getNext();
      const third = manager.getNext();
      const fourth = manager.getNext();
      
      expect(first.provider).toBe(SandboxProviderType.DAYTONA);
      expect(second.provider).toBe(SandboxProviderType.E2B);
      expect(third.provider).toBe(SandboxProviderType.DAYTONA);
      expect(fourth.provider).toBe(SandboxProviderType.E2B);
    });

    it('should rotate through keys within each provider', () => {
      process.env.DAYTONA_API_KEY = 'dtn_key1,dtn_key2';
      process.env.E2B_API_KEY = 'e2b_key1,e2b_key2';
      
      const manager = new MultiProviderKeyManager();
      
      // Call 1: daytona key 0
      const c1 = manager.getNext();
      expect(c1.provider).toBe(SandboxProviderType.DAYTONA);
      expect(c1.index).toBe(0);
      
      // Call 2: e2b key 0
      const c2 = manager.getNext();
      expect(c2.provider).toBe(SandboxProviderType.E2B);
      expect(c2.index).toBe(0);
      
      // Call 3: daytona key 1
      const c3 = manager.getNext();
      expect(c3.provider).toBe(SandboxProviderType.DAYTONA);
      expect(c3.index).toBe(1);
      
      // Call 4: e2b key 1
      const c4 = manager.getNext();
      expect(c4.provider).toBe(SandboxProviderType.E2B);
      expect(c4.index).toBe(1);
      
      // Call 5: daytona key 0 (wrap around)
      const c5 = manager.getNext();
      expect(c5.provider).toBe(SandboxProviderType.DAYTONA);
      expect(c5.index).toBe(0);
      
      // Call 6: e2b key 0 (wrap around)
      const c6 = manager.getNext();
      expect(c6.provider).toBe(SandboxProviderType.E2B);
      expect(c6.index).toBe(0);
    });

    it('should handle unequal key counts', () => {
      process.env.DAYTONA_API_KEY = 'dtn_key1,dtn_key2,dtn_key3';
      process.env.E2B_API_KEY = 'e2b_key1';
      
      const manager = new MultiProviderKeyManager();
      
      // Pattern: d0 -> e0 -> d1 -> e0 -> d2 -> e0 -> d0 -> e0 ...
      const results: Array<{ provider: SandboxProviderType; index: number }> = [];
      for (let i = 0; i < 8; i++) {
        const entry = manager.getNext();
        results.push({ provider: entry.provider, index: entry.index });
      }
      
      // Verify alternating pattern
      expect(results[0].provider).toBe(SandboxProviderType.DAYTONA);
      expect(results[1].provider).toBe(SandboxProviderType.E2B);
      expect(results[2].provider).toBe(SandboxProviderType.DAYTONA);
      expect(results[3].provider).toBe(SandboxProviderType.E2B);
      
      // E2B should always be index 0 (only one key)
      const e2bResults = results.filter(r => r.provider === SandboxProviderType.E2B);
      expect(e2bResults.every(r => r.index === 0)).toBe(true);
      
      // Daytona should cycle through 0, 1, 2, 0, ...
      const daytonaResults = results.filter(r => r.provider === SandboxProviderType.DAYTONA);
      expect(daytonaResults[0].index).toBe(0);
      expect(daytonaResults[1].index).toBe(1);
      expect(daytonaResults[2].index).toBe(2);
      expect(daytonaResults[3].index).toBe(0); // wrap around
    });
  });

  describe('single provider mode', () => {
    it('should work with only Daytona keys', () => {
      process.env.DAYTONA_API_KEY = 'dtn_key1,dtn_key2';
      process.env.E2B_API_KEY = '';
      
      const manager = new MultiProviderKeyManager();
      
      const first = manager.getNext();
      const second = manager.getNext();
      const third = manager.getNext();
      
      expect(first.provider).toBe(SandboxProviderType.DAYTONA);
      expect(first.index).toBe(0);
      
      expect(second.provider).toBe(SandboxProviderType.DAYTONA);
      expect(second.index).toBe(1);
      
      expect(third.provider).toBe(SandboxProviderType.DAYTONA);
      expect(third.index).toBe(0); // wrap around
    });

    it('should work with only E2B keys', () => {
      process.env.DAYTONA_API_KEY = '';
      process.env.E2B_API_KEY = 'e2b_key1,e2b_key2';
      
      const manager = new MultiProviderKeyManager();
      
      const first = manager.getNext();
      const second = manager.getNext();
      
      expect(first.provider).toBe(SandboxProviderType.E2B);
      expect(second.provider).toBe(SandboxProviderType.E2B);
    });
  });

  describe('error handling', () => {
    it('should throw when no keys available', () => {
      process.env.DAYTONA_API_KEY = '';
      process.env.E2B_API_KEY = '';
      
      const manager = new MultiProviderKeyManager();
      
      expect(() => manager.getNext()).toThrow('No API keys available');
    });
  });

  describe('getKey', () => {
    it('should return specific key by provider and index', () => {
      process.env.DAYTONA_API_KEY = 'dtn_key1,dtn_key2';
      process.env.E2B_API_KEY = 'e2b_key1';
      
      const manager = new MultiProviderKeyManager();
      
      const daytonaKey0 = manager.getKey(SandboxProviderType.DAYTONA, 0);
      const daytonaKey1 = manager.getKey(SandboxProviderType.DAYTONA, 1);
      const e2bKey0 = manager.getKey(SandboxProviderType.E2B, 0);
      
      expect(daytonaKey0?.apiKey).toBe('dtn_key1');
      expect(daytonaKey1?.apiKey).toBe('dtn_key2');
      expect(e2bKey0?.apiKey).toBe('e2b_key1');
    });

    it('should return null for invalid index', () => {
      process.env.DAYTONA_API_KEY = 'dtn_key1';
      process.env.E2B_API_KEY = '';
      
      const manager = new MultiProviderKeyManager();
      
      expect(manager.getKey(SandboxProviderType.DAYTONA, 5)).toBeNull();
      expect(manager.getKey(SandboxProviderType.E2B, 0)).toBeNull();
    });
  });

  describe('reset', () => {
    it('should reset rotation state', () => {
      process.env.DAYTONA_API_KEY = 'dtn_key1,dtn_key2';
      process.env.E2B_API_KEY = 'e2b_key1';
      
      const manager = new MultiProviderKeyManager();
      
      // Advance state
      manager.getNext(); // d0
      manager.getNext(); // e0
      manager.getNext(); // d1
      
      // Reset
      manager.reset();
      
      // Should start from beginning
      const first = manager.getNext();
      expect(first.provider).toBe(SandboxProviderType.DAYTONA);
      expect(first.index).toBe(0);
    });
  });
});

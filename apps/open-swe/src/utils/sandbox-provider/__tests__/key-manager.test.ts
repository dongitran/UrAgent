/**
 * Unit tests for MultiProviderKeyManager
 * 
 * Run with: npm run test
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
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
    it('should alternate between providers with equal keys', () => {
      process.env.DAYTONA_API_KEY = 'dtn_key1';
      process.env.E2B_API_KEY = 'e2b_key1';
      
      const manager = new MultiProviderKeyManager();
      
      // With 1:1 ratio, should alternate
      const first = manager.getNext();
      const second = manager.getNext();
      const third = manager.getNext();
      const fourth = manager.getNext();
      
      // Pattern should be interleaved (D at position 0, E at position 1)
      // or (E at position 0, D at position 1) depending on interleave algorithm
      const providers = [first.provider, second.provider, third.provider, fourth.provider];
      const daytonaCount = providers.filter(p => p === SandboxProviderType.DAYTONA).length;
      const e2bCount = providers.filter(p => p === SandboxProviderType.E2B).length;
      
      // Should be 2:2 ratio over 4 calls
      expect(daytonaCount).toBe(2);
      expect(e2bCount).toBe(2);
    });

    it('should use weighted rotation with unequal keys (1 daytona : 6 e2b)', () => {
      process.env.DAYTONA_API_KEY = 'dtn_key1';
      process.env.E2B_API_KEY = 'e2b_key1,e2b_key2,e2b_key3,e2b_key4,e2b_key5,e2b_key6';
      
      const manager = new MultiProviderKeyManager();
      
      // Slot pattern should have 7 slots: 1 daytona, 6 e2b
      const slots = manager.getSlotPattern();
      expect(slots.length).toBe(7);
      
      const daytonaSlots = slots.filter(s => s === SandboxProviderType.DAYTONA).length;
      const e2bSlots = slots.filter(s => s === SandboxProviderType.E2B).length;
      
      expect(daytonaSlots).toBe(1);
      expect(e2bSlots).toBe(6);
      
      // Over 7 calls, should use daytona 1x and each e2b key 1x
      const results: Array<{ provider: SandboxProviderType; index: number }> = [];
      for (let i = 0; i < 7; i++) {
        const entry = manager.getNext();
        results.push({ provider: entry.provider, index: entry.index });
      }
      
      const daytonaResults = results.filter(r => r.provider === SandboxProviderType.DAYTONA);
      const e2bResults = results.filter(r => r.provider === SandboxProviderType.E2B);
      
      expect(daytonaResults.length).toBe(1);
      expect(e2bResults.length).toBe(6);
      
      // Each E2B key should be used exactly once
      const e2bIndices = e2bResults.map(r => r.index).sort();
      expect(e2bIndices).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('should rotate through keys within each provider', () => {
      process.env.DAYTONA_API_KEY = 'dtn_key1,dtn_key2';
      process.env.E2B_API_KEY = 'e2b_key1,e2b_key2';
      
      const manager = new MultiProviderKeyManager();
      
      // With 2:2 ratio, over 4 calls each key should be used once
      const results: Array<{ provider: SandboxProviderType; index: number }> = [];
      for (let i = 0; i < 4; i++) {
        const entry = manager.getNext();
        results.push({ provider: entry.provider, index: entry.index });
      }
      
      const daytonaResults = results.filter(r => r.provider === SandboxProviderType.DAYTONA);
      const e2bResults = results.filter(r => r.provider === SandboxProviderType.E2B);
      
      expect(daytonaResults.length).toBe(2);
      expect(e2bResults.length).toBe(2);
      
      // Each key should be used
      const daytonaIndices = daytonaResults.map(r => r.index).sort();
      const e2bIndices = e2bResults.map(r => r.index).sort();
      
      expect(daytonaIndices).toEqual([0, 1]);
      expect(e2bIndices).toEqual([0, 1]);
    });

    it('should handle unequal key counts (2 daytona : 3 e2b)', () => {
      process.env.DAYTONA_API_KEY = 'dtn_key1,dtn_key2';
      process.env.E2B_API_KEY = 'e2b_key1,e2b_key2,e2b_key3';
      
      const manager = new MultiProviderKeyManager();
      
      // Slot pattern should have 5 slots
      const slots = manager.getSlotPattern();
      expect(slots.length).toBe(5);
      
      // Over 5 calls, should use each key exactly once
      const results: Array<{ provider: SandboxProviderType; index: number }> = [];
      for (let i = 0; i < 5; i++) {
        const entry = manager.getNext();
        results.push({ provider: entry.provider, index: entry.index });
      }
      
      const daytonaResults = results.filter(r => r.provider === SandboxProviderType.DAYTONA);
      const e2bResults = results.filter(r => r.provider === SandboxProviderType.E2B);
      
      expect(daytonaResults.length).toBe(2);
      expect(e2bResults.length).toBe(3);
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

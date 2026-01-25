/**
 * Unit tests for GoogleApiKeyManager
 * 
 * Tests round-robin rotation, key parsing, and error handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    GoogleApiKeyManager,
    getGoogleApiKeyManager,
    resetGoogleApiKeyManager
} from '../google-api-key-manager.js';

describe('GoogleApiKeyManager', () => {
    // Store original env values
    let originalGoogleApiKey: string | undefined;

    beforeEach(() => {
        originalGoogleApiKey = process.env.GOOGLE_API_KEY;
        resetGoogleApiKeyManager();
    });

    afterEach(() => {
        // Restore original env values
        if (originalGoogleApiKey !== undefined) {
            process.env.GOOGLE_API_KEY = originalGoogleApiKey;
        } else {
            delete process.env.GOOGLE_API_KEY;
        }
        resetGoogleApiKeyManager();
    });

    describe('key parsing', () => {
        it('should parse single key correctly', () => {
            process.env.GOOGLE_API_KEY = 'AIzaSyTest123';
            const manager = new GoogleApiKeyManager();

            expect(manager.getKeyCount()).toBe(1);
            expect(manager.getNextKey()).toBe('AIzaSyTest123');
        });

        it('should parse multiple comma-separated keys', () => {
            process.env.GOOGLE_API_KEY = 'key1,key2,key3';
            const manager = new GoogleApiKeyManager();

            expect(manager.getKeyCount()).toBe(3);
        });

        it('should trim whitespace from keys', () => {
            process.env.GOOGLE_API_KEY = ' key1 , key2 , key3 ';
            const manager = new GoogleApiKeyManager();

            expect(manager.getKeyCount()).toBe(3);
            expect(manager.getNextKey()).toBe('key1');
        });

        it('should filter out empty keys', () => {
            process.env.GOOGLE_API_KEY = 'key1,,key2,,,key3';
            const manager = new GoogleApiKeyManager();

            expect(manager.getKeyCount()).toBe(3);
        });

        it('should handle empty env variable', () => {
            process.env.GOOGLE_API_KEY = '';
            const manager = new GoogleApiKeyManager();

            expect(manager.getKeyCount()).toBe(0);
        });
    });

    describe('round-robin rotation', () => {
        it('should rotate keys in order', () => {
            process.env.GOOGLE_API_KEY = 'key1,key2,key3';
            const manager = new GoogleApiKeyManager();

            expect(manager.getNextKey()).toBe('key1');
            expect(manager.getNextKey()).toBe('key2');
            expect(manager.getNextKey()).toBe('key3');
            expect(manager.getNextKey()).toBe('key1'); // wrap around
            expect(manager.getNextKey()).toBe('key2');
        });

        it('should return same key when only one key', () => {
            process.env.GOOGLE_API_KEY = 'single-key';
            const manager = new GoogleApiKeyManager();

            expect(manager.getNextKey()).toBe('single-key');
            expect(manager.getNextKey()).toBe('single-key');
            expect(manager.getNextKey()).toBe('single-key');
        });

        it('should throw error when no keys available', () => {
            process.env.GOOGLE_API_KEY = '';
            const manager = new GoogleApiKeyManager();

            expect(() => manager.getNextKey()).toThrow(
                'No Google API keys available. Set GOOGLE_API_KEY environment variable.'
            );
        });
    });

    describe('utility methods', () => {
        it('should return correct key by index', () => {
            process.env.GOOGLE_API_KEY = 'key1,key2,key3';
            const manager = new GoogleApiKeyManager();

            expect(manager.getKey(0)).toBe('key1');
            expect(manager.getKey(1)).toBe('key2');
            expect(manager.getKey(2)).toBe('key3');
            expect(manager.getKey(3)).toBeNull();
            expect(manager.getKey(-1)).toBeNull();
        });

        it('should correctly report hasMultipleKeys', () => {
            process.env.GOOGLE_API_KEY = 'key1';
            const singleManager = new GoogleApiKeyManager();
            expect(singleManager.hasMultipleKeys()).toBe(false);

            resetGoogleApiKeyManager();
            process.env.GOOGLE_API_KEY = 'key1,key2';
            const multiManager = new GoogleApiKeyManager();
            expect(multiManager.hasMultipleKeys()).toBe(true);
        });

        it('should return correct stats', () => {
            process.env.GOOGLE_API_KEY = 'AIzaSyTest123,AIzaSyTest456';
            const manager = new GoogleApiKeyManager();

            manager.getNextKey(); // call once
            const stats = manager.getStats();

            expect(stats.totalKeys).toBe(2);
            expect(stats.currentIndex).toBe(1);
            expect(stats.totalCalls).toBe(1);
            expect(stats.keys).toHaveLength(2);
            // Keys should be masked
            expect(stats.keys[0]).toContain('***');
        });

        it('should reset state correctly', () => {
            process.env.GOOGLE_API_KEY = 'key1,key2,key3';
            const manager = new GoogleApiKeyManager();

            manager.getNextKey();
            manager.getNextKey();
            manager.reset();

            const stats = manager.getStats();
            expect(stats.currentIndex).toBe(0);
            expect(stats.totalCalls).toBe(0);
            expect(manager.getNextKey()).toBe('key1');
        });
    });

    describe('singleton pattern', () => {
        it('should return same instance', () => {
            process.env.GOOGLE_API_KEY = 'key1';
            const manager1 = getGoogleApiKeyManager();
            const manager2 = getGoogleApiKeyManager();

            expect(manager1).toBe(manager2);
        });

        it('should reset singleton correctly', () => {
            process.env.GOOGLE_API_KEY = 'key1';
            const manager1 = getGoogleApiKeyManager();
            manager1.getNextKey();

            resetGoogleApiKeyManager();
            process.env.GOOGLE_API_KEY = 'newkey';
            const manager2 = getGoogleApiKeyManager();

            expect(manager1).not.toBe(manager2);
            expect(manager2.getNextKey()).toBe('newkey');
        });
    });
});

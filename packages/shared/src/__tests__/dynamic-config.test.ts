/**
 * Unit tests for dynamic-config module
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
    getConfig,
    getConfigNumber,
    getConfigBoolean,
    initDynamicConfig,
    isConfigInitialized,
    isConfigLoadedFromMongoDB,
    resetConfigState,
    isConfigFromMongoDBEnabled,
} from "../dynamic-config.js";

describe("dynamic-config", () => {
    // Store original env vars
    const originalEnv = { ...process.env };

    beforeEach(() => {
        // Reset state before each test
        resetConfigState();
        // Reset env vars
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        // Restore original env vars
        process.env = originalEnv;
    });

    describe("isConfigFromMongoDBEnabled", () => {
        it("returns false when CONFIG_FROM_MONGODB is not set", () => {
            delete process.env.CONFIG_FROM_MONGODB;
            expect(isConfigFromMongoDBEnabled()).toBe(false);
        });

        it("returns false when CONFIG_FROM_MONGODB is 'false'", () => {
            process.env.CONFIG_FROM_MONGODB = "false";
            expect(isConfigFromMongoDBEnabled()).toBe(false);
        });

        it("returns true when CONFIG_FROM_MONGODB is 'true'", () => {
            process.env.CONFIG_FROM_MONGODB = "true";
            expect(isConfigFromMongoDBEnabled()).toBe(true);
        });
    });

    describe("getConfig without MongoDB", () => {
        beforeEach(() => {
            process.env.CONFIG_FROM_MONGODB = "false";
        });

        it("returns process.env value when MongoDB is disabled", () => {
            process.env.TEST_KEY = "test_value";
            expect(getConfig("TEST_KEY")).toBe("test_value");
        });

        it("returns undefined for non-existent key", () => {
            delete process.env.NON_EXISTENT_KEY;
            expect(getConfig("NON_EXISTENT_KEY")).toBeUndefined();
        });
    });

    describe("getConfigNumber", () => {
        beforeEach(() => {
            process.env.CONFIG_FROM_MONGODB = "false";
        });

        it("returns number for valid numeric string", () => {
            process.env.TEST_NUMBER = "42";
            expect(getConfigNumber("TEST_NUMBER")).toBe(42);
        });

        it("returns default for non-existent key", () => {
            delete process.env.NON_EXISTENT_NUMBER;
            expect(getConfigNumber("NON_EXISTENT_NUMBER", 100)).toBe(100);
        });

        it("returns default for non-numeric string", () => {
            process.env.INVALID_NUMBER = "not-a-number";
            expect(getConfigNumber("INVALID_NUMBER", 50)).toBe(50);
        });

        it("returns undefined when no default and key not found", () => {
            delete process.env.MISSING_KEY;
            expect(getConfigNumber("MISSING_KEY")).toBeUndefined();
        });
    });

    describe("getConfigBoolean", () => {
        beforeEach(() => {
            process.env.CONFIG_FROM_MONGODB = "false";
        });

        it("returns true for 'true' string", () => {
            process.env.TEST_BOOL = "true";
            expect(getConfigBoolean("TEST_BOOL")).toBe(true);
        });

        it("returns true for '1' string", () => {
            process.env.TEST_BOOL = "1";
            expect(getConfigBoolean("TEST_BOOL")).toBe(true);
        });

        it("returns true for 'yes' string", () => {
            process.env.TEST_BOOL = "yes";
            expect(getConfigBoolean("TEST_BOOL")).toBe(true);
        });

        it("returns false for 'false' string", () => {
            process.env.TEST_BOOL = "false";
            expect(getConfigBoolean("TEST_BOOL")).toBe(false);
        });

        it("returns false for other strings", () => {
            process.env.TEST_BOOL = "random";
            expect(getConfigBoolean("TEST_BOOL")).toBe(false);
        });

        it("returns default when key not found", () => {
            delete process.env.MISSING_BOOL;
            expect(getConfigBoolean("MISSING_BOOL", true)).toBe(true);
        });
    });

    describe("initDynamicConfig", () => {
        it("returns false when MongoDB is disabled", async () => {
            process.env.CONFIG_FROM_MONGODB = "false";
            const result = await initDynamicConfig();
            expect(result).toBe(false);
            expect(isConfigInitialized()).toBe(true);
            expect(isConfigLoadedFromMongoDB()).toBe(false);
        });

        it("returns false when CONFIG_MONGODB_URI is not set", async () => {
            process.env.CONFIG_FROM_MONGODB = "true";
            delete process.env.CONFIG_MONGODB_URI;
            const result = await initDynamicConfig();
            expect(result).toBe(false);
            expect(isConfigInitialized()).toBe(true);
        });

        it("only initializes once", async () => {
            process.env.CONFIG_FROM_MONGODB = "false";
            await initDynamicConfig();
            await initDynamicConfig();
            expect(isConfigInitialized()).toBe(true);
        });
    });

    describe("resetConfigState", () => {
        it("resets all state", async () => {
            process.env.CONFIG_FROM_MONGODB = "false";
            await initDynamicConfig();
            expect(isConfigInitialized()).toBe(true);

            resetConfigState();
            expect(isConfigInitialized()).toBe(false);
            expect(isConfigLoadedFromMongoDB()).toBe(false);
        });
    });
});

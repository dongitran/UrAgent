---
name: uragent-env-config
description: Guide for adding new ENV variables to UrAgent. Use when creating new environment config that needs dynamic reload from MongoDB.
---

# UrAgent ENV Configuration Guide

> [!NOTE]
> Only applies to `apps/open-swe`, `apps/open-swe-v2`, and `packages/`. Does not apply to `web`.

## Adding New ENV Variable

When adding a new runtime-configurable environment variable:

### 1. Add to `Dockerfile.api.dev`
```dockerfile
ENV MY_NEW_VAR="default-value"
```

### 2. Add to `.env`
```
MY_NEW_VAR=development-value
```

### 3. Use `getConfig()` in Code
```typescript
import { getConfig } from "@openswe/shared/dynamic-config";

// ✅ CORRECT - supports MongoDB dynamic config
const value = getConfig("MY_NEW_VAR") || "fallback";

// ❌ WRONG - static, requires rebuild
const value = process.env.MY_NEW_VAR;
```

## Variable Categories

| Category | Use `getConfig()` | Example |
|----------|-------------------|---------|
| **Runtime Config** | ✅ Yes | `LLM_PROVIDER`, `MAX_CONTEXT_ACTIONS` |
| **Security/Secrets** | ❌ No | `GITHUB_APP_PRIVATE_KEY`, `SECRETS_ENCRYPTION_KEY` |
| **Bootstrap** | ❌ No | `CONFIG_FROM_MONGODB`, `CONFIG_MONGODB_URI` |
| **Infrastructure** | ❌ No | `PORT`, `DATABASE_URI` |

## Test MongoDB Dynamic Config

```javascript
// Insert to MongoDB collection: uragent-urcard-config
db.getCollection('uragent-urcard-config').updateOne(
  {},
  { $set: { MY_NEW_VAR: "new-value" } },
  { upsert: true }
);
```

Config auto-refreshes every **10 seconds**.

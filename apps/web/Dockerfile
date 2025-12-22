# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies for building
RUN apk add --no-cache libc6-compat

# Copy yarn config files
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn

# Copy package.json files for workspaces
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

# Install dependencies
RUN yarn install --mode=skip-build

# Copy source code
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
COPY tsconfig.json ./

# Build shared package first
RUN cd packages/shared && yarn tsc

# Build web app
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && yarn build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy public assets
COPY --from=builder /app/apps/web/public ./apps/web/public

# Copy standalone build
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/web/server.js"]

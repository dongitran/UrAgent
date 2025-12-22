FROM langchain/langgraphjs-api:20

WORKDIR /deps/open-swe

# Copy package files first for better caching
COPY package.json yarn.lock .yarnrc.yml ./
COPY apps/open-swe/package.json ./apps/open-swe/
COPY packages/shared/package.json ./packages/shared/

# Install dependencies (cached if package files don't change)
RUN yarn install --mode=skip-build

# Copy source code
COPY packages/shared ./packages/shared
COPY apps/open-swe ./apps/open-swe
COPY tsconfig.json ./

# Build shared package
RUN cd packages/shared && yarn tsc

ENV LANGGRAPH_HTTP='{"app": "./apps/open-swe/src/routes/app.ts:app", "configurable_headers": {"include": ["x-github-access-token", "x-github-installation-token", "x-github-user-id", "x-github-user-login", "x-github-installation-name", "x-github-installation-id", "x-github-pat", "x-local-mode"]}}'

ENV LANGSERVE_GRAPHS='{"programmer": "./apps/open-swe/src/graphs/programmer/index.ts:graph", "planner": "./apps/open-swe/src/graphs/planner/index.ts:graph", "manager": "./apps/open-swe/src/graphs/manager/index.ts:graph"}'

RUN (test ! -f /api/langgraph_api/js/build.mts && echo "Prebuild script not found, skipping") || tsx /api/langgraph_api/js/build.mts

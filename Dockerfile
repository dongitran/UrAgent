FROM langchain/langgraphjs-api:20

ADD . /deps/open-swe

# Install dependencies without running postinstall scripts
RUN cd /deps/open-swe && yarn install --mode=skip-build

# Build shared package to generate dist folder
RUN cd /deps/open-swe/packages/shared && yarn tsc

ENV LANGGRAPH_HTTP='{"app": "./apps/open-swe/src/routes/app.ts:app", "configurable_headers": {"include": ["x-github-access-token", "x-github-installation-token", "x-github-user-id", "x-github-user-login", "x-github-installation-name", "x-github-installation-id", "x-github-pat", "x-local-mode"]}}'

ENV LANGSERVE_GRAPHS='{"programmer": "./apps/open-swe/src/graphs/programmer/index.ts:graph", "planner": "./apps/open-swe/src/graphs/planner/index.ts:graph", "manager": "./apps/open-swe/src/graphs/manager/index.ts:graph"}'

WORKDIR /deps/open-swe

RUN (test ! -f /api/langgraph_api/js/build.mts && echo "Prebuild script not found, skipping") || tsx /api/langgraph_api/js/build.mts

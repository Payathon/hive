# hive server image: the API, the built web app and the CLI bundle (/hive.mjs) in one process.
# Build: docker build -t hive .        Run: see deploy/docker-compose.yml (needs DATABASE_URL).
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Manifests first so the dependency layer is cached until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/cli/package.json packages/cli/
COPY packages/client/package.json packages/client/
COPY packages/core/package.json packages/core/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
# Baked into the served /hive.mjs as its default server; empty keeps localhost (agents set HIVE_SERVER anyway).
ARG HIVE_DEFAULT_SERVER=""
RUN pnpm --filter @hive/web build && pnpm --filter @hive/cli build
# A self-contained copy of the server with production dependencies only (tsx runs the TypeScript).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @hive/server deploy --prod --legacy /out

FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8787 \
    WEB_DIST=/app/web \
    HIVE_CLI_BUNDLE=/app/cli/hive.mjs \
    FILES_DIR=/data/files \
    VAPID_FILE=/data/vapid.json \
    FAKE_PAY_STATE=/data/fake-pay.json
WORKDIR /app/server
COPY --from=build /out /app/server
COPY --from=build /repo/apps/web/dist /app/web
COPY --from=build /repo/packages/cli/dist/hive.mjs /app/cli/hive.mjs
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/main.ts"]

# Local evaluation image. Public distribution of the original game still needs permission.
# Build from the repository root: docker build -f community/deploy/Dockerfile .
# Exact version tags are intentional; verified image digests are a public-release gate.
# https://docs.docker.com/build/building/multi-stage/
FROM node:26.4.0-bookworm-slim AS dependencies
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
WORKDIR /app/community
COPY community/package.json community/package-lock.json ./
# Keep development dependencies: native TS execution needs types at build time,
# server startup imports esbuild, and local reference checks use Playwright.
RUN npm ci --ignore-scripts && npx --no-install playwright install --with-deps chromium \
    && chmod -R a+rX /opt/playwright

FROM dependencies AS checked
COPY community/tsconfig.json ./
COPY community/api/ ./api/
COPY community/engine/ ./engine/
COPY community/runtime/ ./runtime/
COPY community/shared/ ./shared/
COPY community/web/ ./web/
COPY community/worker/ ./worker/
COPY community/voting/ ./voting/
COPY community/db/ ./db/
COPY community/scripts/ ./scripts/
COPY community/tests/ ./tests/
COPY _site/releases/2.35.30/main.767a81ddb61f928b36d7.bundle.js /app/_site/releases/2.35.30/
COPY _site/releases/2.35.30/vendors.d5bf7f8c0122f25ddc8b.bundle.js /app/_site/releases/2.35.30/
COPY _site/releases/2.35.30/assets/ /app/_site/releases/2.35.30/assets/
RUN npm run build && npm run prepare:runtime

FROM dependencies AS application
ENV NODE_ENV=development \
    COMMUNITY_DATA_DIR=/app/community/.data \
    COMMUNITY_HOST=0.0.0.0 \
    COMMUNITY_LOCAL_CONTAINER=1 \
    PORT=8080
# Deliberate allowlist: no repository root, docs, tests, fixtures, profiles,
# environment files, generated host output, or original website configuration.
COPY --from=checked /app/community/api/ ./api/
COPY --from=checked /app/community/engine/ ./engine/
COPY --from=checked /app/community/runtime/ ./runtime/
COPY --from=checked /app/community/shared/ ./shared/
COPY --from=checked /app/community/web/ ./web/
COPY --from=checked /app/community/worker/ ./worker/
COPY --from=checked /app/community/db/ ./db/
COPY --from=checked /app/community/scripts/prepare-runtime.ts ./scripts/prepare-runtime.ts
COPY --from=checked /app/community/scripts/retire-preview-cache.ts ./scripts/retire-preview-cache.ts
COPY --from=checked /app/_site/releases/2.35.30/ /app/_site/releases/2.35.30/
RUN mkdir -p .runtime .web .data && chown node:node .runtime .web .data
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 \
    CMD node --input-type=module -e "const r=await fetch('http://127.0.0.1:8080/readyz');if(!r.ok)process.exit(1)"
CMD ["node", "api/server.ts"]

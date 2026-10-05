# Build from the repository root. The final API image contains no game engine or browser.
FROM node:26.4.0-bookworm-slim AS build
WORKDIR /app/community
COPY community/package.json community/package-lock.json ./
RUN npm ci --ignore-scripts
COPY community/ ./
COPY ["community maps/", "/app/community maps/"]
RUN npm run build && node scripts/build-voting-manifest.ts voting/manifest.json

FROM node:26.4.0-bookworm-slim AS application
WORKDIR /app/community
ENV NODE_ENV=production
COPY community/package.json community/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/community/voting/ ./voting/
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node --input-type=module -e "const r=await fetch('http://127.0.0.1:8080/healthz');if(!r.ok)process.exit(1)"
CMD ["node", "voting/server.ts"]

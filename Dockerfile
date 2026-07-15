# Official Node image on debian slim (glibc), never Alpine: musl will not load the glibc-compiled node-pty addon.
FROM node:24-trixie-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
# build_from_source compiles node-pty rather than pulling a prebuilt; make vendor re-copies xterm + Inter from node_modules (committed JetBrains woff2 are already up to date, so no uv needed).
RUN npm_config_build_from_source=true npm ci && make vendor

FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app .
EXPOSE 8442
ENTRYPOINT ["node", "bin/rinnegan.js", "serve"]
CMD ["--config", "/data/config.json"]

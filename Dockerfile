# Build stage: has compilers in case the SQLite driver has no prebuilt binary for this platform.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY app ./app
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /data
VOLUME /data
EXPOSE 3000
CMD ["node", "app/server.js"]

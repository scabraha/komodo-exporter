# syntax=docker/dockerfile:1.24

FROM node:24-alpine AS builder
WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
RUN addgroup -S exporter && adduser -S -G exporter exporter
WORKDIR /app
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY package.json ./
USER exporter
EXPOSE 9105
ENTRYPOINT ["node", "dist/index.js"]

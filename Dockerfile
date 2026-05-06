FROM node:22-alpine AS builder

WORKDIR /src

COPY package.json package-lock.json ./

RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src/ ./src/

RUN npm run build

FROM node:22-alpine

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

COPY --from=builder /src/node_modules ./node_modules
COPY --from=builder /src/dist ./dist
COPY --from=builder /src/package.json ./

VOLUME ["/app/data"]

ENTRYPOINT ["node", "dist/index.mjs"]

CMD ["-config", "/app/data/config.yaml"]

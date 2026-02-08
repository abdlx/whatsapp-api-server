FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:20-alpine AS production

WORKDIR /app

RUN apk add --no-cache tini

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

RUN mkdir -p sessions && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/app.js"]

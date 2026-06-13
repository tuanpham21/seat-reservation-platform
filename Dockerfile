FROM node:20-bookworm-slim

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY next.config.mjs tsconfig.json .eslintrc.json ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src

RUN npm run build
RUN chmod +x scripts/docker-entrypoint.sh scripts/stripe-listen-to-file.sh

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["./scripts/docker-entrypoint.sh"]

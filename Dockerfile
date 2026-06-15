FROM node:20-bookworm-slim

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY next.config.mjs tsconfig.json .eslintrc.json ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src

ENV APP_URL=http://localhost:3000
ENV AUTH_COOKIE_SECURE=false
ENV JWT_SECRET=build-only-jwt-secret-long-enough-123456
ENV STRIPE_SECRET_KEY=sk_test_replace_me
ENV STRIPE_WEBHOOK_SECRET=whsec_replace_me
ENV STRIPE_WEBHOOK_SECRET_FILE=/run/stripe/webhook-secret
ENV SEAT_HOLD_TTL_SECONDS=600
ENV ACCESS_TOKEN_TTL_SECONDS=900
ENV REFRESH_SESSION_TTL_DAYS=90

RUN npm run build
RUN chmod +x scripts/docker-entrypoint.sh scripts/stripe-listen-to-file.sh
RUN chown -R node:node /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

USER node

EXPOSE 3000

CMD ["./scripts/docker-entrypoint.sh"]

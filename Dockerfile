# Fein — single-container deploy. Embedded Postgres (PGlite) keeps its data
# in the /data volume; set DATABASE_URL to use an external Postgres instead.
FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY sample ./sample
COPY LICENSE README.md CHANGELOG.md ./

# 0.0.0.0 is safe here only because startWebServer refuses it without
# FEIN_AUTH_TOKEN — the container fails closed if you forget the token.
ENV FEIN_HOST=0.0.0.0 \
    FEIN_DATA=/data \
    FEIN_PORT=4321

VOLUME /data
EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://localhost:'+(process.env.FEIN_PORT||4321)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/cli.js", "web"]

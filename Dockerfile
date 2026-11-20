# Lanterna: immagine di produzione (opzionale, vedi docs/DEPLOY.md). Nessun segreto qui dentro:
# la configurazione arriva da variabili d'ambiente a runtime (docker-compose.yml + .env).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json eslint.config.js ./
COPY packages ./packages
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_URL=file:/data/lanterna.db \
    UPLOAD_DIR=/data/uploads \
    BACKUP_DIR=/data/backups
WORKDIR /app
COPY --from=build --chown=node:node /app /app
# Dati (database, upload, backup) in un volume, scrivibile dall'utente non root.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
# /api/health risponde {"status":"ok"} senza autenticazione.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "packages/server/dist/main.js"]

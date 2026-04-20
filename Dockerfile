# Dockerfile para correr SchoolAlerts en Fly.io / Oracle Cloud / cualquier
# PaaS que soporte containers. Localmente NO hace falta: seguis usando
# `node server.js` directo.
#
# Estrategia: multi-stage build para que la imagen final sea chica
#  - Stage "deps": instala solo las dependencias de prod (npm ci --omit=dev)
#  - Stage "runtime": copia node_modules + codigo en node:20-alpine (~50MB)
#
# No copiamos archivos que no hacen falta (APK, windows/, tests, etc.) —
# de eso se encarga .dockerignore.

FROM node:20-alpine AS deps

WORKDIR /app

# Copiamos solo los manifests primero para aprovechar el cache de layers
# de Docker: si package.json no cambia, npm ci se saltea.
COPY package.json package-lock.json* ./

# --omit=dev: no instalamos devDependencies (no hay, pero por si acaso).
# --no-audit --no-fund: silencia mensajes molestos.
# Si no hay package-lock.json caemos en npm install (algo mas lento).
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# -----------------------------------------------------------------------

FROM node:20-alpine AS runtime

# tini: init minimo para manejar senales (PID 1 en Docker es medio roto
# sin esto; Ctrl+C / fly apps restart matan mas limpio con tini).
RUN apk add --no-cache tini curl

WORKDIR /app

# Usuario no-root para seguir best practices.
RUN addgroup -S app && adduser -S -G app app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app . .

# Crear /data asi el server puede escribir (Fly.io lo sobrescribe con el
# volume montado, pero localmente sirve para probar la imagen).
RUN mkdir -p /data && chown -R app:app /data
USER app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV VAPID_CONTACT=mailto:schoolalerts@example.com

EXPOSE 3000

# tini como init + node como proceso principal.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]

FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS node-base
ARG OS_PATCH_REVISION=local
RUN apk upgrade --no-cache && npm install --global npm@12.2.2 --ignore-scripts

FROM node-base AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY shared shared
COPY web web
RUN npm run build -w web

# API image: serves whichever API(s) SERVICE selects (default: all of them). Used by the k8s deployments.
FROM node-base AS api
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DB_PATH=/data/azure-vision.db
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
# Only the build needs npm; do not ship its dependency graph in the runtime image.
RUN npm ci --omit=dev --workspace shared --workspace server \
    && mkdir /data && chown node /data \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm /usr/local/bin/npm /usr/local/bin/npx
COPY shared shared
COPY server server
USER node
VOLUME /data
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3001') + '/api/health').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"]
CMD ["node", "--import", "tsx", "server/src/index.ts"]

# Static UI behind nginx, which also routes /api/* to the services (see web/nginx/templates/default.conf.template).
FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 AS web
ARG OS_PATCH_REVISION=local
ENV INVENTORY_UPSTREAM=http://inventory-api:3001 COST_UPSTREAM=http://cost-api:3001 LAYOUT_UPSTREAM=http://layout-api:3001
USER root
RUN apk upgrade --no-cache && rm -f /etc/nginx/conf.d/default.conf
COPY web/nginx/templates /etc/nginx/templates
COPY --from=build /app/web/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["wget", "--quiet", "--spider", "http://127.0.0.1:8080/api/health"]

# Single-process image (default target): the API plus the built UI, for `docker run`.
FROM api AS standalone
ENV WEB_DIST=/app/web/dist
COPY --from=build /app/web/dist web/dist

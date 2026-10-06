# Build once on the build machine's CPU: the output is plain JavaScript.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts && npm run build
ARG VERSION=dev
RUN mkdir /app && cp package.json package-lock.json /app/ \
 && for p in packages/*/; do mkdir -p /app/$p && cp $p/package.json /app/$p && cp -R $p/dist /app/$p; done \
 && cd /app && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && find node_modules -type d -empty -delete \
 && printf '{"version":"%s"}\n' "$VERSION" > /app/version.json

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN groupadd --system pipulse && useradd --system --gid pipulse --home /data --shell /usr/sbin/nologin pipulse \
 && mkdir /data && chown pipulse:pipulse /data
COPY --from=build /app /opt/pipulse/app
ENV PIPULSE_DB_PATH=/data/pipulse.sqlite \
    PIPULSE_WEB_DIR=/opt/pipulse/app/packages/web/dist \
    PIPULSE_HOST_ROOT=/host \
    PIPULSE_IN_CONTAINER=true \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
USER pipulse
VOLUME /data
EXPOSE 8889
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s \
  CMD node /opt/pipulse/app/packages/tls/dist/health-check.js || exit 1
CMD ["node", "/opt/pipulse/app/packages/api/dist/server.js"]

# syntax=docker/dockerfile:1.7
# Browser/WASM consumer image (#195). Build context is testbed/; the staged
# artifacts arrive as the named context 'artifacts'. The same clean-install
# verification as the Node consumer runs first (candidate: the packed tarballs;
# published: the pinned releases), then esbuild bundles the INSTALLED packages
# for a browser. Pin: node 22.16.0 (bookworm-slim), the Node consumer's digest.
ARG NODE_IMAGE=node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34

FROM ${NODE_IMAGE} AS install
ARG TESTBED_FAULT=""
ENV TESTBED_FAULT=${TESTBED_FAULT}
RUN mkdir -p /opt/consumer && chown node:node /opt/consumer
USER node
WORKDIR /opt/consumer
COPY --chown=node:node services/node-consumer/install-and-verify.mjs /tmp/install-and-verify.mjs
RUN --mount=type=bind,from=artifacts,target=/artifacts,readonly \
    HOME=/tmp/home node /tmp/install-and-verify.mjs
COPY --chown=node:node contract/aictx-cases.mjs /opt/consumer/contract/aictx-cases.mjs
COPY --chown=node:node services/browser-consumer/app/ /opt/consumer/app/
COPY --chown=node:node services/browser-consumer/build.mjs /opt/consumer/build.mjs
COPY --chown=node:node services/browser-consumer/public/ /opt/consumer/public/
RUN node build.mjs

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
COPY --from=install --chown=root:root /opt/consumer/public/ /opt/consumer/public/
COPY --from=install --chown=root:root /opt/consumer/status.json /opt/consumer/install-manifest.json /opt/consumer/
COPY services/browser-consumer/server.mjs /opt/consumer/server.mjs
USER node
WORKDIR /opt/consumer
EXPOSE 8080
CMD ["node", "server.mjs"]

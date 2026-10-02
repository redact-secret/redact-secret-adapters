# syntax=docker/dockerfile:1.7
# Scenario UI shell (#192). Dependency-free, so the image only needs Node.
ARG NODE_IMAGE=node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY services/ui/server.mjs ./server.mjs
COPY services/ui/public/ ./public/
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]

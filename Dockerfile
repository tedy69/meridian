FROM node:22-bookworm-slim AS dependencies

WORKDIR /build

COPY package.json package-lock.json .npmrc ./
COPY scripts ./scripts

RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund \
  && npm run postinstall

FROM node:22-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

COPY --from=dependencies --chown=node:node /build/node_modules /runtime/node_modules
COPY --chown=node:node . ./

USER node

CMD ["node", "index.js"]

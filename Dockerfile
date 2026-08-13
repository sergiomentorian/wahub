FROM node:20-alpine

WORKDIR /app

# Instala deps primeiro (cache de layer). package-lock é opcional.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Código do broker
COPY . .

RUN mkdir -p /config /waha-sessions \
  && chown -R node:node /app /config /waha-sessions

ENV NODE_ENV=production
ENV PORT=8090
EXPOSE 8090

USER node

CMD ["node", "index.js"]

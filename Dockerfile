FROM node:20-alpine

WORKDIR /app

# Instala deps primeiro (cache de layer). package-lock é opcional.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Código do broker
COPY . .

ENV PORT=8090
EXPOSE 8090

CMD ["node", "index.js"]

ARG WAHA_BASE_IMAGE=devlikeapro/waha:noweb-2026.7.1

FROM node:20-alpine AS baileys-builder

ARG BAILEYS_REPOSITORY=https://github.com/devlikeapro/Baileys.git
ARG BAILEYS_COMMIT=6f0a733c5741358be19d1febbffa40d978b2225c

RUN apk add --no-cache git
RUN git clone --filter=blob:none "${BAILEYS_REPOSITORY}" /src \
  && git -C /src checkout --detach "${BAILEYS_COMMIT}"
WORKDIR /src
RUN corepack enable \
  && yarn install --immutable \
  && yarn build \
  && test "$(node -p "require('./package.json').version")" = "7.0.0-rc14" \
  && grep -q "1043857760" lib/Utils/generics.js

FROM ${WAHA_BASE_IMAGE}

USER root

# A imagem WAHA 2026.7.1 foi publicada com o fork Baileys rc13. Mantemos toda
# a release estavel do WAHA e substituimos somente o pacote NOWEB pelo commit
# rc14 fixado do proprio fork devlikeapro, compativel com o gateway Mentorian.
RUN rm -rf \
  /app/node_modules/@adiwajshing/baileys/lib \
  /app/node_modules/@adiwajshing/baileys/WAProto
COPY --from=baileys-builder /src/lib /app/node_modules/@adiwajshing/baileys/lib
COPY --from=baileys-builder /src/WAProto /app/node_modules/@adiwajshing/baileys/WAProto
COPY --from=baileys-builder /src/package.json /app/node_modules/@adiwajshing/baileys/package.json

RUN test "$(node -p "require('/app/node_modules/@adiwajshing/baileys/package.json').version")" = "7.0.0-rc14" \
  && grep -q "1043857760" /app/node_modules/@adiwajshing/baileys/lib/Utils/generics.js

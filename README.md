# wa-hub — Hub de APIs não-oficiais do WhatsApp

Sobe **Evolution API · Evolution Go · WuzAPI · WAHA** em **uma stack Docker**, lê o **QR de qualquer uma** por
uma UI comum e **migra a sessão de uma API para outra com 1 clique** — sem re-parear o celular.

O truque: todas autenticam a **mesma sessão multi-device** do WhatsApp; só muda **onde** cada uma guarda as
credenciais (família **Baileys**, **whatsmeow** ou **browser**). Um serviço **broker** usa um **passaporte**
canônico como formato intermediário para importar/exportar/migrar entre elas.

## Recursos

- **Lista unificada** das sessões de todas as APIs, agrupadas por número.
- **Ler QR** de qualquer API pela mesma tela (com código de pareamento por telefone quando disponível).
- **Migrar 1-clique** entre APIs sem re-parear: a identidade do aparelho é transferida e o destino conecta sem QR.
  - **Tier 1** (todas as combinações): migra as credenciais; histórico/mídias re-sincronizam no destino.
  - **Tier 2** (mesma família): copia também o store de chaves (migração "quente").
- **Colar passaporte**: importar credenciais no formato do Contrato A como fallback.
- **Testar envio** de texto por qualquer sessão, direto da UI.
- **Instalações externas**: por padrão cada API usa a instalação da stack, mas você pode apontar qualquer uma
  para uma instalação externa (URL + token e, quando a API exige, os DSNs de banco/volume). A configuração é
  aplicada em runtime, persiste no broker e pode ser revertida ao padrão da stack a qualquer momento.

## Estrutura

```
docker-compose.yml   stack: postgres + redis + evolution + evogo + wuzapi + waha + broker
.env.example         segredos/tokens/tags (copie p/ .env)
init-db/             CREATE DATABASE idempotente dos DBs
broker/              serviço Node (Express) — o "broker" do hub
  lib/passport.js    codec Contrato A <-> Baileys <-> whatsmeow + derivação X25519 (núcleo)
  lib/util.js        http/secret/dedup/poll
  index.js           servidor HTTP + registry de adapters + rotas
  migrate.js         orquestração da migração 1-clique
  adapters/          evolution · evogo · wuzapi · waha · uazapi
  public/index.html  UI (lista unificada + Ler QR + Migrar + Colar passaporte + Configurações)
```

## Quickstart

```bash
cp .env.example .env      # edite HUB_SECRET, senhas, tokens, tags de imagem

# construir a imagem do WuzAPI UMA vez por máquina (upstream asternic, do Dockerfile do repo).
# necessário: o serviço wuzapi usa uma imagem pré-construída, não é buildado pelo compose.
docker build -t wuzapi:hub https://github.com/asternic/wuzapi.git

docker compose up -d --build   # sobe a stack (builda o broker; demais usam imagens)

# ativar licença do EvoGo (senão não conecta):
docker compose exec evogo wget -qO- "http://localhost:8082/license/activate?code=SEU_CODIGO"
```

UI em `http://127.0.0.1:8090` (única porta exposta; protegida por `HUB_SECRET`).

### Sobre o build do WuzAPI

**Sim, o `docker build -t wuzapi:hub ...` precisa rodar antes** do `docker compose up -d --build`. O serviço
`wuzapi` referencia uma imagem pré-construída (`WUZAPI_IMAGE`, default `wuzapi:hub`) e **não tem `build:`** no
compose — então `--build` builda apenas o `broker`. Sem a imagem local, o compose tentaria puxar `wuzapi:hub`
de um registry (não existe) e falharia. Basta buildar **uma vez por máquina**; nos `up` seguintes a imagem já
está no cache local. Como o upstream `asternic/wuzapi` não expõe endpoint de import nativo, o broker importa
via SQL direto (`WUZAPI_IMPORT_MODE=auto`).

## Segurança

- Todas as rotas de dados exigem o cabeçalho `x-hub-secret` (= `HUB_SECRET`), comparado em tempo constante.
- Única porta exposta é a `8090`, com bind em `127.0.0.1`. Para acesso remoto, coloque atrás de um proxy
  reverso (ex.: Traefik/Nginx) com TLS e mantenha o `HUB_SECRET`.
- **Não faça logout na origem ao migrar**: logout desregistra o aparelho no WhatsApp. A migração usa
  release/disconnect que preserva o registro do device; o destino assume via *replace* multi-device.

> Status: **funcional** — migração de sessão validada ao vivo entre WAHA, WuzAPI, Evolution Go e Evolution API,
> sem re-parear o celular.

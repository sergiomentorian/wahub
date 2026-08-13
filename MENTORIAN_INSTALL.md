# Instalacao Mentorian

Esta arvore preserva o WA Hub como servico independente GPL-3.0. O MentorOps
continua sendo um projeto privado separado e consulta o broker somente no servidor.

## Fronteira de producao

- `mentorian.io/monitoring/provider-hub`: interface autenticada e autorizada.
- broker WA Hub: processo Docker persistente, acessivel apenas pelo MentorOps via TLS
  ou rede privada.
- Postgres, Redis e volumes de sessao: persistentes no mesmo host do broker.
- nenhum token, passaporte ou `HUB_SECRET` e entregue ao navegador.

O broker inicia com `HUB_MUTATIONS_ENABLED=false` e `HUB_STATIC_UI_ENABLED=false`.
Assim, inventario e saude ficam disponiveis, mas QR, envio, importacao, exclusao,
configuracao e migracao falham fechados.

## Ativacao operacional

Antes de mudar `HUB_MUTATIONS_ENABLED` para `true`, implementar e provar:

1. lock distribuido e idempotencia por migracao;
2. backup cifrado e duravel do passaporte e do store;
3. verificacao do destino antes de apagar a origem;
4. rollback testado apos falha e reinicio do broker;
5. auditoria sem tokens, credenciais ou PII;
6. proxy TLS privado, allowlist e rate limiting;
7. teste supervisionado apenas com um numero autorizado.

Nunca use migracao para contornar restricao do WhatsApp e nunca mantenha dois
sockets nao oficiais ativos para o mesmo numero.

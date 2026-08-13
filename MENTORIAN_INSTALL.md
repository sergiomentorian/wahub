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

## Atualização estável dos provedores

Todo provedor homologado deve usar o canal estável com atualização protegida. Para
o WAHA, o workflow `publish-waha-stable.yml` consulta somente a release oficial que
não seja draft/prerelease, constrói a imagem NOWEB com o Baileys homologado e publica
uma tag imutável no GHCR.

Na VPS, instale uma vez o timer:

```bash
sudo ops/install-waha-auto-update.sh
sudo systemctl start mentorian-waha-auto-update.service
```

O atualizador diário:

1. bloqueia concorrência e valida a release estável e a imagem imutável;
2. registra a quantidade de sessões operacionais;
3. para somente o WAHA, cria backup cifrado do volume e promove a imagem;
4. só conclui quando as mesmas sessões voltam `WORKING`;
5. restaura automaticamente a imagem anterior se o gate falhar;
6. persiste versão, canal, data, origem e estado do auto-update para o MentorOps.

Ele nunca chama `logout`, apaga credenciais nem gera QR Code. Backups cifrados são
mantidos por 30 dias e a chave fica em `/etc/mentorian-waha-updater.env` com modo
`0600`.

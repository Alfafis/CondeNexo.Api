#!/usr/bin/env bash
# Deploy da API na VPS, disparado pelo GitHub Actions (.github/workflows/deploy-api.yml; docs/deploy.md, seção 11).
#
# Roda no HOST como root, SÓ pela chave do CI, que no authorized_keys fica presa a este comando:
#   restrict,command="/usr/local/sbin/tcc-portaria-deploy" ssh-ed25519 AAAA... tcc-portaria-ci
# O comando que o cliente mandar ($SSH_ORIGINAL_COMMAND) é ignorado: a chave só sabe fazer "deploy da origin/main".
# Mesmo vazada, ela não abre shell, não faz túnel e não escolhe o que sobe.
#
# Instalado FORA do clone (cópia manual, não acompanha o git): um push que altere este arquivo não muda o que o root
# executa. Atualizar: install -m 755 -o root -g root scripts/deploy/deploy-vps.sh /usr/local/sbin/tcc-portaria-deploy
#
# Fluxo: fetch -> recusa se a main foi reescrita ou se mudou infra -> backup do banco -> build -> troca API_TAG ->
# up --wait (migrate roda antes da API) -> /saude. Falhou depois da troca: volta a tag e o commit anteriores.
# Saída: 0 ok ou nada a fazer; 1 falha (com rollback da imagem); 2 mudança de infra, deploy manual; 75 outro em curso.
set -euo pipefail
# 022, não 077: o git checkout grava os arquivos do clone com este umask, e o build copia esses arquivos para imagens
# que rodam como `node` (o migrate lê drizzle/ em runtime). Com 077 saíram 600 do root e o migrate deu EACCES.
# O que é sigiloso protege-se pela pasta: o dump local vai para um diretório 700, e o backup-portaria.sh tem umask próprio.
umask 022

PORTARIA_DIR="${PORTARIA_DIR:-/opt/tcc-portaria}"
PRE_DEPLOY_DIR="${PRE_DEPLOY_DIR:-/var/backups/tcc-portaria/pre-deploy}"
RECIPIENTES="${BACKUP_AGE_RECIPIENTES:-/etc/tcc-portaria/backup-age.pub}"
# Infra muda o que roda como root no host (compose: volumes, privilégios; bootstrap do banco; este script): só à mão.
# O .env.producao.example entra porque variável nova exige alguém preencher o .env antes.
INFRA_RE='^(docker-compose[^/]*\.ya?ml|Dockerfile|\.dockerignore|db/bootstrap/|db/backup/|scripts/deploy/|\.env\.producao\.example)'

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

exec 9>/run/tcc-portaria-deploy.lock
flock -n 9 || { log "outro deploy em andamento"; exit 75; }

cd "$PORTARIA_DIR"
tag_env() { sed -n 's/^API_TAG=//p' .env; }
porta="$(sed -n 's/^API_HOST_PORT=//p' .env)"
URL_SAUDE="http://127.0.0.1:${porta:-3100}/api/v1/saude"

saude() {
  local _
  for _ in $(seq 1 20); do
    curl -fsS --max-time 5 "$URL_SAUDE" 2>/dev/null | grep -q '"banco":"ok"' && return 0
    sleep 3
  done
  return 1
}

git fetch --quiet origin main
ATUAL="$(git rev-parse HEAD)"
ALVO="$(git rev-parse origin/main)"
TAG_ATUAL="$(tag_env)"

if [ "$ATUAL" = "$ALVO" ]; then
  log "já em ${ALVO:0:7} (API_TAG=$TAG_ATUAL), nada a fazer"
  exit 0
fi
if ! git merge-base --is-ancestor "$ATUAL" "$ALVO"; then
  log "origin/main não descende de ${ATUAL:0:7} (force-push?): deploy manual"
  exit 2
fi
MUDOU="$(git diff --name-only "$ATUAL" "$ALVO")"
if INFRA="$(grep -E "$INFRA_RE" <<<"$MUDOU")"; then
  log "mudança de infra entre ${ATUAL:0:7} e ${ALVO:0:7}, deploy manual (docs/deploy.md, seção 11):"
  printf '  %s\n' $INFRA
  exit 2
fi
MIGRACAO=0
# drizzle/ (bancos de condomínio) e drizzle-plataforma/ (banco plataforma, SaaS): o serviço migrate aplica os dois (SAAS-16).
grep -qE '^drizzle(-plataforma)?/' <<<"$MUDOU" && MIGRACAO=1

# Backup antes de qualquer migração. Com a chave age instalada, o backup cifrado completo; sem ela, um dump local
# (root, 600) só para desfazer este deploy, guardando os 3 últimos.
if [ -s "$RECIPIENTES" ] && command -v age >/dev/null; then
  log "backup cifrado antes do deploy"
  "$PORTARIA_DIR/db/backup/backup-portaria.sh"
  BACKUP="ver /var/backups/tcc-portaria/diario"
else
  # SaaS (F2): um dump por banco (portaria, plataforma e os dos condomínios), com o mesmo carimbo. Guarda 3 conjuntos.
  install -d -m 700 "$PRE_DEPLOY_DIR"
  SUFIXO="$(date -u +%Y%m%dT%H%M%SZ)-$TAG_ATUAL.dump"
  BACKUP="$PRE_DEPLOY_DIR/<banco>-$SUFIXO"
  BANCOS="$(docker compose exec -T db psql -U postgres -tAc \
    "SELECT datname FROM pg_database WHERE datname IN ('portaria', 'plataforma') OR datname ~ '^portaria_[a-z0-9]{8}$' ORDER BY 1")"
  for b in $BANCOS; do
    log "dump local antes do deploy (sem chave age): $PRE_DEPLOY_DIR/$b-$SUFIXO"
    docker compose exec -T db pg_dump -U postgres -d "$b" -Fc --no-password >"$PRE_DEPLOY_DIR/$b-$SUFIXO"
  done
  ls -1t "$PRE_DEPLOY_DIR"/portaria-*.dump | tail -n +4 | while read -r f; do rm -f "$PRE_DEPLOY_DIR"/*-"${f##*/portaria-}"; done
fi

git checkout --quiet --detach "$ALVO"
TAG_NOVA="$(git rev-parse --short HEAD)"
log "build ${TAG_NOVA} (atual ${TAG_ATUAL})"
# Uma imagem por vez: em 2026-10-24 o dockerd 29.6.1 caiu ("concurrent map iteration and map write") com api e migrate
# em paralelo, e ao voltar não religou nenhum container da VPS, Tobe incluso. Se o build falhar, conferir `docker ps -a`.
if ! { API_TAG="$TAG_NOVA" docker compose build --quiet api && API_TAG="$TAG_NOVA" docker compose build --quiet migrate; }; then
  log "build falhou; conferir docker ps -a (se o dockerd caiu, os containers ficam parados)"
  git checkout --quiet --detach "$ATUAL"
  exit 1
fi

sed -i "s|^API_TAG=.*|API_TAG=$TAG_NOVA|" .env
if docker compose up -d --wait && saude; then
  log "ok: API em ${TAG_NOVA}"
  # Guarda as 3 imagens mais novas de cada (rollback rápido) e apaga as outras.
  for img in tcc-portaria-api tcc-portaria-migrate; do
    docker images "$img" --format '{{.Repository}}:{{.Tag}}' | tail -n +4 | xargs -r docker rmi >/dev/null 2>&1 || true
  done
  exit 0
fi

log "falhou em ${TAG_NOVA}; voltando para ${TAG_ATUAL}"
docker compose logs --tail 40 migrate api 2>&1 | sed 's/^/  /' || true
git checkout --quiet --detach "$ATUAL"
sed -i "s|^API_TAG=.*|API_TAG=$TAG_ATUAL|" .env
docker compose up -d --wait || log "rollback também falhou: intervir à mão"
if [ "$MIGRACAO" = 1 ]; then
  log "ATENÇÃO: havia migração nova e ela pode ter sido aplicada; o schema não volta sozinho. Backup: $BACKUP"
fi
exit 1

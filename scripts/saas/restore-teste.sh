#!/usr/bin/env bash
# Restore de TESTE de um backup do banco `portaria` num Postgres DESCARTÁVEL (fase F0 do SaaS; docs/deploy.md, seção 12).
# Roda na máquina do responsável (onde está a chave PRIVADA age), nunca na VPS: a privada não vai para lá, e um container
# local não tem como tocar no banco de produção. Precisa de docker, age, git, node e do build da API
# (npm ci && npm run build, na raiz do repositório).
#
#   AGE_IDENTIDADE=~/caminho/portaria-backup.key scripts/saas/restore-teste.sh \
#     ~/backups/tcc-portaria/diario/portaria-<carimbo>.dump.age  [linha-de-base-<carimbo>.tar.age]
#
# O que faz: sobe postgres:17-alpine (a versão de produção) só em 127.0.0.1, numa porta livre; cria os roles do
# bootstrap (sem login) e um banco descartável; restaura o dump decifrado por pipe (sem arquivo em claro); roda a CLI
# linha-de-base contra ele, em modo --conferir quando a linha de base da F0 é informada (cadeia íntegra, âncoras do
# GitHub conferem, cabeça igual ou posterior e MESMO hash no seq da linha de base). Se houver o arquivos-<carimbo>.tar.age
# ao lado do dump, confere que ele decifra e lista. No fim, apaga o container e a pasta temporária, com sucesso ou não.
# Use um dump feito DEPOIS da linha de base (senão a cabeça do dump é anterior e a comparação acusa).
#
# Saída: 0 confere; 4 restaurou mas NÃO confere; 1 erro.
set -euo pipefail
umask 077

DUMP="${1:?uso: AGE_IDENTIDADE=<chave privada> restore-teste.sh <portaria-*.dump.age> [linha-de-base-*.tar.age]}"
LINHA_DE_BASE="${2:-}"
: "${AGE_IDENTIDADE:?defina AGE_IDENTIDADE com o caminho da chave PRIVADA age}"
RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="$RAIZ/dist/cli/linha-de-base.js"
IMAGEM="postgres:17-alpine"

log() { printf '%s restore-teste: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
falha() { log "ERRO: $*"; exit 1; }

for c in docker age git node; do command -v "$c" >/dev/null || falha "$c não encontrado"; done
[ -r "$DUMP" ] || falha "dump não encontrado: $DUMP"
[ -r "$AGE_IDENTIDADE" ] || falha "chave privada não encontrada: $AGE_IDENTIDADE"
[ -f "$CLI" ] || falha "sem $CLI: rode npm run build na raiz do repositório"
[ -z "$LINHA_DE_BASE" ] || [ -r "$LINHA_DE_BASE" ] || falha "linha de base não encontrada: $LINHA_DE_BASE"

TMP="$(mktemp -d)"
NOME="portaria-restore-teste-$$"
export POSTGRES_PASSWORD; POSTGRES_PASSWORD="$(openssl rand -hex 16)"
limpar() { docker rm -f "$NOME" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap limpar EXIT

# 1) Postgres descartável, só em loopback. A senha vai pelo ambiente (-e sem valor), não pela linha de comando.
log "subindo $IMAGEM descartável"
docker run -d --rm --name "$NOME" -e POSTGRES_PASSWORD -e TZ=UTC -e PGTZ=UTC -p 127.0.0.1::5432 "$IMAGEM" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NOME" pg_isready -h 127.0.0.1 -U postgres -q 2>/dev/null && break
  sleep 1
done
docker exec "$NOME" pg_isready -h 127.0.0.1 -U postgres -q || falha "o Postgres descartável não subiu"
PORTA="$(docker port "$NOME" 5432/tcp | head -n1 | sed 's/.*://')"

# 2) Roles do bootstrap (o dump traz owners e GRANTs, não roles) e o banco descartável.
docker exec -i "$NOME" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
CREATE ROLE app_migrator NOLOGIN;
CREATE ROLE app_rw NOLOGIN;
CREATE DATABASE portaria_restore_teste OWNER app_migrator;
SQL

# 3) Restore direto do age (pipe): o dump em claro não toca o disco.
log "restaurando $(basename "$DUMP")"
age --decrypt -i "$AGE_IDENTIDADE" "$DUMP" \
  | docker exec -i "$NOME" pg_restore -U postgres -d portaria_restore_teste --exit-on-error --no-password \
  || falha "pg_restore falhou"

# 4) Anexos: o tar do mesmo carimbo decifra e lista (não extrai: os anexos já são cifrados pela KEK, que não está aqui).
ARQ="$(dirname "$DUMP")/arquivos-$(basename "$DUMP" .dump.age | sed 's/^portaria-//').tar.age"
if [ -r "$ARQ" ]; then
  N="$(age --decrypt -i "$AGE_IDENTIDADE" "$ARQ" | tar -tf - | grep -c '^documentos/.\+\.bin$' || true)"
  log "arquivos: $(basename "$ARQ") decifra e lista; $N anexo(s) cifrado(s)"
else
  log "arquivos: $(basename "$ARQ") não encontrado ao lado do dump (pulado)"
fi

# 5) selos.jsonl: o da linha de base (mesmo arquivo usado na F0) ou o atual do branch ancoras.
if [ -n "$LINHA_DE_BASE" ]; then
  age --decrypt -i "$AGE_IDENTIDADE" "$LINHA_DE_BASE" | tar -xf - -C "$TMP" linha-de-base.json selos.jsonl
  # O atual do branch cobre mais dias; sem rede, vale o da linha de base.
  if git -C "$RAIZ" fetch --quiet origin ancoras && git -C "$RAIZ" show FETCH_HEAD:selos.jsonl >"$TMP/selos-atual.jsonl"; then
    mv "$TMP/selos-atual.jsonl" "$TMP/selos.jsonl"
  else
    log "sem acesso ao branch ancoras: usando o selos.jsonl da linha de base"
  fi
else
  git -C "$RAIZ" fetch --quiet origin ancoras || falha "git fetch do branch ancoras falhou"
  git -C "$RAIZ" show FETCH_HEAD:selos.jsonl >"$TMP/selos.jsonl"
fi

# 6) Conferência (só leitura, transação READ ONLY) com a mesma CLI da F0.
export DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${PORTA}/portaria_restore_teste"
set +e
if [ -n "$LINHA_DE_BASE" ]; then
  node "$CLI" --conferir "$TMP/linha-de-base.json" <"$TMP/selos.jsonl" >"$TMP/conferencia.json"
  R=$?
else
  # Sem referência: só o resumo (o tar com a trilha passa pelo pipe e é descartado; só o JSON sai).
  node "$CLI" <"$TMP/selos.jsonl" | tar -xOf - linha-de-base.json >"$TMP/conferencia.json"
  R=${PIPESTATUS[0]}
fi
set -e
case "$R" in
  0) log "CONFERE: restore íntegro${LINHA_DE_BASE:+ e coerente com a linha de base}" ;;
  4) log "NÃO CONFERE: ver PROBLEMA acima"; exit 4 ;;
  *) falha "a CLI falhou (código $R)" ;;
esac

#!/usr/bin/env bash
# Linha de base da cadeia do piloto (fase F0 do SaaS, docs/05_arquitetura_saas.md; runbook em docs/deploy.md, seção 12).
# Roda NA VPS, no HOST, pelo operador (root ou grupo docker). Só leitura no banco: a CLI abre uma transação
# REPEATABLE READ READ ONLY como app_rw. Não para a API, não grava no banco, não muda o compose.
#
# O que sai, cifrado com a chave PÚBLICA age (a privada nunca fica na VPS), num arquivo só:
#   linha-de-base/linha-de-base-<carimbo>.tar.age   tar com linha-de-base.json (cabeça seq/hash, verificação interna,
#                                                   verificar-ancoras, contagem por tabela, última migração),
#                                                   trilha.jsonl (exportação verificável SEM nomes) e selos.jsonl
#   linha-de-base/linha-de-base-<carimbo>.sha256
# Nada de dado pessoal em claro: a trilha vai da CLI direto para o age por pipe (nem arquivo temporário), e o terminal
# só mostra cabeça, contagens e o resultado das conferências.
#
# Variáveis (com o padrão):
#   PORTARIA_DIR=/opt/tcc-portaria                       clone com o .env de produção (COMPOSE_FILE)
#   BACKUP_DIR=/var/backups/tcc-portaria                 o resultado vai para $BACKUP_DIR/linha-de-base/
#   BACKUP_AGE_RECIPIENTES=/etc/tcc-portaria/backup-age.pub
#   SELOS_JSONL=                                         caminho de um selos.jsonl já baixado; vazio = git fetch do branch ancoras
# Saída: 0 ok; 4 gerado, MAS a cadeia ou as âncoras não conferem (o arquivo fica: é a evidência; não seguir para F1);
#        1 erro (nada fica).
set -euo pipefail
umask 077

PORTARIA_DIR="${PORTARIA_DIR:-/opt/tcc-portaria}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/tcc-portaria}"
RECIPIENTES="${BACKUP_AGE_RECIPIENTES:-/etc/tcc-portaria/backup-age.pub}"

log() { printf '%s linha-de-base: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
falha() { log "ERRO: $*"; exit 1; }

command -v age >/dev/null || falha "age não instalado"
command -v docker >/dev/null || falha "docker não encontrado"
[ -r "$RECIPIENTES" ] || falha "chave pública age não encontrada: $RECIPIENTES"
grep -q '^age1' "$RECIPIENTES" || falha "$RECIPIENTES não tem chave pública age (age1...)"
if grep -q 'AGE-SECRET-KEY' "$RECIPIENTES"; then falha "$RECIPIENTES contém uma chave PRIVADA; deixe só a pública"; fi
[ -f "$PORTARIA_DIR/.env" ] || falha "sem $PORTARIA_DIR/.env"

DEST="$BACKUP_DIR/linha-de-base"
install -d -m 700 "$DEST"
CARIMBO="$(date -u +%Y%m%dT%H%M%SZ)"
SAIDA="$DEST/linha-de-base-$CARIMBO.tar.age"
SELOS_TMP="$(mktemp)"
trap 'rm -f "$SAIDA.parcial" "$SELOS_TMP"' EXIT

cd "$PORTARIA_DIR"

# 1) selos.jsonl do branch `ancoras` (dado público: data, seq, hash, total do dia). FETCH_HEAD: não muda o checkout.
if [ -n "${SELOS_JSONL:-}" ]; then
  cp "$SELOS_JSONL" "$SELOS_TMP"
else
  git fetch --quiet origin ancoras || falha "git fetch do branch ancoras falhou (sem rede? use SELOS_JSONL=<arquivo>)"
  git show FETCH_HEAD:selos.jsonl >"$SELOS_TMP" || falha "selos.jsonl não encontrado no branch ancoras"
fi
log "selos.jsonl: $(grep -c . "$SELOS_TMP" || true) dia(s) ancorado(s)"

# 2) CLI num container descartável da imagem da API (memória própria: não disputa os 384 MiB da API no ar), sem
#    dependências, sem porta. stdout = tar -> age. stderr = resumo legível, sem dado pessoal.
log "gerando (somente leitura, como app_rw)"
set +e
docker compose run --rm --no-deps -T api node dist/cli/linha-de-base.js <"$SELOS_TMP" \
  | age --encrypt -R "$RECIPIENTES" -o "$SAIDA.parcial"
ESTADOS=("${PIPESTATUS[@]}")
set -e
CLI="${ESTADOS[0]}"; AGE="${ESTADOS[1]}"
[ "$AGE" = 0 ] || falha "age falhou (código $AGE)"
case "$CLI" in
  0|4) ;;
  *) falha "a CLI falhou (código $CLI); nada foi guardado" ;;
esac
[ -s "$SAIDA.parcial" ] || falha "saída vazia"
mv "$SAIDA.parcial" "$SAIDA"
( cd "$DEST" && sha256sum "$(basename "$SAIDA")" >"linha-de-base-$CARIMBO.sha256" )

log "ok: $SAIDA ($(du -h "$SAIDA" | cut -f1))"
log "levar ao Mac (na máquina do responsável): scp <vps>:$SAIDA <vps>:$DEST/linha-de-base-$CARIMBO.sha256 ."
if [ "$CLI" = 4 ]; then
  log "ATENÇÃO: a cadeia ou as âncoras NÃO conferem (ver PROBLEMA acima). O arquivo ficou como evidência; não seguir para a F1."
  exit 4
fi
